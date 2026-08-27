// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 对拍：目录刷新的代价，与索引是不是挂在它上面。
//!
//! `refresh_documents_scales_in_release` 的装置要写二十万个文件，光是建装置
//! 就要好几分钟，用它做 A/B 太贵而且分不清「装置慢」与「代码慢」。
//!
//! 这个探针用小得多的规模（可调），量的是同一件事：**刷新 N 次的总耗时随
//! 索引触发点而变**。
//!
//! 跑法：cargo test -p refrain-store --release --test refresh_cost_probe -- --nocapture

use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use std::fs;
use std::time::Instant;

const DOCUMENTS: usize = 2_000;
const REFRESHES: usize = 21;

#[test]
fn refresh_cost_does_not_scale_with_indexing() {
    let root = std::env::temp_dir().join(format!("refrain-refresh-probe-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    for index in 0..DOCUMENTS {
        fs::write(
            root.join(format!("章节-{index:05}.md")),
            format!("第{index}章。陆沉舟站在窗前，想起营销那件事。\n"),
        )
        .unwrap();
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

    let cold = Instant::now();
    let rows = store.refresh_documents().unwrap();
    let cold = cold.elapsed();
    assert_eq!(rows.len(), DOCUMENTS);

    let warm = Instant::now();
    for _ in 0..REFRESHES {
        store.refresh_documents().unwrap();
    }
    let warm = warm.elapsed();

    // 第一次检索付索引的钱。
    let first_search = Instant::now();
    let hits = store.search_documents("营销", 20).unwrap();
    let first_search = first_search.elapsed();
    assert!(!hits.is_empty(), "正文检索应当命中");

    // 之后的检索不再付。
    let later_search = Instant::now();
    let again = store.search_documents("营销", 20).unwrap();
    let later_search = later_search.elapsed();
    assert_eq!(again.len(), hits.len());

    println!("PROBE 文档数            = {DOCUMENTS}");
    println!("PROBE 首次刷新          = {:?}", cold);
    println!("PROBE 之后 {REFRESHES} 次刷新合计 = {:?}", warm);
    println!("PROBE 每次热刷新        = {:?}", warm / REFRESHES as u32);
    println!("PROBE 第一次检索(含建索引) = {:?}", first_search);
    println!("PROBE 之后的检索        = {:?}", later_search);

    // Windows 上文件句柄不解就删目录会吃到 code 32；先放掉现场再清。
    drop(store);
    fs::remove_dir_all(root).unwrap();

    // 判据一：热刷新绝不该与建索引同量级。
    // 索引若挂在对账上，每次热刷新都要读 DOCUMENTS 个文件。
    let per_refresh = warm / REFRESHES as u32;
    assert!(
        per_refresh * 4 < first_search,
        "热刷新 {per_refresh:?} 与建索引 {first_search:?} 同量级——索引又被挂到对账上了"
    );

    // 判据二：建索引必须是批量事务。
    //
    // 这条是绝对上限而不是比值，因为**比值抓不到它**：逐份 fsync 时热刷新与
    // 建索引会一起变慢，比值照样成立。实测两千份在一个事务里是 43.6ms，
    // 而每份各自 fsync 是 22.1 秒——五百倍，中间没有灰色地带。
    //
    // 两千份对应约 4000 次 fsync。放宽到 2 秒（实测值的 45 倍）是为了让
    // 慢盘或高负载不会误报，同时离 22 秒仍有十倍余量。
    assert!(
        first_search < std::time::Duration::from_secs(2),
        "建索引花了 {first_search:?}——每份文档各自 fsync 了。整批必须包在一个事务里"
    );
}
