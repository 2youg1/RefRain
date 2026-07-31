//! 真实语料实测：把工作区的中文文档灌进索引，检索 KL9。
//!
//! KL9 2026-07-31 提议用这个做实测。它比造数据可信，因为这些文档是真的
//! 中英混排、真的有标点、真的有长短不一的段落，而这三件事恰好是分词最容易出错的地方。
//!
//! 用法：cargo run -p refrain-store --example search_probe -- <目录>

use refrain_store::Database;
use refrain_store::project::search::{IndexedBlock, index_document, search};
use refrain_store::schema::{ProjectDb, open_in_memory};
use std::time::Instant;

fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // 跳过构建产物与版本库：它们不是作者写的字。
        if matches!(name, "target" | "node_modules" | ".git" | "dist") {
            continue;
        }
        if path.is_dir() {
            walk(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            out.push(path);
        }
    }
}

fn main() {
    let root = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/workspace/v0.2.1".to_string());

    let mut db = open_in_memory().unwrap();
    ProjectDb::migrate(&mut db).unwrap();

    let mut files = Vec::new();
    walk(std::path::Path::new(&root), &mut files);
    files.sort();

    println!("── 灌索引：{} 下的 {} 份 Markdown ──", root, files.len());
    let start = Instant::now();
    let mut bytes = 0usize;
    let mut indexed = 0usize;
    for file in &files {
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        bytes += text.len();
        let digest = format!("{:x}", text.len());
        let path = file
            .strip_prefix(&root)
            .unwrap_or(file)
            .display()
            .to_string();
        if index_document(&db, &path, &digest, &text).unwrap() {
            indexed += 1;
        }
    }
    let build_ms = start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "  {indexed} 份 / {:.2} MB / {build_ms:.0} ms  （{:.1} MB/秒）\n",
        bytes as f64 / 1e6,
        bytes as f64 / 1e6 / (build_ms / 1000.0)
    );

    // 重灌一次：摘要没变，应当一份都不重建。
    let start = Instant::now();
    let mut rebuilt = 0usize;
    for file in &files {
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        let digest = format!("{:x}", text.len());
        let path = file
            .strip_prefix(&root)
            .unwrap_or(file)
            .display()
            .to_string();
        if index_document(&db, &path, &digest, &text).unwrap() {
            rebuilt += 1;
        }
    }
    println!(
        "── 重灌（摘要未变）──\n  重建 {rebuilt} 份，耗时 {:.0} ms\n",
        start.elapsed().as_secs_f64() * 1000.0
    );

    // 跨词边界的假匹配：bigram 的已知代价（清华 ICU 演讲里「市长 匹配
    // 武汉市长江大桥」那个例子）。这里用真实语料量它到底有多严重——
    // BM25 是否把真答案排在假匹配之前。
    let queries = [
        "KL9",
        "市长",
        "深度",
        "屎山",
        "深模块",
        "门禁",
        "渐进式披露",
        "我",
        "营销",
        "不存在的词",
    ];
    println!("── 检索 ──");
    for query in queries {
        let start = Instant::now();
        let hits: Vec<IndexedBlock> = search(&db, query, 5).unwrap();
        let micros = start.elapsed().as_micros();
        let top = hits
            .iter()
            .take(3)
            .map(|hit| format!("{}({:.2})", hit.path, hit.relevance))
            .collect::<Vec<_>>()
            .join("  ");
        println!("  {query:12} {:2} 条  {micros:>5}µs   {top}", hits.len());
    }
}
