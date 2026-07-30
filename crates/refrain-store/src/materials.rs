//! Material draft rows (schema v5, SPEC 8.7).
//!
//! A draft is evidence of what the agent proposed; only a Human Material
//! Action turns one into a Material (a plain Markdown document with role
//! 'material'). Rows are inserted at collect, listed for review, and deleted
//! by the action that resolves them — never edited in place, because the
//! draft must stay the agent's words.

use rusqlite::params;

use crate::project::{ProjectFailure, ProjectStore};

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

pub struct PreparedMaterialSource {
    pub material: crate::ingest::IngestedMaterial,
    pub clone: std::path::PathBuf,
}

/// Read, identify, clone, and project one source without holding a project lock.
/// The same bounded byte buffer supplies the digest, immutable clone, and parser.
pub fn prepare_material_source(
    source: &std::path::Path,
    clone_dir: &std::path::Path,
) -> Result<PreparedMaterialSource, ProjectFailure> {
    let bytes = crate::ingest::read_source(source).map_err(ProjectFailure::Domain)?;
    let material = crate::ingest::ingest_bytes(source, &bytes).map_err(ProjectFailure::Domain)?;
    std::fs::create_dir_all(clone_dir).map_err(|source_error| ProjectFailure::Io {
        path: clone_dir.to_path_buf(),
        source: source_error,
    })?;
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("bin");
    let clone = clone_dir.join(format!("{}.{extension}", material.source_digest));
    if !clone.exists() {
        crate::atomic::replace_file_atomically(&clone, &bytes, |_| Ok(())).map_err(
            |source_error| ProjectFailure::Io {
                path: clone.clone(),
                source: source_error,
            },
        )?;
    }
    Ok(PreparedMaterialSource { material, clone })
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
    fn source_preparation_is_write_once_and_uses_one_buffer() {
        let store = scratch_store();
        let clone_dir = store.layout().source_backup_dir.join("materials");
        let dir = std::env::temp_dir().join(format!("refrain-src-{}", refrain_core::Id::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("参考.html");
        std::fs::write(&source, "<p>原件。</p>").unwrap();

        let prepared = prepare_material_source(&source, &clone_dir).unwrap();
        assert!(prepared.clone.exists(), "the clone landed");
        assert_eq!(
            prepared.material.source_digest,
            refrain_core::digest::content_hex("<p>原件。</p>".as_bytes())
        );
        assert_eq!(
            std::fs::read(&prepared.clone).unwrap(),
            "<p>原件。</p>".as_bytes()
        );
        assert_eq!(prepared.material.text, "原件。");

        let again = prepare_material_source(&source, &clone_dir).unwrap();
        assert_eq!(prepared.clone, again.clone);

        std::fs::write(&source, "<p>被换过。</p>").unwrap();
        let changed = prepare_material_source(&source, &clone_dir).unwrap();
        assert_ne!(prepared.clone, changed.clone);
        assert_eq!(
            std::fs::read(&prepared.clone).unwrap(),
            "<p>原件。</p>".as_bytes(),
            "a later source cannot rewrite the original clone"
        );
    }
}
