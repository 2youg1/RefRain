//! Ordering the index.
//!
//! Sorting is a linear pass over a contiguous `Vec`, parallel above a threshold.
//! Two decisions carry the weight here.
//!
//! **Directories first.** A folder is a place, a file is a thing; interleaving
//! them by name makes a tree unreadable. Every order keeps the split.
//!
//! **Natural order for names.** `chapter-10.md` belongs after `chapter-9.md`,
//! not between `chapter-1` and `chapter-2`. Lexicographic order is what a naive
//! comparator gives and it is wrong for every numbered manuscript, which is most
//! of them.

use crate::index::{Entry, Kind};
use rayon::prelude::*;
use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Order {
    Name,
    Modified,
    Size,
    /// File extension, then name. Groups a chapter with its chapters.
    Kind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Ascending,
    Descending,
}

/// Compare two names the way a reader expects, digits as numbers.
///
/// Compares character by character, and when both sides are at a digit, takes
/// the whole digit run as one number. Leading zeros do not change the value, so
/// `01` and `1` compare equal and fall through to the tie-break.
pub fn natural(left: &str, right: &str) -> Ordering {
    let mut a = left.chars().peekable();
    let mut b = right.chars().peekable();

    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                if x.is_ascii_digit() && y.is_ascii_digit() {
                    let left_number = take_number(&mut a);
                    let right_number = take_number(&mut b);
                    match left_number.cmp(&right_number) {
                        Ordering::Equal => continue,
                        other => return other,
                    }
                }

                a.next();
                b.next();
                match x.cmp(&y) {
                    Ordering::Equal => continue,
                    other => return other,
                }
            }
        }
    }
}

/// Consume a run of digits and return its value.
///
/// Saturating: a hundred-digit filename must not overflow into a wrong order or
/// a panic. Beyond u128 the exact value stops mattering for sorting anyway.
fn take_number(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> u128 {
    let mut value: u128 = 0;
    while let Some(c) = chars.peek().copied() {
        if !c.is_ascii_digit() {
            break;
        }
        chars.next();
        value = value
            .saturating_mul(10)
            .saturating_add((c as u8 - b'0') as u128);
    }
    value
}

/// Directories before files, symlinks last. A place, then a thing, then a
/// pointer to one.
fn by_kind(kind: Kind) -> u8 {
    match kind {
        Kind::Directory => 0,
        Kind::File => 1,
        Kind::Symlink => 2,
    }
}

/// Sort in place. `direction` reverses the primary key only: directories stay
/// first in a descending sort, because "reverse by name" never means "put the
/// files on top".
pub fn sort(entries: &mut [Entry], order: Order, direction: Direction) {
    let compare = |a: &Entry, b: &Entry| -> Ordering {
        let grouped = by_kind(a.kind).cmp(&by_kind(b.kind));
        if grouped != Ordering::Equal {
            return grouped;
        }

        let primary = match order {
            Order::Name => natural(&a.name_folded, &b.name_folded),
            Order::Modified => a.modified_ms.cmp(&b.modified_ms),
            Order::Size => a.size.cmp(&b.size),
            Order::Kind => extension(a).cmp(extension(b)),
        };

        let primary = match direction {
            Direction::Ascending => primary,
            Direction::Descending => primary.reverse(),
        };

        // Name is the tie-break for every order, so a redraw never reshuffles
        // rows that compare equal on the primary key.
        primary.then_with(|| natural(&a.name_folded, &b.name_folded))
    };

    if entries.len() >= 4096 {
        entries.par_sort_by(compare);
    } else {
        entries.sort_by(compare);
    }
}

fn extension(entry: &Entry) -> &str {
    entry
        .path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn entry(name: &str, kind: Kind, size: u64, modified_ms: i64) -> Entry {
        Entry {
            path: PathBuf::from(format!("/root/{name}")),
            name: name.to_string(),
            name_folded: name.to_lowercase(),
            kind,
            size,
            modified_ms,
            depth: 1,
            manuscript: name.ends_with(".md"),
        }
    }

    fn file(name: &str) -> Entry {
        entry(name, Kind::File, 0, 0)
    }

    fn names(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn numbers_sort_as_numbers_not_as_text() {
        let mut entries = vec![
            file("chapter-10.md"),
            file("chapter-9.md"),
            file("chapter-1.md"),
        ];
        sort(&mut entries, Order::Name, Direction::Ascending);

        assert_eq!(
            names(&entries),
            vec!["chapter-1.md", "chapter-9.md", "chapter-10.md"]
        );
    }

    #[test]
    fn leading_zeros_do_not_change_the_number() {
        assert_eq!(natural("chapter-01", "chapter-1"), Ordering::Equal);
        assert_eq!(natural("chapter-007.md", "chapter-8.md"), Ordering::Less);
    }

    #[test]
    fn a_very_long_digit_run_does_not_panic() {
        let long = "9".repeat(200);
        assert_eq!(natural(&long, &long), Ordering::Equal);
        // Saturating arithmetic: both saturate, so they compare equal and fall
        // through rather than overflowing.
        assert_eq!(
            natural(&format!("a{long}"), &format!("a{long}")),
            Ordering::Equal
        );
    }

    #[test]
    fn directories_come_first_in_both_directions() {
        let mut entries = vec![
            file("z.md"),
            entry("a-folder", Kind::Directory, 0, 0),
            file("a.md"),
        ];

        sort(&mut entries, Order::Name, Direction::Ascending);
        assert_eq!(entries[0].name, "a-folder");

        sort(&mut entries, Order::Name, Direction::Descending);
        assert_eq!(
            entries[0].name, "a-folder",
            "reversing the name order must not float files above folders"
        );
    }

    #[test]
    fn sorts_by_modified_time() {
        let mut entries = vec![
            entry("old.md", Kind::File, 0, 1_000),
            entry("new.md", Kind::File, 0, 9_000),
        ];
        sort(&mut entries, Order::Modified, Direction::Descending);

        assert_eq!(entries[0].name, "new.md");
    }

    #[test]
    fn sorts_by_size() {
        let mut entries = vec![
            entry("small.md", Kind::File, 10, 0),
            entry("big.md", Kind::File, 9_000, 0),
        ];
        sort(&mut entries, Order::Size, Direction::Descending);

        assert_eq!(entries[0].name, "big.md");
    }

    #[test]
    fn equal_keys_fall_back_to_the_name_so_redraws_are_stable() {
        let mut entries = vec![
            entry("b.md", Kind::File, 100, 5),
            entry("a.md", Kind::File, 100, 5),
            entry("c.md", Kind::File, 100, 5),
        ];
        sort(&mut entries, Order::Size, Direction::Ascending);

        assert_eq!(names(&entries), vec!["a.md", "b.md", "c.md"]);
    }

    #[test]
    fn cjk_names_sort_without_panicking() {
        let mut entries = vec![file("第二章.md"), file("第一章.md"), file("第10章.md")];
        sort(&mut entries, Order::Name, Direction::Ascending);

        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn the_parallel_and_sequential_paths_agree() {
        let build = |count: usize| -> Vec<Entry> {
            (0..count)
                .map(|i| file(&format!("chapter-{}.md", count - i)))
                .collect()
        };

        let mut small = build(100);
        let mut large = build(5000);
        sort(&mut small, Order::Name, Direction::Ascending);
        sort(&mut large, Order::Name, Direction::Ascending);

        assert_eq!(small[0].name, "chapter-1.md");
        assert_eq!(large[0].name, "chapter-1.md");
    }

    #[test]
    fn an_empty_index_sorts_without_incident() {
        let mut entries: Vec<Entry> = Vec::new();
        sort(&mut entries, Order::Name, Direction::Ascending);
        assert!(entries.is_empty());
    }
}
