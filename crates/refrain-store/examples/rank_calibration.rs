//! 块级 bm25 的分布实测，用于重新标定 `search_rank` 的四信号上限。
//!
//! 判据 1-4。文档级的那组比例（PATH_EXACT 10 / PATH_CONTAINS 6 /
//! HEADING 4 / BODY 3 / RECENCY 1.5）是按**文档级** bm25 分布标定的：
//! 那时「文档长度」是整篇。块级之后长度变成块长，bm25 的量纲随之改变，
//! 沿用旧比例等于拿旧尺子量新东西。
//!
//! 这个探针不作判断，只出数字：块级 bm25 的实际取值范围，以及在
//! `squash` 之后它能占到 `cap::BODY` 的多大比例。标定的结论由人读数字定。
//!
//! 跑法：cargo run -p refrain-store --example rank_calibration -- <语料目录>

use std::path::PathBuf;

use refrain_core::block_shape::BlockKind;
use refrain_store::Database;
use refrain_store::project::search::{IndexedBlock, index_document, search_with};
use refrain_store::schema::{ProjectDb, open_in_memory};
use rusqlite::Connection;

use refrain_core::chinese_index::Precision;

/// squash 的复制品，与 `search_rank::squash` 同式。
///
/// 复制而非导出：这是探针，它要能在不改动被测模块的前提下问「若换成另一
/// 个上限会怎样」。导出会让被测对象与探针共享一个可能正被质疑的实现。
fn squash(value: f64, ceiling: f64) -> f64 {
    ceiling * (value / (value + 1.0))
}

fn load_corpus(root: &PathBuf, limit: usize) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if out.len() >= limit {
                return out;
            }
            let path = entry.path();
            if path.is_dir() {
                // node_modules 与 .git 不是作者的稿子，进来只会拖慢并污染分布。
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if name == "node_modules" || name == ".git" || name == "target" {
                    continue;
                }
                stack.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("md")
                && let Ok(text) = std::fs::read_to_string(&path)
                && !text.trim().is_empty()
            {
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                out.push((relative, text));
            }
        }
    }
    out
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f64 * fraction).round() as usize;
    sorted[index]
}

fn report(db: &Connection, queries: &[&str]) {
    let mut all: Vec<f64> = Vec::new();
    println!(
        "\n{:<16} {:>7} {:>9} {:>9} {:>9}",
        "查询", "命中", "bm25最小", "bm25中位", "bm25最大"
    );
    for query in queries {
        let hits: Vec<IndexedBlock> = search_with(db, query, Precision::Exact, 500).unwrap();
        if hits.is_empty() {
            println!("{query:<16} {:>7}", 0);
            continue;
        }
        let mut scores: Vec<f64> = hits.iter().map(|hit| hit.relevance).collect();
        scores.sort_by(|a, b| a.partial_cmp(b).unwrap());
        all.extend_from_slice(&scores);
        println!(
            "{:<16} {:>7} {:>9.4} {:>9.4} {:>9.4}",
            query,
            hits.len(),
            scores[0],
            percentile(&scores, 0.5),
            scores[scores.len() - 1]
        );
    }

    all.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if all.is_empty() {
        println!("\n没有任何命中，无法标定。");
        return;
    }
    println!("\n=== 块级 bm25 总体分布（{} 个命中）===", all.len());
    for (label, fraction) in [
        ("p05", 0.05),
        ("p25", 0.25),
        ("p50", 0.50),
        ("p75", 0.75),
        ("p95", 0.95),
        ("p99", 0.99),
    ] {
        println!("  {label} = {:.4}", percentile(&all, fraction));
    }
    println!("  最大 = {:.4}", all[all.len() - 1]);

    // 关键读数：squash 之后 body 信号实际占 cap::BODY 的多少。
    // 若绝大多数命中都压在上限的很小一段，BODY 这个信号就名存实亡；
    // 若普遍贴近上限，它又会盖过 HEADING。
    println!("\n=== squash 后占 cap::BODY(=3.0) 的比例 ===");
    for (label, fraction) in [("p25", 0.25), ("p50", 0.50), ("p75", 0.75), ("p95", 0.95)] {
        let raw = percentile(&all, fraction).max(0.0);
        let squashed = squash(raw, 3.0);
        println!(
            "  {label}: bm25={raw:.4} → squash={squashed:.4} （占上限 {:.1}%）",
            squashed / 3.0 * 100.0
        );
    }
}

fn main() {
    let root: PathBuf = std::env::args()
        .nth(1)
        .map_or_else(|| PathBuf::from("/workspace"), PathBuf::from);
    let limit: usize = std::env::args()
        .nth(2)
        .and_then(|n| n.parse().ok())
        .unwrap_or(3000);

    let corpus = load_corpus(&root, limit);
    println!(
        "语料：{} 份 markdown，来自 {}",
        corpus.len(),
        root.display()
    );

    let mut db = open_in_memory().unwrap();
    ProjectDb::migrate(&mut db).unwrap();

    let started = std::time::Instant::now();
    let mut blocks = 0usize;
    let mut bytes = 0usize;
    {
        let transaction = db.transaction().unwrap();
        for (path, text) in &corpus {
            let digest = refrain_core::digest::content_hex(text.as_bytes());
            bytes += text.len();
            blocks += refrain_core::searchable_block::blocks_of(text).len();
            let _ = index_document(&transaction, path, &digest, text);
        }
        transaction.commit().unwrap();
    }
    let elapsed = started.elapsed();

    println!(
        "灌库：{blocks} 块 / {:.1} MB / {:.2} 秒（{:.1} MB/秒，{:.0} 块/秒）",
        bytes as f64 / 1_048_576.0,
        elapsed.as_secs_f64(),
        bytes as f64 / 1_048_576.0 / elapsed.as_secs_f64(),
        blocks as f64 / elapsed.as_secs_f64()
    );

    // 判据 1-7 的另一半：库体积。
    let pages: i64 = db
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .unwrap();
    let page_size: i64 = db
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .unwrap();
    println!(
        "库体积：{:.1} MB（{} 页 × {} 字节），为语料的 {:.2}×",
        (pages * page_size) as f64 / 1_048_576.0,
        pages,
        page_size,
        (pages * page_size) as f64 / bytes as f64
    );

    // 块类型分布：HEADING 信号能不能真的被触发，取决于标题块占多少。
    let mut kinds = [0usize; 3];
    for (_, text) in &corpus {
        for block in refrain_core::searchable_block::blocks_of(text) {
            let slot = match block.kind {
                BlockKind::Paragraph => 0,
                BlockKind::Heading(_) => 1,
                BlockKind::Fence => 2,
                BlockKind::Table(_) => 3,
            };
            kinds[slot] += 1;
        }
    }
    let total = kinds.iter().sum::<usize>().max(1);
    println!(
        "块类型：段落 {:.1}% / 标题 {:.1}% / 围栏 {:.1}%",
        kinds[0] as f64 / total as f64 * 100.0,
        kinds[1] as f64 / total as f64 * 100.0,
        kinds[2] as f64 / total as f64 * 100.0
    );

    report(
        &db,
        &[
            "渐进式披露",
            "上下文",
            "检索",
            "索引",
            "门禁",
            "块级",
            "Agent",
            "token",
        ],
    );
}
