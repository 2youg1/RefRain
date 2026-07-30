//! 检索的生命周期：作者写下的字，什么时候变成能搜到的。
//!
//! 检索层本身的正确性在 `search.rs` 的测试里。这一份问的是另一件事——
//! 索引有没有跟上作者的动作。它此前完全没有覆盖，而缺口是真的：
//! 采纳一个已经写好的项目后，正文与标题**都搜不到任何东西**，因为索引
//! 只在打开或保存单个文档时才建，而采纳既不打开也不保存。

use refrain_store::project::{DocumentCommit, ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let unique = format!(
        "refrain-search-life-{}-{}-{}",
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

fn adopt(root: &Path) -> (Connection, ProjectStore) {
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

/// 作者会看到的结果：检索 + 排序 + 目录过滤。
fn found(store: &mut ProjectStore, query: &str) -> Vec<String> {
    store
        .search_documents(query, 20)
        .unwrap()
        .into_iter()
        .map(|document| document.path)
        .collect()
}

/// 索引自身的实况，不经目录过滤。
fn indexed(store: &mut ProjectStore, query: &str) -> Vec<String> {
    store.indexed_paths(query, 20).unwrap()
}

#[test]
fn adopting_a_manuscript_makes_its_prose_searchable() {
    // 作者带着已经写好的稿子来。他从没在本程序里打开过任何一章，
    // 而他要做的第一件事往往就是搜自己写过的一句话。
    let root = scratch();
    fs::write(root.join("第三章.md"), "陆沉舟站在窗前，想起营销那件事。\n").unwrap();
    fs::write(root.join("第四章.md"), "第二天他没有再提。\n").unwrap();

    let (app, mut store) = adopt(&root);
    store.refresh_documents().unwrap();

    // 「营销」只出现在正文里，标题不含它——这正是旧的 LIKE 路径搜不到的东西。
    assert_eq!(found(&mut store, "营销"), ["第三章.md"]);
    assert_eq!(found(&mut store, "第三章"), ["第三章.md"]);

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_title_outranks_a_body_that_merely_mentions_it() {
    // BM25 单独会把「提了三次的正文」排在「就叫这个名字的那一章」之前，
    // 这是正确的信息检索、对作者无用。
    //
    // 这条测的是**两层的合力**：FTS5 的列权重（标题 ×16）已能排对多数这类
    // 情形，抹掉排序层它仍然绿。只有排序层能答的问题在下一条。
    let root = scratch();
    fs::write(root.join("长夜.md"), "他睡不着。\n").unwrap();
    fs::write(root.join("别的章.md"), "长夜，长夜，还是长夜，长夜漫漫。\n").unwrap();

    let (app, mut store) = adopt(&root);
    store.refresh_documents().unwrap();

    let hits = found(&mut store, "长夜");
    assert_eq!(
        hits.first().map(String::as_str),
        Some("长夜.md"),
        "标题命中必须排在正文重复之前，实际次序：{hits:?}"
    );

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_exact_title_outranks_a_title_that_merely_contains_the_query() {
    // 只有排序层答得了这个，语料是实测挑出来的：
    //
    //   FTS5 次序 = ["长夜之后.md", "长夜.md"]   ← 错的
    //   排序后    = ["长夜.md", "长夜之后.md"]   ← 对的
    //
    // FTS5 两篇的标题都命中、给同一个列权重，然后按正文长度惩罚——于是
    // 正文越长排得越后，而《长夜》恰恰是作者写得最多的那一章。它分不出
    // 「就叫这个名字」与「名字里有这几个字」，`PathMatch::Exact`(10) 与
    // `Contains`(6) 的差就是这条断言的全部内容。
    //
    // 选这个语料是有意的：把正文长度调成接近，两层会给出同一答案，断言
    // 便测不出排序层——抹掉 rank_top 它照样绿。测两层的合力见上一条。
    let root = scratch();
    fs::write(
        root.join("长夜.md"),
        "长夜降临。长夜降临。长夜降临。长夜降临。长夜降临。长夜降临。长夜降临。长夜降临。\n",
    )
    .unwrap();
    fs::write(root.join("长夜之后.md"), "短。\n").unwrap();

    let (app, mut store) = adopt(&root);
    store.refresh_documents().unwrap();

    // 先钉住前提：检索层自己确实排错了。否则这条断言可能只是在复述 FTS5。
    assert_eq!(
        indexed(&mut store, "长夜").first().map(String::as_str),
        Some("长夜之后.md"),
        "前提不成立：FTS5 已经排对了，这条语料测不出排序层"
    );

    let hits = found(&mut store, "长夜");
    assert_eq!(
        hits.first().map(String::as_str),
        Some("长夜.md"),
        "标题恰为查询的那一章必须排第一，实际次序：{hits:?}"
    );

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn saving_replaces_what_the_index_says_about_a_document() {
    // 作者改了一段话。旧句子必须不再被搜到——否则检索会把已经不存在的
    // 文字指给他，而他会去那一章里找一句他刚删掉的话。
    let root = scratch();
    let chapter = root.join("第五章.md");
    fs::write(&chapter, "初稿里写着黄昏。\n").unwrap();

    let (app, mut store) = adopt(&root);
    store.refresh_documents().unwrap();
    assert_eq!(found(&mut store, "黄昏"), ["第五章.md"]);

    store
        .commit(&DocumentCommit {
            path: "第五章.md".to_string(),
            bytes: "改后写的是黎明。\n".as_bytes().to_vec(),
            expected: None,
        })
        .unwrap();

    assert!(
        found(&mut store, "黄昏").is_empty(),
        "删掉的句子仍能搜到：{:?}",
        found(&mut store, "黄昏")
    );
    assert_eq!(found(&mut store, "黎明"), ["第五章.md"]);

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_deleted_chapter_leaves_the_index_with_it() {
    // 文件在程序之外被删掉。索引必须跟着放手。
    //
    // 这条断言必须**直接问索引**，不能问 `search_documents`：后者只返回
    // 目录里仍有行的文档，于是索引即使留着已删的章，读取端也会把它滤掉，
    // 断言照样绿。那不是安全，是泄漏被掩盖——倒排表会随每次删除单调增长，
    // 而任何直接读索引的人（工单取数层就要这么读）都会拿到不存在的稿子。
    let root = scratch();
    fs::write(
        root.join("将被删除.md"),
        "这里写过一句独一无二的话：鹈鹕。\n",
    )
    .unwrap();
    fs::write(root.join("留下.md"), "另一章的正文。\n").unwrap();

    let (app, mut store) = adopt(&root);
    store.refresh_documents().unwrap();
    assert_eq!(indexed(&mut store, "鹈鹕"), ["将被删除.md"]);

    fs::remove_file(root.join("将被删除.md")).unwrap();
    store.refresh_documents().unwrap();

    assert!(
        indexed(&mut store, "鹈鹕").is_empty(),
        "已删除的章仍在倒排索引里：{:?}",
        indexed(&mut store, "鹈鹕")
    );
    // 留下的那一章不受牵连——删除必须是精确的，不是清空重建。
    assert_eq!(indexed(&mut store, "另一章"), ["留下.md"]);

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_search_before_any_refresh_still_finds_the_manuscript() {
    // 索引的新鲜度曾用 `indexed == reconciled` 判断，而两者都是 Option——
    // **一个从未对账过的 store 会认为索引已就绪**，于是搜一个空索引并回答
    // 「这份稿子里什么都没有」。改成必须由一次成功构建来置位的布尔之后，
    // 这条路径才成立。
    //
    // 触发它不需要人为构造：单文件 Root 打开后直接搜，就是这个形状。
    let root = scratch();
    fs::write(root.join("独章.md"), "陆沉舟想起营销那件事。\n").unwrap();

    let (app, mut store) = adopt(&root);
    // 注意：这里**没有** refresh_documents()。
    store.open_document("独章.md").unwrap();

    assert_eq!(
        found(&mut store, "营销"),
        ["独章.md"],
        "还没对账过就检索，必须照样找得到"
    );

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}
