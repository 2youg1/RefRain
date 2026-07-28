//! Schema frames and the migration runner.
//!
//! Two transaction domains (SPEC D6): `app.db` for machine-level facts and a
//! per-project `refrain.db`. Both carry a monotonic schema version and share
//! one runner. R0 lands the frame; R1 fills the tables.
//!
//! Three rules the runner enforces, each with a test that fails without it:
//!
//! 1. **Monotonic.** A database opened by a newer build is never downgraded.
//! 2. **One transaction per step.** A step applies whole or not at all.
//! 3. **The completion mark is written last.** A process killed mid-step leaves
//!    the old version on disk, so the next open retries rather than skipping a
//!    step it never finished.

use rusqlite::{Connection, Transaction};
use std::fmt;

/// A monotonic schema version. Zero means an empty database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct SchemaVersion(pub u32);

impl fmt::Display for SchemaVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// One irreversible step from `version - 1` to `version`.
pub struct Migration {
    pub version: SchemaVersion,
    pub name: &'static str,
    pub apply: fn(&Transaction<'_>) -> rusqlite::Result<()>,
}

/// What went wrong opening or migrating a database.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database is at schema {found}, newer than this build's {supported}")]
    Downgrade {
        found: SchemaVersion,
        supported: SchemaVersion,
    },
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// A database with a migration ladder. Implemented once per transaction domain.
pub trait Database {
    /// Steps in ascending version order, starting at 1 with no gaps.
    fn migrations() -> &'static [Migration];

    fn latest() -> SchemaVersion {
        Self::migrations()
            .last()
            .map_or(SchemaVersion(0), |m| m.version)
    }

    /// Brings a connection to the latest schema, or refuses and leaves it alone.
    fn migrate(connection: &mut Connection) -> Result<SchemaVersion, StoreError> {
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;

        let current = read_version(connection)?;
        let latest = Self::latest();
        if current > latest {
            return Err(StoreError::Downgrade {
                found: current,
                supported: latest,
            });
        }

        for migration in Self::migrations().iter().filter(|m| m.version > current) {
            let transaction = connection.transaction()?;
            (migration.apply)(&transaction)?;
            // Last write in the step, and inside the same transaction: an
            // interrupted process leaves the previous version on disk.
            transaction.pragma_update(None, "user_version", migration.version.0)?;
            transaction.commit()?;
        }

        read_version(connection)
    }
}

fn read_version(connection: &Connection) -> Result<SchemaVersion, StoreError> {
    let version: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    Ok(SchemaVersion(version))
}

/// Machine-level state: preferences, Root permits, Harness Connections, icon
/// assets, WorkContext (SPEC 10.1).
pub struct AppDb;

impl Database for AppDb {
    fn migrations() -> &'static [Migration] {
        &[Migration {
            version: SchemaVersion(1),
            name: "app-frame",
            apply: |tx| {
                tx.execute_batch(
                    "CREATE TABLE preferences (
                         key   TEXT PRIMARY KEY,
                         value TEXT NOT NULL
                     ) STRICT;",
                )
            },
        }]
    }
}

/// Per-project state: documents, revisions, tasks, runs, proposals, verdicts,
/// agents, materials, migration log (SPEC 10.1).
pub struct ProjectDb;

impl Database for ProjectDb {
    fn migrations() -> &'static [Migration] {
        &[Migration {
            version: SchemaVersion(1),
            name: "project-frame",
            apply: |tx| {
                tx.execute_batch(
                    "CREATE TABLE migration_log (
                         id         TEXT PRIMARY KEY,
                         applied_at TEXT NOT NULL,
                         name       TEXT NOT NULL
                     ) STRICT;",
                )
            },
        }]
    }
}

/// An in-memory connection, for tests and for the R0 round trip.
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    Connection::open_in_memory()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrating_an_empty_database_reaches_the_latest_version() {
        let mut db = open_in_memory().unwrap();
        assert_eq!(AppDb::migrate(&mut db).unwrap(), AppDb::latest());
    }

    #[test]
    fn migrating_twice_changes_nothing_the_second_time() {
        let mut db = open_in_memory().unwrap();
        let first = AppDb::migrate(&mut db).unwrap();
        let second = AppDb::migrate(&mut db).unwrap();
        assert_eq!(first, second);
    }

    /// A database written by a newer build is refused, not quietly rewritten.
    #[test]
    fn a_newer_database_is_refused() {
        let mut db = open_in_memory().unwrap();
        db.pragma_update(None, "user_version", 9_999_u32).unwrap();
        let error = ProjectDb::migrate(&mut db).unwrap_err();
        assert!(
            matches!(error, StoreError::Downgrade { found, .. } if found == SchemaVersion(9_999)),
            "got {error:?}"
        );
        // Refusing means leaving it alone: the version on disk is untouched.
        assert_eq!(read_version(&db).unwrap(), SchemaVersion(9_999));
    }

    /// The failure this asserts: a step that throws leaves its half-built
    /// tables behind and marks the version anyway, so the next open skips it.
    #[test]
    fn a_failing_step_leaves_neither_tables_nor_a_version() {
        struct Broken;
        impl Database for Broken {
            fn migrations() -> &'static [Migration] {
                &[Migration {
                    version: SchemaVersion(1),
                    name: "half-built",
                    apply: |tx| {
                        tx.execute_batch("CREATE TABLE early (a TEXT) STRICT;")?;
                        tx.execute_batch("CREATE TABLE bad (this is not sql);")
                    },
                }]
            }
        }

        let mut db = open_in_memory().unwrap();
        assert!(Broken::migrate(&mut db).is_err());
        assert_eq!(read_version(&db).unwrap(), SchemaVersion(0));

        let survivors: u32 = db
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'early'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(survivors, 0, "a rolled-back step left a table behind");
    }

    /// Versions start at 1 and advance by one. A gap or a repeat would let the
    /// runner's `> current` filter skip a step without anyone noticing.
    #[test]
    fn ladders_are_contiguous_from_one() {
        for ladder in [AppDb::migrations(), ProjectDb::migrations()] {
            for (index, migration) in ladder.iter().enumerate() {
                let expected = u32::try_from(index + 1).unwrap();
                assert_eq!(
                    migration.version,
                    SchemaVersion(expected),
                    "step {} is out of order",
                    migration.name
                );
            }
        }
    }
}
