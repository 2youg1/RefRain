//! 检索：中文能不能搜到，以及两种精度各自答的是什么问题。
//!
//! 这些断言的依据是真实语料实测（`review/search-probe-results.md`）：
//! 22410 份文档、252MB。那次实测推翻了外部资料一致推荐的 OR 连接——
//! 它对「不存在的词」返回 500 条噪音——也否决了看起来更严格的 NEAR，
//! 后者对一个真实存在的短语返回 0 条。

use refrain_core::chinese_index::Precision;
use refrain_store::Database;
use refrain_store::project::search::{forget_document, index_document, search, search_with};
use refrain_store::schema::{ProjectDb, open_in_memory};
use rusqlite::Connection;

fn indexed() -> Connection {
    let mut db = open_in_memory().unwrap();
    ProjectDb::migrate(&mut db).unwrap();
    for (path, digest, text) in [
        (
            "第一章-停留.md",
            "d1",
            "写作是把尚未成形的东西按住，让它在纸面上停留得够久。陆沉舟站在窗前。",
        ),
        (
            "第二章-长夜.md",
            "d2",
            "长夜将尽时，陆沉舟才想起白天那句话。营销这个词他一向不喜欢。",
        ),
        (
            "资料-人物志.md",
            "d3",
            "陆沉舟，四十二岁，前营销总监。习惯在纸上写字。",
        ),
        ("notes-english.md", "d4", "The quick brown fox jumps over."),
    ] {
        index_document(&db, path, digest, text).unwrap();
    }
    db
}

fn paths(hits: Vec<refrain_store::project::search::IndexedBlock>) -> Vec<String> {
    hits.into_iter().map(|hit| hit.path).collect()
}

#[test]
fn a_two_character_chinese_word_is_findable() {
    // FTS5 的 trigram 分词器对这个查询返回 0 条——它不索引三字以下的 token，
    // 而中文双字词是最常见的查询形态。整个 bigram 方案就是为这一条存在的。
    let db = indexed();
    let found = paths(search(&db, "营销", 10).unwrap());
    assert_eq!(found.len(), 2, "{found:?}");
    assert!(found.contains(&"资料-人物志.md".to_string()));
}

#[test]
fn a_name_is_findable_by_any_part_of_it() {
    // 作者笔下的人名不在任何词典里。jieba 会把「陆沉舟」切成「陆/沉舟」，
    // 搜「沉舟」就找不到——bigram 没有这个问题。
    let db = indexed();
    assert_eq!(paths(search(&db, "沉舟", 10).unwrap()).len(), 3);
    assert_eq!(paths(search(&db, "陆沉舟", 10).unwrap()).len(), 3);
}

#[test]
fn ranking_puts_the_title_match_first() {
    // 搜「停留」，标题里有它的那一篇该排最前。path 列权重是 body 的四倍。
    //
    // 断言必须让「只在标题里」与「只在正文里」正面相撞：第一版拿一篇标题与正文
    // 都含该词的文档来试，于是把权重从 4.0 改成 1.0 它照样通过——两条路都指向
    // 同一篇，权重差别无从显现。
    let mut db = open_in_memory().unwrap();
    ProjectDb::migrate(&mut db).unwrap();
    // 正文提了三次，标题没有。
    index_document(&db, "别的章.md", "a", "远行，远行，还是远行。").unwrap();
    // 标题里有，正文没有。
    index_document(&db, "远行.md", "b", "什么都没写。").unwrap();

    let found = paths(search(&db, "远行", 10).unwrap());
    assert_eq!(
        found.first().map(String::as_str),
        Some("远行.md"),
        "标题命中应当压过正文里的三次提及：{found:?}"
    );
}

#[test]
fn latin_still_works() {
    let db = indexed();
    assert_eq!(
        paths(search(&db, "brown", 10).unwrap()),
        vec!["notes-english.md"]
    );
}

#[test]
fn exact_requires_every_part_and_loose_does_not() {
    // 这是两种模式存在的全部理由。「营销总监」只有人物志那篇完整写过；
    // 而「营销」「销总」「总监」分开看，长夜那篇也有一部分。
    let db = indexed();
    let exact = paths(search_with(&db, "营销总监", Precision::Exact, 10).unwrap());
    let loose = paths(search_with(&db, "营销总监", Precision::Loose, 10).unwrap());
    assert_eq!(exact, vec!["资料-人物志.md"]);
    assert!(loose.len() > exact.len(), "宽松模式应当召回更多：{loose:?}");
    assert!(loose.contains(&"资料-人物志.md".to_string()));
}

#[test]
fn the_default_is_exact() {
    let db = indexed();
    assert_eq!(
        paths(search(&db, "营销总监", 10).unwrap()),
        paths(search_with(&db, "营销总监", Precision::Exact, 10).unwrap())
    );
}

#[test]
fn a_phrase_nobody_wrote_finds_nothing_in_exact_mode() {
    // 真实语料上 OR 对这类查询返回 500 条噪音，AND 返回 21 条。
    let db = indexed();
    assert!(paths(search(&db, "量子力学", 10).unwrap()).is_empty());
}

#[test]
fn an_empty_query_is_no_results_not_an_error() {
    // FTS5 对空 MATCH 表达式报错。空查询的正确答案是零条，不是崩溃。
    let db = indexed();
    assert!(search(&db, "", 10).unwrap().is_empty());
    assert!(search(&db, "   ", 10).unwrap().is_empty());
    assert!(search(&db, "，。！", 10).unwrap().is_empty());
}

#[test]
fn reindexing_unchanged_text_does_nothing() {
    // 摘要没变就不重建。打开一个一百章的项目、其中一章改过，只该重写一条。
    let db = indexed();
    assert!(!index_document(&db, "第一章-停留.md", "d1", "随便什么内容").unwrap());
}

#[test]
fn a_changed_document_replaces_its_old_text() {
    // 旧正文必须消失，否则索引会答出作者已经删掉的句子。
    //
    // 断言用的是只出现在正文里的词。第一版拿「停留」来试，而它同时在文件名里，
    // 于是测试红了却不是因为缺陷——路径本来就该继续匹配。
    let db = indexed();
    index_document(&db, "第一章-停留.md", "d1-new", "全新的内容。").unwrap();
    let gone = paths(search(&db, "纸面", 10).unwrap());
    assert!(!gone.contains(&"第一章-停留.md".to_string()), "{gone:?}");
    assert!(!paths(search(&db, "全新", 10).unwrap()).is_empty());
    // 标题没变，所以按标题仍找得到——这正是路径与正文分列的意义。
    assert!(paths(search(&db, "停留", 10).unwrap()).contains(&"第一章-停留.md".to_string()));
}

#[test]
fn forgetting_a_document_removes_it_from_results() {
    let db = indexed();
    assert!(forget_document(&db, "资料-人物志.md").unwrap());
    let found = paths(search(&db, "营销", 10).unwrap());
    assert!(!found.contains(&"资料-人物志.md".to_string()), "{found:?}");
    // 再忘一次不该报错，也不该说自己做了事。
    assert!(!forget_document(&db, "资料-人物志.md").unwrap());
}

#[test]
fn relevance_is_larger_is_better() {
    // FTS5 的 bm25 是越小越好，这一层已经翻过符号，与 search_rank 的口径一致。
    let db = indexed();
    let hits = search(&db, "陆沉舟", 10).unwrap();
    assert!(hits.iter().all(|hit| hit.relevance > 0.0), "{hits:?}");
    for pair in hits.windows(2) {
        assert!(pair[0].relevance >= pair[1].relevance, "{hits:?}");
    }
}

#[test]
fn the_limit_is_respected() {
    let db = indexed();
    assert_eq!(search(&db, "陆沉舟", 1).unwrap().len(), 1);
}
