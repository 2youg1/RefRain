// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 正文索引的真实成本：十万文件全读要多久。
//!
//! 目前的目录 reconcile **不读文件内容**，只走路径与 mtime。正文搜索必须读，
//! 而这是一条按字节计的新成本，与现有的按文件数计的成本不同量级。
//!
//! 这个探针只回答一个问题：**如果要为正文建索引，读这一遍要多久。**
//! 答案决定策略是「打开项目时同步建」「后台增量建」还是「只索引打开过的文档」。
//! 不先量就选，等于替作者赌一个他要等的时间。

use std::fs;
use std::time::Instant;

use refrain_core::Id;

const DOCUMENT_COUNT: usize = 100_000;
const FILES_PER_DIRECTORY: usize = 500;

/// 一份中日文稿件的典型大小：约 4KB，与真实章节相当。
fn chapter_body(index: usize) -> String {
    let mut text = String::with_capacity(4096);
    text.push_str(&format!("# 章节-{index:06}\n\n"));
    for paragraph in 0..12 {
        text.push_str(&"直骨令的雨落在窗上，他久久没有回头。".repeat(4));
        text.push_str("\n\n");
        if paragraph % 5 == 4 {
            text.push_str("他久久没有说话。\n\n");
        }
    }
    text
}

#[test]
#[ignore = "expensive: writes 100,000 files (~400MB)"]
fn reading_every_document_body_at_one_hundred_thousand_files() {
    let root = std::env::temp_dir().join(format!("refrain-fts-cost-{}", Id::new()));
    let directories = DOCUMENT_COUNT.div_ceil(FILES_PER_DIRECTORY);

    let write_started = Instant::now();
    let mut total_bytes = 0u64;
    for directory in 0..directories {
        let path = root.join(format!("卷-{directory:04}"));
        fs::create_dir_all(&path).unwrap();
        for offset in 0..FILES_PER_DIRECTORY {
            let index = directory * FILES_PER_DIRECTORY + offset;
            if index >= DOCUMENT_COUNT {
                break;
            }
            let body = chapter_body(index);
            total_bytes += body.len() as u64;
            fs::write(path.join(format!("章节-{index:06}.md")), body).unwrap();
        }
    }
    let write_ms = write_started.elapsed().as_millis();

    // 读一遍全部正文——这正是建正文索引不可避免的那一步。
    let read_started = Instant::now();
    let mut read_bytes = 0u64;
    let mut files = 0usize;
    for directory in 0..directories {
        let path = root.join(format!("卷-{directory:04}"));
        for entry in fs::read_dir(&path).unwrap() {
            let entry = entry.unwrap();
            let body = fs::read_to_string(entry.path()).unwrap();
            read_bytes += body.len() as u64;
            files += 1;
        }
    }
    let read_ms = read_started.elapsed().as_millis();

    println!(
        "fts_cost files={files} bytes={read_bytes} write_ms={write_ms} read_ms={read_ms} \
         mib={:.1}",
        read_bytes as f64 / 1_048_576.0
    );
    assert_eq!(files, DOCUMENT_COUNT);
    assert_eq!(read_bytes, total_bytes);

    fs::remove_dir_all(&root).ok();
}
