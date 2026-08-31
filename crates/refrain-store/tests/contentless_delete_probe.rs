// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! `contentless_delete=1` 在**这台机器实际链接的那个 SQLite** 上到底做什么。
//!
//! 这三条决定索引怎么删：外部内容表（`content=''`）删一行要把当初插进去的
//! 那段文本一字不差地喂回去，FTS5 重新分词才找得到要摘掉的 posting。喂错不
//! 报错——它摘掉本来不存在的 posting、留下真正的那些，下一次读索引报
//! 「database disk image is malformed」。为了不喂错，索引把整份语料又存了
//! 一遍（每块的 bigram 后全文）。
//!
//! `contentless_delete=1`（SQLite 3.43 起）让 `DELETE ... WHERE rowid = ?`
//! 直接成立，那份拷贝因此没有存在的理由。先量再改。

use rusqlite::Connection;

fn probe(options: &str) -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(&format!(
        "CREATE VIRTUAL TABLE t USING fts5(body, content='', {options}
             tokenize='unicode61 remove_diacritics 2', detail=full);"
    ))
    .unwrap_or_else(|error| panic!("creating a table with `{options}` failed: {error}"));
    db
}

fn hits(db: &Connection, term: &str) -> i64 {
    db.query_row("SELECT count(*) FROM t WHERE t MATCH ?1", [term], |row| {
        row.get(0)
    })
    .unwrap()
}

#[test]
fn contentless_delete_is_available_and_deletes_by_rowid_alone() {
    let db = probe("contentless_delete=1,");
    db.execute("INSERT INTO t(rowid, body) VALUES (7, 'alpha')", [])
        .unwrap();
    assert_eq!(hits(&db, "alpha"), 1);

    db.execute("DELETE FROM t WHERE rowid = 7", []).unwrap();
    assert_eq!(
        hits(&db, "alpha"),
        0,
        "a rowid is enough to delete; the text that was inserted is not needed"
    );
}

/// A reused rowid still double-indexes. **The option does not close that.**
///
/// This was measured because the reverse was assumed: a table that can delete
/// by rowid looked like a table that knows which rowids it holds. It does not.
/// `contentless_delete=1` keeps tombstones so a delete can be replayed; it does
/// not keep the rows, so an insert at a live rowid is accepted by both shapes
/// and both postings answer queries afterwards.
///
/// What follows for the product: switching the option removes the copy of the
/// corpus and the "feed back exactly what was inserted" hazard, and it does
/// **not** remove the need to allocate rowids that were never used. `next_rowid`
/// stays, and the atomicity of the two writes stays a separate question.
#[test]
fn a_reused_rowid_double_indexes_under_both_shapes() {
    for options in ["contentless_delete=1,", ""] {
        let db = probe(options);
        db.execute("INSERT INTO t(rowid, body) VALUES (7, 'alpha')", [])
            .unwrap_or_else(|error| panic!("first insert under `{options}`: {error}"));
        db.execute("INSERT INTO t(rowid, body) VALUES (7, 'beta')", [])
            .unwrap_or_else(|error| panic!("second insert under `{options}`: {error}"));
        assert_eq!(
            (hits(&db, "alpha"), hits(&db, "beta")),
            (1, 1),
            "under `{options}` one rowid answers as two blocks"
        );
    }
}

/// A rowid written twice can never be fully cleared. Measured, not assumed.
///
/// One `DELETE` covers the most recent insert at that rowid; repeating it does
/// not reach the older one, because the tombstone is per rowid and it is already
/// there. So the rule the product must keep is unchanged by this option: **a
/// rowid is written once, ever**. `next_rowid` is what keeps it, and an
/// interrupted index that leaves a posting behind is a hole no delete closes.
///
/// What the option does buy is the delete itself: a rowid is the whole handle,
/// where the old shape needed the exact bytes of the posting — which is the copy
/// of the corpus this migration deletes.
#[test]
fn a_delete_needs_only_a_rowid_and_a_doubled_rowid_never_fully_clears() {
    let db = probe("contentless_delete=1,");
    db.execute("INSERT INTO t(rowid, body) VALUES (7, 'alpha')", [])
        .unwrap();
    db.execute("INSERT INTO t(rowid, body) VALUES (7, 'beta')", [])
        .unwrap();

    db.execute("DELETE FROM t WHERE rowid = 7", []).unwrap();
    assert_eq!(
        (hits(&db, "alpha"), hits(&db, "beta")),
        (1, 0),
        "a delete covers the most recent insert at that rowid, not every one of them"
    );

    db.execute("DELETE FROM t WHERE rowid = 7", []).unwrap();
    assert_eq!(
        (hits(&db, "alpha"), hits(&db, "beta")),
        (1, 0),
        "the tombstone is per rowid: repeating the delete does not reach the older posting"
    );
}

/// Ranking is what the index is for, so the option must not cost it.
///
/// `detail=full` maintains the column sizes bm25() needs; the probe asserts the
/// two documents come back in relevance order under the same tokenizer the
/// product uses.
#[test]
fn deletion_support_does_not_change_ranking() {
    let db = probe("contentless_delete=1,");
    db.execute(
        "INSERT INTO t(rowid, body) VALUES (1, 'rain rain rain')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO t(rowid, body) VALUES (2, 'rain and a great deal of other prose entirely')",
        [],
    )
    .unwrap();

    let mut statement = db
        .prepare("SELECT rowid FROM t WHERE t MATCH 'rain' ORDER BY bm25(t)")
        .unwrap();
    let order: Vec<i64> = statement
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(order, vec![1, 2], "the denser match still ranks first");
}
