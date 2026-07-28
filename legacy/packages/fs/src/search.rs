//! Matching a query against the index.
//!
//! Two matchers, chosen by what the user typed:
//!
//! - A **substring** match, through `memchr::memmem`, which selects an AVX2 or
//!   SSE2 kernel at run time. This is the path a pasted filename takes.
//! - A **subsequence** match with a gap penalty, which is what "chp1" should do
//!   to `chapter-one.md`. Ranking, not filtering, is the hard part here.
//!
//! Both run over `Entry::name_folded`, lowered once during the walk. Folding per
//! keystroke would allocate once per entry per character typed — on a workspace
//! of any size, that dominates everything else the matcher does.
//!
//! CJK note: the subsequence matcher steps over `char`, not bytes, so a query in
//! Chinese behaves the same as one in English. A byte-wise matcher would slice
//! multi-byte characters and score nonsense.

use crate::index::{Entry, Kind};
use memchr::memmem;
use rayon::prelude::*;

/// A matched entry and why it ranked where it did.
#[derive(Debug, Clone)]
pub struct Hit<'a> {
    pub entry: &'a Entry,
    pub score: i32,
    /// Character offsets into `entry.name` that matched, for highlighting.
    /// Character offsets rather than byte offsets: the renderer indexes by
    /// grapheme, and a byte offset lands mid-character in any CJK name.
    pub positions: Vec<usize>,
}

/// Score components. Public because the ranking is a product decision, and a
/// reviewer should be able to read the weights without reading the loop.
mod weight {
    /// A contiguous run is worth more than the same characters scattered.
    pub const CONTIGUOUS: i32 = 12;
    /// Matching at a word boundary is what the user usually meant.
    pub const BOUNDARY: i32 = 16;
    /// Matching the first character is a strong signal.
    pub const LEADING: i32 = 20;
    /// Every skipped character costs, so tight matches sort first.
    pub const GAP: i32 = -2;
    /// A short name matching is more relevant than a long one.
    pub const BREVITY: i32 = 8;
    /// The file the user can actually edit outranks a sibling image.
    pub const MANUSCRIPT: i32 = 6;
    /// An exact substring beats any subsequence of the same length.
    pub const SUBSTRING: i32 = 40;
}

/// True when the character before `index` ends a word, making `index` a
/// boundary. Hyphen, underscore, space, and dot are the separators that appear
/// in manuscript filenames.
fn is_boundary(previous: Option<char>) -> bool {
    match previous {
        None => true,
        Some(c) => matches!(c, '-' | '_' | ' ' | '.' | '/' | '\\'),
    }
}

/// Score a subsequence match, or `None` when the query does not fit.
///
/// One left-to-right pass. A full Smith-Waterman would score marginally better
/// and cost a matrix per candidate; on a list this size the greedy pass is the
/// right trade.
fn subsequence(needle: &str, haystack: &str) -> Option<(i32, Vec<usize>)> {
    let mut positions = Vec::with_capacity(needle.chars().count());
    let mut score = 0;
    let mut previous: Option<char> = None;
    let mut last_match: Option<usize> = None;

    let mut haystack_chars = haystack.char_indices().enumerate().peekable();

    for wanted in needle.chars() {
        let mut found = false;
        for (position, (_, actual)) in haystack_chars.by_ref() {
            if actual == wanted {
                if position == 0 {
                    score += weight::LEADING;
                } else if is_boundary(previous) {
                    score += weight::BOUNDARY;
                }

                match last_match {
                    Some(previous_position) if position == previous_position + 1 => {
                        score += weight::CONTIGUOUS;
                    }
                    Some(previous_position) => {
                        score += weight::GAP * (position - previous_position - 1).min(8) as i32;
                    }
                    None => {}
                }

                positions.push(position);
                last_match = Some(position);
                previous = Some(actual);
                found = true;
                break;
            }
            previous = Some(actual);
        }
        if !found {
            return None;
        }
    }

    let length = haystack.chars().count().max(1) as i32;
    score += (weight::BREVITY * 16) / length;
    Some((score, positions))
}

/// Run `query` over `entries` in parallel and return hits, best first.
///
/// `rayon` splits the scan across the pool. The work per entry is small, so the
/// split only pays above a few thousand entries — below that the sequential
/// path avoids the coordination entirely.
pub fn matches<'a>(entries: &'a [Entry], query: &str, limit: usize) -> Vec<Hit<'a>> {
    let query = query.trim();
    if query.is_empty() {
        return entries
            .iter()
            .take(limit)
            .map(|entry| Hit {
                entry,
                score: 0,
                positions: Vec::new(),
            })
            .collect();
    }

    let folded = query.to_lowercase();
    let finder = memmem::Finder::new(folded.as_bytes());

    let score_one = |entry: &'a Entry| -> Option<Hit<'a>> {
        // Substring first: it is both the common case and the cheaper one, and
        // memmem's SIMD kernel makes it the fastest test available.
        if let Some(byte_offset) = finder.find(entry.name_folded.as_bytes()) {
            let start = entry.name_folded[..byte_offset].chars().count();
            let length = folded.chars().count();
            let positions: Vec<usize> = (start..start + length).collect();

            let mut score = weight::SUBSTRING + weight::CONTIGUOUS * length as i32;
            if start == 0 {
                score += weight::LEADING;
            } else if is_boundary(entry.name_folded.chars().nth(start.wrapping_sub(1))) {
                score += weight::BOUNDARY;
            }
            let name_length = entry.name_folded.chars().count().max(1) as i32;
            score += (weight::BREVITY * 16) / name_length;
            if entry.manuscript {
                score += weight::MANUSCRIPT;
            }
            return Some(Hit {
                entry,
                score,
                positions,
            });
        }

        let (mut score, positions) = subsequence(&folded, &entry.name_folded)?;
        if entry.manuscript {
            score += weight::MANUSCRIPT;
        }
        Some(Hit {
            entry,
            score,
            positions,
        })
    };

    let mut hits: Vec<Hit<'a>> = if entries.len() >= 4096 {
        entries.par_iter().filter_map(score_one).collect()
    } else {
        entries.iter().filter_map(score_one).collect()
    };

    // Score descending, then name ascending so equal scores hold a stable,
    // explicable order rather than whatever the pool happened to produce.
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.entry.name_folded.cmp(&b.entry.name_folded))
    });
    hits.truncate(limit);
    hits
}

/// Directories only, for a move destination picker.
pub fn directories<'a>(entries: &'a [Entry], query: &str, limit: usize) -> Vec<Hit<'a>> {
    matches(entries, query, entries.len())
        .into_iter()
        .filter(|hit| matches!(hit.entry.kind, Kind::Directory))
        .take(limit)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn entry(name: &str) -> Entry {
        Entry {
            path: PathBuf::from(format!("/root/{name}")),
            name: name.to_string(),
            name_folded: name.to_lowercase(),
            kind: Kind::File,
            size: 0,
            modified_ms: 0,
            depth: 1,
            manuscript: name.ends_with(".md"),
        }
    }

    #[test]
    fn finds_an_exact_substring() {
        let entries = vec![entry("chapter-one.md"), entry("notes.md")];
        let hits = matches(&entries, "chapter", 10);

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.name, "chapter-one.md");
    }

    #[test]
    fn matches_are_case_insensitive() {
        let entries = vec![entry("Chapter-One.MD")];
        assert_eq!(matches(&entries, "CHAPTER", 10).len(), 1);
        assert_eq!(matches(&entries, "chapter", 10).len(), 1);
    }

    #[test]
    fn an_initialism_matches_as_a_subsequence() {
        let entries = vec![entry("chapter-one.md"), entry("zzz.md")];
        let hits = matches(&entries, "cho", 10);

        assert_eq!(hits[0].entry.name, "chapter-one.md");
    }

    #[test]
    fn a_substring_outranks_a_scattered_subsequence() {
        let entries = vec![entry("c-h-a-p.md"), entry("chap.md")];
        let hits = matches(&entries, "chap", 10);

        assert_eq!(hits[0].entry.name, "chap.md", "contiguous wins");
    }

    #[test]
    fn a_leading_match_outranks_a_late_one() {
        let entries = vec![entry("draft-chapter.md"), entry("chapter-draft.md")];
        let hits = matches(&entries, "chapter", 10);

        assert_eq!(hits[0].entry.name, "chapter-draft.md");
    }

    #[test]
    fn cjk_queries_match_by_character() {
        let entries = vec![entry("第一章-开端.md"), entry("第二章.md")];
        let hits = matches(&entries, "第一", 10);

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.name, "第一章-开端.md");
    }

    #[test]
    fn cjk_positions_are_character_offsets_not_bytes() {
        let entries = vec![entry("第一章.md")];
        let hits = matches(&entries, "一", 10);

        // Byte offset would be 3; character offset is 1. The renderer highlights
        // by character, so a byte offset would underline the wrong glyph.
        assert_eq!(hits[0].positions, vec![1]);
    }

    #[test]
    fn an_empty_query_returns_the_head_of_the_index() {
        let entries = vec![entry("a.md"), entry("b.md"), entry("c.md")];
        assert_eq!(matches(&entries, "", 2).len(), 2);
        assert_eq!(matches(&entries, "   ", 2).len(), 2);
    }

    #[test]
    fn a_query_that_fits_nothing_returns_nothing() {
        let entries = vec![entry("chapter.md")];
        assert!(matches(&entries, "zzzz", 10).is_empty());
    }

    #[test]
    fn the_limit_is_honoured() {
        let entries: Vec<Entry> = (0..100)
            .map(|i| entry(&format!("chapter-{i}.md")))
            .collect();
        assert_eq!(matches(&entries, "chapter", 7).len(), 7);
    }

    #[test]
    fn equal_scores_sort_by_name_so_the_order_is_stable() {
        let entries = vec![entry("b-same.md"), entry("a-same.md")];
        let hits = matches(&entries, "same", 10);

        assert_eq!(hits[0].entry.name, "a-same.md");
        assert_eq!(hits[1].entry.name, "b-same.md");
    }

    #[test]
    fn a_manuscript_outranks_a_sibling_with_the_same_stem() {
        let mut image = entry("cover.png");
        image.manuscript = false;
        let entries = vec![image, entry("cover.md")];
        let hits = matches(&entries, "cover", 10);

        assert_eq!(hits[0].entry.name, "cover.md");
    }

    #[test]
    fn the_parallel_and_sequential_paths_agree() {
        // Above the threshold the scan goes through rayon; the ranking must not
        // depend on which path ran.
        let small: Vec<Entry> = (0..10).map(|i| entry(&format!("chapter-{i}.md"))).collect();
        let large: Vec<Entry> = (0..5000)
            .map(|i| entry(&format!("chapter-{i}.md")))
            .collect();

        let small_hits = matches(&small, "chapter1", 5);
        let large_hits = matches(&large, "chapter1", 5);

        assert_eq!(small_hits[0].entry.name, large_hits[0].entry.name);
    }
}
