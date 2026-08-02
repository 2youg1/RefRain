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

/// Read back the immutable clone of an imported source.
///
/// The clone is what `prepare_material_source` wrote, named `{digest}.{ext}`.
/// Reading it is how a reader sees the original pages of a PDF while writing
/// in their own manuscript — RefRain projects text out of a source but never
/// writes back into one, so the clone is the only faithful copy it can show.
///
/// This is a **read** of `SOURCE_BACKUP_DIR`. Nothing here creates or replaces
/// a file: the backup is written once at import and is never touched again.
///
/// The digest is checked against the bytes on the way out. A clone whose
/// content no longer matches its own name is not shown, because the caller
/// asked for one specific document and would otherwise render a different one.
///
/// **Which guard actually holds**: the digest check is the load-bearing one.
/// A traversal that escapes this directory reaches some other file, and that
/// file will not hash to the name that was asked for — so the digest refuses
/// it even with the character check removed (measured: deleting the character
/// check alone left every test green; both had to go before the traversal
/// test could fail). The character check is defence in depth and a clearer
/// error, not the thing standing between a crafted row and an arbitrary read.
/// Anyone tempted to drop the digest check to save a hash should read that
/// sentence again.
pub fn read_material_clone(
    clone_dir: &std::path::Path,
    digest: &str,
    extension: &str,
) -> Result<Vec<u8>, ProjectFailure> {
    // The digest and extension both reach this function from a stored row, but
    // they still travel through a path join. Reject anything that could leave
    // the clone directory rather than trusting the caller.
    //
    // Which guard carries the load, measured by deleting each one:
    //
    // | deleted            | tests |
    // |--------------------|-------|
    // | this char check    | all 6 pass — the digest check catches it |
    // | the digest check   | 1 fails |
    // | both               | 2 fail, including the traversal case |
    //
    // So the digest comparison below is the load-bearing guard: a traversal
    // path reaches some other file, and that file does not hash to the name
    // that was asked for. This check is defence in depth — it refuses the
    // attempt before any read happens. Delete neither; if a future reader
    // trims one for cost, this table says which one costs correctness.
    let safe = |value: &str| {
        !value.is_empty()
            && value
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
    };
    if !safe(digest) || !safe(extension) {
        return Err(ProjectFailure::Domain(refrain_core::RefrainError::new(
            refrain_core::ErrorCode::UnsupportedFormat,
            "read an imported source",
            "clone name",
        )));
    }
    let path = clone_dir.join(format!("{digest}.{extension}"));
    let bytes = std::fs::read(&path).map_err(|source| ProjectFailure::Io {
        path: path.clone(),
        source,
    })?;
    if refrain_core::digest::content_hex(&bytes) != digest {
        return Err(ProjectFailure::Domain(refrain_core::RefrainError::new(
            refrain_core::ErrorCode::UnsupportedFormat,
            "read an imported source",
            "clone digest mismatch",
        )));
    }
    Ok(bytes)
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
    fn a_recorded_source_survives_reconciliation() {
        // The whole point of storing the source on the row: the reader resolves
        // the original pages from these two columns. Reconciliation walks the
        // folder and upserts every document it finds, knowing nothing about
        // imports — without the COALESCE in `upsert_document` that pass writes
        // NULL over the record and every Material silently loses its original.
        let mut store = scratch_store();
        let created = store
            .create(&crate::project::CreateDocument {
                title: "参考".to_string(),
                role: refrain_core::DocumentRole::Material,
            })
            .unwrap();
        let path = created.row.path.clone();
        assert!(
            created.row.source_digest.is_none(),
            "a freshly created document has no source"
        );

        store
            .record_imported_source(&path, "abc123", "pdf")
            .unwrap();
        let find = |store: &ProjectStore| {
            store
                .documents()
                .unwrap()
                .into_iter()
                .find(|row| row.path == path)
                .expect("the row is there")
        };
        let after_import = find(&store);
        assert_eq!(after_import.source_digest.as_deref(), Some("abc123"));
        assert_eq!(after_import.source_format.as_deref(), Some("pdf"));

        // Reconciliation walks the folder and inserts every document it finds,
        // knowing nothing about imports. It is guarded by `ON CONFLICT DO
        // NOTHING`; if that ever becomes an upsert that writes its own NULL
        // columns through, every Material loses the pointer to its original on
        // the next scan and the reader silently falls back to plain text.
        //
        // The reconciler caches a fingerprint of the scan, so calling it twice
        // in a row returns early. Touching the file changes the scan and makes
        // the second pass do real work — without this the assertion below
        // passes on a code path that never ran.
        store.refresh_documents().unwrap();
        let extra = store.permit().canonical_path.join("另一份.md");
        std::fs::write(&extra, "第二份稿子。").unwrap();
        store.refresh_documents().unwrap();

        let after_scan = find(&store);
        assert_eq!(
            after_scan.source_digest.as_deref(),
            Some("abc123"),
            "a scan that knows nothing about imports must not erase one"
        );
        assert_eq!(after_scan.source_format.as_deref(), Some("pdf"));
    }

    #[test]
    fn an_imported_source_reads_back_byte_for_byte() {
        let store = scratch_store();
        let clone_dir = store.layout().source_backup_dir.join("materials");
        let dir = std::env::temp_dir().join(format!("refrain-read-{}", refrain_core::Id::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("参考.html");
        let original = "<p>原件的字节。</p>";
        std::fs::write(&source, original).unwrap();
        let prepared = prepare_material_source(&source, &clone_dir).unwrap();

        let read = read_material_clone(&clone_dir, &prepared.material.source_digest, "html")
            .expect("the clone reads back");
        assert_eq!(
            read,
            original.as_bytes(),
            "the reader sees the original bytes, not the projected text"
        );
    }

    #[test]
    fn a_clone_whose_bytes_no_longer_match_its_name_is_refused() {
        // The digest is the file's own name. If the two disagree the caller
        // would be shown a different document than the one it asked for, so
        // this refuses rather than rendering the wrong pages.
        let store = scratch_store();
        let clone_dir = store.layout().source_backup_dir.join("materials");
        std::fs::create_dir_all(&clone_dir).unwrap();
        let digest = refrain_core::digest::content_hex(b"the real bytes");
        let path = clone_dir.join(format!("{digest}.html"));
        std::fs::write(&path, b"different bytes entirely").unwrap();

        assert!(
            read_material_clone(&clone_dir, &digest, "html").is_err(),
            "a clone that does not hash to its own name is refused"
        );
    }

    #[test]
    fn a_clone_name_cannot_leave_its_directory() {
        // Both parts reach the join from a stored row, but a stored row is not
        // a reason to skip the check — this is the one place a path is built
        // from data.
        //
        // The traversal target must **exist and be readable**, or this test
        // passes for the wrong reason: a name that escapes the directory and
        // then hits a missing file fails at `fs::read`, so removing the guard
        // changes nothing and the assertion never sees the branch it claims to
        // cover. Measured: with a non-existent target, deleting the guard left
        // all five tests green.
        let store = scratch_store();
        let clone_dir = store.layout().source_backup_dir.join("materials");
        std::fs::create_dir_all(&clone_dir).unwrap();
        let outside = clone_dir.parent().unwrap().join("outside.html");
        std::fs::write(&outside, b"bytes the caller must never receive").unwrap();
        // `../outside` + `html` joins to `materials/../outside.html`, which
        // resolves to the file written above. Measured, because two earlier
        // attempts did not: `..` alone joins to `materials/...html` (a name
        // inside the directory) and a percent-encoded `..%2F` is never decoded,
        // so both left the guard untested while reading as if they covered it.
        assert!(
            read_material_clone(&clone_dir, "../outside", "html").is_err(),
            "`../outside.html` is refused before it becomes a path"
        );
        // The guard rejects on character class, so cover each way a name can
        // leave the set rather than only the traversal shape.
        for (digest, extension) in [
            ("", "html"),
            ("abc", ""),
            ("a/b", "html"),
            ("abc", "ht/ml"),
            ("a.b", "html"),
        ] {
            assert!(
                read_material_clone(&clone_dir, digest, extension).is_err(),
                "{digest}.{extension} is refused"
            );
        }
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
