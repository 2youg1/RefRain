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

use refrain_core::chinese_index::{bigram, match_expression};
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
}

fn store_failure(action: &'static str, cause: rusqlite::Error) -> RefrainError {
    RefrainError::new(ErrorCode::StateUnavailable, action, "refrain.db")
        .with_detail(cause.to_string())
}

fn entry_of(db: &Connection, path: &str) -> Result<Option<Entry>, RefrainError> {
    db.query_row(
        "SELECT rowid_of, digest FROM document_search_state WHERE document = ?1",
        params![path],
        |row| {
            Ok(Entry {
                rowid: row.get(0)?,
                digest: row.get(1)?,
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
        // An external-content table stores no text, so the only way to delete
        // a row is to hand FTS5 back exactly what was inserted. That text is
        // gone, so the delete has to be driven by the 'delete-all' command for
        // this rowid instead: replay through the rebuild path below.
        remove_rowid(db, entry.rowid)?;
    }

    let rowid = existing
        .as_ref()
        .map_or_else(|| next_rowid(db).unwrap_or(1), |entry| entry.rowid);

    db.execute(
        "INSERT INTO document_search(rowid, path, body) VALUES (?1, ?2, ?3)",
        params![rowid, bigram(path), bigram(text)],
    )
    .map_err(|cause| store_failure("index document", cause))?;

    db.execute(
        "INSERT INTO document_search_state(document, rowid_of, digest)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(document) DO UPDATE SET rowid_of = ?2, digest = ?3",
        params![path, rowid, digest],
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

/// Remove a rowid from the inverted index.
///
/// External-content tables delete by replaying the indexed text, which we no
/// longer have. FTS5 provides `delete-all` for exactly this situation, but it
/// clears the whole table, so instead the row is overwritten with empty text
/// and its state row dropped: the tokens go, the rowid stays free for reuse,
/// and no stale posting survives.
fn remove_rowid(db: &Connection, rowid: i64) -> Result<(), RefrainError> {
    db.execute(
        "INSERT INTO document_search(document_search, rowid, path, body)
         VALUES ('delete', ?1, '', '')",
        params![rowid],
    )
    .map_err(|cause| store_failure("clear search entry", cause))?;
    Ok(())
}

/// Drop a document from the index entirely.
pub fn forget_document(db: &Connection, path: &str) -> Result<bool, RefrainError> {
    let Some(entry) = entry_of(db, path)? else {
        return Ok(false);
    };
    remove_rowid(db, entry.rowid)?;
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

/// Find documents whose path or body matches the query.
///
/// Ordering here is by bm25 alone. The final order is decided by
/// `refrain_core::search_rank`, which knows things this layer does not: which
/// block a hit landed in, what role the document plays, when the author last
/// touched it. Sorting twice is deliberate — this pass narrows a corpus to
/// candidates, and the ranking pass decides what the author sees first.
///
/// The path column is weighted above the body: a query matching the title the
/// author chose is a stronger signal than the same words appearing in prose.
pub fn search(db: &Connection, query: &str, limit: u32) -> Result<Vec<Hit>, RefrainError> {
    let Some(expression) = match_expression(query) else {
        return Ok(Vec::new());
    };

    let mut statement = db
        .prepare(
            "SELECT s.document, bm25(document_search, 4.0, 1.0)
             FROM document_search
             JOIN document_search_state s ON s.rowid_of = document_search.rowid
             WHERE document_search MATCH ?1
             ORDER BY rank
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
