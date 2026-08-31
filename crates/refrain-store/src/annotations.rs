// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! Persistent highlights and comments.
//!
//! The row stores a stable block identity, exact UTF-8 text offsets, and the
//! quoted source. The store preserves that anchor; the live manuscript decides
//! whether it is still anchored or has drifted.

use refrain_core::{ErrorCode, RefrainError};
use rusqlite::{Error as SqlError, params};

use crate::project::{ProjectFailure, ProjectStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AnnotationKind {
    Highlight,
    Comment,
}

impl AnnotationKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Highlight => "highlight",
            Self::Comment => "comment",
        }
    }

    fn parse(value: &str) -> Result<Self, SqlError> {
        match value {
            "highlight" => Ok(Self::Highlight),
            "comment" => Ok(Self::Comment),
            _ => Err(SqlError::InvalidQuery),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationRow {
    pub id: String,
    pub document: String,
    pub block_id: String,
    pub start: u32,
    pub end: u32,
    pub quote: String,
    pub kind: AnnotationKind,
    pub body: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl ProjectStore {
    /// Insert a new annotation or relocate/update the same annotation.
    /// Creation time is immutable; relocation only advances `updated_at`.
    pub fn annotation_upsert(&mut self, row: &AnnotationRow) -> Result<(), ProjectFailure> {
        let changed = self.db.execute(
            "INSERT INTO annotations
                 (id, document, block_id, start, end, quote, kind, body, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
                 block_id = excluded.block_id,
                 start = excluded.start,
                 end = excluded.end,
                 quote = excluded.quote,
                 kind = excluded.kind,
                 body = excluded.body,
                 updated_at = excluded.updated_at
             WHERE annotations.document = excluded.document",
            params![
                row.id,
                row.document,
                row.block_id,
                row.start,
                row.end,
                row.quote,
                row.kind.as_str(),
                row.body,
                row.created_at,
                row.updated_at,
            ],
        )?;
        if changed == 0 {
            return Err(RefrainError::new(
                ErrorCode::StateUnavailable,
                "move an annotation into another document",
                row.id.clone(),
            )
            .into());
        }
        Ok(())
    }

    pub fn annotations(&self, document: &str) -> Result<Vec<AnnotationRow>, ProjectFailure> {
        let mut statement = self.db.prepare(
            "SELECT id, document, block_id, start, end, quote, kind, body, created_at, updated_at
             FROM annotations WHERE document = ?1 ORDER BY created_at, rowid",
        )?;
        let rows = statement
            .query_map(params![document], |row| {
                let kind: String = row.get(6)?;
                Ok(AnnotationRow {
                    id: row.get(0)?,
                    document: row.get(1)?,
                    block_id: row.get(2)?,
                    start: row.get(3)?,
                    end: row.get(4)?,
                    quote: row.get(5)?,
                    kind: AnnotationKind::parse(&kind)?,
                    body: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Return whether a row existed. Repeating delete is a harmless no-op.
    pub fn annotation_delete(&mut self, id: &str) -> Result<bool, ProjectFailure> {
        Ok(self
            .db
            .execute("DELETE FROM annotations WHERE id = ?1", params![id])?
            > 0)
    }
}
