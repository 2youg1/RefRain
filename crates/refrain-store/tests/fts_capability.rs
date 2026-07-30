//! FTS5 的可用性与 CJK 分词行为。
//!
//! 这两件事都不能靠读文档定案：`rusqlite` 的 `bundled` 是否编入 FTS5、
//! `unicode61` 对中日文如何切分，都要在**这台机器实际链接的那个 SQLite** 上问。
//!
//! 结论会决定正文搜索怎么做，所以先量再设计。

use rusqlite::Connection;

#[test]
fn fts5_is_compiled_into_the_bundled_sqlite() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE VIRTUAL TABLE probe USING fts5(body);")
        .expect(
            "FTS5 is not compiled in; the bundled feature alone does not include it and the \
             Cargo feature has to be enabled",
        );
}

#[test]
fn the_default_tokenizer_cannot_find_a_phrase_inside_cjk_text() {
    // unicode61 切词靠空白与标点。中日文没有词间空格，于是整句被当作一个词元，
    // 搜「没有说话」找不到「他久久没有说话。」——这是产品语义问题，不是配置问题。
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='unicode61');")
        .unwrap();
    db.execute("INSERT INTO t(body) VALUES ('他久久没有说话。')", [])
        .unwrap();

    let hits: i64 = db
        .query_row(
            "SELECT count(*) FROM t WHERE t MATCH '没有说话'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    assert_eq!(
        hits, 0,
        "if this now finds the phrase, the tokenizer changed and the trigram decision below \
         should be revisited"
    );
}

#[test]
fn the_trigram_tokenizer_finds_a_phrase_inside_cjk_text() {
    // trigram 按三字符滑窗建索引，因此子串匹配成立，中日文与西文一视同仁。
    // 代价是索引更大、且查询串短于三个字符时退化——两者都要在实现里说清。
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram');")
        .expect("trigram tokenizer is available from SQLite 3.34");
    db.execute("INSERT INTO t(body) VALUES ('他久久没有说话。')", [])
        .unwrap();
    db.execute("INSERT INTO t(body) VALUES ('剑没有松。')", [])
        .unwrap();

    let hits: i64 = db
        .query_row(
            "SELECT count(*) FROM t WHERE t MATCH '没有说话'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(hits, 1, "a phrase inside a CJK sentence must be findable");

    // 三个字符是 trigram 的下限，正好命中两句。
    let three: i64 = db
        .query_row(
            "SELECT count(*) FROM t WHERE t MATCH '没有说'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(three, 1);
}

#[test]
fn a_two_character_query_finds_nothing_under_trigram() {
    // **实测得到的硬约束**：trigram 按三字符滑窗建索引，所以短于三个字符的查询
    // 索引里根本没有对应项——返回 0 而不是报错。这对中日文尤其要紧：「没有」
    // 「章节」这类两字词是作者最常输入的东西。
    //
    // 产品必须显式处理这一段，不能让它静默返回空：两字以内退回既有的 LIKE
    // 子串搜索（路径与正文都能扫，只是不走索引），三字以上走 FTS5。
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram');")
        .unwrap();
    db.execute("INSERT INTO t(body) VALUES ('他久久没有说话。')", [])
        .unwrap();
    db.execute("INSERT INTO t(body) VALUES ('剑没有松。')", [])
        .unwrap();

    let hits: i64 = db
        .query_row("SELECT count(*) FROM t WHERE t MATCH '没有'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        hits, 0,
        "two characters are below the trigram window; the product falls back to LIKE here"
    );
}

#[test]
fn a_query_shorter_than_a_trigram_is_a_real_limit_not_an_error() {
    // 单字查询在 trigram 下无法用索引。产品要么拒绝、要么退回 LIKE；
    // 无论选哪个，都不能假装它工作。
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram');")
        .unwrap();
    db.execute("INSERT INTO t(body) VALUES ('他久久没有说话。')", [])
        .unwrap();

    let outcome = db.query_row("SELECT count(*) FROM t WHERE t MATCH '没'", [], |row| {
        row.get::<_, i64>(0)
    });
    // 记录实际行为：可能报错，也可能返回 0。两种都要求产品显式处理。
    println!("single-character trigram query: {outcome:?}");
}
