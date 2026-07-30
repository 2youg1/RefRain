//! Project document catalog.
//!
//! One module owns membership reconciliation and every read model over that
//! membership. The filesystem scan is authoritative for membership; SQLite is
//! the durable catalog. Existing rows keep identity, role, digest, confirmed
//! head, and lineage across a refresh.

use refrain_core::{DocumentRole, ErrorCode, Id, RefrainError, digest};
use rusqlite::params;

use super::{ProjectFailure, ProjectStore, infer_role};
use crate::files::{ScanOptions, index::scan_checked};
use crate::root::RootKind;

/// Name one scanned set by its paths and inferred roles.
///
/// Skip the generated ID because it changes on every scan. Sort the set because
/// filesystem traversal order is not stable. Length-prefixed parts keep paths
/// with arbitrary characters unambiguous without joining the full set first.
fn fingerprint_of(scanned: &[[String; 3]]) -> [u8; 32] {
    let mut identity: Vec<(&str, &str)> = scanned
        .iter()
        .map(|entry| (entry[1].as_str(), entry[2].as_str()))
        .collect();
    identity.sort_unstable();
    digest::sequence_bytes(
        identity
            .iter()
            .flat_map(|(path, role)| [path.as_bytes(), role.as_bytes()]),
    )
}

#[cfg(test)]
#[path = "catalog/tests/mod.rs"]
mod tests;
/// The largest document page that may cross a composition boundary at once.
pub const MAX_DOCUMENT_PAGE_SIZE: u32 = 256;
/// The largest search result that may cross the bridge at once.
pub const MAX_DOCUMENT_SEARCH_RESULTS: u32 = 64;
const MAX_DOCUMENT_SEARCH_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentPageQuery {
    pub after: Option<String>,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentPage {
    pub documents: Vec<DocumentRow>,
    pub total: u32,
    pub next: Option<String>,
}

/// A document row as the project database knows it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRow {
    pub id: Id,
    /// Portable identity inside the Root: the relative path, `/`-joined.
    pub path: String,
    pub role: DocumentRole,
    pub digest: Option<String>,
    /// The confirmed revision id and lineage paired with the digest.
    pub current_head: Option<String>,
    pub head_block_ids: Option<String>,
}

type StoredDocument = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn stored_document(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredDocument> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
    ))
}

fn decode_document(stored: StoredDocument) -> Result<DocumentRow, RefrainError> {
    let (id, path, role, digest, current_head, head_block_ids) = stored;
    let id = id
        .parse::<uuid::Uuid>()
        .map(Id::from_uuid)
        .map_err(|error| {
            RefrainError::new(ErrorCode::StateUnavailable, "read a document id", &path)
                .with_detail(error.to_string())
        })?;
    let role = DocumentRole::from_wire(&role).ok_or_else(|| {
        RefrainError::new(ErrorCode::StateUnavailable, "read a document role", &path)
    })?;
    Ok(DocumentRow {
        id,
        path,
        role,
        digest,
        current_head,
        head_block_ids,
    })
}

impl ProjectStore {
    /// Reconcile the authoritative scan in one transaction.
    ///
    /// An unchanged path-and-role fingerprint skips the temporary-table load
    /// and set comparison. Content changes do not invalidate this cache because
    /// this operation owns catalog membership only; document heads own content.
    fn reconcile_documents(&mut self) -> Result<(), ProjectFailure> {
        let scanned = if self.permit.kind == RootKind::File {
            vec![[
                Id::new().to_string(),
                self.permit
                    .canonical_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                DocumentRole::Document.as_str().to_string(),
            ]]
        } else {
            scan_checked(
                std::slice::from_ref(&self.permit.canonical_path),
                &ScanOptions {
                    manuscripts_only: true,
                    ..ScanOptions::default_for_open()
                },
            )
            .map_err(|error| {
                ProjectFailure::Domain(
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "reconcile the document index",
                        self.permit.canonical_path.display().to_string(),
                    )
                    .with_detail(error.to_string()),
                )
            })?
            .into_iter()
            .filter(|entry| entry.manuscript)
            .map(|entry| {
                let path = self.relative_path(&entry.path)?;
                Ok([
                    Id::new().to_string(),
                    path.clone(),
                    infer_role(self.permit.kind, &path).as_str().to_string(),
                ])
            })
            .collect::<Result<Vec<_>, ProjectFailure>>()?
        };
        let fingerprint = fingerprint_of(&scanned);
        if self.reconciled == Some(fingerprint) {
            return Ok(());
        }

        let scanned_json = serde_json::to_string(&scanned).map_err(|error| {
            ProjectFailure::Domain(
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "serialize the document index",
                    "refrain.db",
                )
                .with_detail(error.to_string()),
            )
        })?;

        let transaction = self.db.transaction()?;
        transaction.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS refreshed_documents (
                 id   TEXT NOT NULL,
                 path TEXT PRIMARY KEY,
                 role TEXT NOT NULL
             ) STRICT;
             DELETE FROM refreshed_documents;",
        )?;
        {
            let mut load_scan = transaction.prepare(
                "INSERT INTO refreshed_documents (id, path, role)
                 SELECT value ->> 0, value ->> 1, value ->> 2
                 FROM json_each(?1)",
            )?;
            load_scan.execute(params![scanned_json])?;

            let mut insert_new = transaction.prepare(
                "INSERT INTO documents (id, path, role, digest)
                 SELECT id, path, role, NULL FROM refreshed_documents WHERE true
                 ON CONFLICT(path) DO NOTHING",
            )?;
            insert_new.execute([])?;

            let mut remove_absent = transaction.prepare(
                "DELETE FROM documents
                 WHERE NOT EXISTS (
                     SELECT 1 FROM refreshed_documents
                     WHERE refreshed_documents.path = documents.path
                 )",
            )?;
            remove_absent.execute([])?;
        }
        transaction.commit()?;
        // A failed transaction leaves the cache empty so the next call retries.
        self.reconciled = Some(fingerprint);
        Ok(())
    }

    /// Reconcile and return the complete internal view.
    pub fn refresh_documents(&mut self) -> Result<Vec<DocumentRow>, ProjectFailure> {
        self.reconcile_documents()?;
        self.documents().map_err(ProjectFailure::Domain)
    }

    /// Reconcile and return one bounded renderer-facing page.
    pub fn refresh_document_page(
        &mut self,
        query: DocumentPageQuery,
    ) -> Result<DocumentPage, ProjectFailure> {
        self.reconcile_documents()?;
        self.document_page(query).map_err(ProjectFailure::Domain)
    }

    /// Every registered document, in path order. Internal callers only.
    pub fn documents(&self) -> Result<Vec<DocumentRow>, RefrainError> {
        let mut statement = self
            .db
            .prepare(
                "SELECT id, path, role, digest, current_head, head_block_ids
                 FROM documents ORDER BY path",
            )
            .map_err(|error| {
                RefrainError::new(ErrorCode::StateUnavailable, "list documents", "refrain.db")
                    .with_detail(error.to_string())
            })?;
        let rows = statement.query_map([], stored_document).map_err(|error| {
            RefrainError::new(ErrorCode::StateUnavailable, "list documents", "refrain.db")
                .with_detail(error.to_string())
        })?;
        rows.map(|row| {
            let stored = row.map_err(|error| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "read a document row",
                    "refrain.db",
                )
                .with_detail(error.to_string())
            })?;
            decode_document(stored)
        })
        .collect()
    }

    /// One bounded, path-ordered page. SQL limits rows before they enter Rust.
    pub fn document_page(&self, query: DocumentPageQuery) -> Result<DocumentPage, RefrainError> {
        let total = self
            .db
            .query_row("SELECT COUNT(*) FROM documents", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|error| {
                RefrainError::new(ErrorCode::StateUnavailable, "count documents", "refrain.db")
                    .with_detail(error.to_string())
            })?;
        let total = u32::try_from(total).map_err(|error| {
            RefrainError::new(ErrorCode::StateUnavailable, "count documents", "refrain.db")
                .with_detail(error.to_string())
        })?;
        let limit = query.limit.min(MAX_DOCUMENT_PAGE_SIZE);
        if limit == 0 {
            return Ok(DocumentPage {
                documents: Vec::new(),
                total,
                next: None,
            });
        }

        let mut statement = self
            .db
            .prepare(
                "SELECT id, path, role, digest, current_head, head_block_ids
                 FROM documents
                 WHERE (?1 IS NULL OR path > ?1)
                 ORDER BY path
                 LIMIT ?2",
            )
            .map_err(|error| {
                RefrainError::new(ErrorCode::StateUnavailable, "page documents", "refrain.db")
                    .with_detail(error.to_string())
            })?;
        let rows = statement
            .query_map(
                params![query.after.as_deref(), i64::from(limit) + 1],
                stored_document,
            )
            .map_err(|error| {
                RefrainError::new(ErrorCode::StateUnavailable, "page documents", "refrain.db")
                    .with_detail(error.to_string())
            })?;
        let mut documents = rows
            .map(|row| {
                let stored = row.map_err(|error| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "read a document row",
                        "refrain.db",
                    )
                    .with_detail(error.to_string())
                })?;
                decode_document(stored)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let next = if documents.len() > limit as usize {
            documents.pop();
            documents.last().map(|document| document.path.clone())
        } else {
            None
        };
        Ok(DocumentPage {
            documents,
            total,
            next,
        })
    }

    /// Literal substring search with a bounded response.
    ///
    /// The 100,000-row release fixture keeps p95 below 10ms. `%`, `_`, and `\`
    /// are literals, not renderer-controlled wildcards.
    pub fn search_documents(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<DocumentRow>, RefrainError> {
        let query = query.trim();
        if query.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        if query.len() > MAX_DOCUMENT_SEARCH_BYTES {
            return Err(
                RefrainError::new(ErrorCode::IllegalName, "search documents", "query").with_detail(
                    format!("query exceeds {MAX_DOCUMENT_SEARCH_BYTES} UTF-8 bytes"),
                ),
            );
        }
        let mut pattern = String::with_capacity(query.len() + 2);
        pattern.push('%');
        for character in query.chars() {
            if matches!(character, '%' | '_' | '\\') {
                pattern.push('\\');
            }
            pattern.push(character);
        }
        pattern.push('%');

        let mut statement = self
            .db
            .prepare(
                "SELECT id, path, role, digest, current_head, head_block_ids
                 FROM documents
                 WHERE path LIKE ?1 ESCAPE '\\'
                 ORDER BY path
                 LIMIT ?2",
            )
            .map_err(|error| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "search documents",
                    "refrain.db",
                )
                .with_detail(error.to_string())
            })?;
        let rows = statement
            .query_map(
                params![pattern, i64::from(limit.min(MAX_DOCUMENT_SEARCH_RESULTS))],
                stored_document,
            )
            .map_err(|error| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "search documents",
                    "refrain.db",
                )
                .with_detail(error.to_string())
            })?;
        rows.map(|row| {
            let stored = row.map_err(|error| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "read a document search result",
                    "refrain.db",
                )
                .with_detail(error.to_string())
            })?;
            decode_document(stored)
        })
        .collect()
    }
}
