//! Row access for the orchestration tables (schema v4, SPEC 8.1).
//!
//! The row structs carry each fact twice: the whole entity as JSON (the
//! authority) and the columns the rail and the recovery view query by. The
//! mapping from the host's types to these rows lives in src-tauri — §6.2
//! makes store and host siblings, so this crate cannot name them.
//!
//! `host_authorization_record` is the one multi-write path and runs as a
//! single transaction (§8.2-2): the Task transition, every Run, and the
//! DispatchAuthorization land together or not at all.

use rusqlite::params;

use crate::project::{ProjectFailure, ProjectStore};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRow {
    pub id: String,
    pub baseline: String,
    pub progress_kind: String,
    pub entity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunRow {
    pub id: String,
    pub task_id: String,
    pub agent_id: String,
    pub progress_kind: String,
    pub retry_of: Option<String>,
    pub entity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationRow {
    pub id: String,
    pub manifest_digest: String,
    pub authorized_at: i64,
    pub entity: String,
}

/// Every orchestration row, as the journal's load returns it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostRows {
    pub tasks: Vec<TaskRow>,
    pub runs: Vec<RunRow>,
    pub authorizations: Vec<AuthorizationRow>,
}

impl ProjectStore {
    /// The whole orchestration world. Tasks and authorizations come back in
    /// insertion order; runs grouped by their task, so the host's in-memory
    /// vectors rebuild deterministically.
    pub fn host_rows(&self) -> Result<HostRows, ProjectFailure> {
        let mut tasks = self
            .db
            .prepare("SELECT id, baseline, progress_kind, entity FROM tasks ORDER BY rowid")?;
        let tasks = tasks
            .query_map([], |row| {
                Ok(TaskRow {
                    id: row.get(0)?,
                    baseline: row.get(1)?,
                    progress_kind: row.get(2)?,
                    entity: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut runs = self.db.prepare(
            "SELECT id, task_id, agent_id, progress_kind, retry_of, entity FROM runs ORDER BY rowid",
        )?;
        let runs = runs
            .query_map([], |row| {
                Ok(RunRow {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    agent_id: row.get(2)?,
                    progress_kind: row.get(3)?,
                    retry_of: row.get(4)?,
                    entity: row.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut authorizations = self.db.prepare(
            "SELECT id, manifest_digest, authorized_at, entity FROM authorizations ORDER BY rowid",
        )?;
        let authorizations = authorizations
            .query_map([], |row| {
                Ok(AuthorizationRow {
                    id: row.get(0)?,
                    manifest_digest: row.get(1)?,
                    authorized_at: row.get(2)?,
                    entity: row.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(HostRows {
            tasks,
            runs,
            authorizations,
        })
    }

    pub fn host_task_append(&mut self, row: &TaskRow) -> Result<(), ProjectFailure> {
        self.db.execute(
            "INSERT INTO tasks (id, baseline, progress_kind, entity) VALUES (?1, ?2, ?3, ?4)",
            params![row.id, row.baseline, row.progress_kind, row.entity],
        )?;
        Ok(())
    }

    /// Whether a run id already has a row: the journal's split between new
    /// and re-authorized runs depends on it.
    pub fn host_run_known(&self, id: &str) -> Result<bool, ProjectFailure> {
        let count: u32 = self.db.query_row(
            "SELECT count(*) FROM runs WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// §8.2-2: the authorization, its runs, and the task transition land in
    /// one transaction or not at all. `new_runs` insert (the first
    /// authorization; a conflict is an error, never a silent overwrite);
    /// `reauthorized_runs` update (a retry's own new authorization, §8.4b).
    pub fn host_authorization_record(
        &mut self,
        task: &TaskRow,
        new_runs: &[RunRow],
        reauthorized_runs: &[RunRow],
        authorization: &AuthorizationRow,
    ) -> Result<(), ProjectFailure> {
        let tx = self.db.transaction()?;
        let changed = tx.execute(
            "UPDATE tasks SET baseline = ?2, progress_kind = ?3, entity = ?4 WHERE id = ?1",
            params![task.id, task.baseline, task.progress_kind, task.entity],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::StatementChangedRows(0).into());
        }
        for run in new_runs {
            tx.execute(
                "INSERT INTO runs (id, task_id, agent_id, progress_kind, retry_of, entity)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    run.id,
                    run.task_id,
                    run.agent_id,
                    run.progress_kind,
                    run.retry_of,
                    run.entity
                ],
            )?;
        }
        for run in reauthorized_runs {
            let changed = tx.execute(
                "UPDATE runs SET task_id = ?2, agent_id = ?3, progress_kind = ?4, retry_of = ?5, entity = ?6
                 WHERE id = ?1",
                params![
                    run.id,
                    run.task_id,
                    run.agent_id,
                    run.progress_kind,
                    run.retry_of,
                    run.entity
                ],
            )?;
            if changed == 0 {
                return Err(rusqlite::Error::StatementChangedRows(0).into());
            }
        }
        tx.execute(
            "INSERT INTO authorizations (id, manifest_digest, authorized_at, entity)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                authorization.id,
                authorization.manifest_digest,
                authorization.authorized_at,
                authorization.entity
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn host_task_update(&mut self, row: &TaskRow) -> Result<(), ProjectFailure> {
        let changed = self.db.execute(
            "UPDATE tasks SET baseline = ?2, progress_kind = ?3, entity = ?4 WHERE id = ?1",
            params![row.id, row.baseline, row.progress_kind, row.entity],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::StatementChangedRows(0).into());
        }
        Ok(())
    }

    pub fn host_run_update(&mut self, row: &RunRow) -> Result<(), ProjectFailure> {
        let changed = self.db.execute(
            "UPDATE runs SET task_id = ?2, agent_id = ?3, progress_kind = ?4, retry_of = ?5, entity = ?6
             WHERE id = ?1",
            params![
                row.id,
                row.task_id,
                row.agent_id,
                row.progress_kind,
                row.retry_of,
                row.entity
            ],
        )?;
        if changed == 0 {
            return Err(rusqlite::Error::StatementChangedRows(0).into());
        }
        Ok(())
    }

    pub fn host_run_append(&mut self, row: &RunRow) -> Result<(), ProjectFailure> {
        self.db.execute(
            "INSERT INTO runs (id, task_id, agent_id, progress_kind, retry_of, entity)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                row.id,
                row.task_id,
                row.agent_id,
                row.progress_kind,
                row.retry_of,
                row.entity
            ],
        )?;
        Ok(())
    }
}

impl From<rusqlite::Error> for ProjectFailure {
    fn from(source: rusqlite::Error) -> Self {
        crate::schema::StoreError::from(source).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::RootLocator;
    use crate::root::RootKind;
    use crate::schema::{AppDb, Database};

    fn scratch_store() -> (std::path::PathBuf, ProjectStore) {
        let dir = std::env::temp_dir().join(format!("refrain-orch-{}", refrain_core::Id::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut app = crate::schema::open_in_memory().unwrap();
        AppDb::migrate(&mut app).unwrap();
        let locator = RootLocator {
            path: dir.clone(),
            kind: RootKind::Folder,
        };
        let (store, _backup) = ProjectStore::adopt(&mut app, &locator).unwrap();
        (dir, store)
    }

    fn task(id: &str, kind: &str) -> TaskRow {
        TaskRow {
            id: id.to_string(),
            baseline: "b".to_string(),
            progress_kind: kind.to_string(),
            entity: format!("{{\"id\":\"{id}\"}}"),
        }
    }

    fn run(id: &str, task: &str, kind: &str) -> RunRow {
        RunRow {
            id: id.to_string(),
            task_id: task.to_string(),
            agent_id: "agent".to_string(),
            progress_kind: kind.to_string(),
            retry_of: None,
            entity: format!("{{\"id\":\"{id}\"}}"),
        }
    }

    fn authorization(id: &str) -> AuthorizationRow {
        AuthorizationRow {
            id: id.to_string(),
            manifest_digest: "digest".to_string(),
            authorized_at: 1_000,
            entity: format!("{{\"id\":\"{id}\"}}"),
        }
    }

    #[test]
    fn the_orchestration_world_round_trips() {
        let (_dir, mut store) = scratch_store();
        store.host_task_append(&task("t1", "draft")).unwrap();
        store
            .host_authorization_record(
                &task("t1", "open"),
                &[run("r1", "t1", "authorized"), run("r2", "t1", "authorized")],
                &[],
                &authorization("a1"),
            )
            .unwrap();
        store
            .host_run_update(&run("r1", "t1", "launching"))
            .unwrap();
        store.host_run_append(&run("r3", "t1", "queued")).unwrap();
        // A retry's own new authorization (§8.4b): the queued run updates,
        // the new authorization appends, the task row is rewritten as-is.
        store
            .host_authorization_record(
                &task("t1", "open"),
                &[],
                &[run("r3", "t1", "authorized")],
                &authorization("a2"),
            )
            .unwrap();

        let rows = store.host_rows().unwrap();
        assert_eq!(rows.tasks, vec![task("t1", "open")]);
        assert_eq!(
            rows.runs,
            vec![
                run("r1", "t1", "launching"),
                run("r2", "t1", "authorized"),
                run("r3", "t1", "authorized")
            ]
        );
        assert_eq!(
            rows.authorizations,
            vec![authorization("a1"), authorization("a2")]
        );
    }

    /// §8.2-2: a failure anywhere in the authorization leaves no partial
    /// facts — the second run's dangling task reference trips the foreign
    /// key mid-transaction.
    #[test]
    fn a_failing_authorization_lands_nothing() {
        let (_dir, mut store) = scratch_store();
        store.host_task_append(&task("t1", "draft")).unwrap();

        let result = store.host_authorization_record(
            &task("t1", "open"),
            &[
                run("r1", "t1", "authorized"),
                run("r2", "ghost", "authorized"),
            ],
            &[],
            &authorization("a1"),
        );
        assert!(result.is_err());

        let rows = store.host_rows().unwrap();
        // The task kept its pre-authorization state; neither run landed; no
        // authorization was recorded.
        assert_eq!(rows.tasks, vec![task("t1", "draft")]);
        assert!(rows.runs.is_empty());
        assert!(rows.authorizations.is_empty());
    }

    #[test]
    fn a_conflicting_new_run_is_an_error_not_an_overwrite() {
        let (_dir, mut store) = scratch_store();
        store.host_task_append(&task("t1", "draft")).unwrap();
        store.host_run_append(&run("r1", "t1", "queued")).unwrap();
        let result = store.host_authorization_record(
            &task("t1", "open"),
            &[run("r1", "t1", "authorized")],
            &[],
            &authorization("a1"),
        );
        assert!(result.is_err());
        assert_eq!(
            store.host_rows().unwrap().runs,
            vec![run("r1", "t1", "queued")]
        );
    }

    #[test]
    fn updating_a_missing_row_is_an_error_not_a_silence() {
        let (_dir, mut store) = scratch_store();
        assert!(store.host_task_update(&task("ghost", "open")).is_err());
        assert!(
            store
                .host_run_update(&run("ghost", "t1", "launching"))
                .is_err()
        );
    }
}
