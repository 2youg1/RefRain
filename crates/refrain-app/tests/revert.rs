//! 工单信箱的回溯：还在批次里的裁决可以退回未读，离开批次的不许动。

use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::decide::revert_verdicts;
use refrain_core::Id;
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

const CHAPTER: &str = "章一.md";

fn scratch() -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-revert-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(CHAPTER), "剑没有松。\n").unwrap();
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

fn verdict(id: &str) -> VerdictRecord {
    VerdictRecord {
        id: id.to_string(),
        proposal_id: Id::new().to_string(),
        slice_id: "ch01:b1".to_string(),
        kind: VerdictKindName::Accept,
        final_text: None,
        reason: None,
        decided_at: 1,
        legacy_baseline: None,
    }
}

fn stage(store: &mut ProjectStore, ids: &[&str]) {
    for id in ids {
        store.ledger().record(&verdict(id)).unwrap();
    }
    let batch = serde_json::to_string(ids).unwrap();
    store.review_session_set(CHAPTER, 0, &batch).unwrap();
}

#[test]
fn a_staged_verdict_returns_to_unread() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    stage(&mut store, &["v1", "v2"]);

    let forgotten = revert_verdicts(&mut store, CHAPTER, &["v1".to_string()]).unwrap();

    assert_eq!(forgotten, 1);
    // 批次里只剩 v2；账本里 v1 已经不在。
    let (_cursor, batch) = store.review_session_get(CHAPTER).unwrap().unwrap();
    assert_eq!(batch, "[\"v2\"]");
    assert!(store.ledger().find_many(&["v1".to_string()]).is_err());
    assert!(store.ledger().find_many(&["v2".to_string()]).is_ok());

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_verdict_outside_the_batch_is_refused_and_untouched() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    stage(&mut store, &["v1"]);

    // v9 不在批次里：它可能已合并进正文，删它会同时毁掉审计与事实。
    let refusal = revert_verdicts(&mut store, CHAPTER, &["v9".to_string()]);
    assert!(refusal.is_err());
    let (_cursor, batch) = store.review_session_get(CHAPTER).unwrap().unwrap();
    assert_eq!(batch, "[\"v1\"]");
    assert!(store.ledger().find_many(&["v1".to_string()]).is_ok());

    drop(store);
    fs::remove_dir_all(root).unwrap();
}
