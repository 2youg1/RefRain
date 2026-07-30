//! Release-scale regression for ProjectStore document registration.
//!
//! Run with:
//! `cargo test --release -p refrain-store --test project_performance -- --nocapture`

use refrain_core::DocumentRole;
use refrain_store::project::{
    DocumentPageQuery, MAX_DOCUMENT_PAGE_SIZE, MAX_DOCUMENT_SEARCH_RESULTS, ProjectStore,
    RootLocator,
};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

const DOCUMENT_COUNT: usize = 100_000;
const FILES_PER_DIRECTORY: usize = 100;
const WARM_RUNS: usize = 20;

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let unique = format!(
        "refrain-project-performance-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos()),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let root = std::env::temp_dir().join(unique);
    fs::create_dir_all(&root).unwrap();
    root
}

fn large_project() -> PathBuf {
    let root = scratch();
    let directories = DOCUMENT_COUNT.div_ceil(FILES_PER_DIRECTORY);
    for directory in 0..directories {
        let section = root.join(format!("资料-{directory:04}"));
        fs::create_dir(&section).unwrap();
        for file in 0..FILES_PER_DIRECTORY {
            let index = directory * FILES_PER_DIRECTORY + file;
            if index >= DOCUMENT_COUNT {
                break;
            }
            fs::write(
                section.join(format!("章节-{file:03}.md")),
                format!("第 {directory:04}-{file:03} 节。\n"),
            )
            .unwrap();
        }
    }
    root
}

fn percentile(samples: &[Duration], percentile: usize) -> Duration {
    let rank = (percentile * samples.len()).div_ceil(100);
    samples[rank.saturating_sub(1)]
}

#[cfg_attr(debug_assertions, ignore = "release-only performance gate")]
#[test]
fn refresh_documents_scales_in_release() {
    let root = large_project();
    let mut app = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();

    let refresh_started = Instant::now();
    let first_started = Instant::now();
    let first_rows = store.refresh_documents().unwrap();
    let first_refresh = first_started.elapsed();
    assert_eq!(first_rows.len(), DOCUMENT_COUNT);

    let mut warm = Vec::with_capacity(WARM_RUNS);
    for _ in 0..WARM_RUNS {
        let started = Instant::now();
        let rows = store.refresh_documents().unwrap();
        warm.push(started.elapsed());
        assert_eq!(rows.len(), DOCUMENT_COUNT);
    }
    let refresh_elapsed = refresh_started.elapsed();
    warm.sort_unstable();
    let p50 = percentile(&warm, 50);
    let p95 = percentile(&warm, 95);

    let mut searches = Vec::with_capacity(WARM_RUNS);
    let mut pages = Vec::with_capacity(WARM_RUNS);
    for _ in 0..WARM_RUNS {
        let search_started = Instant::now();
        let found = store
            .search_documents("章节-050", MAX_DOCUMENT_SEARCH_RESULTS)
            .unwrap();
        searches.push(search_started.elapsed());
        assert_eq!(found.len(), MAX_DOCUMENT_SEARCH_RESULTS as usize);

        let page_started = Instant::now();
        let page = store
            .document_page(DocumentPageQuery {
                after: Some("资料-0500/章节-050.md".to_owned()),
                limit: MAX_DOCUMENT_PAGE_SIZE,
            })
            .unwrap();
        pages.push(page_started.elapsed());
        assert_eq!(page.documents.len(), MAX_DOCUMENT_PAGE_SIZE as usize);
    }
    // Measure the product path: reconcile the catalog, then return one page.
    // The complete internal view and a page without reconciliation measure
    // different operations and cannot support an open-project latency claim.
    let mut product = Vec::with_capacity(WARM_RUNS);
    for _ in 0..WARM_RUNS {
        let started = Instant::now();
        let page = store
            .refresh_document_page(DocumentPageQuery {
                after: None,
                limit: MAX_DOCUMENT_PAGE_SIZE,
            })
            .unwrap();
        product.push(started.elapsed());
        assert_eq!(page.documents.len(), MAX_DOCUMENT_PAGE_SIZE as usize);
        assert_eq!(page.total, DOCUMENT_COUNT as u32);
    }
    product.sort_unstable();
    let product_p95 = percentile(&product, 95);

    searches.sort_unstable();
    pages.sort_unstable();
    let search_p95 = percentile(&searches, 95);
    let page_p95 = percentile(&pages, 95);

    eprintln!(
        "project_performance count={DOCUMENT_COUNT} first_us={} warm_runs={WARM_RUNS} warm_p50_us={} warm_p95_us={} search_p95_us={} page_p95_us={} product_p95_us={} refresh_elapsed_us={}",
        first_refresh.as_micros(),
        p50.as_micros(),
        p95.as_micros(),
        search_p95.as_micros(),
        page_p95.as_micros(),
        product_p95.as_micros(),
        refresh_elapsed.as_micros(),
    );

    drop(store);
    drop(app);
    fs::remove_dir_all(&root).unwrap();

    assert!(
        first_refresh < Duration::from_secs(10),
        "first refresh took {first_refresh:?}; the measured pre-fix N+1 baseline was 54.161335s"
    );
    assert!(
        p95 < Duration::from_millis(500),
        "warm refresh p95 took {p95:?}"
    );
    assert!(
        refresh_elapsed < Duration::from_secs(20),
        "all measured refreshes took {refresh_elapsed:?}"
    );
    assert!(
        product_p95 < Duration::from_millis(500),
        "the product path (reconcile + one page) missed its project-open budget: p95 {product_p95:?}"
    );
    assert!(
        search_p95 < Duration::from_millis(10),
        "100,000-row document search p95 took {search_p95:?}"
    );
    assert!(
        page_p95 < Duration::from_millis(10),
        "100,000-row document page p95 took {page_p95:?}"
    );
}

#[test]
fn refresh_reconciles_the_scan_without_rewriting_stable_rows() {
    let root = scratch();
    fs::write(root.join("保留.md"), "原稿。\n").unwrap();
    fs::write(root.join("移除.md"), "稍后移走。\n").unwrap();
    let mut app = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();

    store.refresh_documents().unwrap();
    let opened = store.open_document("保留.md").unwrap();
    store
        .save_continuity("保留.md", "head-7", r#"["block-a"]"#)
        .unwrap();
    let before = store
        .refresh_documents()
        .unwrap()
        .into_iter()
        .find(|row| row.path == "保留.md")
        .unwrap();
    assert_eq!(before.digest, Some(opened.stamp.digest));

    fs::remove_file(root.join("移除.md")).unwrap();
    fs::create_dir(root.join("资料")).unwrap();
    fs::write(root.join("资料").join("新增.md"), "新材料。\n").unwrap();

    let after = store.refresh_documents().unwrap();
    assert_eq!(
        after
            .iter()
            .map(|row| row.path.as_str())
            .collect::<Vec<_>>(),
        ["保留.md", "资料/新增.md"]
    );
    let preserved = after.iter().find(|row| row.path == "保留.md").unwrap();
    assert_eq!(preserved.id, before.id);
    assert_eq!(preserved.role, before.role);
    assert_eq!(preserved.digest, before.digest);
    assert_eq!(preserved.current_head.as_deref(), Some("head-7"));
    assert_eq!(preserved.head_block_ids.as_deref(), Some(r#"["block-a"]"#));
    assert_eq!(
        after
            .iter()
            .find(|row| row.path == "资料/新增.md")
            .unwrap()
            .role,
        DocumentRole::Material
    );
    assert!(
        after
            .iter()
            .all(|row| !row.path.starts_with(".refrain-source/"))
    );

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn document_pages_are_ordered_complete_and_hard_limited() {
    let root = scratch();
    let document_count = MAX_DOCUMENT_PAGE_SIZE + 17;
    for index in (0..document_count).rev() {
        fs::write(root.join(format!("{index:04}-章.md")), "正文。\n").unwrap();
    }
    let mut app = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    let expected = store.refresh_documents().unwrap();

    let first = store
        .document_page(DocumentPageQuery {
            after: None,
            limit: u32::MAX,
        })
        .unwrap();
    assert_eq!(first.total, document_count);
    assert_eq!(first.documents.len(), MAX_DOCUMENT_PAGE_SIZE as usize);
    assert_eq!(
        first
            .documents
            .iter()
            .map(|row| row.path.as_str())
            .collect::<Vec<_>>(),
        expected[..MAX_DOCUMENT_PAGE_SIZE as usize]
            .iter()
            .map(|row| row.path.as_str())
            .collect::<Vec<_>>()
    );
    let first_cursor = first.next.clone().expect("another page");
    assert_eq!(
        first_cursor,
        expected[MAX_DOCUMENT_PAGE_SIZE as usize - 1].path
    );

    let second = store
        .document_page(DocumentPageQuery {
            after: Some(first_cursor),
            limit: MAX_DOCUMENT_PAGE_SIZE,
        })
        .unwrap();
    assert_eq!(second.total, document_count);
    assert_eq!(
        second.documents,
        expected[MAX_DOCUMENT_PAGE_SIZE as usize..]
    );
    assert_eq!(second.next, None);

    let empty = store
        .document_page(DocumentPageQuery {
            after: None,
            limit: 0,
        })
        .unwrap();
    assert!(empty.documents.is_empty());
    assert_eq!(empty.total, document_count);
    assert_eq!(empty.next, None);

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn document_search_is_ranked_and_hard_limited() {
    let root = scratch();
    // 一份标题里带 FTS5 与 LIKE 都视为语法的字符。它必须能被当字面搜到，
    // 而不是把查询读成通配符或 MATCH 语法。
    fs::write(root.join("100%_确定.md").as_path(), "精确命中。\n").unwrap();
    for index in 0..(MAX_DOCUMENT_SEARCH_RESULTS + 17) {
        fs::write(root.join(format!("needle-{index:04}.md")), "命中。\n").unwrap();
    }
    fs::write(root.join("100xx确定.md"), "通配符不应命中。\n").unwrap();
    let mut app = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    store.refresh_documents().unwrap();

    // 「确定」两篇都有；只有 100%_确定 的标题里有那串字面字符。
    let literal = store.search_documents("100%_确定", u32::MAX).unwrap();
    assert_eq!(
        literal
            .iter()
            .map(|document| document.path.as_str())
            .collect::<Vec<_>>(),
        ["100%_确定.md"]
    );

    // 上限仍是硬的。次序现在由相关度决定，不再是路径字典序——检索层排的是
    // 「作者要哪一份」，而路径序只是「文件系统怎么摆」。
    let bounded = store.search_documents("needle", u32::MAX).unwrap();
    assert_eq!(bounded.len(), MAX_DOCUMENT_SEARCH_RESULTS as usize);
    let unique: std::collections::BTreeSet<&str> = bounded
        .iter()
        .map(|document| document.path.as_str())
        .collect();
    assert_eq!(
        unique.len(),
        bounded.len(),
        "同一份文档不得在结果里出现两次"
    );

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}
