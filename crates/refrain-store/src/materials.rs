//! Material draft rows (schema v5, SPEC 8.7).
//!
//! A draft is evidence of what the agent proposed; only a Human Material
//! Action turns one into a Material (a plain Markdown document with role
//! 'material'). Rows are inserted at collect, listed for review, and deleted
//! by the action that resolves them — never edited in place, because the
//! draft must stay the agent's words.

use rusqlite::params;

use crate::project::{ProjectFailure, ProjectStore};
use sha2::Digest as _;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MaterialDraftRow {
    pub id: String,
    pub run_id: String,
    /// The dispatch's document: the draft's context of origin.
    pub document: String,
    pub kind: String,
    pub title: String,
    /// JSON array of `DOCUMENT@REVISION` references.
    pub basis: String,
    pub body: String,
    #[serde(with = "crate::project::u64_string")]
    #[specta(type = String)]
    pub created_at: u64,
}

impl ProjectStore {
    pub fn material_draft_insert(&mut self, row: &MaterialDraftRow) -> Result<(), ProjectFailure> {
        self.db.execute(
            "INSERT INTO material_drafts (id, run_id, document, kind, title, basis, body, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                row.id,
                row.run_id,
                row.document,
                row.kind,
                row.title,
                row.basis,
                row.body,
                row.created_at as i64
            ],
        )?;
        Ok(())
    }

    pub fn material_drafts(&self) -> Result<Vec<MaterialDraftRow>, ProjectFailure> {
        let mut statement = self.db.prepare(
            "SELECT id, run_id, document, kind, title, basis, body, created_at
                 FROM material_drafts ORDER BY created_at, rowid",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(MaterialDraftRow {
                    id: row.get(0)?,
                    run_id: row.get(1)?,
                    document: row.get(2)?,
                    kind: row.get(3)?,
                    title: row.get(4)?,
                    basis: row.get(5)?,
                    body: row.get(6)?,
                    created_at: row.get::<_, i64>(7)? as u64,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The action resolves the draft: save or dismiss, the row goes. A
    /// missing row is an error — resolving nothing must not look like
    /// resolving something.
    pub fn material_draft_take(&mut self, id: &str) -> Result<MaterialDraftRow, ProjectFailure> {
        let row = self
            .material_drafts()?
            .into_iter()
            .find(|row| row.id == id)
            .ok_or(crate::schema::StoreError::Sqlite(
                rusqlite::Error::QueryReturnedNoRows,
            ))?;
        self.db
            .execute("DELETE FROM material_drafts WHERE id = ?1", params![id])?;
        Ok(row)
    }

    /// Clone one material's source into the project's read-only zone (KL9:
    /// the source never moves — backtracking forever needs the original
    /// bytes inside the project, not just the projected text). The clone is
    /// digest-named and write-once: an existing clone of the same bytes is
    /// proof, not a collision, and nothing ever overwrites it. The expected
    /// digest must match what was ingested; a source that moved between
    /// ingest and clone is a typed refusal, not a quiet re-read.
    pub fn clone_material_source(
        &self,
        source: &std::path::Path,
        expected_digest: &str,
    ) -> Result<std::path::PathBuf, ProjectFailure> {
        let bytes = std::fs::read(source).map_err(|source_error| ProjectFailure::Io {
            path: source.to_path_buf(),
            source: source_error,
        })?;
        let digest = format!("{:x}", sha2::Sha256::digest(&bytes));
        if digest != expected_digest {
            return Err(ProjectFailure::Domain(refrain_core::RefrainError::new(
                refrain_core::ErrorCode::StateUnavailable,
                "clone a source that changed since ingest",
                source.display().to_string(),
            )));
        }
        let dir = self.layout().source_backup_dir.join("materials");
        std::fs::create_dir_all(&dir).map_err(|source_error| ProjectFailure::Io {
            path: dir.clone(),
            source: source_error,
        })?;
        let extension = source
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("bin");
        let target = dir.join(format!("{digest}.{extension}"));
        if !target.exists() {
            crate::atomic::replace_file_atomically(&target, &bytes, |_| Ok(())).map_err(
                |source_error| ProjectFailure::Io {
                    path: target.clone(),
                    source: source_error,
                },
            )?;
        }
        Ok(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::RootLocator;
    use crate::root::RootKind;
    use crate::schema::{AppDb, Database};

    fn scratch_store() -> ProjectStore {
        let dir = std::env::temp_dir().join(format!("refrain-mat-{}", refrain_core::Id::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut app = crate::schema::open_in_memory().unwrap();
        AppDb::migrate(&mut app).unwrap();
        let locator = RootLocator {
            path: dir,
            kind: RootKind::Folder,
        };
        let (store, _backup) = ProjectStore::adopt(&mut app, &locator).unwrap();
        store
    }

    fn draft(id: &str) -> MaterialDraftRow {
        MaterialDraftRow {
            id: id.to_string(),
            run_id: "r1".to_string(),
            document: "ch01.md".to_string(),
            kind: "character-profile".to_string(),
            title: "林栖迟".to_string(),
            basis: "[\"ch01.md@rev1\"]".to_string(),
            body: "她说话很省。".to_string(),
            created_at: 1_000,
        }
    }

    #[test]
    fn drafts_insert_list_and_take() {
        let mut store = scratch_store();
        store.material_draft_insert(&draft("d1")).unwrap();
        store.material_draft_insert(&draft("d2")).unwrap();
        assert_eq!(store.material_drafts().unwrap().len(), 2);

        let taken = store.material_draft_take("d1").unwrap();
        assert_eq!(taken.title, "林栖迟");
        assert_eq!(store.material_drafts().unwrap().len(), 1);
        assert!(
            store.material_draft_take("d1").is_err(),
            "a resolved draft is gone"
        );
    }

    #[test]
    fn a_source_clone_is_write_once_and_digest_verified() {
        let store = scratch_store();
        let dir = std::env::temp_dir().join(format!("refrain-src-{}", refrain_core::Id::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("参考.html");
        std::fs::write(&source, "<p>原件。</p>").unwrap();
        let digest = format!("{:x}", sha2::Sha256::digest("<p>原件。</p>".as_bytes()));

        let clone = store.clone_material_source(&source, &digest).unwrap();
        assert!(clone.exists(), "the clone landed");
        assert_eq!(std::fs::read(&clone).unwrap(), "<p>原件。</p>".as_bytes());

        // A second import of the same bytes writes nothing new.
        let again = store.clone_material_source(&source, &digest).unwrap();
        assert_eq!(clone, again);

        // A stale digest is a typed refusal; a changed source cannot sneak in.
        assert!(store.clone_material_source(&source, &"0".repeat(64)).is_err());
        std::fs::write(&source, "<p>被换过。</p>").unwrap();
        assert!(store.clone_material_source(&source, &digest).is_err());
    }
}
