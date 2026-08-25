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

/// The budgets, per platform, with the measurement that produced each.
///
/// **Why per platform.** A warm refresh is a metadata walk of 100,000 files
/// plus a reconcile; the walk dominates it. NTFS charges several times what
/// ext4 charges for that walk, so one cross-platform number cannot be honest
/// on both: it was measured on Linux, and on Windows — the platform RefRain
/// actually ships from — the identical code missed it roughly two-fold while
/// nothing had regressed. A budget that is permanently red on the release
/// platform stops being read, which is worse than no budget at all.
///
/// **Where the Windows numbers come from.** Measured here on the development
/// machine: Intel Core i5-1340P (4P+8E, 12C/16T, 1.9 GHz base), 16 GB DDR5-5200,
/// Samsung MZVL41T0HBLB NVMe, Windows 11 build 26220, `x86_64-pc-windows-msvc`,
/// release. **The machine belongs in the record because the budget is a claim
/// about a machine.** A warm refresh is a metadata walk bound by single-thread
/// CPU and storage latency, so a faster desktop reads well under these numbers
/// and a slower laptop can legitimately exceed them without anything having
/// regressed — which is exactly the argument a reader needs to make when this
/// budget goes red on hardware nobody wrote down. Twice on 2026-08-15: warm p95
/// 1032.2 / 1028.4 ms, product p95 809.9 / 794.5 ms, search p95 21.7 / 21.8 ms,
/// page p95 13.7 / 13.5 ms, all refreshes 20.66 / 20.92 s. A third time on
/// 2026-08-16, the reading the README now carries: warm p95 1074.6 ms, product
/// p95 843.7 ms, search p95 23.2 ms, page p95 14.1 ms, first refresh 2.02 s,
/// all refreshes 22.11 s. Run-to-run spread stays near 4%, so the budgets below
/// are those readings with roughly 50% headroom — enough that machine noise
/// never reds the gate, tight enough that doubling the per-document work still
/// does.
///
/// **The Windows budgets halved on 2026-08-25.** `files::index::Entry::from`
/// took a `PathBuf` and called `symlink_metadata` on it, although the walk had
/// already handed it the file type. `refresh_phase_probe` charged that second
/// call 651 ms of a 1,080 ms warm refresh, against 69 ms for the whole
/// traversal. The function now takes the `DirEntry`. Three times on the same
/// machine after the change: warm p95 508.1 / 505.6 / 477.1 ms, product p95
/// 281.4 / 311.8 / 228.0 ms, search p95 22.3 / 22.0 / 22.0 ms, page p95 14.4 /
/// 14.5 / 13.6 ms, first refresh 1.88 / 1.67 / 1.63 s, all refreshes 10.75 /
/// 9.83 / 9.84 s. Search and page are unmoved, as they must be: neither walks
/// the tree. The budgets below are the slowest of the three with roughly 50%
/// headroom, by the same rule the pre-change budgets used.
///
/// **The budget was watched going red.** Putting the per-entry
/// `symlink_metadata` back, minutes later on the same machine, gave warm p50
/// 1218.8 ms, warm p95 1573.1 ms, product p95 1051.7 ms, all refreshes 28.59 s
/// — and this gate failed with `warm refresh p95 took 1.5731091s, budget
/// 800ms`. Read that pair rather than the pair against the 2026-08-16 record:
/// it is the same machine in the same session, so it isolates the call instead
/// of also measuring five months of machine drift.
///
/// **Take the readings on a quiet machine.** A third reading, taken while two
/// 100,000-file probe corpora still sat in the temp directory, gave warm p95
/// 1560.7 ms against a median of 561.3 ms. `WARM_RUNS` is 20, so this p95 is
/// the nineteenth of twenty samples — an order statistic that reports the tail,
/// and the tail is what a loaded machine moves first. The medians and the
/// twenty-one-refresh total agreed with the clean readings throughout.
///
/// The Linux numbers are unchanged; they are what CI measures and what the
/// pre-fix N+1 baseline (54.161335 s for the first refresh) was judged against.
/// The change helps Linux too — a stat is a syscall on ext4 as well — but by
/// how much is unmeasured here, and a budget nobody measured is a guess with a
/// gate attached. CI's next Linux run sets those three numbers.
struct Budget;

impl Budget {
    /// One warm `refresh_documents`: walk, fingerprint, then the complete
    /// internal view of every row.
    const WARM_REFRESH_P95: Duration = Duration::from_millis(if cfg!(windows) { 800 } else { 500 });
    /// The product path an author actually waits on: reconcile, then one page.
    ///
    /// One number on both platforms since 2026-08-25, and the convergence is
    /// the finding rather than a tidy-up: the per-file `symlink_metadata` was
    /// most of what NTFS charged over ext4 here, so removing it removed the
    /// reason this budget needed two numbers. Split it again only against a
    /// Linux reading that asks for the split.
    const PRODUCT_P95: Duration = Duration::from_millis(500);
    /// One document search over 100,000 rows.
    const SEARCH_P95: Duration = Duration::from_millis(if cfg!(windows) { 32 } else { 10 });
    /// One document page over 100,000 rows.
    const PAGE_P95: Duration = Duration::from_millis(if cfg!(windows) { 20 } else { 10 });
    /// The first refresh plus all twenty warm ones.
    const ALL_REFRESHES: Duration = Duration::from_secs(if cfg!(windows) { 16 } else { 20 });
    /// The first refresh alone. One number on both platforms: it exists to
    /// catch the N+1 shape returning, and 54 s against 10 s is not a margin
    /// any filesystem difference reaches.
    const FIRST_REFRESH: Duration = Duration::from_secs(10);
}

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
        first_refresh < Budget::FIRST_REFRESH,
        "first refresh took {first_refresh:?}; the measured pre-fix N+1 baseline was 54.161335s"
    );
    assert!(
        p95 < Budget::WARM_REFRESH_P95,
        "warm refresh p95 took {p95:?}, budget {:?}",
        Budget::WARM_REFRESH_P95
    );
    assert!(
        refresh_elapsed < Budget::ALL_REFRESHES,
        "all measured refreshes took {refresh_elapsed:?}, budget {:?}",
        Budget::ALL_REFRESHES
    );
    assert!(
        product_p95 < Budget::PRODUCT_P95,
        "the product path (reconcile + one page) missed its project-open budget: p95 {product_p95:?}, budget {:?}",
        Budget::PRODUCT_P95
    );
    assert!(
        search_p95 < Budget::SEARCH_P95,
        "100,000-row document search p95 took {search_p95:?}, budget {:?}",
        Budget::SEARCH_P95
    );
    assert!(
        page_p95 < Budget::PAGE_P95,
        "100,000-row document page p95 took {page_p95:?}, budget {:?}",
        Budget::PAGE_P95
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
