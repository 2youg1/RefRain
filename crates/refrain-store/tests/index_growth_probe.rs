//! 对拍：作者一边写一边搜时，检索的代价随语料长到哪里去。
//!
//! 现有探针都量固定规模的一次开销（`refresh_cost_probe` 量刷新与建索引的
//! 量级差，`project_performance` 量十万份的预算）。它们量不到「越用越卡」——
//! 那是一条随**会话推进**抬升的曲线，只有反复「新建一份、再搜一次」才画得出。
//!
//! 量的是这条曲线的形状，不是任何一点的绝对值：轮次翻倍时每轮的检索若也翻倍，
//! 代价就系在语料总量上而不是这一轮的改动上。
//!
//! 跑法：cargo test -p refrain-store --release --test index_growth_probe -- --nocapture

use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;
use std::fs;
use std::time::{Duration, Instant};

/// 起手已有的篇目。作者不是从空目录开始搜的。
///
/// 用 `REFRAIN_GROWTH_BASE` 换规模：同一条探针跑两个规模，才能分开「代价系在
/// 这一次改动上」与「代价系在整份语料上」——后者的耗时随基数成比例。
fn base_documents() -> usize {
    std::env::var("REFRAIN_GROWTH_BASE")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(400)
}
/// 会话里新建多少份。每一份都改变成员身份，也就都触发一次对账。
const ROUNDS: usize = 12;

fn chapter_text(index: usize) -> String {
    // 每份都长一点，好让「读全文并摘要」与「只查一行元数据」在计时上分得开。
    let mut text = format!("# 第{index}章\n\n");
    for line in 0..40 {
        text.push_str(&format!(
            "陆沉舟站在窗前，想起营销那件事。第{index}章第{line}段。雨从檐上落下来。\n"
        ));
    }
    text
}

/// 判据是一个倍数，而倍数的分母是一次两毫秒的稳态检索——它在共享 runner 上
/// 量的是那台机器的噪声。GitHub 的 windows-latest 在 debug 下读出 5.2 倍
/// （后三轮 11.46ms，稳态 2.20ms，同一轮内新建后检索在 7.39ms 与 19.59ms
/// 之间摆动），于是 `cargo test --workspace --all-targets` 从 2026-08-18 起
/// 每次推送都红在这一条上。
///
/// 门槛 4.0 是在 release 下标定的（见下方那两组实测：26.1/11.6/12.0 对
/// 2.7/1.3/1.2），debug 从来不在标定范围内；本文件开头写的跑法也是 release。
/// 所以这里补的是这条探针一直缺的那个限定，与 `project_performance.rs`、
/// `large_input_performance.rs`、`scope_scale.rs` 用的是同一条规则。
#[cfg_attr(debug_assertions, ignore = "release-only performance gate")]
#[test]
fn search_after_a_new_file_does_not_scale_with_the_whole_corpus() {
    let base_documents = base_documents();
    let root = std::env::temp_dir().join(format!("refrain-growth-probe-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    for index in 0..base_documents {
        fs::write(
            root.join(format!("章节-{index:05}.md")),
            chapter_text(index),
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

    // 开工程那一次的钱照付，不计入曲线。
    store.refresh_documents().unwrap();
    let cold_search = Instant::now();
    let hits = store.search_documents("营销", 20).unwrap();
    let cold_search = cold_search.elapsed();
    assert!(!hits.is_empty(), "正文检索应当命中");

    // 会话开始：每轮新建一份、刷新、搜一次，再紧接着搜第二次。
    // 第一次搜付的是「成员身份变了」的钱，第二次搜付的是稳态的钱。
    let mut after_new_file: Vec<Duration> = Vec::with_capacity(ROUNDS);
    let mut steady: Vec<Duration> = Vec::with_capacity(ROUNDS);
    for round in 0..ROUNDS {
        let index = base_documents + round;
        fs::write(
            root.join(format!("章节-{index:05}.md")),
            chapter_text(index),
        )
        .unwrap();
        store.refresh_documents().unwrap();

        let first = Instant::now();
        store.search_documents("营销", 20).unwrap();
        after_new_file.push(first.elapsed());

        let second = Instant::now();
        store.search_documents("营销", 20).unwrap();
        steady.push(second.elapsed());
    }

    println!("PROBE 起手篇目          = {base_documents}");
    println!("PROBE 开工程后首次检索  = {cold_search:?}");
    for round in 0..ROUNDS {
        println!(
            "PROBE 第{:02}轮 语料={:4} 新建后检索={:>12?} 稳态检索={:>10?}",
            round + 1,
            base_documents + round + 1,
            after_new_file[round],
            steady[round],
        );
    }

    let head: Duration = after_new_file[..3].iter().sum::<Duration>() / 3;
    let tail: Duration = after_new_file[ROUNDS - 3..].iter().sum::<Duration>() / 3;
    let steady_mean: Duration = steady.iter().sum::<Duration>() / ROUNDS as u32;
    println!(
        "PROBE 新建后每份摊        = {:?}",
        tail / u32::try_from(base_documents).unwrap_or(u32::MAX)
    );
    println!("PROBE 前三轮均值        = {head:?}");
    println!("PROBE 后三轮均值        = {tail:?}");
    println!("PROBE 稳态均值          = {steady_mean:?}");
    println!(
        "PROBE 新建后 / 稳态     = {:.1} 倍",
        after_new_file.iter().sum::<Duration>().as_secs_f64()
            / steady.iter().sum::<Duration>().as_secs_f64()
    );

    drop(store);
    let _ = fs::remove_dir_all(&root);

    // 判据：新建一份文档之后的那次检索，代价应当系在**这一份**上，不是整份语料上。
    //
    // 量它对**稳态检索**的倍数，不量对开工程那次的比值：后者拓不红。开工程要写
    // 全部 FTS 条目，本就比「只读不写」的重扫贵几倍，于是缺陷在场时比值依然
    // 好看。稳态检索才是干净的参系：它量的是这次查询本身，不含任何读盘。
    //
    // 实测（同一台机器，400/800/1600 份语料）：无条件判陈旧时是 26.1/11.6/12.0 倍，
    // 只欠到达那几条时是 2.7/1.3/1.2 倍。四倍落在两群之间的空地上。
    let excess = after_new_file.iter().sum::<Duration>().as_secs_f64()
        / steady.iter().sum::<Duration>().as_secs_f64();
    assert!(
        excess < 4.0,
        "新建一份后的检索是稳态检索的 {excess:.1} 倍（后三轮 {tail:?}，稳态 {steady_mean:?}，\
         开工程 {cold_search:?}）——成员身份一变就在重读整份语料"
    );
}
