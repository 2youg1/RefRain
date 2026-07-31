//! Keeping the search index in step with the manuscript.
//!
//! # What this owns
//!
//! One question: given a document's path and its current text, is the index
//! telling the truth about it? Everything else follows — indexing a document,
//! dropping one, and answering a query are all the same question asked at
//! different moments.
//!
//! # Why the index holds no text
//!
//! The manuscript lives in `.md` files on disk. That is the project's central
//! promise, and an index that kept its own copy would become a second
//! authority: the author edits the file, the copy goes stale, and search
//! quietly returns sentences that no longer exist. So `block_search` is an
//! external-content FTS5 table (`content=''`) holding only the inverted index,
//! and `document_index_state` records which digest each document's entries
//! were built from. When the digests disagree the entries are rebuilt; when
//! the index is lost it can be rebuilt from the files, because nothing lives
//! only here.
//!
//! # Why a row is a block, not a document
//!
//! A document-level index answers "which file" and never "which passage". An
//! agent that receives an outline instead of 100KB of prose has to be able to
//! retrieve a passage and cite it, and "chapter three is relevant" gives it
//! nothing to cite. It also improves ranking on its own terms: bm25's notion
//! of document length becomes the block's length, so a short paragraph that
//! is *about* the query stops losing to a long chapter that mentions it.
//!
//! # Why the text is bigrammed
//!
//! Measured, not assumed: FTS5's `unicode61` reads a run of Chinese as a
//! single token, so 「营销」 inside it matches nothing, and `trigram` indexes
//! nothing shorter than three characters while returning bm25 = -0.0000 for
//! every row. `refrain_core::chinese_index` splits Chinese into overlapping
//! pairs so that ordinary token matching works and bm25 keeps its
//! discrimination. See `review/search-probe-results.md`.

use refrain_core::block_shape::BlockKind;
use refrain_core::chinese_index::{Precision, bigram, match_expression_with};
use refrain_core::searchable_block::blocks_of;
use refrain_core::{ErrorCode, RefrainError};
use rusqlite::{Connection, OptionalExtension, params};

/// One block's place in the index.
///
/// The rowid is FTS5's own, kept in `block_search_state` because an
/// external-content table cannot be asked what it holds — deleting from it
/// requires replaying the exact text that was inserted, at the exact rowid.
struct Entry {
    rowid: i64,
    /// The exact text handed to FTS5, path and body.
    ///
    /// An external-content table stores nothing itself, so deleting a row
    /// means replaying precisely what was inserted — FTS5 re-tokenises the
    /// text to find the postings to remove. Feeding it anything else does not
    /// fail: it removes postings that were never there and leaves the real
    /// ones behind, and SQLite reports the result as "database disk image is
    /// malformed" the next time the index is read. That is how this was found,
    /// and a block-level index owns N of these per document rather than one.
    indexed: (String, String),
}

fn store_failure(action: &'static str, cause: rusqlite::Error) -> RefrainError {
    RefrainError::new(ErrorCode::StateUnavailable, action, "refrain.db")
        .with_detail(cause.to_string())
}

/// The digest the index built this document's blocks from, if it has seen it.
fn indexed_digest(db: &Connection, path: &str) -> Result<Option<String>, RefrainError> {
    db.query_row(
        "SELECT digest FROM document_index_state WHERE document = ?1",
        params![path],
        |row| row.get(0),
    )
    .optional()
    .map_err(|cause| store_failure("read index state", cause))
}

/// Every block entry the index holds for one document.
fn entries_of(db: &Connection, path: &str) -> Result<Vec<Entry>, RefrainError> {
    let mut statement = db
        .prepare(
            "SELECT rowid_of, indexed_path, indexed_body
             FROM block_search_state WHERE document = ?1 ORDER BY ordinal",
        )
        .map_err(|cause| store_failure("prepare index state read", cause))?;
    let rows = statement
        .query_map(params![path], |row| {
            Ok(Entry {
                rowid: row.get(0)?,
                indexed: (row.get(1)?, row.get(2)?),
            })
        })
        .map_err(|cause| store_failure("read index state", cause))?;
    rows.collect::<rusqlite::Result<Vec<Entry>>>()
        .map_err(|cause| store_failure("read index state", cause))
}

fn kind_name(kind: BlockKind) -> &'static str {
    // No catch-all: a new BlockKind must force a decision about how it is
    // stored rather than silently landing in whatever this arm happened to be.
    match kind {
        BlockKind::Paragraph => "paragraph",
        BlockKind::Heading => "heading",
        BlockKind::Fence => "fence",
    }
}

fn kind_of(name: &str) -> BlockKind {
    match name {
        "heading" => BlockKind::Heading,
        "fence" => BlockKind::Fence,
        // A row written by a newer build carrying a kind this one does not
        // know reads as prose. That is the honest floor: it ranks the passage
        // by its words rather than claiming structure this build cannot see.
        _ => BlockKind::Paragraph,
    }
}

/// Put a document's blocks into the index, or leave them alone if already
/// correct.
///
/// Returns whether anything changed, which lets a caller indexing a whole
/// project report real work rather than a count of files it looked at.
///
/// The digest check is what makes reindexing a project cheap: opening a
/// hundred chapters where one changed rewrites one document's blocks.
pub fn index_document(
    db: &Connection,
    path: &str,
    digest: &str,
    text: &str,
) -> Result<bool, RefrainError> {
    if indexed_digest(db, path)?.as_deref() == Some(digest) {
        return Ok(false);
    }

    // The document's old blocks go before the new ones arrive. Rewriting in
    // place is not possible: an edit changes how many blocks there are, so
    // "update row 3" has no meaning when the new text has two blocks.
    forget_document(db, path)?;

    let indexed_path = bigram(path);
    // The rowid runs alongside the blocks: FTS5 needs one per row and an
    // external-content table has none of its own to autoincrement from.
    for (rowid, block) in (next_rowid(db)?..).zip(blocks_of(text)) {
        let indexed_body = bigram(block.text);
        db.execute(
            "INSERT INTO block_search(rowid, path, body) VALUES (?1, ?2, ?3)",
            params![rowid, indexed_path, indexed_body],
        )
        .map_err(|cause| store_failure("index block", cause))?;
        db.execute(
            "INSERT INTO block_search_state
                 (rowid_of, document, ordinal, kind, start_byte, bytes,
                  indexed_path, indexed_body)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                rowid,
                path,
                block.ordinal,
                kind_name(block.kind),
                block.start as i64,
                block.text.len() as i64,
                indexed_path,
                indexed_body
            ],
        )
        .map_err(|cause| store_failure("record block state", cause))?;
    }

    db.execute(
        "INSERT INTO document_index_state(document, digest) VALUES (?1, ?2)
         ON CONFLICT(document) DO UPDATE SET digest = ?2",
        params![path, digest],
    )
    .map_err(|cause| store_failure("record index state", cause))?;

    Ok(true)
}

/// The next unused rowid.
///
/// FTS5 rowids are the join key between the index and the state table, so they
/// are allocated here rather than left to SQLite: an external-content table
/// has no rows of its own to autoincrement from.
fn next_rowid(db: &Connection) -> Result<i64, RefrainError> {
    db.query_row(
        "SELECT COALESCE(MAX(rowid_of), 0) + 1 FROM block_search_state",
        [],
        |row| row.get(0),
    )
    .map_err(|cause| store_failure("allocate search rowid", cause))
}

/// Remove one block from the inverted index.
///
/// The text has to be exactly what was inserted. FTS5 re-tokenises it to find
/// the postings to remove, and anything else corrupts the index silently —
/// the failure surfaces later as "database disk image is malformed", which is
/// how the first version of this function was caught.
fn remove_entry(db: &Connection, entry: &Entry) -> Result<(), RefrainError> {
    db.execute(
        "INSERT INTO block_search(block_search, rowid, path, body)
         VALUES ('delete', ?1, ?2, ?3)",
        params![entry.rowid, entry.indexed.0, entry.indexed.1],
    )
    .map_err(|cause| store_failure("clear search entry", cause))?;
    Ok(())
}

/// Is the index already built from these exact bytes?
///
/// Lets a caller skip reading a file it would only hand back unchanged. The
/// digest is the same one the catalog stores, so agreement here means the
/// index and the file agree, not merely that an entry exists.
pub fn index_is_current(db: &Connection, path: &str, digest: &str) -> bool {
    matches!(indexed_digest(db, path), Ok(Some(found)) if found == digest)
}

/// Drop a document from the index entirely, every block of it.
pub fn forget_document(db: &Connection, path: &str) -> Result<bool, RefrainError> {
    let entries = entries_of(db, path)?;
    let known = indexed_digest(db, path)?.is_some();
    if entries.is_empty() && !known {
        return Ok(false);
    }
    for entry in &entries {
        remove_entry(db, entry)?;
    }
    db.execute(
        "DELETE FROM block_search_state WHERE document = ?1",
        params![path],
    )
    .map_err(|cause| store_failure("forget block entries", cause))?;
    db.execute(
        "DELETE FROM document_index_state WHERE document = ?1",
        params![path],
    )
    .map_err(|cause| store_failure("forget index state", cause))?;
    Ok(true)
}

/// One block that matched, with everything needed to cite and re-read it.
///
/// The ordinal is what an agent quotes back to fetch the passage; the byte
/// range is what proves the fetched text is the text the index saw.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedBlock {
    pub path: String,
    /// Which block of that document, counting from zero.
    pub ordinal: u32,
    /// What the author made this block — heading, fence, or prose. Ranking
    /// reads it; before block-level indexing this was unknowable and every
    /// candidate had to claim `Paragraph`.
    pub kind: BlockKind,
    /// Byte offset of the block within the document.
    pub start_byte: u32,
    /// Byte length of the block.
    pub bytes: u32,
    /// bm25, negated so that larger means better — matching the convention
    /// `refrain_core::search_rank` scores on. FTS5 returns smaller-is-better.
    pub relevance: f64,
}

/// Find blocks whose document path or text matches the query, exactly.
///
/// For when the author remembers the words. See `search_with` for the other
/// state an author can be in.
pub fn search(db: &Connection, query: &str, limit: u32) -> Result<Vec<IndexedBlock>, RefrainError> {
    search_with(db, query, Precision::Exact, limit)
}

/// Find blocks whose document path or text matches the query.
///
/// `Precision::Exact` requires every part of the query to appear; `Loose`
/// takes blocks holding any part and lets ranking sort them out. Measured
/// over the workspace, 「渐进式披露」 returns far fewer exact than loose — the
/// first is what an author who remembers the phrase wants, the second is what
/// an author who only remembers the sense needs.
///
/// Ordering here is by bm25 alone. The final order is decided by
/// `refrain_core::search_rank`, which knows things this layer does not: what
/// role the document plays, when the author last touched it. Sorting twice is
/// deliberate — this pass narrows a corpus to candidates, and the ranking pass
/// decides what the author sees first.
///
/// The path column is weighted far above the body: a query matching the title
/// the author chose is a stronger signal than the same words appearing in
/// prose. The multiplier is 16, not the 4 it started at, because BM25 counts
/// term frequency and a body that mentions a word three times outscored a
/// title that *is* that word — measured, and the reason the weight moved.
/// Even 16 only buys a margin; the durable fix is `search_rank`, which caps
/// each signal so no amount of repetition can overtake a title.
pub fn search_with(
    db: &Connection,
    query: &str,
    precision: Precision,
    limit: u32,
) -> Result<Vec<IndexedBlock>, RefrainError> {
    let Some(expression) = match_expression_with(query, precision) else {
        return Ok(Vec::new());
    };

    let mut statement = db
        .prepare(
            "SELECT s.document, s.ordinal, s.kind, s.start_byte, s.bytes,
                    bm25(block_search, 16.0, 1.0)
             FROM block_search
             JOIN block_search_state s ON s.rowid_of = block_search.rowid
             WHERE block_search MATCH ?1
             -- ORDER BY the same expression the SELECT computes, not `rank`.
             -- `rank` is bm25() with *default* weights, so ordering by it
             -- silently ignores the column weighting: a body mentioning a word
             -- three times sorted above a title that is that word, while the
             -- scores in the same result set said the opposite.
             ORDER BY bm25(block_search, 16.0, 1.0)
             LIMIT ?2",
        )
        .map_err(|cause| store_failure("prepare search", cause))?;

    let rows = statement
        .query_map(params![expression, limit], |row| {
            let kind: String = row.get(2)?;
            Ok(IndexedBlock {
                path: row.get(0)?,
                ordinal: row.get(1)?,
                kind: kind_of(&kind),
                start_byte: row.get(3)?,
                bytes: row.get(4)?,
                // FTS5 returns smaller-is-better; flip it so callers can read
                // "larger is more relevant" the way every other score here does.
                relevance: -row.get::<_, f64>(5)?,
            })
        })
        .map_err(|cause| store_failure("run search", cause))?;

    rows.collect::<rusqlite::Result<Vec<IndexedBlock>>>()
        .map_err(|cause| store_failure("read search results", cause))
}
