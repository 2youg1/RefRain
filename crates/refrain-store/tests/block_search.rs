// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 块级检索：命中指回的是哪一段，以及删除路径会不会毁掉索引。
//!
//! 这些测试与 `search.rs` 分开，因为它们要的语料不同。`search.rs` 的每份
//! 文档都是一段短文——足以验证中文能不能搜到，但**整篇即一块**，于是
//! 「按块索引」与「按文档索引」在那份语料上给出完全相同的答案。实测过：
//! 把切分改成 `take(1)`（整篇一块）、把删除的 replay 改成传空字符串，
//! 那 13 个测试全绿。一个不能让被测对象失败的夹具认证不了任何东西。
//!
//! 所以这里的每份文档都有多个块，且块类型各不相同。

use refrain_core::block_shape::{BlockKind, HeadingLevel};
use refrain_core::searchable_block::block_at;
use refrain_store::Database;
use refrain_store::project::search::{IndexedBlock, forget_document, index_document, search};
use refrain_store::schema::{ProjectDb, open_in_memory};
use rusqlite::Connection;

/// 一份有四个块的文档：标题、正文、围栏、正文。
const CHAPTER: &str = "# 第三章 停留\n\n\
    写作是把尚未成形的东西按住，让它在纸面上停留得够久。\n\n\
    ```rust\n\
    let 营销 = \"这个词出现在围栏里\";\n\
    ```\n\n\
    陆沉舟站在窗前，想起白天那句关于营销的话。";

const MATERIAL: &str = "# 人物志\n\n\
    陆沉舟，四十二岁，前营销总监。\n\n\
    ## 习惯\n\n\
    习惯在纸上写字，不用电脑。";

fn indexed() -> Connection {
    let mut db = open_in_memory().unwrap();
    ProjectDb::migrate(&mut db).unwrap();
    index_document(&db, "第三章.md", "d1", CHAPTER).unwrap();
    index_document(&db, "资料-人物志.md", "d2", MATERIAL).unwrap();
    db
}

fn source_of(path: &str) -> &'static str {
    match path {
        "第三章.md" => CHAPTER,
        "资料-人物志.md" => MATERIAL,
        other => panic!("unknown fixture {other}"),
    }
}

/// 判据 1-3：检索返回的每条片段都能被精确取回，字节相等。
///
/// 这是块级索引存在的全部理由——Agent 拿到的必须是能引用回去的一段，
/// 而不是「第三章相关」。
#[test]
fn every_hit_seeks_back_to_the_exact_bytes_it_matched() {
    let db = indexed();
    let hits = search(&db, "营销", 20).unwrap();
    assert!(!hits.is_empty(), "查询应有命中");

    for hit in &hits {
        let source = source_of(&hit.path);
        let block = block_at(
            source,
            hit.ordinal,
            refrain_core::DocumentFormat::of_path(&hit.path).block_scan(),
        )
        .expect("ordinal 应能定位到块");

        // 索引记的字节范围与真实取回的必须逐字节相同。
        assert_eq!(block.start, hit.start_byte as usize, "{hit:?}");
        assert_eq!(block.text.len(), hit.bytes as usize, "{hit:?}");
        assert_eq!(
            &source[hit.start_byte as usize..(hit.start_byte + hit.bytes) as usize],
            block.text,
            "{hit:?}"
        );
        // 取回的那一段必须真的含查询词——否则「指回块」只是指回了某个块。
        assert!(block.text.contains("营销"), "取回的块应含查询词: {block:?}");
    }
}

/// 同一份文档的不同段落是各自独立的命中，而不是一条文档级命中。
///
/// 这一条直接对着「整篇一块」的注入：文档级索引下 `ordinal` 恒为 0，
/// 一份文档至多一条命中。
#[test]
fn one_document_yields_one_hit_per_matching_block() {
    let db = indexed();
    let hits = search(&db, "营销", 20).unwrap();
    let chapter: Vec<&IndexedBlock> = hits.iter().filter(|hit| hit.path == "第三章.md").collect();

    // 「营销」在第三章出现两次：一次在围栏里，一次在最后一段。
    assert_eq!(chapter.len(), 2, "应是两条独立的块级命中: {chapter:?}");
    let ordinals: Vec<u32> = chapter.iter().map(|hit| hit.ordinal).collect();
    assert_ne!(ordinals[0], ordinals[1], "两条命中应指向不同的块");
}

/// 块类型是索引记下的事实，不是猜的。
///
/// 排序层的 `HEADING` 信号在文档级索引下永远拿不到——`catalog.rs` 里那句
/// 「claiming Heading would award structure this layer never observed」
/// 正是这个缺口的自白。
#[test]
fn a_hit_carries_the_kind_of_block_it_landed_in() {
    let db = indexed();
    let heading = search(&db, "人物志", 20)
        .unwrap()
        .into_iter()
        .find(|hit| hit.path == "资料-人物志.md" && hit.ordinal == 0)
        .expect("标题块应被命中");
    assert_eq!(
        heading.kind,
        BlockKind::Heading(HeadingLevel::from_level(1).expect("1 is a level"))
    );

    // The level has to survive the round trip through SQLite, not merely exist
    // in memory: the outline is rebuilt from the index, so a level that is
    // written and not read back leaves every heading looking top-level. This
    // material has both a `#` and a `##`, and they must come back different.
    let nested = search(&db, "习惯", 20)
        .unwrap()
        .into_iter()
        .find(|hit| hit.path == "资料-人物志.md" && hit.kind != BlockKind::Paragraph)
        .expect("二级标题块应被命中");
    assert_eq!(
        nested.kind,
        BlockKind::Heading(HeadingLevel::from_level(2).expect("2 is a level")),
        "a `##` heading must read back as level 2, not as a bare heading"
    );

    let fence = search(&db, "这个词出现在围栏里", 20)
        .unwrap()
        .into_iter()
        .find(|hit| hit.path == "第三章.md")
        .expect("围栏块应被命中");
    assert_eq!(fence.kind, BlockKind::Fence);
}

/// 判据 1-5：删除必须 replay 精确插入过的文本。
///
/// 传空字符串不会报错。FTS5 拿你给的文本重新分词去找要删的 posting，
/// 给错文本就删错东西——**该删的留下、不该删的被删**。
///
/// 这条断言换过三次才立住，三次失败都值得记，因为它们是三种不同的假绿：
///
/// 一、断言「删掉的文档不再出现」——注入空删仍绿。
/// 二、换成两份文档共有的查询词——仍绿。
/// 三、改用 FTS5 的 `integrity-check`——**仍绿**。第三次最值得记：
///     `integrity-check` 比对倒排索引与**外部内容**，而 `content=''`
///     的表根本没有外部内容可比对，于是它对这类损坏结构性失明。
///
/// 探针下才看清真相：正确实现删后 FTS 内只剩 `rowid [5,6,7,8]`（幸存
/// 文档的四个块），空删则剩 `[4,5,6,7,8]`——4 是被删文档的最后一块，
/// 它的 posting 仍在。而前两次之所以查不出来，是因为 bigram 把查询拆成
/// 双字，恰好没命中那条残留。**症状会挑语料，残留不会。**
///
/// 所以这里直接问 FTS：删除之后，索引里还有没有属于这份文档的 rowid。
#[test]
fn forgetting_a_document_removes_every_block_and_leaves_the_index_intact() {
    let db = indexed();

    // 被删文档占用的 rowid，删之前先记下来。
    let doomed: Vec<i64> = {
        let mut statement = db
            .prepare("SELECT rowid_of FROM block_search_state WHERE document = ?1")
            .unwrap();
        statement
            .query_map(["第三章.md"], |row| row.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    };
    assert!(doomed.len() >= 2, "夹具应有多块文档: {doomed:?}");

    assert!(forget_document(&db, "第三章.md").unwrap());

    // 靶心：FTS 里不得再有任何属于这份文档的 rowid。
    // 用一个覆盖面很宽的查询把索引里还活着的 rowid 全捞出来。
    let alive: Vec<i64> = {
        let mut statement = db
            .prepare(
                "SELECT rowid FROM block_search
                 WHERE block_search MATCH '陆沉 OR 习惯 OR 人物 OR 写作 OR 营销 OR 停留'",
            )
            .unwrap();
        statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    };
    for rowid in &doomed {
        assert!(
            !alive.contains(rowid),
            "被删文档的 rowid {rowid} 仍在索引里: alive={alive:?}"
        );
    }

    // 删掉的文档一条都不剩。
    let after = search(&db, "陆沉舟", 20).unwrap();
    assert!(
        after.iter().all(|hit| hit.path != "第三章.md"),
        "删掉的文档仍有命中: {after:?}"
    );

    // 未被删除的文档完好无损。
    assert!(
        after.iter().any(|hit| hit.path == "资料-人物志.md"),
        "未被删除的文档应仍可检索: {after:?}"
    );

    // 逐块复核幸存文档：每条命中仍能指回真实字节。
    for hit in &after {
        let block = block_at(
            source_of(&hit.path),
            hit.ordinal,
            refrain_core::DocumentFormat::of_path(&hit.path).block_scan(),
        )
        .expect("幸存块应仍可定位");
        assert_eq!(block.text.len(), hit.bytes as usize);
    }
}

/// 重新索引一份改过的文档，旧块不残留。
///
/// 一次编辑会改变块的数量，所以「更新第 3 行」没有意义——旧块必须整体退场。
#[test]
fn reindexing_a_changed_document_leaves_no_stale_blocks() {
    let db = indexed();
    let before = search(&db, "营销", 20).unwrap().len();
    assert!(before >= 3);

    index_document(
        &db,
        "第三章.md",
        "d1-new",
        "# 第三章\n\n全新的内容，没有那个词。",
    )
    .unwrap();

    let after = search(&db, "营销", 20).unwrap();
    assert!(
        after.iter().all(|hit| hit.path != "第三章.md"),
        "改写后旧块仍在: {after:?}"
    );
    // 幸存文档不受影响。
    assert!(after.iter().any(|hit| hit.path == "资料-人物志.md"));

    // 新内容可被搜到，且 ordinal 从头编号。
    let fresh = search(&db, "全新", 20).unwrap();
    assert_eq!(fresh.len(), 1);
    assert_eq!(fresh[0].path, "第三章.md");
    assert_eq!(fresh[0].ordinal, 1, "新文档的第二块");
}

/// 摘要未变则不重建：块级之后这条依然要成立，否则灌库预算被击穿。
#[test]
fn an_unchanged_document_is_not_reindexed() {
    let db = indexed();
    assert!(!index_document(&db, "第三章.md", "d1", CHAPTER).unwrap());
}
