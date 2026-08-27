// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! D1：裁决即落盘。
//!
//! 判据来自审计的 F-01——账本已经记下「已接受」，磁盘上的正文却还是旧的。
//! 裁决是档案性动作（它写进 Ledger），所以账本承认的那一刻磁盘必须同真：
//! 杀掉进程重开，作者不该看见一份账本承认过、正文里却不存在的修改。

use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::decide::{DecisionOutcome, commit_decision_batch};
use refrain_core::{Id, Lineage, Manuscript, SourceSnapshot};
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

const CHAPTER: &str = "章一.md";
const OPENING: &str = "剑一直握在他手里。";
const SECOND: &str = "他没有说话，风从窗口进来。";
const MERGED: &str = "他握着剑。";

fn scratch() -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-durable-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(CHAPTER), format!("{OPENING}\n\n{SECOND}\n")).unwrap();
    root
}

fn store_at(root: &Path) -> (Connection, ProjectStore) {
    let mut app = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.to_path_buf(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    (app, store)
}

fn open_manuscript(root: &Path) -> Manuscript {
    let snapshot = SourceSnapshot::read(fs::read(root.join(CHAPTER)).unwrap());
    let lineage = Lineage::fresh(snapshot.block_count());
    Manuscript::open(snapshot, lineage).unwrap()
}

/// 冻一条改写提案并给它接受裁决，返回 proposal id。走的是真实的合并路径。
fn stage_accepted_proposal(store: &mut ProjectStore, manuscript: &Manuscript) -> String {
    let proposal = Id::new();
    let block_id = manuscript.head().blocks()[0].id();
    store
        .proposal_insert(&refrain_store::project::ProposalRow {
            id: proposal.to_string(),
            run: Id::new().to_string(),
            baseline: manuscript.head().id().to_string(),
            document_path: CHAPTER.to_string(),
            scope: serde_json::to_string(&[block_id]).unwrap(),
            before_text: OPENING.to_string(),
            after_text: Some(MERGED.to_string()),
            created_at: 1,
        })
        .unwrap();
    // 改写提案切成 [Delete(0), Insert(1)]，两片都要裁决才算一次完整合并。
    let verdict_ids: Vec<String> = [0u32, 1]
        .iter()
        .enumerate()
        .map(|(index, ordinal)| {
            let verdict = Id::new();
            store
                .ledger()
                .record(&VerdictRecord {
                    id: verdict.to_string(),
                    proposal_id: proposal.to_string(),
                    slice_id: format!("{proposal}:{ordinal}"),
                    kind: VerdictKindName::Accept,
                    final_text: None,
                    reason: None,
                    decided_at: 2 + index as u64,
                    legacy_baseline: None,
                })
                .unwrap();
            verdict.to_string()
        })
        .collect();
    store
        .review_session_set(CHAPTER, 0, &serde_json::to_string(&verdict_ids).unwrap())
        .unwrap();
    proposal.to_string()
}

#[test]
fn an_outside_change_is_refused_instead_of_overwritten() {
    // 裁决即落盘，但裁决没有比作者按保存更多的权力。别人（另一个编辑器、一次
    // git checkout）在作者盖戳之后改了这个文件，覆盖它就是丢掉那些字。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let mut manuscript = open_manuscript(&root);
    stage_accepted_proposal(&mut store, &manuscript);

    // 作者盖戳时看到的那一份。
    // 作者打开文稿的那一刻盖的戳——真实路径就是这么拿到它的。
    let stamp = store.open_document(CHAPTER).unwrap().stamp;
    // 然后外面动了这个文件。
    let outside = format!("{OPENING}\n\n别人写下的一段。\n");
    fs::write(root.join(CHAPTER), &outside).unwrap();

    let outcome = commit_decision_batch(&mut store, &mut manuscript, CHAPTER, Some(stamp)).unwrap();

    match outcome {
        DecisionOutcome::Conflict { on_disk, .. } => {
            assert_eq!(String::from_utf8(on_disk).unwrap(), outside);
        }
        other => panic!("an outside change must be a Conflict, got {other:?}"),
    }
    // 决定性的一条：别人的字还在盘上。
    assert_eq!(fs::read_to_string(root.join(CHAPTER)).unwrap(), outside);
}

#[test]
fn a_matching_stamp_lets_the_decision_land() {
    // Conflict 那一条要有对照，否则它可能只是「凡带 stamp 必拒」。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let mut manuscript = open_manuscript(&root);
    stage_accepted_proposal(&mut store, &manuscript);

    // 作者打开文稿的那一刻盖的戳——真实路径就是这么拿到它的。
    let stamp = store.open_document(CHAPTER).unwrap().stamp;

    let outcome = commit_decision_batch(&mut store, &mut manuscript, CHAPTER, Some(stamp)).unwrap();

    match outcome {
        DecisionOutcome::Durable { .. } => {}
        other => panic!("an untouched disk must accept the decision, got {other:?}"),
    }
    assert!(
        fs::read_to_string(root.join(CHAPTER))
            .unwrap()
            .contains(MERGED)
    );
}

#[test]
fn accepting_a_proposal_leaves_the_new_text_on_disk() {
    // F-01 的判据。裁决走完之后不按保存，直接看磁盘。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let mut manuscript = open_manuscript(&root);
    stage_accepted_proposal(&mut store, &manuscript);

    let transition = commit_decision_batch(&mut store, &mut manuscript, CHAPTER, None).unwrap();
    assert!(
        manuscript.head().text().contains(MERGED),
        "the merge itself must have happened: {}",
        manuscript.head().text()
    );
    let _ = transition;

    // 这是全部的判据：重开这份稿子时读到的字节。
    let on_disk = fs::read_to_string(root.join(CHAPTER)).unwrap();
    assert!(
        on_disk.contains(MERGED),
        "the ledger says accepted, so the disk must agree; found: {on_disk}"
    );
    assert!(
        !on_disk.contains(OPENING),
        "the replaced text must be gone from disk; found: {on_disk}"
    );
}
