// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Opening a manuscript must not copy its text.
//
// `SourceSnapshot` already owns every byte behind an `Arc`, and `SourceLayout`
// already records where each block starts and ends. A `Block` that stores its
// own `String` therefore re-allocates text the document is holding anyway: one
// heap allocation per block, plus a second full copy of the manuscript.
//
// The cost is not theoretical. A 1 GiB manuscript splits into 7.2 million
// blocks, and the probe in `refrain-store/tests/huge_input_probe.rs` measures
// 2,980 ms to open it against 25 ms to walk every block that was just built —
// a factor of 123. The gap is the copying.
//
// These tests fix the property that removes the cost: block text borrows the
// snapshot's bytes, so opening allocates a bounded amount regardless of how
// large the manuscript is.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use refrain_core::manuscript::{Lineage, Manuscript, SourceSnapshot};

/// Counts bytes handed out by the allocator so a test can state what a call
/// allocated rather than how long it took. Timing would make the assertion
/// depend on the machine; allocation volume is a property of the code.
///
/// The count is per-thread. A process-wide counter would attribute every
/// other test's allocations to whichever test happened to be measuring, which
/// is how an earlier version of this file reported a passing bound while the
/// same call allocated 3.7x its budget. Each test runs on its own thread, so
/// counting per thread makes each measurement describe only its own call.
struct Counting;

thread_local! {
    static ALLOCATED: Cell<usize> = const { Cell::new(0) };
    static COUNTING: Cell<bool> = const { Cell::new(false) };
}

// SAFETY: every method forwards to `System`, which upholds the `GlobalAlloc`
// contract. The counter only observes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record(new_size.saturating_sub(layout.size()));
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

/// Adds to this thread's total when it is measuring.
///
/// `try_with` matters: during thread teardown the thread-local is already gone,
/// and a panicking allocator would abort the process.
fn record(bytes: usize) {
    let _ = COUNTING.try_with(|counting| {
        if counting.get() {
            let _ = ALLOCATED.try_with(|total| total.set(total.get() + bytes));
        }
    });
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn allocated_by<T>(call: impl FnOnce() -> T) -> (T, usize) {
    ALLOCATED.with(|total| total.set(0));
    COUNTING.with(|counting| counting.set(true));
    let value = call();
    COUNTING.with(|counting| counting.set(false));
    (value, ALLOCATED.with(Cell::get))
}

/// Builds a manuscript of `blocks` paragraphs, each `width` bytes wide.
fn manuscript_source(blocks: usize, width: usize) -> Vec<u8> {
    let mut text = String::with_capacity(blocks * (width + 2));
    for index in 0..blocks {
        let head = format!("{index} ");
        text.push_str(&head);
        text.extend(std::iter::repeat_n('x', width.saturating_sub(head.len())));
        text.push_str("\n\n");
    }
    text.into_bytes()
}

#[test]
fn opening_a_manuscript_does_not_copy_its_text() {
    let blocks = 20_000;
    let width = 400;
    let source = manuscript_source(blocks, width);
    let manuscript_bytes = source.len();

    let snapshot = SourceSnapshot::read(source);
    let lineage = Lineage::fresh(snapshot.block_count());

    let (manuscript, allocated) =
        allocated_by(|| Manuscript::open(snapshot, lineage).expect("manuscript opens"));

    assert_eq!(manuscript.head().blocks().len(), blocks);

    // Opening builds one index entry per block — the block vector, the id
    // lookup, and the offset table — so cost is bounded per block, not per
    // byte of text. 320 bytes per block is several times what those structures
    // need and still far below the 400-byte text this manuscript carries per
    // block, so the bound separates an index from a copy.
    //
    // Stating the budget per block rather than as a fraction of the manuscript
    // keeps the test honest at any block width: a per-byte fraction would pass
    // for the copying design too, simply by making blocks wider.
    let ceiling = blocks * 320;
    assert!(
        allocated < ceiling,
        "opening a {manuscript_bytes}-byte manuscript in {blocks} blocks allocated \
         {allocated} bytes, over the {ceiling}-byte index budget; block text is \
         being copied instead of borrowed from the snapshot"
    );
}

#[test]
fn opening_allocates_proportionally_to_block_count_not_text_size() {
    // The same block count at two text widths. If text is borrowed, the wider
    // manuscript costs the same to open; if it is copied, cost tracks width.
    let blocks = 20_000;

    let narrow = SourceSnapshot::read(manuscript_source(blocks, 100));
    let narrow_lineage = Lineage::fresh(narrow.block_count());
    let (_narrow, narrow_allocated) =
        allocated_by(|| Manuscript::open(narrow, narrow_lineage).expect("manuscript opens"));

    let wide = SourceSnapshot::read(manuscript_source(blocks, 1_000));
    let wide_lineage = Lineage::fresh(wide.block_count());
    let (_wide, wide_allocated) =
        allocated_by(|| Manuscript::open(wide, wide_lineage).expect("manuscript opens"));

    // Ten times the text. Allow generous headroom for allocator rounding and
    // capacity growth, but refuse a cost that scales with the text.
    assert!(
        wide_allocated < narrow_allocated * 2,
        "widening blocks from 100 to 1000 bytes changed open cost from \
         {narrow_allocated} to {wide_allocated} bytes; text is being copied"
    );
}

#[test]
fn borrowed_block_text_still_reads_as_written() {
    // Sharing must not change what a block says. This is the guard against
    // an off-by-one in span arithmetic, which allocation counts cannot see.
    let source = "序章\n\n第一節の本文。\n\nlast line without trailing blank";
    let snapshot = SourceSnapshot::read(source.as_bytes().to_vec());
    let lineage = Lineage::fresh(snapshot.block_count());
    let manuscript = Manuscript::open(snapshot, lineage).expect("manuscript opens");

    let blocks = manuscript.head().blocks();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0].text(), "序章");
    assert_eq!(blocks[1].text(), "第一節の本文。");
    assert_eq!(blocks[2].text(), "last line without trailing blank");
    assert_eq!(manuscript.head().text(), source);
}
