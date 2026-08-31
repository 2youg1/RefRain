// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 信箱服务与逆向裁决的应用层接线。
//!
//! 安排表本身在存储层有自己的测试（refrain-store/tests/mailbox.rs）。这里
//! 钉的是服务层的解析规则与入口纪律：没排过的排在排过的后面、没有安排行
//! 的提案按账本判格、弃置离开默认列表而回收站是另一份投影、取回没弃置过
//! 的是空操作不是错误，以及 `Countermand` 入口的具名拒绝。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use refrain_app::mailbox::MailboxEntryView;
use refrain_app::{
    Application, DecisionReport, ProjectImport, ProjectInput, ProjectOutput, ProjectPlatform,
};
use refrain_core::{ErrorCode, Id};
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::mailbox::MailboxBoxName;
use refrain_store::project::ProposalRow;
use refrain_store::root::RootKind;

const CHAPTER: &str = "正文.md";
const SEQUEL: &str = "续篇.md";
const OPENING: &str = "剑一直握在他手里。";
const SECOND: &str = "他没有说话，风从窗口进来。";
const MERGED: &str = "他握着剑。";

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "refrain-mailbox-service-{label}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

struct Chosen(PathBuf);

impl ProjectPlatform for Chosen {
    fn choose_root(&self, _kind: RootKind) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        Ok(Some(self.0.clone()))
    }

    fn choose_project_parent(&self) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        self.choose_root(RootKind::Folder)
    }

    fn choose_import(
        &self,
        _kind: ProjectImport,
    ) -> Result<Option<PathBuf>, refrain_core::RefrainError> {
        self.choose_root(RootKind::Folder)
    }
}

fn adopt(data: &Path, root: &Path, files: &[(&str, &str)]) -> (Application, String) {
    for (name, body) in files {
        fs::write(root.join(name), body).unwrap();
    }
    let application = Application::open(data).unwrap();
    let ProjectOutput::Opened(opened) = application
        .project(
            &Chosen(root.to_path_buf()),
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap()
    else {
        panic!("adoption must open the project");
    };
    (application, opened.root_id)
}

/// 冻一条提案进 store，返回提案 id。
fn seed_proposal(
    application: &Application,
    root_id: &str,
    document: &str,
    before: &str,
    after: Option<&str>,
    created_at: u64,
) -> String {
    let id = Id::new().to_string();
    application
        .with_project(root_id, |entry| {
            entry
                .store
                .proposal_insert(&ProposalRow {
                    id: id.clone(),
                    run: Id::new().to_string(),
                    baseline: Id::new().to_string(),
                    document_path: document.to_string(),
                    scope: serde_json::to_string(&[Id::new()]).unwrap(),
                    before_text: before.to_string(),
                    after_text: after.map(str::to_string),
                    created_at,
                })
                .unwrap();
            Ok(())
        })
        .unwrap();
    id
}

/// 记一条接受裁决进账本：信箱据账本判「已处理」。
fn seed_verdict(application: &Application, root_id: &str, proposal_id: &str) {
    application
        .with_project(root_id, |entry| {
            entry
                .store
                .ledger()
                .record(&VerdictRecord {
                    id: Id::new().to_string(),
                    proposal_id: proposal_id.to_string(),
                    slice_id: format!("{proposal_id}:1"),
                    kind: VerdictKindName::Accept,
                    final_text: None,
                    reason: None,
                    decided_at: 2,
                    legacy_baseline: None,
                })
                .unwrap();
            Ok(())
        })
        .unwrap();
}

fn mailbox_of(application: &Application, root_id: &str) -> Vec<MailboxEntryView> {
    let ProjectOutput::Mailbox(entries) = application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::ReadMailbox {
                root_id: root_id.to_owned(),
                discarded: false,
            },
        )
        .unwrap()
    else {
        panic!("read mailbox must return entries");
    };
    entries
}

fn ids_of(entries: &[MailboxEntryView]) -> Vec<String> {
    entries.iter().map(|entry| entry.id.clone()).collect()
}

#[test]
fn the_mailbox_merges_proposals_across_documents_in_arrival_order() {
    let data = scratch("merge-data");
    let root = scratch("merge-root");
    let (application, root_id) =
        adopt(&data, &root, &[(CHAPTER, "原稿。\n"), (SEQUEL, "续稿。\n")]);

    let first = seed_proposal(
        &application,
        &root_id,
        CHAPTER,
        "原稿。",
        Some("改过的稿。"),
        1,
    );
    let second = seed_proposal(&application, &root_id, SEQUEL, "续稿。", None, 2);

    let entries = mailbox_of(&application, &root_id);
    assert_eq!(ids_of(&entries), vec![first.clone(), second.clone()]);
    // 投影带的是界面要的列：文档、原文、提议。一行裁决都没有的提案是未读。
    assert_eq!(entries[0].document, CHAPTER);
    assert_eq!(entries[0].before_text, "原稿。");
    assert_eq!(entries[0].after_text.as_deref(), Some("改过的稿。"));
    assert_eq!(entries[0].box_name, MailboxBoxName::Unread);
    assert_eq!(entries[1].document, SEQUEL);
    assert!(entries[1].after_text.is_none(), "删除型提案没有新文本");
    assert!(!entries[0].pinned);
    assert_eq!(entries[0].rank, None, "没人排过的单没有位次");

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_untouched_entry_follows_the_arranged_ones_and_survives_a_reopen() {
    let data = scratch("order-data");
    let root = scratch("order-root");
    let (application, root_id) = adopt(&data, &root, &[(CHAPTER, "原稿。\n")]);
    let p1 = seed_proposal(&application, &root_id, CHAPTER, "一。", Some("甲。"), 1);
    let p2 = seed_proposal(&application, &root_id, CHAPTER, "二。", Some("乙。"), 2);
    let p3 = seed_proposal(&application, &root_id, CHAPTER, "三。", Some("丙。"), 3);

    application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::MailboxRank {
                root_id: root_id.clone(),
                entry_id: p3.clone(),
                box_name: MailboxBoxName::Unread,
                rank: 0,
            },
        )
        .unwrap();
    application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::MailboxPin {
                root_id: root_id.clone(),
                entry_id: p2.clone(),
                box_name: MailboxBoxName::Unread,
                pinned: true,
            },
        )
        .unwrap();

    // near-miss：p1 从没被排过——它必须落在两个排过的后面。NULL 在 SQLite
    // 里小于任何数字，直接按 rank 排序会把它顶到最前，这正是要钉住的。
    let entries = mailbox_of(&application, &root_id);
    assert_eq!(ids_of(&entries), vec![p2.clone(), p3.clone(), p1.clone()]);
    assert!(entries[0].pinned, "Pin 优先于位次");
    assert_eq!(entries[1].rank, Some(0));
    assert_eq!(entries[2].rank, None, "没排过的没有位次");
    assert!(!entries[2].pinned);

    // 安排活在项目库里：换一个全新的应用状态目录重新 adopt，读到的还是它。
    drop(application);
    let rebuilt = scratch("order-rebuilt");
    let (application, root_id) = adopt(&rebuilt, &root, &[]);
    let entries = mailbox_of(&application, &root_id);
    assert_eq!(ids_of(&entries), vec![p2, p3, p1], "安排活过重建");

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(rebuilt).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_entry_without_a_standing_row_follows_the_ledger() {
    let data = scratch("ledger-data");
    let root = scratch("ledger-root");
    let (application, root_id) = adopt(&data, &root, &[(CHAPTER, "原稿。\n")]);
    let fresh = seed_proposal(&application, &root_id, CHAPTER, "一。", Some("甲。"), 1);
    let judged = seed_proposal(&application, &root_id, CHAPTER, "二。", Some("乙。"), 2);
    seed_verdict(&application, &root_id, &judged);

    let entries = mailbox_of(&application, &root_id);
    assert_eq!(ids_of(&entries), vec![fresh.clone(), judged.clone()]);
    assert_eq!(
        entries[0].box_name,
        MailboxBoxName::Unread,
        "一行裁决都没有是未读"
    );
    assert_eq!(
        entries[1].box_name,
        MailboxBoxName::Done,
        "有过裁决是已处理"
    );

    // 有了安排行，行说了算：账本判定只兜底没人碰过的单。
    application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::MailboxRank {
                root_id: root_id.clone(),
                entry_id: judged.clone(),
                box_name: MailboxBoxName::Draft,
                rank: 1,
            },
        )
        .unwrap();
    let entries = mailbox_of(&application, &root_id);
    assert_eq!(ids_of(&entries), vec![judged.clone(), fresh.clone()]);
    assert_eq!(
        entries[0].box_name,
        MailboxBoxName::Draft,
        "安排行优先于账本判定"
    );
    assert_eq!(entries[0].rank, Some(1));

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_discarded_entry_leaves_the_default_list_and_restore_brings_it_back() {
    let data = scratch("discard-data");
    let root = scratch("discard-root");
    let (application, root_id) = adopt(&data, &root, &[(CHAPTER, "原稿。\n")]);
    let p1 = seed_proposal(&application, &root_id, CHAPTER, "一。", Some("甲。"), 1);
    let p2 = seed_proposal(&application, &root_id, CHAPTER, "二。", Some("乙。"), 2);

    application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::MailboxDiscard {
                root_id: root_id.clone(),
                entry_id: p1.clone(),
                box_name: MailboxBoxName::Unread,
            },
        )
        .unwrap();
    let entries = mailbox_of(&application, &root_id);
    assert_eq!(ids_of(&entries), vec![p2.clone()], "弃置的从默认列表消失");

    // 回收站是单独一份投影：弃置的在里面，带着它被弃置时所在的那一格。
    // 走与界面相同的输入通道（`discarded: true`），不是绕开用例层直调。
    let ProjectOutput::Mailbox(discarded) = application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::ReadMailbox {
                root_id: root_id.clone(),
                discarded: true,
            },
        )
        .unwrap()
    else {
        panic!("read mailbox must return entries");
    };
    assert_eq!(ids_of(&discarded), vec![p1.clone()]);
    assert_eq!(discarded[0].box_name, MailboxBoxName::Unread);

    application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::MailboxRestore {
                root_id: root_id.clone(),
                entry_id: p1.clone(),
            },
        )
        .unwrap();
    let entries = mailbox_of(&application, &root_id);
    assert_eq!(entries.len(), 2, "取回之后回到信箱");
    // 软删除的另一面（INV-4）：提案行原地没动，原文还是当初那些字节。
    let restored = entries.iter().find(|entry| entry.id == p1).unwrap();
    assert_eq!(restored.before_text, "一。");
    assert_eq!(restored.box_name, MailboxBoxName::Unread);

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn restoring_an_entry_that_was_never_discarded_is_a_no_op_not_an_error() {
    let data = scratch("restore-data");
    let root = scratch("restore-root");
    let (application, root_id) = adopt(&data, &root, &[(CHAPTER, "原稿。\n")]);
    let p1 = seed_proposal(&application, &root_id, CHAPTER, "一。", Some("甲。"), 1);

    // 从没弃置过：存储层如实报 0 行被改。
    let restored = application
        .with_project(&root_id, |entry| {
            Ok(entry.store.mailbox().restore(&p1, 0).unwrap())
        })
        .unwrap();
    assert_eq!(restored, 0, "没有弃置过的单没有行被改");

    // 服务层同样不把它当成错误：照常返回刷新后的信箱。
    let ProjectOutput::Mailbox(entries) = application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::MailboxRestore {
                root_id: root_id.clone(),
                entry_id: p1.clone(),
            },
        )
        .unwrap()
    else {
        panic!("restoring an untouched entry must answer the refreshed mailbox");
    };
    assert_eq!(ids_of(&entries), vec![p1.clone()], "空操作之后列表不变");

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_countermand_refuses_an_empty_set_and_a_proposal_that_is_not_here() {
    let data = scratch("refuse-data");
    let root = scratch("refuse-root");
    let (application, root_id) = adopt(&data, &root, &[(CHAPTER, "原稿。\n")]);
    // 冲销要在稿子里定位当初合并进去的字节，所以这份文档得先打开。
    application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::OpenDocument {
                root_id: root_id.clone(),
                path: CHAPTER.to_owned(),
            },
        )
        .unwrap();

    let empty = application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::Countermand {
                root_id: root_id.clone(),
                path: CHAPTER.to_owned(),
                proposal_ids: Vec::new(),
            },
        )
        .unwrap_err();
    assert_eq!(empty.code, ErrorCode::StateUnavailable);
    assert!(
        empty.action.contains("empty set"),
        "空集要具名拒绝: {empty:?}"
    );

    let missing = application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::Countermand {
                root_id: root_id.clone(),
                path: CHAPTER.to_owned(),
                proposal_ids: vec![Id::new().to_string()],
            },
        )
        .unwrap_err();
    assert_eq!(missing.code, ErrorCode::StateUnavailable);
    assert!(
        missing.action.contains("not here"),
        "不存在的提案要具名拒绝: {missing:?}"
    );

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_merged_proposal_is_countermanded_through_the_project_input() {
    let data = scratch("countermand-data");
    let root = scratch("countermand-root");
    let body = format!("{OPENING}\n\n{SECOND}\n");
    let (application, root_id) = adopt(&data, &root, &[(CHAPTER, body.as_str())]);
    application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::OpenDocument {
                root_id: root_id.clone(),
                path: CHAPTER.to_owned(),
            },
        )
        .unwrap();

    // seed 一个已合并的提案，走真实的合并路径：提案 + 每片一条接受裁决 +
    // 提交批次。夹具与 tests/countermand.rs 同一条，只是借 with_project
    // 送进应用层。
    let proposal = application
        .with_project(&root_id, |entry| {
            let mut manuscript = entry.manuscripts.get(CHAPTER).cloned().unwrap();
            let proposal = Id::new().to_string();
            let block = manuscript.head().blocks()[0].id();
            entry
                .store
                .proposal_insert(&ProposalRow {
                    id: proposal.clone(),
                    run: Id::new().to_string(),
                    baseline: manuscript.head().id().to_string(),
                    document_path: CHAPTER.to_string(),
                    scope: serde_json::to_string(&[block]).unwrap(),
                    before_text: OPENING.to_string(),
                    after_text: Some(MERGED.to_string()),
                    created_at: 1,
                })
                .unwrap();
            // 改写提案是 [Delete(0), Insert(1)] 两片，每片各要一条裁决——
            // 未裁决的 Delete 片按合并规则保留原文，不算一次完整合并。
            let verdicts: Vec<String> = [0, 1]
                .iter()
                .enumerate()
                .map(|(index, ordinal)| {
                    let verdict = Id::new().to_string();
                    entry
                        .store
                        .ledger()
                        .record(&VerdictRecord {
                            id: verdict.clone(),
                            proposal_id: proposal.clone(),
                            slice_id: format!("{proposal}:{ordinal}"),
                            kind: VerdictKindName::Accept,
                            final_text: None,
                            reason: None,
                            decided_at: 2 + index as u64,
                            legacy_baseline: None,
                        })
                        .unwrap();
                    verdict
                })
                .collect();
            entry
                .store
                .review_session_set(CHAPTER, 0, &serde_json::to_string(&verdicts).unwrap())
                .unwrap();
            refrain_app::decide::commit_decision_batch(
                &mut entry.store,
                &mut manuscript,
                CHAPTER,
                None,
            )
            .unwrap();
            entry.manuscripts.insert(CHAPTER.to_owned(), manuscript);
            Ok(proposal)
        })
        .unwrap();
    application
        .with_project(&root_id, |entry| {
            assert!(
                entry
                    .manuscripts
                    .get(CHAPTER)
                    .unwrap()
                    .head()
                    .text()
                    .contains(MERGED),
                "合并之后正文带着新文本"
            );
            Ok(())
        })
        .unwrap();

    let output = application
        .project(
            &Chosen(PathBuf::new()),
            ProjectInput::Countermand {
                root_id: root_id.clone(),
                path: CHAPTER.to_owned(),
                proposal_ids: vec![proposal.clone()],
            },
        )
        .unwrap();
    assert!(
        matches!(output, ProjectOutput::Decided(DecisionReport::Durable)),
        "冲销成功报 Durable: {output:?}"
    );

    application
        .with_project(&root_id, |entry| {
            // 正文在稿子里回退到冻结前的字节；账本 append-only，接受与冲销
            // 成对都在。
            assert_eq!(
                entry.manuscripts.get(CHAPTER).unwrap().head().text(),
                format!("{OPENING}\n\n{SECOND}")
            );
            let kinds: Vec<VerdictKindName> = entry
                .store
                .ledger()
                .for_document(CHAPTER)
                .unwrap()
                .iter()
                .map(|row| row.kind)
                .collect();
            assert!(
                kinds.contains(&VerdictKindName::Countermanded),
                "账本里有冲销记录: {kinds:?}"
            );
            Ok(())
        })
        .unwrap();

    drop(application);
    fs::remove_dir_all(data).unwrap();
    fs::remove_dir_all(root).unwrap();
}
