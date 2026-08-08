//! Probe: time the real open path of a manuscript on this machine.
//! File read → persisted state → scan → build → window projection.
//! Run: cargo run --release -p refrain-app --example open_probe -- <path>

use refrain_app::native_document::{
    DocumentAnchor, DocumentOpen, DocumentSurface, DocumentViewport,
};
use refrain_core::manuscript::{Lineage, Manuscript, SourceSnapshot};
use refrain_core::{BlockScan, DocumentFormat};
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("usage: open_probe <path>");
    let state_path = format!("{path}.refrain-state.json");

    // Warm the file cache once.
    let _ = std::fs::read(&path).unwrap();

    const RUNS: usize = 7;
    let mut read_ms = Vec::new();
    let mut scan_ms = Vec::new();
    let mut build_ms = Vec::new();
    let mut surface_ms = Vec::new();
    let mut project_ms = Vec::new();
    let mut total_ms = Vec::new();
    let mut window_bytes = 0usize;

    for _ in 0..RUNS {
        let t0 = Instant::now();
        let bytes = std::fs::read(&path).unwrap();
        let t1 = Instant::now();
        let format = DocumentFormat::of_path(&path);
        let scan = match format {
            DocumentFormat::Markdown => BlockScan::Markdown,
            _ => BlockScan::Plain,
        };
        let source = SourceSnapshot::read_checked_with(bytes, scan).unwrap();
        eprintln!("block_count={}", source.block_count());
        let t2 = Instant::now();
        let lineage = Lineage::fresh(source.block_count());
        let _manuscript = Manuscript::open(source, lineage).unwrap();
        let t3 = Instant::now();
        let surface = DocumentSurface::open(DocumentOpen::Persistent {
            path: path.clone().into(),
            state_path: state_path.clone().into(),
        })
        .unwrap();
        let t4 = Instant::now();
        let projection = surface
            .project(DocumentViewport {
                anchor: DocumentAnchor::Block(0),
                columns_em: 65.0,
                block_count: 96,
                max_bytes: 40960,
            })
            .unwrap();
        let t5 = Instant::now();
        read_ms.push(t1.duration_since(t0).as_micros() as f64 / 1000.0);
        scan_ms.push(t2.duration_since(t1).as_micros() as f64 / 1000.0);
        build_ms.push(t3.duration_since(t2).as_micros() as f64 / 1000.0);
        surface_ms.push(t4.duration_since(t3).as_micros() as f64 / 1000.0);
        project_ms.push(t5.duration_since(t4).as_micros() as f64 / 1000.0);
        total_ms.push(t5.duration_since(t0).as_micros() as f64 / 1000.0);
        window_bytes = projection.text.len();
        drop(projection);
        drop(surface);
    }

    let pct = |v: &[f64]| {
        let mut s = v.to_vec();
        s.sort_by(|a, b| a.partial_cmp(b).unwrap());
        s[(s.len() * 95).div_ceil(100) - 1]
    };
    println!(
        "read {:.3} | scan {:.3} | build {:.3} | surface+state {:.3} | project {:.3} | TOTAL {:.3} ms p95 | window {} bytes ({} MB source)",
        pct(&read_ms),
        pct(&scan_ms),
        pct(&build_ms),
        pct(&surface_ms),
        pct(&project_ms),
        pct(&total_ms),
        window_bytes,
        std::fs::metadata(&path).unwrap().len() / 1024 / 1024,
    );
}
