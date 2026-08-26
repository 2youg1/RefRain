use std::fs;

use refrain_core::Id;

use super::{DocumentPageQuery, ProjectStore, fingerprint_of};
use crate::project::RootLocator;
use crate::root::RootKind;
use crate::schema::{AppDb, Database};
use refrain_core::chinese_index::Precision;

#[test]
fn catalog_identity_ignores_scan_order_and_generated_ids() {
    let first = [
        ["id-1".into(), "甲.md".into(), "chapter".into()],
        ["id-2".into(), "资料/乙.md".into(), "material".into()],
    ];
    let reversed_with_new_ids = [
        ["id-3".into(), "资料/乙.md".into(), "material".into()],
        ["id-4".into(), "甲.md".into(), "chapter".into()],
    ];

    assert_eq!(
        fingerprint_of(&first),
        fingerprint_of(&reversed_with_new_ids)
    );
}

/// A real membership change must alter the identity; otherwise the previous
/// test would also pass for a constant function.
#[test]
fn duplicate_paths_would_cancel_out_so_the_scan_must_not_produce_them() {
    // 这条不是在测 fingerprint_of 的正确性，而是钉住它依赖的那个前提。
    //
    // 指纹用异或合并各条目的哈希，好处是与扫描顺序无关（目录遍历次序由文件系统
    // 决定，不能依赖），代价是它对成对出现的相同条目不敏感——两次会互相抵消。
    // 因此如果哪天扫描开始吐重复路径，指纹会把「多了一对重复」看成「什么都没变」。
    //
    // 前提成立的依据：reconcile_documents 把扫描结果灌进 refreshed_documents，
    // 那张表以 path 作 PRIMARY KEY，重复路径根本进不去；documents 表同样以 path
    // 为唯一键。这条测试把「一对重复会抵消」这个事实写在明处，使前提一旦被打破
    // 就有人看得见，而不是留一句注释里的断言。
    let doubled = [
        ["id-1".into(), "甲.md".into(), "chapter".into()],
        ["id-2".into(), "甲.md".into(), "chapter".into()],
    ];
    assert_eq!(super::fingerprint_of(&doubled), [0u8; 32]);
}

#[test]
fn catalog_identity_follows_every_real_change() {
    let base = [
        ["id-1".into(), "甲.md".into(), "chapter".into()],
        ["id-2".into(), "资料/乙.md".into(), "material".into()],
    ];
    let identity = fingerprint_of(&base);

    let renamed: [[String; 3]; 2] = [
        ["id-1".into(), "甲改.md".into(), "chapter".into()],
        ["id-2".into(), "资料/乙.md".into(), "material".into()],
    ];
    let re_roled: [[String; 3]; 2] = [
        ["id-1".into(), "甲.md".into(), "material".into()],
        ["id-2".into(), "资料/乙.md".into(), "material".into()],
    ];
    let removed: [[String; 3]; 1] = [["id-1".into(), "甲.md".into(), "chapter".into()]];
    let added: [[String; 3]; 3] = [
        ["id-1".into(), "甲.md".into(), "chapter".into()],
        ["id-2".into(), "资料/乙.md".into(), "material".into()],
        ["id-3".into(), "丙.md".into(), "chapter".into()],
    ];

    assert_ne!(
        identity,
        fingerprint_of(&renamed),
        "rename was not observed"
    );
    assert_ne!(
        identity,
        fingerprint_of(&re_roled),
        "role change was not observed"
    );
    assert_ne!(
        identity,
        fingerprint_of(&removed),
        "removal was not observed"
    );
    assert_ne!(
        identity,
        fingerprint_of(&added),
        "addition was not observed"
    );
}

/// An unchanged tree must not write another row.
///
/// `total_changes()` counts rows written by this connection and does not
/// benefit from SQLite's page cache. It therefore proves the skip directly.
#[test]
fn an_unchanged_catalog_skips_sql_reconciliation() {
    let root = std::env::temp_dir().join(format!("refrain-catalog-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("chapter.md"), "Text.\n").unwrap();
    let mut app = crate::schema::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();

    store
        .refresh_document_page(DocumentPageQuery {
            after: None,
            limit: 1,
        })
        .unwrap();
    let first_changes = store.db.total_changes();
    store
        .refresh_document_page(DocumentPageQuery {
            after: None,
            limit: 1,
        })
        .unwrap();

    assert_eq!(store.db.total_changes(), first_changes);
    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

/// 块级搜索返回的是**文本**，不只是路径。
///
/// 钉住的失败：搜索结果面板只能显示文件路径，而查询词不在路径里——「高亮
/// 查询词」在那个形状下无处可高亮。`search_documents_with` 把每个命中折叠
/// 成它所属的文档，正是那次折叠丢掉了这两个事实。
#[test]
fn block_search_returns_the_text_that_matched() {
    let root = std::env::temp_dir().join(format!("refrain-blocksearch-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("章.md"),
        "第一段讲的是别的事情。\n\n第二段里有风景的发现这个说法。\n",
    )
    .unwrap();
    let mut app = crate::schema::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();

    // 目录先进表：`index_catalog` 从 `documents` 读路径，而 `adopt` 只认领
    // Root，不扫文件。少这一步索引里一条都没有，搜索恒空。
    store
        .refresh_document_page(DocumentPageQuery {
            after: None,
            limit: 16,
        })
        .unwrap();

    let hits = store
        .search_blocks_with("风景的发现", Precision::Exact, 10)
        .unwrap();

    assert!(!hits.is_empty(), "块级搜索一条都没返回");
    let first = &hits[0];
    // 这是整条改动的意义：拿到了文本，所以有东西可高亮。
    assert!(
        first.text.contains("风景的发现"),
        "返回的块文本里没有查询词：{:?}",
        first.text
    );
    // 命中的是第二段，不是整份文档——折叠若还在，这里会拿到第一段或全文。
    assert!(
        !first.text.contains("第一段"),
        "返回的是整份文档而不是命中的那一块：{:?}",
        first.text
    );
    // `start_byte` 是这条命中可导航的全部理由。
    assert!(first.start_byte > 0, "第二段的偏移不该是 0");

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

/// 索引比磁盘旧时不能崩。
///
/// 偏移来自一份可能早于作者最后一次按键的索引。在不再是字符边界的位置切片
/// 会 panic——而作者只是打了个字。这条测试把文件改短再搜，走的正是那条路。
#[test]
fn stale_offsets_are_skipped_not_panicked_on() {
    let root = std::env::temp_dir().join(format!("refrain-staleoffset-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    let file = root.join("章.md");
    fs::write(
        &file,
        "第一段。\n\n第二段里有风景的发现这个说法，后面还有很长很长的一段话。\n",
    )
    .unwrap();
    let mut app = crate::schema::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    // 先让目录进表再建索引。
    store
        .refresh_document_page(DocumentPageQuery {
            after: None,
            limit: 16,
        })
        .unwrap();
    store
        .search_blocks_with("风景的发现", Precision::Exact, 10)
        .unwrap();

    // 磁盘上的文件变短，索引里的偏移随即越界。
    fs::write(&file, "短。\n").unwrap();
    let hits = store.search_blocks_with("风景的发现", Precision::Exact, 10);

    // 不崩即通过。返回空还是返回别的都可以接受——重点是它没有 panic。
    assert!(hits.is_ok(), "索引比磁盘旧时报错了：{hits:?}");

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

/// 精确查无结果时回退宽松——两条 UI 检索路径与 Agent 路径同一条规矩。
///
/// 语料里没有人写过「营销渠道」连在一起的形状，只有拆开的一半在两篇里
/// 各出现一次：精确（AND）恒空，宽松（OR）能答。回退若不存在，这两条
/// 断言都会拿到空结果。
#[test]
fn an_exact_miss_falls_back_to_loose_on_both_ui_search_paths() {
    let root = std::env::temp_dir().join(format!("refrain-fallback-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("人物志.md"),
        "陆沉舟，前营销总监。习惯在纸上写字。\n",
    )
    .unwrap();
    fs::write(root.join("长夜.md"), "长夜将尽。营销这个词他一向不喜欢。\n").unwrap();
    let mut app = crate::schema::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    store
        .refresh_document_page(DocumentPageQuery {
            after: None,
            limit: 16,
        })
        .unwrap();

    let documents = store
        .search_documents_with("营销渠道", Precision::Exact, 10)
        .unwrap();
    assert!(!documents.is_empty(), "精确恒空的查询应当由宽松回退答出");
    let blocks = store
        .search_blocks_with("营销渠道", Precision::Exact, 10)
        .unwrap();
    assert!(!blocks.is_empty(), "块级路径同一条回退规矩");

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

/// 精确有结果时不回退：「营销总监」在人物志里完整出现，长夜里只有
/// 「营销」半个词。回退若点火，结果里会多出长夜——这条测试的语料
/// 让两条路给出可数的两份不同答案。
#[test]
fn an_exact_hit_never_widens() {
    let root = std::env::temp_dir().join(format!("refrain-nofallback-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("人物志.md"),
        "陆沉舟，前营销总监。习惯在纸上写字。\n",
    )
    .unwrap();
    fs::write(root.join("长夜.md"), "长夜将尽。营销这个词他一向不喜欢。\n").unwrap();
    let mut app = crate::schema::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    store
        .refresh_document_page(DocumentPageQuery {
            after: None,
            limit: 16,
        })
        .unwrap();

    let documents = store
        .search_documents_with("营销总监", Precision::Exact, 10)
        .unwrap();
    let paths: Vec<&str> = documents.iter().map(|row| row.path.as_str()).collect();
    assert_eq!(paths, vec!["人物志.md"], "宽松回退会多长夜.md: {paths:?}");

    let blocks = store
        .search_blocks_with("营销总监", Precision::Exact, 10)
        .unwrap();
    assert!(!blocks.is_empty());
    assert!(
        blocks.iter().all(|hit| hit.path == "人物志.md"),
        "块级路径同样不许宽出精确的答案: {blocks:?}"
    );

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

/// 落点四条规则各验一次。
///
/// 「打开一个项目」承诺的是作者看见自己的字（D10 / F-28）；这里钉的是决定
/// 落在哪一份的那条规则，而不是外壳怎么用它。
#[test]
fn a_folder_root_lands_on_the_first_chapter_and_then_on_the_remembered_one() {
    let root = std::env::temp_dir().join(format!("refrain-landing-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("乙.md"), "第二章。\n").unwrap();
    fs::write(root.join("甲.md"), "第一章。\n").unwrap();
    let mut app = crate::schema::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();

    // 没有记录时按目录序取第一篇 Chapter。
    assert_eq!(store.landing_document().unwrap().as_deref(), Some("乙.md"));

    // 记下来之后回到作者上次写的那一份，而不是回到目录序第一篇。
    store.remember_landing("甲.md").unwrap();
    assert_eq!(store.landing_document().unwrap().as_deref(), Some("甲.md"));

    // 记录指向的文件不在名录里时回到第一篇，而不是回到空白。
    store.remember_landing("已删除.md").unwrap();
    assert_eq!(store.landing_document().unwrap().as_deref(), Some("乙.md"));

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_single_file_root_lands_on_that_file() {
    let root = std::env::temp_dir().join(format!("refrain-landing-file-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    let file = root.join("独立稿.md");
    fs::write(&file, "正文。\n").unwrap();
    let mut app = crate::schema::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: file,
            kind: RootKind::File,
        },
    )
    .unwrap();

    assert_eq!(
        store.landing_document().unwrap().as_deref(),
        Some("独立稿.md"),
        "单文件 Root 必须落在刚选的那一份，不能靠名录第一行去猜"
    );

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

/// 空工作区只有一个正当理由：项目确实没有 Chapter。
#[test]
fn a_project_without_a_chapter_has_no_landing() {
    let root = std::env::temp_dir().join(format!("refrain-landing-empty-{}", Id::new()));
    fs::create_dir_all(root.join("资料")).unwrap();
    fs::write(root.join("资料/参考.md"), "只是资料。\n").unwrap();
    let mut app = crate::schema::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();

    assert_eq!(store.landing_document().unwrap(), None);

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

/// 一次半途失败的建索引，不许在索引里留下任何人够不着的 posting。
///
/// `index_document` 每块写两条记录（`block_search` 一条 posting、
/// `block_search_state` 一条位置），文档摘要最后写。第 N 块失败时前 N-1 块的
/// posting 已经在表里，而状态表与摘要表都不知道它们：
///
/// - `forget_document` 按状态表持有的 rowid 删，够不着它们；
/// - `next_rowid` 从同一张状态表数，下一次重试**发出同一批 rowid**；
/// - 一个 rowid 写两次会答成两段，且没有任何一次删除能清掉旧的那条
///   （实测：`tests/contentless_delete_probe.rs`）。
///
/// 于是一次中断的建索引让作者搜到一句手稿里已经没有的话——正是
/// `project/search.rs` 开篇声明要防的那件事。
///
/// 失败用触发器注入：它是这台机器上真实的 SQLite 行为，不是一个假的
/// `Connection`，所以「重试一次」走的也是真实的那条路。跑两轮，因为残留的
/// 代价要到第二轮重发同一批 rowid 时才结清。
#[test]
fn a_document_that_fails_halfway_leaves_nothing_in_the_index() {
    let root = std::env::temp_dir().join(format!("refrain-index-atomicity-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("中断.md"),
        "# 停留\n\n写作是把尚未成形的东西按住。\n\n\
         陆沉舟站在窗前，想起白天那句关于蜃景的话。\n\n\
         第四段在这里，好让中断发生在文档中间而不是末尾。\n",
    )
    .unwrap();
    fs::write(
        root.join("完好.md"),
        "# 人物志\n\n陆沉舟，四十二岁。\n\n习惯在纸上写字。\n",
    )
    .unwrap();

    let mut app = crate::schema::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();

    // 第三块（ordinal 2）落状态表时中止，且只对那一份文档。到那一刻，前两块
    // 的 posting 已经写进 block_search 了。
    store
        .db
        .execute_batch(
            "CREATE TRIGGER interrupt_third_block
                 BEFORE INSERT ON block_search_state
                 WHEN NEW.ordinal = 2 AND NEW.document LIKE '%中断%'
             BEGIN SELECT RAISE(ABORT, 'injected mid-document failure'); END;",
        )
        .unwrap();

    store.refresh_documents().unwrap();
    store.refresh_documents().unwrap();

    let leaked = store
        .search_blocks_with("蜃景", Precision::Exact, 20)
        .unwrap();
    assert!(
        leaked.is_empty(),
        "索引答出了 {} 段状态表够不着的正文；一次中断的建索引留下了残留",
        leaked.len()
    );

    // 而没被中断的那份仍然可搜：跳过一份文档不该让整份语料失去索引。
    let intact = store
        .search_blocks_with("人物志", Precision::Exact, 20)
        .unwrap();
    assert!(!intact.is_empty(), "未受影响的文档必须仍然可搜");

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}
