//! Ranking search results for a writer.
//!
//! # Why BM25 alone is not enough
//!
//! Measured on a Chinese corpus (`review/search-probe-results.md`): searching
//! 「营销」 returns four documents that each contain the word exactly once, so
//! BM25 scores them all at -0.000. That is BM25 working correctly — it reads
//! term frequency and document length, and by those measures the four really
//! are equal. It is also useless to the author, who wants the character sheet
//! before the chapter that mentions the word in passing.
//!
//! So the score combines several signals. Each one is capped, which is the
//! whole point of the design: a long chapter that repeats a word twenty times
//! must not outrank a short title that matches it exactly. Without caps, body
//! frequency dominates every other signal, and that is precisely the failure
//! mode BM25 alone exhibits.
//!
//! # Why these signals
//!
//! Every signal comes from something the project already knows. Nothing here
//! requires new data collection:
//!
//! - The path is in `documents`.
//! - The block kind comes from `SourceLayout`, which decides it while finding
//!   block boundaries anyway.
//! - The role (chapter or material) is in `documents`.
//! - BM25 comes from the FTS index.
//!
//! # What this module does not do
//!
//! It does not retrieve. It scores candidates a retriever already found, so it
//! stays a pure function of its inputs and can be tested without a database.

use crate::block_shape::BlockKind;
use crate::role::DocumentRole;

/// Where a match was found, and what the surrounding structure says about it.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// The document's path, as the author sees it.
    pub path: String,
    /// Whether this is a chapter of the manuscript or a piece of material.
    pub role: DocumentRole,
    /// How the query relates to the path itself.
    pub path_match: PathMatch,
    /// The kind of block the match landed in.
    pub block: BlockKind,
    /// FTS5's bm25, already negated so that larger means better. Zero when the
    /// retriever found this candidate by other means, or when every candidate
    /// tied — both are common and neither is an error.
    pub bm25: f64,
    /// Days since the author last edited this document.
    pub days_since_edit: f64,
}

/// How a query relates to a document's path.
///
/// Kept as an enum rather than a boolean because the three cases earn very
/// different weight: an author typing 「第三章」 wants the chapter titled that,
/// not the chapter that mentions it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathMatch {
    /// The path is exactly the query.
    Exact,
    /// The query appears somewhere in the path.
    Contains,
    /// The query does not appear in the path at all.
    None,
}

/// Each signal's ceiling.
///
/// The caps are the design. Their ratios say what matters to a writer looking
/// for their own words: an exact title beats everything, a title that contains
/// the query beats a body match, and no amount of body repetition catches up.
mod cap {
    /// An exact path match is as close to certainty as this system gets.
    pub const PATH_EXACT: f64 = 10.0;
    /// The query appears in the title the author chose.
    pub const PATH_CONTAINS: f64 = 6.0;
    /// A heading inside the document — the author's own structure.
    pub const HEADING: f64 = 4.0;
    /// Body text. Capped low on purpose: this is the signal that runs away.
    pub const BODY: f64 = 3.0;
    /// Recency. A document edited today is likelier to be the one in mind,
    /// but only as a tiebreaker — the author may well be looking for something
    /// they wrote years ago.
    pub const RECENCY: f64 = 1.5;

    /// The ratios are the argument this ranking makes, so the compiler holds
    /// them rather than a test: an exact title outranks a partial one, a title
    /// the author chose outranks structure inside the document, a heading they
    /// wrote outranks running prose, and recency only ever breaks ties.
    ///
    /// A runtime assertion on constants is a no-op clippy rightly rejects.
    /// Failing to compile is the stronger guarantee anyway.
    const _ORDERED: () = {
        assert!(PATH_EXACT > PATH_CONTAINS);
        assert!(PATH_CONTAINS > HEADING);
        assert!(HEADING > BODY);
        assert!(RECENCY < BODY);
    };
}

/// How fast the recency bonus decays, in days.
///
/// Two weeks: within a writing session's working set the bonus is nearly full,
/// and by the time a chapter is a season old it contributes almost nothing.
const RECENCY_HALF_LIFE_DAYS: f64 = 14.0;

/// The score for one candidate. Larger is better.
///
/// The BM25 contribution is squashed into `cap::BODY` rather than added
/// directly, because BM25's range depends on corpus statistics that shift as
/// the project grows — an uncapped term would silently change the ranking's
/// balance as the author writes more.
pub fn score(candidate: &Candidate) -> f64 {
    let path = match candidate.path_match {
        PathMatch::Exact => cap::PATH_EXACT,
        PathMatch::Contains => cap::PATH_CONTAINS,
        PathMatch::None => 0.0,
    };

    // No catch-all: BlockKind is a closed set, and a new variant must force a
    // decision here rather than silently scoring zero.
    let structure = match candidate.block {
        // The author wrote this heading to mark where something is.
        BlockKind::Heading => cap::HEADING,
        // A fence is a deliberate insertion — code, a quoted document — and
        // carries more intent than running prose.
        BlockKind::Fence => cap::BODY * 0.75,
        BlockKind::Paragraph => 0.0,
    };

    let body = squash(candidate.bm25.max(0.0), cap::BODY);
    let recency = cap::RECENCY * 0.5_f64.powf(candidate.days_since_edit / RECENCY_HALF_LIFE_DAYS);

    path + structure + body + recency
}

/// Map an unbounded non-negative value into `[0, ceiling)`.
///
/// Monotonic, so ordering within the signal is preserved; asymptotic, so no
/// input can push past the ceiling. This is what keeps a chapter that repeats
/// a word from outranking the character sheet named after it.
fn squash(value: f64, ceiling: f64) -> f64 {
    ceiling * (value / (value + 1.0))
}

/// Sort candidates best-first.
///
/// Ties break on path, ascending, so the order is total and repeatable: an
/// author who runs the same search twice must see the same list, and a test
/// that asserts an order must not depend on the retriever's whims.
///
/// Scores are computed once per candidate rather than inside the comparator.
/// A comparison sort calls its comparator O(n log n) times, so scoring there
/// costs about thirteen scores per candidate at ten thousand candidates —
/// paying for the same arithmetic thirteen times over.
pub fn rank(candidates: &mut [Candidate]) {
    // Decorate-sort-undecorate. The index keeps the sort stable in the sense
    // that matters here: equal scores fall back to the path comparison, and
    // the path comparison is total.
    let mut scored: Vec<(f64, usize)> = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| (score(candidate), index))
        .collect();

    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .partial_cmp(left_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            // Compared left-to-right here, not right-to-left as the scores
            // are: the score is descending, the tiebreak ascending.
            .then_with(|| candidates[*left].path.cmp(&candidates[*right].path))
    });

    apply_permutation(candidates, &scored);
}

/// Put the best `wanted` candidates first, in order, and leave the rest
/// unordered behind them.
///
/// A search box shows a screenful and an agent reads a handful, so ordering the
/// whole pool is work nobody reads. Selection is O(n) where a full sort is
/// O(n log n): partition around the k-th score, then sort only what is in
/// front of it. This is the same shape as the top-k selection literature —
/// find the pivot rank, keep what beats it, order only that.
///
/// Falls through to `rank` when the caller wants everything, since selection
/// followed by sorting the whole prefix is strictly more work than sorting.
pub fn rank_top(candidates: &mut [Candidate], wanted: usize) {
    if wanted >= candidates.len() {
        rank(candidates);
        return;
    }
    if wanted == 0 {
        return;
    }

    let mut scored: Vec<(f64, usize)> = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| (score(candidate), index))
        .collect();

    // Partition so that the `wanted` best scores sit in front. Ties on score
    // are settled by path here as well, so a candidate cannot cross the
    // boundary depending on which side of the pivot the partition put it.
    let compare = |left: &(f64, usize), right: &(f64, usize)| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| candidates[left.1].path.cmp(&candidates[right.1].path))
    };
    scored.select_nth_unstable_by(wanted - 1, compare);
    scored[..wanted].sort_by(compare);

    apply_permutation(candidates, &scored);
}

/// Reorder `candidates` in place to match the order in `scored`.
///
/// Follows each permutation cycle rather than allocating a second vector of
/// candidates, which matters because a candidate owns its path string: a naive
/// rebuild clones every string, and the strings are the largest thing here.
fn apply_permutation(candidates: &mut [Candidate], scored: &[(f64, usize)]) {
    let mut target: Vec<usize> = vec![0; scored.len()];
    for (position, (_, source)) in scored.iter().enumerate() {
        target[*source] = position;
    }
    for index in 0..candidates.len() {
        while target[index] != index {
            let destination = target[index];
            candidates.swap(index, destination);
            target.swap(index, destination);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(path: &str) -> Candidate {
        Candidate {
            path: path.to_string(),
            role: DocumentRole::Chapter,
            path_match: PathMatch::None,
            block: BlockKind::Paragraph,
            bm25: 0.0,
            days_since_edit: 365.0,
        }
    }

    /// The case that motivated this module.
    ///
    /// Measured on a real Chinese corpus: searching 「营销」 finds the word once
    /// in each of four documents, so BM25 scores every one of them -0.000.
    /// The author wants the character sheet whose title says 「人物志」, and BM25
    /// has no way to know that. The path signal does.
    #[test]
    fn a_title_match_wins_when_bm25_ties_at_zero() {
        let mut found = vec![
            Candidate {
                bm25: 0.0,
                ..candidate("第二章-长夜")
            },
            Candidate {
                bm25: 0.0,
                ..candidate("第三章-旧信")
            },
            Candidate {
                path_match: PathMatch::Contains,
                bm25: 0.0,
                ..candidate("资料-营销人物志")
            },
            Candidate {
                bm25: 0.0,
                ..candidate("资料-年表")
            },
        ];
        rank(&mut found);
        assert_eq!(found[0].path, "资料-营销人物志");
    }

    /// The failure mode caps exist to prevent.
    ///
    /// A chapter that repeats a word twenty times must not outrank the short
    /// document named after it. Uncapped BM25 does exactly that, and it is the
    /// single most common complaint about naive lexical ranking.
    #[test]
    fn body_repetition_never_beats_a_title() {
        let mut found = vec![
            Candidate {
                bm25: 200.0,
                ..candidate("第七章-很长的一章")
            },
            Candidate {
                path_match: PathMatch::Exact,
                bm25: 0.0,
                ..candidate("营销")
            },
        ];
        rank(&mut found);
        assert_eq!(found[0].path, "营销");
    }

    #[test]
    fn an_exact_title_beats_a_partial_one() {
        let mut found = vec![
            Candidate {
                path_match: PathMatch::Contains,
                ..candidate("第三章-停留与远行")
            },
            Candidate {
                path_match: PathMatch::Exact,
                ..candidate("停留")
            },
        ];
        rank(&mut found);
        assert_eq!(found[0].path, "停留");
    }

    #[test]
    fn a_heading_hit_beats_a_paragraph_hit() {
        // The author wrote the heading to mark where something is.
        let mut found = vec![
            Candidate {
                block: BlockKind::Paragraph,
                bm25: 1.0,
                ..candidate("甲")
            },
            Candidate {
                block: BlockKind::Heading,
                bm25: 1.0,
                ..candidate("乙")
            },
        ];
        rank(&mut found);
        assert_eq!(found[0].path, "乙");
    }

    #[test]
    fn bm25_still_orders_candidates_that_differ_only_in_it() {
        // Capping BM25 must not flatten it: where it does discriminate, it
        // has to keep discriminating.
        let mut found = vec![
            Candidate {
                bm25: 0.58,
                ..candidate("第四章-远行")
            },
            Candidate {
                bm25: 0.76,
                ..candidate("第一章-停留")
            },
        ];
        rank(&mut found);
        assert_eq!(found[0].path, "第一章-停留");
    }

    #[test]
    fn recency_breaks_a_tie_but_cannot_overturn_a_title() {
        let mut stale_title = candidate("营销");
        stale_title.path_match = PathMatch::Exact;
        stale_title.days_since_edit = 3650.0;
        let fresh_body = Candidate {
            days_since_edit: 0.0,
            bm25: 5.0,
            ..candidate("今天写的")
        };

        let mut found = vec![fresh_body, stale_title];
        rank(&mut found);
        // A decade-old chapter the author named 「营销」 still wins.
        assert_eq!(found[0].path, "营销");
    }

    #[test]
    fn recency_does_decide_when_everything_else_is_equal() {
        let mut found = vec![
            Candidate {
                days_since_edit: 200.0,
                ..candidate("旧稿")
            },
            Candidate {
                days_since_edit: 0.0,
                ..candidate("今天")
            },
        ];
        rank(&mut found);
        assert_eq!(found[0].path, "今天");
    }

    #[test]
    fn each_signal_alone_produces_the_ordering_it_claims() {
        let with = |path_match: PathMatch, block: BlockKind| Candidate {
            path_match,
            block,
            ..candidate("同名")
        };
        // Path signal, holding everything else equal.
        assert!(
            score(&with(PathMatch::Exact, BlockKind::Paragraph))
                > score(&with(PathMatch::Contains, BlockKind::Paragraph))
        );
        assert!(
            score(&with(PathMatch::Contains, BlockKind::Paragraph))
                > score(&with(PathMatch::None, BlockKind::Paragraph))
        );
        // Block signal, holding everything else equal.
        assert!(
            score(&with(PathMatch::None, BlockKind::Heading))
                > score(&with(PathMatch::None, BlockKind::Fence))
        );
        assert!(
            score(&with(PathMatch::None, BlockKind::Fence))
                > score(&with(PathMatch::None, BlockKind::Paragraph))
        );
    }

    #[test]
    fn no_signal_can_exceed_its_cap() {
        let absurd = Candidate {
            bm25: f64::MAX,
            ..candidate("甲")
        };
        let ceiling = cap::PATH_EXACT + cap::HEADING + cap::BODY + cap::RECENCY;
        assert!(score(&absurd) < ceiling);
    }

    #[test]
    fn ordering_is_total_so_the_same_search_gives_the_same_list() {
        // Two candidates identical in every signal must still order
        // deterministically, or the author sees the list shuffle on re-search.
        let mut once = vec![candidate("乙"), candidate("甲")];
        let mut twice = vec![candidate("甲"), candidate("乙")];
        rank(&mut once);
        rank(&mut twice);
        assert_eq!(once[0].path, twice[0].path);
        // 乙 is U+4E59 and 甲 is U+7532: the tiebreak is codepoint order, not
        // the order the two characters have in the sexagenary cycle. Asserting
        // the latter is how this test first failed.
        assert_eq!(once[0].path, "乙");
    }

    /// Selection must agree with sorting on the part the author sees.
    ///
    /// This is the whole safety argument for the fast path: it may leave the
    /// tail in any order, but the prefix must be exactly what a full sort
    /// would have produced, or the speedup is bought with wrong answers.
    #[test]
    fn taking_the_top_agrees_with_sorting_everything() {
        let build = || {
            (0..200)
                .map(|i| Candidate {
                    path: format!("第{i}章"),
                    role: DocumentRole::Chapter,
                    path_match: match i % 7 {
                        0 => PathMatch::Exact,
                        1 | 2 => PathMatch::Contains,
                        _ => PathMatch::None,
                    },
                    block: match i % 3 {
                        0 => BlockKind::Heading,
                        1 => BlockKind::Fence,
                        _ => BlockKind::Paragraph,
                    },
                    bm25: (i % 13) as f64 * 0.37,
                    days_since_edit: (i % 400) as f64,
                })
                .collect::<Vec<_>>()
        };

        for wanted in [1usize, 5, 20, 199] {
            let mut sorted = build();
            rank(&mut sorted);
            let mut selected = build();
            rank_top(&mut selected, wanted);
            let sorted_paths: Vec<&str> =
                sorted[..wanted].iter().map(|c| c.path.as_str()).collect();
            let selected_paths: Vec<&str> =
                selected[..wanted].iter().map(|c| c.path.as_str()).collect();
            assert_eq!(selected_paths, sorted_paths, "top {wanted} disagreed");
        }
    }

    #[test]
    fn asking_for_everything_still_sorts_everything() {
        let mut found = vec![
            candidate("丙"),
            Candidate {
                path_match: PathMatch::Exact,
                ..candidate("甲")
            },
            candidate("乙"),
        ];
        let total = found.len();
        rank_top(&mut found, total);
        assert_eq!(found[0].path, "甲");
        // Asking beyond the end must not panic either.
        rank_top(&mut found, total + 10);
        assert_eq!(found[0].path, "甲");
    }

    #[test]
    fn asking_for_nothing_does_nothing() {
        let mut found = vec![candidate("甲"), candidate("乙")];
        let before: Vec<String> = found.iter().map(|c| c.path.clone()).collect();
        rank_top(&mut found, 0);
        let after: Vec<String> = found.iter().map(|c| c.path.clone()).collect();
        assert_eq!(after, before);
    }

    #[test]
    fn an_empty_result_set_is_not_an_error() {
        let mut nothing: Vec<Candidate> = vec![];
        rank(&mut nothing);
        assert!(nothing.is_empty());
    }
}
