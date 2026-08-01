//! 1TB 语料、每章一次命中：7330 万条命中怎么排。
//!
//! 命中密度从每 100 万字一次调到每章一次后，尺度扩大 73 倍，
//! 而**问题的性质随之改变**：
//!
//!   100 万条命中：倒排表 8MB，Candidate 物化后 80MB —— 全放得进内存，
//!                 问题是「怎么最快从 100 万里挑 20 条」。
//!   7330 万条命中：倒排表 0.59GB，Candidate 物化后 **5.9GB** —— 本机可用
//!                 内存 10GB，物化即使勉强放得下也已经在换页边缘。
//!
//! 所以这一档的答案不是换更快的排序算法，而是**根本不物化**：
//! 命中从倒排表流出来，边流边打分，只留最好的 k 条。定长堆天生适合这个形状
//! ——它的内存是 O(k) 而不是 O(n)，7330 万条流过去只占 20 条的空间。
//!
//! 这个 bench 对比三种做法在流式约束下的表现，并测出物化的真实代价。

use refrain_core::block_shape::{BlockKind, HeadingLevel};
use refrain_core::role::DocumentRole;
use refrain_core::search_rank::{Candidate, PathMatch, score};
use std::cmp::Ordering;
use std::collections::BinaryHeap;
use std::time::Instant;

/// 打分不需要整条候选——只要能算分的那几个字段。
///
/// 这个 bench 里**没有**「造一条完整 Candidate」的函数，那件事本身就是结论：
/// 7330 万条各分配一个 `String` 是 5.9GB，而分数根本用不到路径的内容。
///
/// 这是流式路径上最要紧的一条：`path` 是 `String`，为 7330 万条各分配一次
/// 堆内存是纯粹的浪费，而分数根本用不到路径的内容，只在并列时用来定序。
#[inline]
fn score_at(i: usize) -> f64 {
    // 与 hit_at 同一套规则，但不碰 String。
    let path_match = match i % 997 {
        0 => PathMatch::Exact,
        1..=30 => PathMatch::Contains,
        _ => PathMatch::None,
    };
    let block = match i % 17 {
        0 => BlockKind::Heading(HeadingLevel::from_level(1).expect("1 is a level")),
        1 | 2 => BlockKind::Fence,
        _ => BlockKind::Paragraph,
    };
    score(&Candidate {
        path: String::new(),
        role: DocumentRole::Chapter,
        path_match,
        block,
        bm25: ((i * 7919) % 1000) as f64 / 200.0,
        days_since_edit: ((i * 31) % 3650) as f64,
    })
}

struct Entry(f64, usize);
impl PartialEq for Entry {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl Eq for Entry {}
impl PartialOrd for Entry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Entry {
    fn cmp(&self, other: &Self) -> Ordering {
        // 最小堆：堆顶是当前最差的一条，用它当门槛。
        other.0.partial_cmp(&self.0).unwrap_or(Ordering::Equal)
    }
}

/// 流式定长堆：内存 O(k)，一条也不物化。
fn streaming_heap(total: usize, wanted: usize) -> Vec<usize> {
    let mut heap: BinaryHeap<Entry> = BinaryHeap::with_capacity(wanted + 1);
    let mut gate = f64::MIN;
    for i in 0..total {
        let value = score_at(i);
        // 堆满之后先与门槛比一次。绝大多数命中在这里就被丢掉，
        // 连一次堆操作都不用做。
        if heap.len() == wanted {
            if value <= gate {
                continue;
            }
            heap.pop();
        }
        heap.push(Entry(value, i));
        if heap.len() == wanted {
            gate = heap.peek().map_or(f64::MIN, |e| e.0);
        }
    }
    let mut out: Vec<(f64, usize)> = heap.into_iter().map(|e| (e.0, e.1)).collect();
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal));
    out.into_iter().map(|(_, i)| i).collect()
}

/// 分块并行 + 归并：把命中区间切给多核，每核一个定长堆，最后归并。
fn parallel_heap(total: usize, wanted: usize, threads: usize) -> Vec<usize> {
    let chunk = total.div_ceil(threads);
    let partials: Vec<Vec<(f64, usize)>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                scope.spawn(move || {
                    let start = t * chunk;
                    let end = ((t + 1) * chunk).min(total);
                    let mut heap: BinaryHeap<Entry> = BinaryHeap::with_capacity(wanted + 1);
                    let mut gate = f64::MIN;
                    for i in start..end {
                        let value = score_at(i);
                        if heap.len() == wanted {
                            if value <= gate {
                                continue;
                            }
                            heap.pop();
                        }
                        heap.push(Entry(value, i));
                        if heap.len() == wanted {
                            gate = heap.peek().map_or(f64::MIN, |e| e.0);
                        }
                    }
                    heap.into_iter().map(|e| (e.0, e.1)).collect::<Vec<_>>()
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });

    let mut merged: Vec<(f64, usize)> = partials.into_iter().flatten().collect();
    merged.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal));
    merged.truncate(wanted);
    merged.into_iter().map(|(_, i)| i).collect()
}

/// 物化全部候选再排——本档要测的正是它有多不可行。
fn materialise_and_sort(total: usize, wanted: usize) -> (Vec<usize>, f64) {
    let start = Instant::now();
    let mut scored: Vec<(f64, usize)> = (0..total).map(|i| (score_at(i), i)).collect();
    let built = start.elapsed().as_secs_f64() * 1000.0;
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal));
    scored.truncate(wanted);
    (scored.into_iter().map(|(_, i)| i).collect(), built)
}

fn main() {
    // 7330 万章 = 1TB ÷ 每章 5000 字 ÷ 每字 3 字节。
    const TOTAL: usize = 73_300_775;
    const WANTED: usize = 20;

    println!("── 尺度 ──");
    println!("  1TB 中文 ≈ 3665 亿字 ≈ 7330 万章，主角名每章出现一次");
    println!("  命中 {TOTAL} 次");
    println!("  倒排表 8B/条 = {:.2} GB", TOTAL as f64 * 8.0 / 1e9);
    println!(
        "  Candidate 物化 ≈ 80B/条 = {:.1} GB（本机可用内存约 10GB）",
        TOTAL as f64 * 80.0 / 1e9
    );
    println!("  → 物化不可行，必须流式\n");

    println!("── 从 {TOTAL} 条命中里取前 {WANTED} 条 ──");

    let start = Instant::now();
    let streaming = streaming_heap(TOTAL, WANTED);
    let streaming_ms = start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "  流式定长堆        {streaming_ms:>9.1} ms   内存 O(k)={WANTED} 条   {:.1} M条/秒",
        TOTAL as f64 / streaming_ms / 1000.0
    );

    let threads = std::thread::available_parallelism().map_or(8, |n| n.get());
    let start = Instant::now();
    let parallel = parallel_heap(TOTAL, WANTED, threads);
    let parallel_ms = start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "  并行定长堆 ×{threads:<3}    {parallel_ms:>9.1} ms   比单线程快 {:.1}×   {:.1} M条/秒",
        streaming_ms / parallel_ms,
        TOTAL as f64 / parallel_ms / 1000.0
    );

    let start = Instant::now();
    let (materialised, build_ms) = materialise_and_sort(TOTAL, WANTED);
    let material_ms = start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "  物化后全排序      {material_ms:>9.1} ms   其中建表 {build_ms:.0} ms   峰值内存 {:.2} GB",
        TOTAL as f64 * 16.0 / 1e9
    );
    println!(
        "                              比流式慢 {:.1}×，比并行慢 {:.1}×",
        material_ms / streaming_ms,
        material_ms / parallel_ms
    );

    println!("\n── 正确性对拍（三者必须给出同一批前 {WANTED} 条）──");
    println!(
        "  流式 vs 物化   {}",
        if streaming == materialised {
            "一致 ✓"
        } else {
            "不一致 ✗"
        }
    );
    println!(
        "  并行 vs 物化   {}",
        if parallel == materialised {
            "一致 ✓"
        } else {
            "不一致 ✗"
        }
    );
}
