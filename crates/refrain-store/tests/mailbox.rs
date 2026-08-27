// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 信箱安排（SPEC 9.6）的向量。
//!
//! 每条钉住的失败：作者 Pin 过的单重启后掉回原位、弃置一批提案连带毁掉了
//! 账本与提案行、或者「弃置」被实现成真删除而没有回头路。
//!
//! Windows 纪律：活着的 `ProjectStore` 占着项目库文件，删目录前先 drop。

use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::mailbox::MailboxBoxName;
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let unique = format!(
        "refrain-mailbox-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let dir = std::env::temp_dir().join(unique);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn app_db() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut db).unwrap();
    db
}

fn adopt(app: &mut Connection, root: &Path) -> ProjectStore {
    ProjectStore::adopt(
        app,
        &RootLocator {
            path: root.to_path_buf(),
            kind: RootKind::Folder,
        },
    )
    .unwrap()
    .0
}

/// 次序活过关窗。它此前只在前端 `#order` 里，关窗即失。
#[test]
fn the_authors_order_survives_reopening_the_project() {
    let root = scratch();
    fs::write(root.join("章一.md"), "　　第一段。\n").unwrap();
    let mut app = app_db();

    {
        let store = adopt(&mut app, &root);
        let mailbox = store.mailbox();
        mailbox
            .set_rank("p-3", MailboxBoxName::Unread, 0, 1_000)
            .unwrap();
        mailbox
            .set_rank("p-1", MailboxBoxName::Unread, 1, 1_001)
            .unwrap();
        mailbox
            .set_rank("p-2", MailboxBoxName::Unread, 2, 1_002)
            .unwrap();
    }

    let store = adopt(&mut app, &root);
    let order: Vec<String> = store
        .mailbox()
        .all()
        .unwrap()
        .into_iter()
        .map(|row| row.entry_id)
        .collect();
    assert_eq!(order, vec!["p-3", "p-1", "p-2"]);

    drop(store);
    fs::remove_dir_all(&root).ok();
}

/// Pin 与置顶不是同一件事：置顶是一次排序，新单进来照样压得下去；
/// Pin 说的是这一单不参与后续排序。这条钉住那个差别。
#[test]
fn a_pinned_entry_outranks_every_later_arrival() {
    let root = scratch();
    let mut app = app_db();
    let store = adopt(&mut app, &root);
    let mailbox = store.mailbox();

    mailbox
        .set_pinned("p-pinned", MailboxBoxName::Unread, true, 1_000)
        .unwrap();
    // 后到的单排在最前面的位次上——若 Pin 只是一次排序，它就该赢。
    mailbox
        .set_rank("p-later", MailboxBoxName::Unread, 0, 2_000)
        .unwrap();

    let order: Vec<String> = mailbox
        .all()
        .unwrap()
        .into_iter()
        .map(|row| row.entry_id)
        .collect();
    assert_eq!(order, vec!["p-pinned", "p-later"]);

    // 两个方向都要能走：钉住是意图，取消也是。
    mailbox
        .set_pinned("p-pinned", MailboxBoxName::Unread, false, 3_000)
        .unwrap();
    let after: Vec<String> = mailbox
        .all()
        .unwrap()
        .into_iter()
        .map(|row| row.entry_id)
        .collect();
    assert_eq!(after, vec!["p-later", "p-pinned"]);

    drop(store);
    fs::remove_dir_all(&root).ok();
}

/// 弃置只写下时刻。账本一行不少、提案行原地不动——INV-4 不允许任何一层
/// 做永久删除，而「谁放弃了哪批提案」本身就是要留住的事实。
#[test]
fn discarding_a_ticket_keeps_its_verdicts_and_can_be_undone() {
    let root = scratch();
    let mut app = app_db();
    let store = adopt(&mut app, &root);

    store
        .ledger()
        .record(&VerdictRecord {
            id: "v-1".to_owned(),
            proposal_id: "p-1".to_owned(),
            slice_id: "p-1:0".to_owned(),
            kind: VerdictKindName::Accept,
            final_text: None,
            reason: None,
            decided_at: 1_000,
            legacy_baseline: None,
        })
        .unwrap();

    let mailbox = store.mailbox();
    mailbox
        .discard("p-1", MailboxBoxName::Unread, 2_000)
        .unwrap();

    // 弃置之后账本仍然完整：软删除动的是安排，不是事实。
    assert_eq!(store.ledger().count().unwrap(), 1);
    let discarded = mailbox.discarded().unwrap();
    assert_eq!(discarded.len(), 1);
    assert_eq!(discarded[0].entry_id, "p-1");
    assert_eq!(discarded[0].discarded_at, Some(2_000));

    // 回头路存在，这是「删除只进回收站」的另一半。
    assert_eq!(mailbox.restore("p-1", 3_000).unwrap(), 1);
    assert!(mailbox.discarded().unwrap().is_empty());
    assert_eq!(store.ledger().count().unwrap(), 1);

    drop(store);
    fs::remove_dir_all(&root).ok();
}

/// 取回一单没弃置过的单什么也不改：`restore` 不能顺手造出一条安排。
#[test]
fn restoring_something_that_was_never_discarded_changes_nothing() {
    let root = scratch();
    let mut app = app_db();
    let store = adopt(&mut app, &root);
    let mailbox = store.mailbox();

    mailbox
        .set_rank("p-1", MailboxBoxName::Done, 0, 1_000)
        .unwrap();
    assert_eq!(mailbox.restore("p-1", 2_000).unwrap(), 0);
    assert_eq!(mailbox.restore("p-never-seen", 2_000).unwrap(), 0);
    assert_eq!(mailbox.all().unwrap().len(), 1);

    drop(store);
    fs::remove_dir_all(&root).ok();
}

/// 排过序的单再被 Pin，次序不丢：两种意图各占一列，互不擦除。
#[test]
fn pinning_a_ranked_entry_keeps_its_rank() {
    let root = scratch();
    let mut app = app_db();
    let store = adopt(&mut app, &root);
    let mailbox = store.mailbox();

    mailbox
        .set_rank("p-1", MailboxBoxName::Unread, 7, 1_000)
        .unwrap();
    mailbox
        .set_pinned("p-1", MailboxBoxName::Unread, true, 2_000)
        .unwrap();

    let rows = mailbox.all().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].rank, Some(7));
    assert!(rows[0].pinned);

    drop(store);
    fs::remove_dir_all(&root).ok();
}

/// 相邻交换是一次事务：双方位次互换，次序反转；任一方没排过时是空操作。
#[test]
fn swapping_ranks_is_atomic_and_reverses_the_pair() {
    let root = scratch();
    fs::write(root.join("章一.md"), "　　第一段。\n").unwrap();
    let mut db = app_db();
    let store = adopt(&mut db, &root);

    let now = 1_000u64;
    store
        .mailbox()
        .set_rank("a", MailboxBoxName::Unread, 1, now)
        .unwrap();
    store
        .mailbox()
        .set_rank("b", MailboxBoxName::Unread, 2, now + 1)
        .unwrap();
    store.mailbox().swap_ranks("a", "b", now + 2).unwrap();
    let all = store.mailbox().all().unwrap();
    let a = all.iter().find(|row| row.entry_id == "a").unwrap();
    let b = all.iter().find(|row| row.entry_id == "b").unwrap();
    assert_eq!(a.rank, Some(2));
    assert_eq!(b.rank, Some(1));

    // 反向换回来。
    store.mailbox().swap_ranks("a", "b", now + 3).unwrap();
    let all = store.mailbox().all().unwrap();
    let a = all.iter().find(|row| row.entry_id == "a").unwrap();
    let b = all.iter().find(|row| row.entry_id == "b").unwrap();
    assert_eq!(a.rank, Some(1));
    assert_eq!(b.rank, Some(2));

    // 未排过的单不参与：空操作，行未动。
    store
        .mailbox()
        .set_rank("d", MailboxBoxName::Unread, 4, now + 6)
        .unwrap();
    store
        .mailbox()
        .set_rank("e", MailboxBoxName::Unread, 5, now + 7)
        .unwrap();
    // 让 e 的位次消失（重排为 None 不可行——用不存在的 id 模拟缺席）。
    store
        .mailbox()
        .swap_ranks("a", "no-such-entry", now + 8)
        .unwrap();
    let all = store.mailbox().all().unwrap();
    let a = all.iter().find(|row| row.entry_id == "a").unwrap();
    assert_eq!(a.rank, Some(1), "swapping with a missing entry is a no-op");

    store
        .mailbox()
        .set_rank("c", MailboxBoxName::Unread, 3, now + 4)
        .unwrap();
    store.mailbox().swap_ranks("a", "c", now + 5).unwrap();
    let all = store.mailbox().all().unwrap();
    let a = all.iter().find(|row| row.entry_id == "a").unwrap();
    let c = all.iter().find(|row| row.entry_id == "c").unwrap();
    // a 与 c 都有位次（1 与 3）——换。
    assert_eq!(a.rank, Some(3));
    assert_eq!(c.rank, Some(1));

    drop(store);
    fs::remove_dir_all(root).unwrap();
}
