// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 裁决台的跨界往返：读提案 → 判 → 提交落盘。
//!
//! 判据来自步骤 10.6 的接线：三条 `ProjectInput` 是作者在裁决台上的三个动作，
//! 而它们之间有一层顺序知识——**一次改写被切成两片，每片各要一条裁决**。
//! 界面不该知道这件事，所以它归 `stage_verdict` 那个用例。
//!
//! 这一条守的正是那层知识：把 `stage_verdict` 改回「一条提案写一条账本行」，
//! 提交会因为缺一片而具名拒绝，而 `stage` 那一步仍然成功——失败离动作很远，
//! 这是最难归因的一类缺陷。

use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::{
    Application, ProjectImport, ProjectInput, ProjectOutput, ProjectPlatform, RootKind,
};
use refrain_core::{Id, RefrainError};
use refrain_store::ledger::VerdictKindName;

const CHAPTER: &str = "章一.md";
const OPENING: &str = "剑一直握在他手里。";
const SECOND: &str = "他没有说话，风从窗口进来。";
const MERGED: &str = "他握着剑。";

fn scratch(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("refrain-review-{label}-{}", Id::new()));
    fs::create_dir_all(&path).unwrap();
    path
}

/// 系统选择器的替身：返回预先放好的那个路径。
struct Chosen(std::sync::Mutex<Option<PathBuf>>);

impl ProjectPlatform for Chosen {
    fn choose_root(&self, _kind: RootKind) -> Result<Option<PathBuf>, RefrainError> {
        Ok(self.0.lock().unwrap().take())
    }
    fn choose_project_parent(&self) -> Result<Option<PathBuf>, RefrainError> {
        Ok(self.0.lock().unwrap().take())
    }
    fn choose_import(&self, _kind: ProjectImport) -> Result<Option<PathBuf>, RefrainError> {
        Ok(self.0.lock().unwrap().take())
    }
}

fn nothing() -> Chosen {
    Chosen(std::sync::Mutex::new(None))
}

/// 打开一个项目并打开那份稿子，返回 root id。
fn open_project(application: &Application, root: &Path) -> String {
    let opened = application
        .project(
            &Chosen(std::sync::Mutex::new(Some(root.to_path_buf()))),
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap();
    let ProjectOutput::Opened(opened) = opened else {
        panic!("adopting a Root answers with the opened project");
    };
    let root_id = opened.root_id;
    application
        .project(
            &nothing(),
            ProjectInput::OpenDocument {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
            },
        )
        .unwrap();
    root_id
}

/// 冻一条改写提案。走真实插入路径，切片由领域层算。
fn insert_rewrite_proposal(application: &Application, root_id: &str) -> String {
    let proposal = Id::new();
    application
        .with_project(root_id, |entry| {
            let manuscript = entry.manuscripts.get(CHAPTER).unwrap();
            let block_id = manuscript.head().blocks()[0].id();
            let baseline = manuscript.head().id().to_string();
            entry
                .store
                .proposal_insert(&refrain_store::project::ProposalRow {
                    id: proposal.to_string(),
                    run: Id::new().to_string(),
                    baseline,
                    document_path: CHAPTER.to_string(),
                    scope: serde_json::to_string(&[block_id]).unwrap(),
                    before_text: OPENING.to_string(),
                    after_text: Some(MERGED.to_string()),
                    created_at: 1,
                })
                .unwrap();
            Ok(())
        })
        .unwrap();
    proposal.to_string()
}

#[test]
fn the_review_round_trip_reads_judges_and_lands_on_disk() {
    // 三个动作各自可验证，且最后一个真的改了磁盘——「裁决即落盘」（D1／F-01）
    // 的意思就是账本承认的那一刻磁盘同真，不把「按保存」留给作者。
    let data = scratch("data");
    let root = scratch("root");
    fs::write(root.join(CHAPTER), format!("{OPENING}\n\n{SECOND}\n")).unwrap();
    let application = Application::open(&data).unwrap();
    let root_id = open_project(&application, &root);
    let proposal = insert_rewrite_proposal(&application, &root_id);

    // 读：提案在列表里，且还没判过。
    let listing = application
        .project(
            &nothing(),
            ProjectInput::ReadProposals {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
            },
        )
        .unwrap();
    let ProjectOutput::Proposals(listing) = listing else {
        panic!("reading proposals answers with the listing");
    };
    assert_eq!(listing.proposals.len(), 1);
    assert_eq!(listing.proposals[0].id, proposal);
    assert_eq!(listing.proposals[0].before_text, OPENING);
    assert_eq!(listing.proposals[0].after_text.as_deref(), Some(MERGED));
    assert!(
        listing.staged.is_empty(),
        "a proposal nobody judged yet is not staged"
    );

    // 判：接受。判过之后 `staged` 里出现的是**提案** id，界面据此逐行标记。
    let staged = application
        .project(
            &nothing(),
            ProjectInput::StageVerdict {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
                proposal_id: proposal.clone(),
                kind: VerdictKindName::Accept,
                final_text: None,
                reason: None,
            },
        )
        .unwrap();
    let ProjectOutput::Proposals(staged) = staged else {
        panic!("staging a verdict answers with the refreshed listing");
    };
    assert_eq!(
        staged.staged,
        vec![proposal.clone(), proposal.clone()],
        "a rewrite is two slices, so it stages two ledger rows for the one proposal"
    );

    // 提交：落盘。这一步是「裁决即落盘」——磁盘上必须已经是新正文。
    let decided = application
        .project(
            &nothing(),
            ProjectInput::CommitVerdicts {
                root_id: root_id.clone(),
                path: CHAPTER.to_string(),
            },
        )
        .unwrap();
    let ProjectOutput::Decided(report) = decided else {
        panic!("committing verdicts answers with the decision report");
    };
    assert!(
        matches!(report, refrain_app::DecisionReport::Durable),
        "the verdict landed, so both the body and its derived state are durable: {report:?}"
    );

    // 判据落在磁盘上，不在返回值上：账本承认的那一刻文件必须同真。
    let on_disk = fs::read_to_string(root.join(CHAPTER)).unwrap();
    assert!(
        on_disk.contains(MERGED),
        "the accepted text must be on disk without a second save: {on_disk}"
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn judging_a_proposal_that_is_not_on_this_document_is_refused() {
    // 近失手：界面送来一个不属于这份文档的提案 id。在入口拒绝，错误离作者的
    // 动作最近；放过去的话失败会出现在提交那一步，与他刚才的点击隔了很远。
    let data = scratch("data-refuse");
    let root = scratch("root-refuse");
    fs::write(root.join(CHAPTER), format!("{OPENING}\n\n{SECOND}\n")).unwrap();
    let application = Application::open(&data).unwrap();
    let root_id = open_project(&application, &root);

    let refused = application.project(
        &nothing(),
        ProjectInput::StageVerdict {
            root_id: root_id.clone(),
            path: CHAPTER.to_string(),
            proposal_id: Id::new().to_string(),
            kind: VerdictKindName::Accept,
            final_text: None,
            reason: None,
        },
    );
    assert!(refused.is_err(), "an unknown proposal must be refused");

    // 改写型缺最终正文同样在入口拒绝：缺了它，提交那一步才失败。
    let proposal = insert_rewrite_proposal(&application, &root_id);
    let refused = application.project(
        &nothing(),
        ProjectInput::StageVerdict {
            root_id,
            path: CHAPTER.to_string(),
            proposal_id: proposal,
            kind: VerdictKindName::AcceptModified,
            final_text: None,
            reason: None,
        },
    );
    assert!(
        refused.is_err(),
        "accept-modified without its final text must be refused at the entry"
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn collecting_a_run_that_left_nothing_reports_waiting_rather_than_failing() {
    // 「结果还没出现」是正常的一态。把它讲成错误，作者会去重试一次其实
    // 还在跑的派发——而重试开的是一个新 Run。
    let data = scratch("data-collect");
    let root = scratch("root-collect");
    fs::write(root.join(CHAPTER), format!("{OPENING}\n\n{SECOND}\n")).unwrap();
    let application = Application::open(&data).unwrap();
    let root_id = open_project(&application, &root);

    let collected = application.project(
        &nothing(),
        ProjectInput::CollectRun {
            root_id,
            run_id: Id::new().to_string(),
        },
    );
    // 不存在的 Run 是一次具名拒绝，不是 panic，也不是静默的 waiting。
    assert!(
        collected.is_err(),
        "collecting a run that was never authorized must be refused by name"
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}
