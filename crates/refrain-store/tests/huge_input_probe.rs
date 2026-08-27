// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 一份 1GB 的 Markdown，现在的做法要多久、吃多少内存。
//!
//! 现有门禁最大只到 11.4MB（59ms）。1GB 是它的九十倍，而当前的路径是「整份读进
//! 内存 → 切块 → 全量编码成 JSON 交给桥」，三步都与文件大小成正比。这个探针把
//! 每一步分别计时，好判断该先动哪一步，而不是凭直觉猜。
//!
//! 跑法（release，会占用约 3GB 磁盘与内存，跑完自动清理）：
//!   cargo test --release -p refrain-store --test huge_input_probe -- --nocapture --ignored

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use refrain_core::{Lineage, Manuscript, SourceSnapshot};
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

/// 每段的大致长度，与真实稿子接近。
const PARAGRAPH: &str = "这是一段中文正文，长度与真实稿件里的一段接近，用来把文件撑到目标体积。它带有标点，也带有一点变化。\n\n";

fn write_corpus(path: &PathBuf, target_bytes: u64) -> (u64, usize) {
    let file = fs::File::create(path).unwrap();
    let mut writer = std::io::BufWriter::with_capacity(1 << 20, file);
    let chunk = PARAGRAPH.as_bytes();
    let mut written = 0u64;
    let mut paragraphs = 0usize;
    while written < target_bytes {
        writer.write_all(chunk).unwrap();
        written += chunk.len() as u64;
        paragraphs += 1;
    }
    writer.flush().unwrap();
    (written, paragraphs)
}

#[test]
#[ignore = "writes a multi-GB corpus; run explicitly"]
fn one_gigabyte_of_markdown() {
    let root = std::env::temp_dir().join("refrain-huge-probe");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let path = root.join("巨稿.md");

    for target_mib in [64u64, 256, 1024] {
        let target = target_mib * 1024 * 1024;
        let wrote = Instant::now();
        let (bytes, paragraphs) = write_corpus(&path, target);
        let write_ms = wrote.elapsed().as_millis();

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

        // 第一步：把文件读进内存。
        let read_started = Instant::now();
        let opened = store.open_registered_document("巨稿.md").unwrap();
        let read_ms = read_started.elapsed().as_millis();
        let read_bytes = opened.bytes.len();

        // 第二步：切块。
        let split_started = Instant::now();
        let snapshot = SourceSnapshot::read(opened.bytes);
        let block_count = snapshot.block_count();
        let split_ms = split_started.elapsed().as_millis();

        // 第三步：建立可编辑的稿件视图。
        let open_started = Instant::now();
        let manuscript = Manuscript::open(snapshot, Lineage::fresh(block_count)).unwrap();
        let open_ms = open_started.elapsed().as_millis();

        // 参照：只切区间、不拷文本，需要多久。
        // Block 现在每块持有一个 String，1GB 稿子就是七百多万次堆分配加一份整文
        // 拷贝；而字节本来就在 Arc 里共享。这个数字说明去掉拷贝能省下多少。
        let borrow_started = Instant::now();
        let borrowed: usize = manuscript
            .head()
            .blocks()
            .iter()
            .map(|block| block.text().len())
            .sum();
        let borrow_ms = borrow_started.elapsed().as_millis();
        assert!(borrowed > 0);

        // 第四步：编码成桥要的形状（当前是全量 JSON）。
        let encode_started = Instant::now();
        let projection: Vec<(String, &str)> = manuscript
            .head()
            .blocks()
            .iter()
            .map(|block| (block.id().to_string(), block.text()))
            .collect();
        let encoded = serde_json::to_string(&projection).unwrap();
        let encode_ms = encode_started.elapsed().as_millis();

        eprintln!(
            "huge mib={target_mib} bytes={bytes} paragraphs={paragraphs} blocks={block_count} \
             write_ms={write_ms} read_ms={read_ms} read_bytes={read_bytes} split_ms={split_ms} \
             open_ms={open_ms} borrow_ms={borrow_ms} encode_ms={encode_ms} encoded_bytes={}",
            encoded.len()
        );

        drop(manuscript);
        drop(store);
        drop(app);
    }

    fs::remove_dir_all(&root).unwrap();
}
