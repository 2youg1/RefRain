//! 排序的实际耗时：全排序 vs 只取前 N。
//!
//! 搜索框只显示一屏，Agent 只读几条——全排序是没人看的工作。
//! 这个 bench 就是要用数字回答「选择比排序快多少」。

use refrain_core::block_shape::{BlockKind, HeadingLevel};
use refrain_core::role::DocumentRole;
use refrain_core::search_rank::{Candidate, PathMatch, rank, rank_top};
use std::time::Instant;

fn pool(n: usize) -> Vec<Candidate> {
    (0..n)
        .map(|i| Candidate {
            path: format!("第{i}章-某个标题"),
            role: if i % 5 == 0 {
                DocumentRole::Material
            } else {
                DocumentRole::Chapter
            },
            path_match: match i % 7 {
                0 => PathMatch::Exact,
                1 | 2 => PathMatch::Contains,
                _ => PathMatch::None,
            },
            block: match i % 3 {
                0 => BlockKind::Heading(HeadingLevel::from_level(1).expect("1 is a level")),
                1 => BlockKind::Fence,
                _ => BlockKind::Paragraph,
            },
            bm25: (i % 13) as f64 * 0.37,
            days_since_edit: (i % 400) as f64,
        })
        .collect()
}

fn worst_micros(base: &[Candidate], rounds: usize, mut run: impl FnMut(&mut [Candidate])) -> f64 {
    let mut worst = 0u128;
    for _ in 0..rounds {
        let mut candidates = base.to_vec();
        let start = Instant::now();
        run(&mut candidates);
        worst = worst.max(start.elapsed().as_nanos());
    }
    worst as f64 / 1000.0
}

fn main() {
    println!("── 全排序 vs 只取前 20（每档 100 轮取最慢）──");
    for n in [100usize, 1_000, 10_000, 100_000] {
        let base = pool(n);
        let full = worst_micros(&base, 100, rank);
        let top = worst_micros(&base, 100, |candidates: &mut [Candidate]| {
            rank_top(candidates, 20)
        });
        println!(
            "{n:7} 候选   全排序 {full:>9.1}µs   前 20 条 {top:>8.1}µs   快 {:.1}×",
            full / top
        );
    }
}
