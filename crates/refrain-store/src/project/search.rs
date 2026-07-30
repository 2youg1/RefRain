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
//! quietly returns sentences that no longer exist. So `document_search` is an
//! external-content FTS5 table (`content=''`) holding only the inverted index,
//! and `document_search_state` records which digest each entry was built from.
//! When the digests disagree the entry is rebuilt; when the index is lost it
//! can be rebuilt from the files, because nothing lives only here.
//!
//! # Why the text is bigrammed
//!
//! Measured, not assumed: FTS5's `unicode61` reads a run of Chinese as a
//! single token, so 「营销」 inside it matches nothing, and `trigram` indexes
//! nothing shorter than three characters while returning bm25 = -0.0000 for
//! every row. `refrain_core::chinese_index` splits Chinese into overlapping
//! pairs so that ordinary token matching works and bm25 keeps its
//! discrimination. See `review/search-probe-results.md`.

use refrain_core::chinese_index::{Precision, bigram, match_expression_with};
use refrain_core::{ErrorCode, RefrainError};
use rusqlite::{Connection, OptionalExtension, params};

/// One document's place in the index.
///
/// The rowid is FTS5's own, kept in `document_search_state` because an
/// external-content table cannot be asked what it holds — deleting from it
/// requires replaying the exact text that was inserted, at the exact rowid.
struct Entry {
    rowid: i64,
    digest: String,
    /// The exact text handed to FTS5, path and body.
    ///
    /// An external-content table stores nothing itself, so deleting a row
    /// means replaying precisely what was inserted — FTS5 re-tokenises the
    /// text to find the postings to remove. Feeding it anything else does not
    /// fail: it removes postings that were never there and leaves the real
    /// ones behind, and SQLite reports the result as "database disk image is
    /// malformed" the next time the index is read. That is how this was found.
    indexed: (String, String),
}

fn store_failure(action: &'static str, cause: rusqlite::Error) -> RefrainError {
    RefrainError::new(ErrorCode::StateUnavailable, action, "refrain.db")
        .with_detail(cause.to_string())
}

fn entry_of(db: &Connection, path: &str) -> Result<Option<Entry>, RefrainError> {
    db.query_row(
        "SELECT rowid_of, digest, indexed_path, indexed_body
         FROM document_search_state WHERE document = ?1",
        params![path],
        |row| {
            Ok(Entry {
                rowid: row.get(0)?,
                digest: row.get(1)?,
                indexed: (row.get(2)?, row.get(3)?),
            })
        },
    )
    .optional()
    .map_err(|cause| store_failure("read search state", cause))
}

/// Put a document into the index, or leave it alone if it is already correct.
///
/// Returns whether anything changed, which lets a caller indexing a whole
/// project report real work rather than a count of files it looked at.
///
/// The digest check is what makes reindexing a project cheap: opening a
/// hundred chapters where one changed rewrites one entry.
pub fn index_document(
    db: &Connection,
    path: &str,
    digest: &str,
    text: &str,
) -> Result<bool, RefrainError> {
    let existing = entry_of(db, path)?;
    if let Some(entry) = &existing {
        if entry.digest == digest {
            return Ok(false);
        }
        remove_entry(db, entry)?;
    }

    let rowid = existing
        .as_ref()
        .map_or_else(|| next_rowid(db).unwrap_or(1), |entry| entry.rowid);
    let indexed_path = bigram(path);
    let indexed_body = bigram(text);

    db.execute(
        "INSERT INTO document_search(rowid, path, body) VALUES (?1, ?2, ?3)",
        params![rowid, indexed_path, indexed_body],
    )
    .map_err(|cause| store_failure("index document", cause))?;

    db.execute(
        "INSERT INTO document_search_state(document, rowid_of, digest, indexed_path, indexed_body)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(document) DO UPDATE SET
             rowid_of = ?2, digest = ?3, indexed_path = ?4, indexed_body = ?5",
        params![path, rowid, digest, indexed_path, indexed_body],
    )
    .map_err(|cause| store_failure("record search state", cause))?;

    Ok(true)
}

/// The next unused rowid.
///
/// FTS5 rowids are the join key between the index and the state table, so they
/// are allocated here rather than left to SQLite: an external-content table
/// has no rows of its own to autoincrement from.
fn next_rowid(db: &Connection) -> Result<i64, RefrainError> {
    db.query_row(
        "SELECT COALESCE(MAX(rowid_of), 0) + 1 FROM document_search_state",
        [],
        |row| row.get(0),
    )
    .map_err(|cause| store_failure("allocate search rowid", cause))
}

/// Remove an entry from the inverted index.
///
/// The text has to be exactly what was inserted. FTS5 re-tokenises it to find
/// the postings to remove, and anything else corrupts the index silently —
/// the failure surfaces later as "database disk image is malformed", which is
/// how the first version of this function was caught.
fn remove_entry(db: &Connection, entry: &Entry) -> Result<(), RefrainError> {
    db.execute(
        "INSERT INTO document_search(document_search, rowid, path, body)
         VALUES ('delete', ?1, ?2, ?3)",
        params![entry.rowid, entry.indexed.0, entry.indexed.1],
    )
    .map_err(|cause| store_failure("clear search entry", cause))?;
    Ok(())
}

/// Drop a document from the index entirely.
pub fn forget_document(db: &Connection, path: &str) -> Result<bool, RefrainError> {
    let Some(entry) = entry_of(db, path)? else {
        return Ok(false);
    };
    remove_entry(db, &entry)?;
    db.execute(
        "DELETE FROM document_search_state WHERE document = ?1",
        params![path],
    )
    .map_err(|cause| store_failure("forget search entry", cause))?;
    Ok(true)
}

/// One document that matched, with the relevance FTS5 assigned it.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub path: String,
    /// bm25, negated so that larger means better — matching the convention
    /// `refrain_core::search_rank` scores on. FTS5 returns smaller-is-better.
    pub relevance: f64,
}

/// Find documents whose path or body matches the query, exactly.
///
/// For when the author remembers the words. See `search_with` for the other
/// state an author can be in.
pub fn search(db: &Connection, query: &str, limit: u32) -> Result<Vec<Hit>, RefrainError> {
    search_with(db, query, Precision::Exact, limit)
}

/// Find documents whose path or body matches the query.
///
/// `Precision::Exact` requires every part of the query to appear; `Loose`
/// takes documents holding any part and lets ranking sort them out. Measured
/// over the workspace, 「渐进式披露」 returns 7 documents exact and 185 loose —
/// the first is what an author who remembers the phrase wants, the second is
/// what an author who only remembers the sense needs.
///
/// Ordering here is by bm25 alone. The final order is decided by
/// `refrain_core::search_rank`, which knows things this layer does not: which
/// block a hit landed in, what role the document plays, when the author last
/// touched it. Sorting twice is deliberate — this pass narrows a corpus to
/// candidates, and the ranking pass decides what the author sees first.
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
) -> Result<Vec<Hit>, RefrainError> {
    let Some(expression) = match_expression_with(query, precision) else {
        return Ok(Vec::new());
    };

    let mut statement = db
        .prepare(
            "SELECT s.document, bm25(document_search, 16.0, 1.0)
             FROM document_search
             JOIN document_search_state s ON s.rowid_of = document_search.rowid
             WHERE document_search MATCH ?1
             -- ORDER BY the same expression the SELECT computes, not `rank`.
             -- `rank` is bm25() with *default* weights, so ordering by it
             -- silently ignores the column weighting: a body mentioning a word
             -- three times sorted above a title that is that word, while the
             -- scores in the same result set said the opposite.
             ORDER BY bm25(document_search, 16.0, 1.0)
             LIMIT ?2",
        )
        .map_err(|cause| store_failure("prepare search", cause))?;

    let rows = statement
        .query_map(params![expression, limit], |row| {
            Ok(Hit {
                path: row.get(0)?,
                // FTS5 returns smaller-is-better; flip it so callers can read
                // "larger is more relevant" the way every other score here does.
                relevance: -row.get::<_, f64>(1)?,
            })
        })
        .map_err(|cause| store_failure("run search", cause))?;

    rows.collect::<rusqlite::Result<Vec<Hit>>>()
        .map_err(|cause| store_failure("read search results", cause))
}
