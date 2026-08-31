// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! Release-scale contracts for the two large inputs promised by the product.
//!
//! Run with:
//! `cargo test --release -p refrain-store --test large_input_performance -- --nocapture`

use refrain_core::{Lineage, Manuscript, SourceSnapshot};
use refrain_store::materials::prepare_material_source;
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use serde::Serialize;
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{Seek as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const MARKDOWN_BLOCKS: usize = 100_000;
const SEVEN_60HZ_FRAMES: Duration = Duration::from_micros(116_667);
const PDF_PADDING_BYTES: usize = 100 * 1024 * 1024;

fn scratch(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "refrain-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos())
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

fn large_markdown() -> String {
    let mut text = String::with_capacity(11 * 1024 * 1024);
    for index in 0..MARKDOWN_BLOCKS {
        writeln!(
            text,
            "第 {index:06} 段：RefRain keeps this manuscript byte-exact while the visible window stays small. 0123456789ABCDEF\n"
        )
        .unwrap();
    }
    assert!(
        text.len() > 10 * 1024 * 1024,
        "fixture is only {} bytes",
        text.len()
    );
    text
}

#[derive(Serialize)]
struct BlockWire<'a> {
    id: String,
    text: &'a str,
}

fn open_and_encode(store: &mut ProjectStore, path: &str) -> (usize, usize) {
    let opened = store.open_registered_document(path).unwrap();
    let snapshot = SourceSnapshot::read(opened.bytes);
    let count = snapshot.block_count();
    let manuscript = Manuscript::open(snapshot, Lineage::fresh(count)).unwrap();
    let projection = manuscript
        .head()
        .blocks()
        .iter()
        .map(|block| BlockWire {
            id: block.id().to_string(),
            text: block.text(),
        })
        .collect::<Vec<_>>();
    let encoded = serde_json::to_vec(&projection).unwrap();
    (count, encoded.len())
}

fn percentile(samples: &mut [Duration], percentile: usize) -> Duration {
    samples.sort_unstable();
    let rank = (percentile * samples.len()).div_ceil(100);
    samples[rank.saturating_sub(1)]
}

#[cfg_attr(debug_assertions, ignore = "release-only performance gate")]
#[test]
fn a_10_mib_100000_block_manuscript_reaches_the_bridge_inside_seven_frames() {
    let root = scratch("large-markdown");
    let path = root.join("十万段.md");
    fs::write(&path, large_markdown()).unwrap();
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

    let mut samples = Vec::with_capacity(5);
    let mut encoded_bytes = 0;
    for _ in 0..5 {
        let started = Instant::now();
        let (blocks, bytes) = open_and_encode(&mut store, "十万段.md");
        samples.push(started.elapsed());
        assert_eq!(blocks, MARKDOWN_BLOCKS);
        encoded_bytes = bytes;
    }
    let p95 = percentile(&mut samples, 95);
    eprintln!(
        "large_markdown source_bytes={} blocks={MARKDOWN_BLOCKS} bridge_bytes={encoded_bytes} p95_us={}",
        fs::metadata(&path).unwrap().len(),
        p95.as_micros()
    );

    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
    assert!(
        p95 < SEVEN_60HZ_FRAMES,
        "10 MiB open-to-bridge p95 {p95:?} exceeds seven 60 Hz frames"
    );
}

fn write_object(file: &mut File, offsets: &mut Vec<u64>, number: usize, body: &str) {
    offsets.push(file.stream_position().unwrap());
    writeln!(file, "{number} 0 obj\n{body}\nendobj").unwrap();
}

fn write_large_pdf(path: &Path) {
    let mut file = File::create(path).unwrap();
    file.write_all(b"%PDF-1.4\n").unwrap();
    let mut offsets = Vec::new();
    write_object(
        &mut file,
        &mut offsets,
        1,
        "<< /Type /Catalog /Pages 2 0 R >>",
    );
    write_object(
        &mut file,
        &mut offsets,
        2,
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    );
    write_object(
        &mut file,
        &mut offsets,
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    );
    let stream = "BT /F1 24 Tf 72 700 Td (Large RefRain reference) Tj ET";
    write_object(
        &mut file,
        &mut offsets,
        4,
        &format!(
            "<< /Length {} >>\nstream\n{stream}\nendstream",
            stream.len()
        ),
    );
    write_object(
        &mut file,
        &mut offsets,
        5,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    );

    offsets.push(file.stream_position().unwrap());
    writeln!(file, "6 0 obj\n<< /Length {PDF_PADDING_BYTES} >>\nstream").unwrap();
    let zeros = vec![0_u8; 1024 * 1024];
    for _ in 0..(PDF_PADDING_BYTES / zeros.len()) {
        file.write_all(&zeros).unwrap();
    }
    file.write_all(b"\nendstream\nendobj\n").unwrap();

    let xref = file.stream_position().unwrap();
    writeln!(file, "xref\n0 {}", offsets.len() + 1).unwrap();
    file.write_all(b"0000000000 65535 f \n").unwrap();
    for offset in offsets {
        writeln!(file, "{offset:010} 00000 n ").unwrap();
    }
    writeln!(
        file,
        "trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF"
    )
    .unwrap();
    file.sync_all().unwrap();
}

#[cfg_attr(debug_assertions, ignore = "release-only performance gate")]
#[test]
fn a_100_mib_pdf_is_prepared_and_cloned_with_one_bounded_buffer() {
    let root = scratch("large-pdf");
    let source = root.join("百兆资料.pdf");
    let clone_dir = root.join("clones");
    write_large_pdf(&source);
    let source_bytes = fs::metadata(&source).unwrap().len();
    assert!(source_bytes > 100 * 1024 * 1024);

    let started = Instant::now();
    let prepared = prepare_material_source(&source, &clone_dir).unwrap();
    let elapsed = started.elapsed();
    let clone_bytes = fs::metadata(&prepared.clone).unwrap().len();
    eprintln!(
        "large_pdf source_bytes={source_bytes} clone_bytes={clone_bytes} elapsed_ms={}",
        elapsed.as_millis()
    );

    assert_eq!(clone_bytes, source_bytes);
    assert!(prepared.material.text.contains("Large RefRain reference"));
    assert!(
        elapsed < Duration::from_secs(10),
        "100 MiB preparation took {elapsed:?}"
    );
    fs::remove_dir_all(root).unwrap();
}
