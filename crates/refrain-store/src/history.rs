//! The persisted Text Action history: the undo chain, durable across restarts.
//!
//! One row per executed Text Action, written when the action lands — the same
//! journal discipline as `pending_actions`: the row exists exactly when the
//! in-memory action did, and nothing is ever rewritten, only marked.
//!
//! Two moments matter, and the table treats them differently:
//!
//! - **Execute** writes the row. A crash afterwards leaves either a row that
//!   never chained from a saved head (the hydration walk never reaches it) or
//!   a row the next save reconciles — never a partial chain.
//! - **Save** reconciles. `undone_at` is written here and only here, because
//!   undo moves session memory until the author saves: a crash must resume
//!   the chain the disk still holds, and a row marked undone while its text
//!   is still on disk would make hydration skip the whole history.

use refrain_core::{Id, PersistedRegion, TextAction, Verdict};
use rusqlite::{Connection, OptionalExtension, params};

use crate::schema::StoreError;

/// How far back an open rehydrates the undo stack. Every hydrated row holds
/// its regions' full text, so depth is memory kept per open document; 64
/// covers any undo streak an author actually walks back, and older rows stay
/// in the table for the audit even though undo cannot reach them.
pub const HYDRATION_DEPTH: u32 = 64;

/// The most rows one list call returns. A screenful of history entries is
/// tens; 100 covers a long scroll without an unbounded bridge payload.
pub const MAX_TEXT_ACTION_LIST: u32 = 100;

/// One row of the history as the sidebar lists it: no regions, no edits —
/// the summary the panel needs to offer a rollback point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionSummary {
    pub id: Id,
    pub ordinal: u32,
    pub cause: String,
    /// Milliseconds since the Unix epoch.
    pub created_at: u64,
    pub undone: bool,
}

/// The history is a view over the project database, never a second store.
pub struct ActionHistory<'a> {
    db: &'a Connection,
}

impl<'a> ActionHistory<'a> {
    #[must_use]
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// Record an executed action. The ordinal is assigned inside the same
    /// statement as the insert (`MAX + 1` over the document's rows), so a
    /// crash cannot leave a gap, and `UNIQUE(document, ordinal)` refuses the
    /// duplicate if it ever could.
    pub fn record(&self, document: &str, action: &TextAction, head: Id) -> Result<(), StoreError> {
        let regions = encode("regions", &action.persisted_regions())?;
        let edits = encode("edits", &action.edits())?;
        let verdicts = encode("verdicts", &action.verdicts())?;
        self.db.execute(
            "INSERT INTO text_actions
                 (id, document, ordinal, base, head, cause, regions, edits, verdicts, created_at)
             SELECT ?1, ?2, COALESCE(MAX(ordinal), 0) + 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9
             FROM text_actions WHERE document = ?2",
            params![
                action.id().to_string(),
                document,
                action.base().to_string(),
                head.to_string(),
                action.cause(),
                regions,
                edits,
                verdicts,
                now_millis() as i64,
            ],
        )?;
        Ok(())
    }

    /// The live chain that produced `tip`, oldest first, capped at `depth`
    /// rows. The walk follows the chain's own linkage — a row joins only when
    /// its `head` is the `base` the row above it names — so rows that never
    /// chained from a saved head (crash orphans, undone branches the next
    /// save has not reconciled yet) are unreachable by construction.
    pub fn chain(
        &self,
        document: &str,
        tip: Id,
        depth: u32,
    ) -> Result<Vec<TextAction>, StoreError> {
        let mut statement = self.db.prepare(
            "SELECT id, base, cause, regions, verdicts, ordinal
             FROM text_actions
             WHERE document = ?1 AND head = ?2 AND undone_at IS NULL AND ordinal < ?3
             ORDER BY ordinal DESC
             LIMIT 1",
        )?;
        let mut target = tip.to_string();
        let mut bound = i64::MAX;
        let mut walked = Vec::new();
        for _ in 0..depth {
            let row = statement
                .query_row(params![document, target, bound], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })
                .optional()?;
            let Some((id, base, cause, regions, verdicts, ordinal)) = row else {
                break;
            };
            walked.push(decode_action(&id, &base, &cause, &regions, &verdicts)?);
            target = base;
            bound = ordinal;
        }
        walked.reverse();
        Ok(walked)
    }

    /// The most recent rows, newest first, for the history panel.
    pub fn list_recent(
        &self,
        document: &str,
        limit: u32,
    ) -> Result<Vec<ActionSummary>, StoreError> {
        let mut statement = self.db.prepare(
            "SELECT id, ordinal, cause, created_at, undone_at
             FROM text_actions
             WHERE document = ?1
             ORDER BY ordinal DESC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![document, i64::from(limit)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })?;
        rows.map(|row| {
            let (id, ordinal, cause, created_at, undone_at) = row?;
            Ok(ActionSummary {
                id: id.parse().map_err(|_| damaged(&id, "id"))?,
                ordinal: u32::try_from(ordinal).map_err(|_| damaged(&id, "ordinal"))?,
                cause,
                created_at: u64::try_from(created_at).map_err(|_| damaged(&id, "created_at"))?,
                undone: undone_at.is_some(),
            })
        })
        .collect()
    }

    /// Reconcile the rows with the session's live chain at save time: every
    /// row in the chain's window that the live stack no longer names —
    /// undone in the session, or orphaned by a crash between execute and
    /// save — is marked undone, exactly when the state without it becomes
    /// durable.
    ///
    /// The window starts at the oldest row the live chain names. When the
    /// complete hydrated window was undone, the just-saved document head names
    /// the base of its first row instead. Rows below that floor fell out of the
    /// hydrated depth and are still part of the durable chain.
    /// The marks are idempotent, so a failure here is repaired by the next
    /// save rather than by a repair path.
    pub fn sync_chain(&self, document: &str, live: &[Id]) -> Result<(), StoreError> {
        let live: std::collections::HashSet<String> = live.iter().map(Id::to_string).collect();
        let mut statement = self.db.prepare(
            "SELECT id, ordinal FROM text_actions
             WHERE document = ?1 AND undone_at IS NULL",
        )?;
        let rows = statement
            .query_map(params![document], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let floor = if live.is_empty() {
            // Undoing the whole hydrated window leaves no live id to derive a
            // floor from. The head this save just made durable names the base
            // of the first undone row, which is that floor.
            self.db.query_row(
                "SELECT MIN(actions.ordinal)
                 FROM text_actions AS actions
                 JOIN documents ON documents.path = actions.document
                 WHERE actions.document = ?1
                   AND actions.undone_at IS NULL
                   AND actions.base = documents.current_head",
                params![document],
                |row| row.get::<_, Option<i64>>(0),
            )?
        } else {
            rows.iter()
                .filter(|(id, _)| live.contains(id))
                .map(|(_, ordinal)| *ordinal)
                .min()
        };
        let Some(floor) = floor else {
            return Ok(());
        };
        let now = now_millis() as i64;
        for (id, _) in rows
            .iter()
            .filter(|(id, ordinal)| *ordinal >= floor && !live.contains(id))
        {
            self.db.execute(
                "UPDATE text_actions SET undone_at = ?1 WHERE id = ?2 AND undone_at IS NULL",
                params![now, id],
            )?;
        }
        Ok(())
    }
}

fn encode<T: serde::Serialize>(column: &str, value: &T) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|error| {
        StoreError::Sqlite(rusqlite::Error::ToSqlConversionFailure(
            format!("encode text_actions.{column}: {error}").into(),
        ))
    })
}

/// A row that does not decode is damaged evidence, not a skipped row: the
/// refusal names it, the way a damaged Config names its field.
fn damaged(row: &str, column: &str) -> StoreError {
    StoreError::Sqlite(rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        format!("text_actions row {row} carries a damaged {column}").into(),
    ))
}

fn decode_action(
    id: &str,
    base: &str,
    cause: &str,
    regions: &str,
    verdicts: &str,
) -> Result<TextAction, StoreError> {
    let id_parsed: Id = id.parse().map_err(|_| damaged(id, "id"))?;
    let base_parsed: Id = base.parse().map_err(|_| damaged(id, "base"))?;
    let regions: Vec<PersistedRegion> =
        serde_json::from_str(regions).map_err(|_| damaged(id, "regions"))?;
    let verdicts: Vec<Verdict> =
        serde_json::from_str(verdicts).map_err(|_| damaged(id, "verdicts"))?;
    Ok(TextAction::from_persisted(
        id_parsed,
        base_parsed,
        cause.to_owned(),
        regions,
        verdicts,
    ))
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{Database, ProjectDb};

    fn migrated() -> Connection {
        let mut db = crate::schema::open_in_memory().unwrap();
        ProjectDb::migrate(&mut db).unwrap();
        db
    }

    /// `UNIQUE(document, ordinal)` is the database's own proof that the
    /// MAX-plus-one insert cannot duplicate: writing one by hand must fail.
    #[test]
    fn the_ordinal_sequence_refuses_a_duplicate() {
        let db = migrated();
        let insert = |ordinal: i64| {
            db.execute(
                "INSERT INTO text_actions
                     (id, document, ordinal, base, head, cause, regions, edits, verdicts, created_at)
                 VALUES (?1, '章.md', ?2, ?3, ?4, 'author edit', '[]', '[]', '[]', 0)",
                params![
                    Id::new().to_string(),
                    ordinal,
                    Id::new().to_string(),
                    Id::new().to_string()
                ],
            )
        };
        insert(1).unwrap();
        assert!(
            insert(1).is_err(),
            "a duplicate (document, ordinal) must fail"
        );
        // Another document's first ordinal is not a duplicate.
        db.execute(
            "INSERT INTO text_actions
                 (id, document, ordinal, base, head, cause, regions, edits, verdicts, created_at)
             VALUES (?1, '二章.md', 1, ?2, ?3, 'author edit', '[]', '[]', '[]', 0)",
            params![
                Id::new().to_string(),
                Id::new().to_string(),
                Id::new().to_string()
            ],
        )
        .unwrap();
    }

    /// A row whose regions do not decode is damaged evidence: the walk
    /// refuses and names the row, the way a damaged Config names its field.
    #[test]
    fn a_damaged_row_refuses_the_walk_loudly() {
        let db = migrated();
        let head = Id::new();
        db.execute(
            "INSERT INTO text_actions
                 (id, document, ordinal, base, head, cause, regions, edits, verdicts, created_at)
             VALUES (?1, '章.md', 1, ?2, ?3, 'author edit', 'not json', '[]', '[]', 0)",
            params![
                Id::new().to_string(),
                Id::new().to_string(),
                head.to_string()
            ],
        )
        .unwrap();

        let failure = ActionHistory::new(&db)
            .chain("章.md", head, 10)
            .unwrap_err();
        assert!(
            failure.to_string().contains("damaged regions"),
            "the refusal must name what broke: {failure}"
        );
    }
}
