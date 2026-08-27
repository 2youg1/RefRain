// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 对拍：一次热刷新的那一秒，花在哪一段上。
//!
//! `project_performance.rs` 只给一个总数（Windows 上 warm p95 1074.6 ms）。
//! 预算注释断言「the walk dominates it」，但那是判断，不是拆分——没有哪一次
//! 测量把这一秒切开过。切不开就没法排优化的次序：换数据库、改遍历、还是改
//! 那条 SELECT，读同一个总数会得出三种结论。
//!
//! 这个探针在同一棵树上量四段：
//!
//! | 段 | 量的是 |
//! |---|---|
//! | `walk_only`      | `ignore` 遍历本身，只取目录项自带的 file_type——`Entry::from` 今天的做法 |
//! | `walk_stat`      | 同一次遍历，外加 `symlink_metadata()`——旧代码的做法，留作对照 |
//! | `refresh_warm`   | `refresh_documents()`，指纹命中，跳过整个事务 |
//! | `documents_only` | `documents()`，把每一行读回内存 |
//!
//! 于是「映射 + 指纹」= `refresh_warm` − `walk_only` − `documents_only`。
//! `walk_stat` 不再进这个减法：它量的是已经删掉的那次调用值多少钱，
//! 是这次改动的收据，不是现状的一段。
//!
//! 跑法（release，因为预算是 release 的）：
//! `cargo test -p refrain-store --release --test refresh_phase_probe -- --nocapture`
//!
//! 规模默认两万，与十万同形而快得多；要复现预算那一档：
//! `REFRAIN_PROBE_DOCUMENTS=100000`

use ignore::{WalkBuilder, WalkState};
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const FILES_PER_DIRECTORY: usize = 100;
const RUNS: usize = 10;

fn document_count() -> usize {
    std::env::var("REFRAIN_PROBE_DOCUMENTS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(20_000)
}

fn scratch(count: usize) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "refrain-refresh-phase-{}-{}",
        std::process::id(),
        count
    ));
    let _ = fs::remove_dir_all(&root);
    let directories = count.div_ceil(FILES_PER_DIRECTORY);
    for directory in 0..directories {
        let section = root.join(format!("资料-{directory:04}"));
        fs::create_dir_all(&section).unwrap();
        for file in 0..FILES_PER_DIRECTORY {
            let index = directory * FILES_PER_DIRECTORY + file;
            if index >= count {
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

/// 与 `files::index::scan_all` 同参数的遍历。
///
/// `stat` 为真时对每个条目再调一次 `symlink_metadata()`，这正是
/// `Entry::from` 今天做的事；为假时只用目录迭代已经交回来的 file_type。
/// 两者之差就是那一次额外系统调用的价钱。
fn walk(root: &Path, stat: bool) -> usize {
    let counted = AtomicUsize::new(0);
    let errors = Mutex::new(Vec::<String>::new());

    WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .ignore(true)
        .parents(true)
        .follow_links(false)
        .filter_entry(|entry| entry.file_name() != ".refrain-source")
        .build_parallel()
        .run(|| {
            let counted = &counted;
            let errors = &errors;
            Box::new(move |result| {
                let entry = match result {
                    Ok(entry) => entry,
                    Err(error) => {
                        errors
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .push(error.to_string());
                        return WalkState::Continue;
                    }
                };
                if entry.depth() == 0 {
                    return WalkState::Continue;
                }
                let cheap_kind = entry.file_type();
                let path = entry.into_path();
                let is_file = if stat {
                    match path.symlink_metadata() {
                        Ok(metadata) => metadata.file_type().is_file(),
                        Err(error) => {
                            errors
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner())
                                .push(error.to_string());
                            return WalkState::Continue;
                        }
                    }
                } else {
                    cheap_kind.is_some_and(|kind| kind.is_file())
                };
                if is_file && path.extension().is_some_and(|ext| ext == "md") {
                    counted.fetch_add(1, Ordering::Relaxed);
                }
                WalkState::Continue
            })
        });

    assert!(
        errors
            .into_inner()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_empty(),
        "the probe's own walk must be complete or its numbers mean nothing"
    );
    counted.into_inner()
}

fn median(samples: &mut [Duration]) -> Duration {
    samples.sort_unstable();
    samples[samples.len() / 2]
}

#[cfg_attr(debug_assertions, ignore = "release-only cost probe")]
#[test]
fn where_the_warm_refresh_second_goes() {
    let count = document_count();
    let root = scratch(count);

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

    // 第一次刷新做真正的对账并建目录；它不是这次要拆的那一秒。
    let cold = Instant::now();
    let rows = store.refresh_documents().unwrap();
    let cold = cold.elapsed();
    assert_eq!(rows.len(), count);

    let mut walk_only = Vec::with_capacity(RUNS);
    let mut walk_stat = Vec::with_capacity(RUNS);
    let mut refresh_warm = Vec::with_capacity(RUNS);
    let mut documents_only = Vec::with_capacity(RUNS);

    for _ in 0..RUNS {
        let started = Instant::now();
        let seen = walk(&root, false);
        walk_only.push(started.elapsed());
        assert_eq!(seen, count);

        let started = Instant::now();
        let seen = walk(&root, true);
        walk_stat.push(started.elapsed());
        assert_eq!(seen, count);

        let started = Instant::now();
        let rows = store.refresh_documents().unwrap();
        refresh_warm.push(started.elapsed());
        assert_eq!(rows.len(), count);

        let started = Instant::now();
        let rows = store.documents().unwrap();
        documents_only.push(started.elapsed());
        assert_eq!(rows.len(), count);
    }

    let walk_only = median(&mut walk_only);
    let walk_stat = median(&mut walk_stat);
    let refresh_warm = median(&mut refresh_warm);
    let documents_only = median(&mut documents_only);
    let stat_surcharge = walk_stat.saturating_sub(walk_only);
    let mapping = refresh_warm
        .saturating_sub(walk_only)
        .saturating_sub(documents_only);

    let share = |part: Duration| {
        if refresh_warm.is_zero() {
            0.0
        } else {
            100.0 * part.as_secs_f64() / refresh_warm.as_secs_f64()
        }
    };

    println!("\n=== 热刷新一次的构成（{count} 篇，{RUNS} 次取中位数）===");
    println!("首次对账（含建目录）      {cold:>10.2?}");
    println!("热刷新一次 refresh_warm   {refresh_warm:>10.2?}   100.0%");
    println!(
        "  ├ 遍历（含类型判定）    {walk_only:>10.2?}   {:>5.1}%",
        share(walk_only)
    );
    println!(
        "  ├ 映射 + 指纹           {mapping:>10.2?}   {:>5.1}%",
        share(mapping)
    );
    println!(
        "  └ documents() 全量读出  {documents_only:>10.2?}   {:>5.1}%",
        share(documents_only)
    );
    println!(
        "\nSQLite 承担的份额：{:.1}%（documents() 一项；指纹命中时热刷新不开事务）",
        share(documents_only)
    );
    println!("文件系统承担的份额：{:.1}%", share(walk_only));
    println!(
        "对照：每条再调一次 symlink_metadata 要 {stat_surcharge:.2?}，\
         即这次改动省下的钱\n"
    );
}
