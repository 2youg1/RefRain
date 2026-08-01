//! Relations between the Runs of one Task.
//!
//! # What was missing
//!
//! `AuthorizeDispatch` opens one Run per agent, and those Runs are parallel,
//! unordered, and unaware of each other. That expresses exactly one kind of
//! collaboration: ask N agents the same question and let the author pick. It
//! cannot express "one drafts an outline, another writes to it", nor "one
//! writes and another only checks".
//!
//! # Why edges rather than an orchestration framework
//!
//! LangGraph and its kin solve persistence, checkpointing and recovery — all
//! of which this codebase already has in `HostJournal`, which is the append-
//! only record the whole application recovers from. Adding a second runtime
//! would move orchestration state out of the journal, and the journal is the
//! reason a crashed Run can be resumed at all. Three edges are enough for
//! every case the design named, and each one is a variant the compiler makes
//! you handle.
//!
//! # Why edges point at positions, not Run ids
//!
//! A Task's first authorization *mints* its Runs: their ids are generated
//! inside `execute`, so nothing the author clicked can name them. An edge is
//! therefore expressed against the position of an agent in `new_agents` —
//! "the second one follows the first" — and resolved to ids at the moment
//! they exist. This also makes the cycle check a pure question about the
//! request, answerable before anything is written down.
//!
//! # Why the cycle check happens at authorization
//!
//! `DispatchAuthorization` is immutable (INV-14): it records what the author
//! clicked. An authorization holding a cycle could never be withdrawn, only
//! refused over and over at execution time — a statically decidable error
//! left to run time. So it is decided before the record exists.

use refrain_core::Id;
use serde::{Deserialize, Serialize};

/// How one Run relates to another within the same Task.
///
/// Each variant earns its place with a case the design named, and each
/// carries the invariant that makes it checkable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "value")]
pub enum RunEdge {
    /// This Run may only be authorized once the upstream Run is terminal, and
    /// the upstream's output enters this Run's request.
    ///
    /// The author's case: draft an outline, then write to it. Cognition's
    /// first principle applies here — the downstream must see the upstream's
    /// *whole* output, not a summary of it, or it is completing a judgement
    /// it never read. That is why the material compression of the first part
    /// does not apply to this edge: reference material is what an agent
    /// *might* need, an upstream artifact is what it must understand.
    Follows { upstream: usize },
    /// This Run reads another's output and may only comment on it.
    ///
    /// The standing guidance: "Separate, fresh-context verifier
    /// subagents tend to outperform self-critique." Their Opus 5 guidance
    /// says the opposite — do not use subagents to verify your own work.
    /// That is not a contradiction but a difference between models, which is
    /// why whether to use this edge belongs to an agent's connection
    /// configuration rather than being hard-coded here.
    Verifies { subject: usize },
    /// This Run answers the same question as another, without seeing it.
    ///
    /// The existing star-shaped behaviour, now named. Naming it is what makes
    /// "they cannot see each other" an invariant a test can check rather than
    /// an accident of how the code happens to be written.
    Alternates { peer: usize },
}

impl RunEdge {
    /// The position this edge points at.
    #[must_use]
    pub const fn target(self) -> usize {
        match self {
            Self::Follows { upstream } => upstream,
            Self::Verifies { subject } => subject,
            Self::Alternates { peer } => peer,
        }
    }

    /// Whether this edge orders execution.
    ///
    /// `Follows` and `Verifies` both require their target to finish first —
    /// one to read its artifact, the other to check it. `Alternates` does
    /// not: that is the whole of its meaning.
    #[must_use]
    pub const fn waits_for_target(self) -> bool {
        matches!(self, Self::Follows { .. } | Self::Verifies { .. })
    }

    /// The wire spelling, in one place.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Follows { .. } => "follows",
            Self::Verifies { .. } => "verifies",
            Self::Alternates { .. } => "alternates",
        }
    }
}

/// What is wrong with a proposed set of edges.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EdgeRefusal {
    #[error("edge {at} points at position {target}, but only {count} runs were requested")]
    OutOfRange {
        at: usize,
        target: usize,
        count: usize,
    },
    #[error("edge {at} points at itself")]
    SelfEdge { at: usize },
    #[error("edges form a cycle: {}", render_cycle(.positions))]
    Cycle { positions: Vec<usize> },
}

fn render_cycle(positions: &[usize]) -> String {
    positions
        .iter()
        .map(usize::to_string)
        .collect::<Vec<_>>()
        .join(" → ")
}

/// Check a proposed edge set before anything is written down.
///
/// `edges[i]` is the edge belonging to the run at position `i`; `None` means
/// that run has no relation to any other, which is the ordinary case and the
/// shape every existing caller produces.
///
/// Returns the order in which the runs may be authorized: an ordering that
/// puts every waited-for run before the run waiting on it. That the ordering
/// exists is the same fact as the graph being acyclic, so one traversal
/// answers both questions.
pub fn resolve_order(edges: &[Option<RunEdge>]) -> Result<Vec<usize>, EdgeRefusal> {
    let count = edges.len();
    for (at, edge) in edges.iter().enumerate() {
        let Some(edge) = edge else { continue };
        let target = edge.target();
        if target >= count {
            return Err(EdgeRefusal::OutOfRange { at, target, count });
        }
        if target == at {
            return Err(EdgeRefusal::SelfEdge { at });
        }
    }

    // Depth-first with an explicit colour per node: white unvisited, grey on
    // the current path, black finished. Grey-on-grey is a cycle, and the path
    // that found it is what the refusal reports — an author told "there is a
    // cycle" cannot act, one told "0 → 2 → 0" can.
    #[derive(Clone, Copy, PartialEq)]
    enum Colour {
        White,
        Grey,
        Black,
    }
    let mut colour = vec![Colour::White; count];
    let mut order = Vec::with_capacity(count);

    for start in 0..count {
        if colour[start] != Colour::White {
            continue;
        }
        // An explicit stack rather than recursion: a Task with ten thousand
        // runs must refuse cleanly rather than overflow the real stack.
        let mut path: Vec<usize> = vec![start];
        colour[start] = Colour::Grey;
        while let Some(&node) = path.last() {
            let next = edges[node]
                .filter(|edge| edge.waits_for_target())
                .map(RunEdge::target);
            match next {
                Some(target) if colour[target] == Colour::Grey => {
                    // The cycle is the grey suffix of the current path.
                    let from = path.iter().position(|&seen| seen == target).unwrap_or(0);
                    let mut positions = path[from..].to_vec();
                    positions.push(target);
                    return Err(EdgeRefusal::Cycle { positions });
                }
                Some(target) if colour[target] == Colour::White => {
                    colour[target] = Colour::Grey;
                    path.push(target);
                }
                _ => {
                    colour[node] = Colour::Black;
                    order.push(node);
                    path.pop();
                }
            }
        }
    }

    Ok(order)
}

/// Which runs may be authorized right now, given what has already finished.
///
/// A run whose edge waits on another may only go once that other is terminal.
/// `terminal` answers, for a position, whether that run has finished.
pub fn ready_positions(edges: &[Option<RunEdge>], terminal: &impl Fn(usize) -> bool) -> Vec<usize> {
    (0..edges.len())
        .filter(|&at| match edges[at] {
            Some(edge) if edge.waits_for_target() => terminal(edge.target()),
            _ => true,
        })
        .collect()
}

/// The Runs that must not see each other's output.
///
/// Two runs are mutually invisible when either declares the other a peer.
/// Declaring it on one side is enough: an author marking B an alternative of
/// A means the two are alternatives, and requiring both sides to say so would
/// make the invariant depend on redundant bookkeeping.
#[must_use]
pub fn alternates_of(edges: &[Option<RunEdge>], at: usize) -> Vec<usize> {
    let mut peers = Vec::new();
    if let Some(RunEdge::Alternates { peer }) = edges.get(at).copied().flatten() {
        peers.push(peer);
    }
    for (other, edge) in edges.iter().enumerate() {
        if other == at {
            continue;
        }
        if let Some(RunEdge::Alternates { peer }) = edge
            && *peer == at
            && !peers.contains(&other)
        {
            peers.push(other);
        }
    }
    peers.sort_unstable();
    peers
}

/// A Run's edge once its ids exist.
///
/// The positions of the request become the ids of the minted Runs. Kept
/// separate from `RunEdge` so the type itself says whether it has been
/// resolved: a position and an id are not interchangeable, and a bug that
/// confused them would be silent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "value")]
pub enum ResolvedEdge {
    Follows { upstream: Id },
    Verifies { subject: Id },
    Alternates { peer: Id },
}

/// Bind edges to the Run ids that were minted for them.
///
/// Returns `None` when a position has no edge, keeping the two vectors
/// aligned so a caller can zip them with the runs.
#[must_use]
pub fn resolve_edges(edges: &[Option<RunEdge>], ids: &[Id]) -> Vec<Option<ResolvedEdge>> {
    edges
        .iter()
        .map(|edge| {
            let edge = (*edge)?;
            let target = *ids.get(edge.target())?;
            Some(match edge {
                RunEdge::Follows { .. } => ResolvedEdge::Follows { upstream: target },
                RunEdge::Verifies { .. } => ResolvedEdge::Verifies { subject: target },
                RunEdge::Alternates { .. } => ResolvedEdge::Alternates { peer: target },
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 判据 2-7：星形不回归。没有边的一组 Run 全部可以立刻授权。
    #[test]
    fn runs_without_edges_are_all_ready_at_once() {
        let edges = vec![None, None, None];
        let order = resolve_order(&edges).expect("无边即无环");
        assert_eq!(order.len(), 3);
        let ready = ready_positions(&edges, &|_| false);
        assert_eq!(ready, vec![0, 1, 2], "星形扇出不应被任何边挡住");
    }

    /// `Alternates` 是既有行为的显式命名，不是一条新的执行路径。
    #[test]
    fn alternates_do_not_order_execution() {
        let edges = vec![
            Some(RunEdge::Alternates { peer: 1 }),
            Some(RunEdge::Alternates { peer: 0 }),
        ];
        resolve_order(&edges).expect("并列不构成环");
        // 谁都不等谁：两条都能立刻跑，这正是星形的语义。
        assert_eq!(ready_positions(&edges, &|_| false), vec![0, 1]);
    }

    /// 判据 2-6 的地基：互为并列的 Run 能被查出来，供「互不可见」断言使用。
    #[test]
    fn peers_are_mutual_even_when_declared_on_one_side() {
        // 只有 1 声明了 0 是它的并列方。
        let edges = vec![None, Some(RunEdge::Alternates { peer: 0 })];
        assert_eq!(alternates_of(&edges, 0), vec![1], "单侧声明也要成立");
        assert_eq!(alternates_of(&edges, 1), vec![0]);
    }

    /// `Follows` 排出执行次序：上游先，下游后。
    #[test]
    fn following_puts_the_upstream_first() {
        // 1 跟随 0；2 跟随 1。
        let edges = vec![
            None,
            Some(RunEdge::Follows { upstream: 0 }),
            Some(RunEdge::Follows { upstream: 1 }),
        ];
        let order = resolve_order(&edges).expect("链不是环");
        let place = |at: usize| order.iter().position(|&seen| seen == at).unwrap();
        assert!(place(0) < place(1), "上游应排在下游之前: {order:?}");
        assert!(place(1) < place(2), "{order:?}");
    }

    /// 上游没终态时下游不可授权——这是 `Follows` 的全部约束力。
    #[test]
    fn a_follower_waits_until_its_upstream_is_terminal() {
        let edges = vec![None, Some(RunEdge::Follows { upstream: 0 })];
        assert_eq!(
            ready_positions(&edges, &|_| false),
            vec![0],
            "上游未终态时只有上游可授权"
        );
        assert_eq!(
            ready_positions(&edges, &|at| at == 0),
            vec![0, 1],
            "上游终态后下游解锁"
        );
    }

    /// 验证者同样要等它检查的对象跑完——它读的是那份产出。
    #[test]
    fn a_verifier_waits_for_what_it_verifies() {
        let edges = vec![None, Some(RunEdge::Verifies { subject: 0 })];
        assert_eq!(ready_positions(&edges, &|_| false), vec![0]);
        assert_eq!(ready_positions(&edges, &|at| at == 0), vec![0, 1]);
    }

    /// 判据 2-2：环在授权时被拒，且拒绝要说得出环在哪。
    #[test]
    fn a_cycle_is_refused_with_the_path_that_forms_it() {
        let edges = vec![
            Some(RunEdge::Follows { upstream: 2 }),
            Some(RunEdge::Follows { upstream: 0 }),
            Some(RunEdge::Follows { upstream: 1 }),
        ];
        let refusal = resolve_order(&edges).unwrap_err();
        match refusal {
            EdgeRefusal::Cycle { positions } => {
                // 三个位置都在环里，且首尾相接。
                assert!(positions.len() >= 3, "{positions:?}");
                assert_eq!(positions.first(), positions.last(), "{positions:?}");
            }
            other => panic!("应是 Cycle，实为 {other:?}"),
        }
    }

    #[test]
    fn a_two_run_cycle_is_refused() {
        let edges = vec![
            Some(RunEdge::Follows { upstream: 1 }),
            Some(RunEdge::Follows { upstream: 0 }),
        ];
        assert!(matches!(
            resolve_order(&edges),
            Err(EdgeRefusal::Cycle { .. })
        ));
    }

    /// 自环是环的退化情形，但它有自己的名字——「指向自己」比「构成环」好懂。
    #[test]
    fn an_edge_pointing_at_itself_is_refused_by_that_name() {
        let edges = vec![Some(RunEdge::Follows { upstream: 0 })];
        assert_eq!(
            resolve_order(&edges).unwrap_err(),
            EdgeRefusal::SelfEdge { at: 0 }
        );
    }

    /// 指向不存在的位置必须当场拒绝，不能悄悄忽略。
    #[test]
    fn an_edge_past_the_end_is_refused() {
        let edges = vec![None, Some(RunEdge::Follows { upstream: 7 })];
        assert_eq!(
            resolve_order(&edges).unwrap_err(),
            EdgeRefusal::OutOfRange {
                at: 1,
                target: 7,
                count: 2
            }
        );
    }

    /// 并列边不参与排序，所以两个并列的 Run 互指也不算环。
    #[test]
    fn alternates_pointing_at_each_other_are_not_a_cycle() {
        let edges = vec![
            Some(RunEdge::Alternates { peer: 1 }),
            Some(RunEdge::Alternates { peer: 0 }),
        ];
        assert!(resolve_order(&edges).is_ok());
    }

    /// 位置在 Run 铸出来之后才变成 id，两者不可混用。
    #[test]
    fn edges_bind_to_the_ids_that_were_minted_for_them() {
        let ids = vec![Id::new(), Id::new(), Id::new()];
        let edges = vec![
            None,
            Some(RunEdge::Follows { upstream: 0 }),
            Some(RunEdge::Verifies { subject: 1 }),
        ];
        let resolved = resolve_edges(&edges, &ids);
        assert_eq!(resolved[0], None);
        assert_eq!(
            resolved[1],
            Some(ResolvedEdge::Follows { upstream: ids[0] })
        );
        assert_eq!(
            resolved[2],
            Some(ResolvedEdge::Verifies { subject: ids[1] })
        );
    }

    /// 一条很长的链不能把真实调用栈压垮——十万个 Run 也要干净地给出次序。
    #[test]
    fn a_very_long_chain_resolves_without_overflowing() {
        let mut edges: Vec<Option<RunEdge>> = vec![None];
        for upstream in 0..100_000 {
            edges.push(Some(RunEdge::Follows { upstream }));
        }
        let order = resolve_order(&edges).expect("长链不是环");
        assert_eq!(order.len(), edges.len());
    }
}
