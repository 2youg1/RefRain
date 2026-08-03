//! Machine-level persistence and Root acquisition.
//!
//! `ApplicationStore` is the only owner of `app.db`. A use-case asks it to
//! adopt a Root; callers never receive the database connection or write Root
//! permits themselves.

use crate::project::{BackupStatus, ProjectFailure, ProjectStore, RootLocator};
use crate::schema::{AppDb, Database, StoreError};
use rusqlite::Connection;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const APP_DB_NAME: &str = "app.db";

#[derive(Debug, thiserror::Error)]
pub enum ApplicationStoreError {
    #[error("I/O at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Project(#[from] ProjectFailure),
}

impl ApplicationStoreError {
    fn io(path: &Path) -> impl FnOnce(io::Error) -> Self + '_ {
        move |source| Self::Io {
            path: path.to_path_buf(),
            source,
        }
    }
}

#[derive(Debug)]
pub struct ApplicationStore {
    db: Connection,
}

impl ApplicationStore {
    pub fn open(data_dir: &Path) -> Result<Self, ApplicationStoreError> {
        fs::create_dir_all(data_dir).map_err(ApplicationStoreError::io(data_dir))?;
        let database = data_dir.join(APP_DB_NAME);
        let mut db = Connection::open(&database).map_err(StoreError::from)?;
        AppDb::migrate(&mut db)?;
        Ok(Self { db })
    }

    pub fn adopt(
        &mut self,
        locator: &RootLocator,
    ) -> Result<(ProjectStore, BackupStatus), ApplicationStoreError> {
        ProjectStore::adopt(&mut self.db, locator).map_err(ApplicationStoreError::from)
    }
}
