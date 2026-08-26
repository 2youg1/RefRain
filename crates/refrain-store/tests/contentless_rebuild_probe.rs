//! 换成 `contentless_delete=1` 之后，重建一遍索引要多久，索引小了多少。
//!
//! 迁移把整张索引丢掉重建（v8 的同一条判断：索引是派生物），所以「作者升级
//! 之后第一次搜索要等多久」是这次改动的真实代价，必须量而不是估。省下的空间
//! 是收益的另一半：`block_search_state` 原本每块存一遍 bigram 之后的全文，
//! 那正是这个设计明说不要保存的东西。
//!
//! 跑法（不进闸门，语料要写盘）：
//! `cargo test -p refrain-store --release --test contentless_rebuild_probe -- --ignored --nocapture`
//! 规模用 `REFRAIN_REBUILD_DOCUMENTS` 换，默认 2,000 份。

use refrain_core::chinese_index::Precision;
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use std::fs;
use std::time::Instant;

fn documents() -> usize {
    std::env::var("REFRAIN_REBUILD_DOCUMENTS")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(2_000)
}

/// 一份有真实块结构的章：段落、标题、栅栏，中文为主。
fn chapter(index: usize) -> String {
    let mut text = format!("# 第{index}章\n\n");
    for paragraph in 0..12 {
        text.push_str(&format!(
            "陆沉舟站在窗前，想起营销那件事。第{index}章第{paragraph}段。雨从檐上落下来，\
             一滴一滴敲在铁皮上，像谁在很远的地方数数。\n\n"
        ));
    }
    text.push_str("```rust\nfn main() {}\n```\n");
    text
}

fn scratch(label: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("refrain-rebuild-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

#[test]
#[ignore = "writes a corpus and rebuilds the whole index; run explicitly"]
fn rebuilding_the_whole_index_after_the_migration() {
    let count = documents();
    let root = scratch("root");
    let mut corpus_bytes = 0usize;
    for index in 0..count {
        let text = chapter(index);
        corpus_bytes += text.len();
        fs::write(root.join(format!("{index:06}.md")), text).unwrap();
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

    // 迁移之后第一次刷新就是那一次重建：索引空着，语料全在。
    let started = Instant::now();
    store.refresh_documents().unwrap();
    let rebuild = started.elapsed();

    let hits = store
        .search_blocks_with("营销那件事", Precision::Exact, 20)
        .unwrap();
    assert!(!hits.is_empty(), "重建之后正文检索必须命中");

    println!("PROBE 文档数        = {count}");
    println!("PROBE 语料字节      = {corpus_bytes}");
    println!("PROBE 重建耗时      = {rebuild:?}");
    assert!(
        rebuild.as_secs() < 600,
        "the migration's rebuild cost more than one gate run: {rebuild:?}"
    );

    let _ = fs::remove_dir_all(&root);
}
