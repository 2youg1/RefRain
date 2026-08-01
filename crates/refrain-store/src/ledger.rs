//! The Verdict Ledger: every human judgment is first-class data (SPEC 1.2).
//!
//! Ported behaviour (legacy `ledger.ts` via `store.test.ts`, owned here since
//! C3):
//!
//! - Recording is idempotent by id: a duplicate id cannot rewrite the
//!   original audit record.
//! - Verdicts return in decision order.
//! - An unstated reason stays absent; it never becomes an empty string.
//! - Search escapes LIKE's wildcards: `_`, `%`, and `\` in the author's query
//!   are characters, not operators. The parameter was always bound, but the
//!   unescaped fragment quietly returned rows that did not match, and the
//!   author had no way to notice.

use rusqlite::{Connection, OptionalExtension, params};

use crate::schema::StoreError;

/// The persisted shape of one judgment. `AcceptModified` carries its final
/// text in `final_text`; the kind column alone never tells that story.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum VerdictKindName {
    Accept,
    AcceptModified,
    Reject,
    CommentOnly,
}

impl VerdictKindName {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::AcceptModified => "accept-modified",
            Self::Reject => "reject",
            Self::CommentOnly => "comment-only",
        }
    }

    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "accept" => Some(Self::Accept),
            "accept-modified" => Some(Self::AcceptModified),
            "reject" => Some(Self::Reject),
            "comment-only" => Some(Self::CommentOnly),
            _ => None,
        }
    }
}

/// One row of the ledger. Ids stay strings here: legacy rows arrive with
/// legacy ids during migration (INV-9), and the ledger must hold both
/// without rewriting either.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VerdictRecord {
    pub id: String,
    pub proposal_id: String,
    pub slice_id: String,
    pub kind: VerdictKindName,
    pub final_text: Option<String>,
    pub reason: Option<String>,
    /// Milliseconds since the Unix epoch (string on the bridge: Specta
    /// forbids BigInt-style exports).
    #[serde(with = "crate::project::u64_string")]
    #[specta(type = String)]
    pub decided_at: u64,
    /// The baseline spelling a legacy row arrived with, kept byte-for-byte.
    pub legacy_baseline: Option<String>,
}

/// The ledger is a view over the project database, never a second store.
pub struct VerdictLedger<'a> {
    db: &'a Connection,
}

impl<'a> VerdictLedger<'a> {
    #[must_use]
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// Records a judgment. A repeated id keeps the original row: the audit
    /// trail is not writable by accident of retry.
    pub fn record(&self, verdict: &VerdictRecord) -> Result<(), StoreError> {
        self.db.execute(
            "INSERT OR IGNORE INTO verdicts
                 (id, proposal_id, slice_id, kind, final_text, reason, decided_at, legacy_baseline)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                verdict.id,
                verdict.proposal_id,
                verdict.slice_id,
                verdict.kind.as_str(),
                verdict.final_text,
                verdict.reason,
                verdict.decided_at as i64,
                verdict.legacy_baseline,
            ],
        )?;
        Ok(())
    }

    /// Every verdict, in decision order (ties broken by insertion order).
    pub fn all(&self) -> Result<Vec<VerdictRecord>, StoreError> {
        let mut statement = self.db.prepare(
            "SELECT id, proposal_id, slice_id, kind, final_text, reason, decided_at, legacy_baseline
                 FROM verdicts ORDER BY decided_at, rowid",
        )?;
        let rows = statement
            .query_map([], read_record)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// One document's verdicts, oldest first: the `<changes>` stream's
    /// source (SPEC 8.5). Verdicts carry no document column; the proposal
    /// they judge does.
    pub fn for_document(&self, path: &str) -> Result<Vec<VerdictRecord>, StoreError> {
        let mut statement = self.db.prepare(
            "SELECT v.id, v.proposal_id, v.slice_id, v.kind, v.final_text, v.reason,
                    v.decided_at, v.legacy_baseline
                 FROM verdicts v
                 JOIN proposals p ON p.id = v.proposal_id
                 WHERE p.document_path = ?1
                 ORDER BY v.decided_at, v.rowid",
        )?;
        let rows = statement
            .query_map(params![path], read_record)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Rows by id, in decision order. The commit path rebuilds its batch
    /// from these; a missing id is a defect, not a skip.
    pub fn find_many(&self, ids: &[String]) -> Result<Vec<VerdictRecord>, StoreError> {
        let all = self.all()?;
        ids.iter()
            .map(|id| {
                all.iter()
                    .find(|row| &row.id == id)
                    .cloned()
                    .ok_or(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
            })
            .collect()
    }

    /// Forget judgments by id: the recall path （已裁决 → 已回复）. Only rows
    /// that never reached a commit should pass through here — the caller owns
    /// that check, because the ledger cannot see batches.
    pub fn forget(&self, ids: &[String]) -> Result<usize, StoreError> {
        let mut forgotten = 0;
        for id in ids {
            forgotten += self
                .db
                .execute("DELETE FROM verdicts WHERE id = ?1", params![id])?;
        }
        Ok(forgotten)
    }

    /// Full-text-free fragment search over the author's stated reasons. The
    /// fragment is escaped so its wildcards are characters.
    pub fn search(&self, fragment: &str) -> Result<Vec<VerdictRecord>, StoreError> {
        let escaped = fragment
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let mut statement = self.db.prepare(
            "SELECT id, proposal_id, slice_id, kind, final_text, reason, decided_at, legacy_baseline
             FROM verdicts
             WHERE reason LIKE ?1 ESCAPE '\\'
             ORDER BY decided_at, rowid",
        )?;
        let rows = statement
            .query_map(params![format!("%{escaped}%")], read_record)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn count(&self) -> Result<u64, StoreError> {
        let count: i64 = self
            .db
            .query_row("SELECT count(*) FROM verdicts", [], |row| row.get(0))
            .optional()?
            .unwrap_or(0);
        Ok(count as u64)
    }
}

fn read_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<VerdictRecord> {
    let kind_text: String = row.get(3)?;
    let kind = VerdictKindName::from_wire(&kind_text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            format!("unknown verdict kind {kind_text}").into(),
        )
    })?;
    Ok(VerdictRecord {
        id: row.get(0)?,
        proposal_id: row.get(1)?,
        slice_id: row.get(2)?,
        kind,
        final_text: row.get(4)?,
        reason: row.get(5)?,
        decided_at: row.get::<_, i64>(6)? as u64,
        legacy_baseline: row.get(7)?,
    })
}
