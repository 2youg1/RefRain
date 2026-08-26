//! Schema frames and the migration runner.
//!
//! Two transaction domains (SPEC D6): `app.db` for machine-level facts and a
//! per-project `refrain.db`. Both carry a monotonic schema version and share
//! one runner. The frame landed in R0; C3 filled the first real tables
//! directly (v0.2 is unreleased, so no second "migrate the placeholder" debt).
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

/// Machine-level state: Root permits, Harness capability/trust evidence, icon
/// assets, WorkContext (SPEC 10.1). User settings and Harness Connection
/// parameters are NOT here — `config.toml` is their only authority (D18), and
/// `verify:config-authority` fails the build if a settings table returns.
pub struct AppDb;

impl Database for AppDb {
    fn migrations() -> &'static [Migration] {
        &[Migration {
            version: SchemaVersion(1),
            name: "app-frame",
            apply: |tx| {
                tx.execute_batch(
                    "CREATE TABLE root_permits (
                         root_id        TEXT PRIMARY KEY,
                         canonical_path TEXT NOT NULL UNIQUE,
                         kind           TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
                         identity       TEXT NOT NULL,
                         nonce          TEXT NOT NULL,
                         adopted_at     INTEGER NOT NULL
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
        &[
            Migration {
                version: SchemaVersion(1),
                name: "project-frame",
                apply: |tx| {
                    tx.execute_batch(
                        "CREATE TABLE migration_log (
                             id         TEXT PRIMARY KEY,
                             applied_at TEXT NOT NULL,
                             name       TEXT NOT NULL
                         ) STRICT;
                         CREATE TABLE documents (
                             id        TEXT PRIMARY KEY,
                             path      TEXT NOT NULL UNIQUE,
                             role      TEXT NOT NULL CHECK (role IN ('document', 'chapter', 'material')),
                             digest    TEXT,
                             legacy_id TEXT
                         ) STRICT;
                         CREATE TABLE verdicts (
                             id              TEXT PRIMARY KEY,
                             proposal_id     TEXT NOT NULL,
                             slice_id        TEXT NOT NULL,
                             kind            TEXT NOT NULL CHECK (kind IN (
                                                 'accept', 'accept-modified', 'reject', 'comment-only')),
                             final_text      TEXT,
                             reason          TEXT,
                             decided_at      INTEGER NOT NULL,
                             legacy_baseline TEXT
                         ) STRICT;",
                    )
                },
            },
            Migration {
                version: SchemaVersion(2),
                name: "revision-continuity",
                apply: |tx| {
                    // Crash recovery (SPEC 7.2): the confirmed revision id and
                    // the lineage it pairs with, plus the pending-action
                    // journal. The journal is written before an EditorAction
                    // executes and cleared after, so a kill between the two
                    // replays on the next open — through the same validation,
                    // never by writing files directly.
                    tx.execute_batch(
                        "ALTER TABLE documents ADD COLUMN current_head TEXT;
                         ALTER TABLE documents ADD COLUMN head_block_ids TEXT;
                         CREATE TABLE pending_actions (
                             id         TEXT PRIMARY KEY,
                             path       TEXT NOT NULL,
                             action     TEXT NOT NULL,
                             created_at INTEGER NOT NULL
                         ) STRICT;",
                    )
                },
            },
            Migration {
                version: SchemaVersion(3),
                name: "review-ledger",
                apply: |tx| {
                    // The review loop's persistence (SPEC 9.7): frozen
                    // candidates and the per-document review session. The
                    // cursor and the batch are staging, not truth — truth is
                    // the verdict rows, which already landed in C3.
                    tx.execute_batch(
                        "CREATE TABLE proposals (
                             id            TEXT PRIMARY KEY,
                             run           TEXT NOT NULL,
                             baseline      TEXT NOT NULL,
                             document_path TEXT NOT NULL,
                             scope         TEXT NOT NULL,
                             before_text   TEXT NOT NULL,
                             after_text    TEXT,
                             created_at    INTEGER NOT NULL
                         ) STRICT;
                         CREATE TABLE review_sessions (
                             document_path TEXT PRIMARY KEY,
                             cursor        INTEGER NOT NULL DEFAULT 0,
                             batch         TEXT NOT NULL DEFAULT '[]',
                             updated_at    INTEGER NOT NULL
                         ) STRICT;",
                    )
                },
            },
            Migration {
                version: SchemaVersion(4),
                name: "orchestration",
                apply: |tx| {
                    // Orchestration truth (SPEC 8.1, 6.3): Task, Run,
                    // Authorization. The entity column carries the whole fact
                    // as JSON; the named columns exist because the rail and
                    // the recovery view query by them.
                    tx.execute_batch(
                        "CREATE TABLE tasks (
                             id            TEXT PRIMARY KEY,
                             baseline      TEXT NOT NULL,
                             progress_kind TEXT NOT NULL,
                             entity        TEXT NOT NULL
                         ) STRICT;
                         CREATE TABLE runs (
                             id            TEXT PRIMARY KEY,
                             task_id       TEXT NOT NULL REFERENCES tasks(id),
                             agent_id      TEXT NOT NULL,
                             progress_kind TEXT NOT NULL,
                             retry_of      TEXT,
                             entity        TEXT NOT NULL
                         ) STRICT;
                         CREATE TABLE authorizations (
                             id              TEXT PRIMARY KEY,
                             manifest_digest TEXT NOT NULL,
                             authorized_at   INTEGER NOT NULL,
                             entity          TEXT NOT NULL
                         ) STRICT;",
                    )
                },
            },
            Migration {
                version: SchemaVersion(5),
                name: "material-drafts",
                apply: |tx| {
                    // Material drafts (SPEC 8.7): an artifact's material-draft
                    // is only ever a draft until a Human Material Action saves
                    // it. The draft row is all there is; the Material itself
                    // is a plain Markdown document with role 'material'.
                    tx.execute_batch(
                        "CREATE TABLE material_drafts (
                             id         TEXT PRIMARY KEY,
                             run_id     TEXT NOT NULL,
                             document   TEXT NOT NULL,
                             kind       TEXT NOT NULL,
                             title      TEXT NOT NULL,
                             basis      TEXT NOT NULL,
                             body       TEXT NOT NULL,
                             created_at INTEGER NOT NULL
                         ) STRICT;",
                    )
                },
            },
            Migration {
                version: SchemaVersion(6),
                name: "annotations",
                apply: |tx| {
                    tx.execute_batch(
                        "CREATE TABLE annotations (
                             id         TEXT PRIMARY KEY,
                             document   TEXT NOT NULL,
                             block_id   TEXT NOT NULL,
                             start      INTEGER NOT NULL CHECK (start >= 0),
                             end        INTEGER NOT NULL CHECK (end >= start),
                             quote      TEXT NOT NULL,
                             kind       TEXT NOT NULL CHECK (kind IN ('highlight', 'comment')),
                             body       TEXT,
                             created_at INTEGER NOT NULL,
                             updated_at INTEGER NOT NULL
                         ) STRICT;
                         CREATE INDEX annotations_document ON annotations(document, created_at);",
                    )
                },
            },
            Migration {
                version: SchemaVersion(7),
                name: "chinese-search",
                apply: |tx| {
                    // Full-text search over the manuscript.
                    //
                    // The tokenizer is `unicode61` and the text stored in it has
                    // been split into overlapping two-character pieces by
                    // `refrain_core::chinese_index`. The two FTS5 tokenizers that
                    // might have served instead were measured and both fail:
                    // `unicode61` alone makes a run of Chinese into one token, so
                    // 「营销」 inside it matches nothing, and `trigram` indexes
                    // nothing shorter than three characters *and* returns
                    // bm25 = -0.0000 for every row because it keeps no column
                    // sizes. See review/search-probe-results.md.
                    //
                    // `content=''` makes this an external-content table holding
                    // no copy of the author's words. The manuscript lives in .md
                    // files on disk and this index is a derived artifact that can
                    // be thrown away and rebuilt — the same reason `documents`
                    // stores a digest rather than the text.
                    //
                    // `detail=full` is required: it is what maintains the column
                    // sizes bm25() needs, and dropping to 'column' or 'none' to
                    // save space would reproduce trigram's ranking failure.
                    tx.execute_batch(
                        "CREATE VIRTUAL TABLE document_search USING fts5(
                             path,
                             body,
                             content='',
                             tokenize='unicode61 remove_diacritics 2',
                             detail=full
                         );
                         CREATE TABLE document_search_state (
                             document      TEXT PRIMARY KEY,
                             rowid_of      INTEGER NOT NULL UNIQUE,
                             digest        TEXT NOT NULL,
                             -- Exactly the text handed to FTS5. Deleting from
                             -- an external-content table means replaying what
                             -- was inserted; without this the index corrupts.
                             indexed_path  TEXT NOT NULL,
                             indexed_body  TEXT NOT NULL
                         ) STRICT;",
                    )
                },
            },
            Migration {
                version: SchemaVersion(8),
                name: "block-level-search",
                apply: |tx| {
                    // One index row per *block*, not per document.
                    //
                    // v7 held a document per row, so a query could answer
                    // "which file" and never "which passage". An agent handed
                    // an outline instead of 100KB of prose needs the second:
                    // it retrieves a passage and cites it, and a document-
                    // level hit gives it nothing to cite.
                    //
                    // Doing this by reading the whole document back and
                    // searching it again in Rust was considered and rejected:
                    // it re-reads exactly the bytes this design exists to stop
                    // sending, and bm25 would still be scoring *documents*, so
                    // ranking quality would not improve at all.
                    //
                    // v7's tables are dropped rather than kept alongside. Two
                    // granularities of the same fact are two authorities, and
                    // the stale one answers queries nobody meant to ask. The
                    // index is a derived artifact — dropping it costs a
                    // rebuild on the next search, which `ensure_indexed`
                    // already performs lazily.
                    //
                    // `ordinal` is the block's position in its document: the
                    // handle shared by the index, the agent's citation, and
                    // the bytes on disk. `start_byte` and `bytes` let a
                    // retrieved block prove it is the same text the index
                    // read, without the index keeping a copy of the words.
                    tx.execute_batch(
                        "DROP TABLE IF EXISTS document_search;
                         DROP TABLE IF EXISTS document_search_state;
                         CREATE VIRTUAL TABLE block_search USING fts5(
                             path,
                             body,
                             content='',
                             tokenize='unicode61 remove_diacritics 2',
                             detail=full
                         );
                         CREATE TABLE block_search_state (
                             rowid_of      INTEGER PRIMARY KEY,
                             document      TEXT NOT NULL,
                             ordinal       INTEGER NOT NULL,
                             kind          TEXT NOT NULL,
                             start_byte    INTEGER NOT NULL,
                             bytes         INTEGER NOT NULL,
                             -- Exactly the text handed to FTS5, per block.
                             -- Deleting from an external-content table means
                             -- replaying what was inserted; a document now
                             -- owns N postings instead of one, so getting
                             -- this wrong corrupts N times as much.
                             indexed_path  TEXT NOT NULL,
                             indexed_body  TEXT NOT NULL,
                             UNIQUE(document, ordinal)
                         ) STRICT;
                         CREATE INDEX block_search_document
                             ON block_search_state(document);
                         -- One row per indexed document: the digest its blocks
                         -- were built from. Freshness is a document-level
                         -- question even though the index is block-level, so
                         -- answering it reads one row rather than counting
                         -- blocks.
                         CREATE TABLE document_index_state (
                             document      TEXT PRIMARY KEY,
                             digest        TEXT NOT NULL
                         ) STRICT;",
                    )
                },
            },
            Migration {
                version: SchemaVersion(9),
                name: "mailbox-standing",
                apply: |tx| {
                    // The author's standing arrangement of the mailbox.
                    //
                    // Order, pinning, and discard were front-end state until
                    // now: a `#order` array inside the panel that the window
                    // dropped on close. Order can be rebuilt by hand, so
                    // losing it was an annoyance. Pinning and discard cannot:
                    // pinning is an explicit statement about what must stay
                    // visible, and discarding a batch of proposals is the
                    // author declining work an agent did. Both are the same
                    // class of fact as a verdict, and facts of that class
                    // live in the project database.
                    //
                    // One row per mailbox entry, keyed by the entry's own id
                    // (a task id or a proposal id). Absence is the default
                    // arrangement: an entry nobody has touched has no row,
                    // so an untouched mailbox costs nothing.
                    //
                    // `discarded_at` is a soft delete. Nothing is unlinked,
                    // nothing leaves the ledger, and the proposal rows stay
                    // exactly where they were — INV-4 permits no permanent
                    // delete at any layer, and a discarded batch remains
                    // auditable. `rank` orders what remains; `pinned` lifts a
                    // row above ranking altogether so later arrivals cannot
                    // push it down.
                    tx.execute_batch(
                        "CREATE TABLE mailbox_standing (
                             entry_id     TEXT PRIMARY KEY,
                             box_name     TEXT NOT NULL CHECK (box_name IN ('draft', 'unread', 'done')),
                             rank         INTEGER,
                             pinned       INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
                             discarded_at INTEGER,
                             updated_at   INTEGER NOT NULL
                         ) STRICT;
                         CREATE INDEX mailbox_standing_box
                             ON mailbox_standing(box_name, rank);",
                    )
                },
            },
            Migration {
                version: SchemaVersion(10),
                name: "imported-source-identity",
                apply: |tx| {
                    // Which file a Material was imported from, and in what
                    // format.
                    //
                    // Import already keeps an immutable clone of the original
                    // bytes, named by its digest. Until now the only record of
                    // that digest was a sentence in the Material's own body
                    // ("> 来源：… blake3 abc123def456；原件克隆：…"), truncated
                    // to twelve characters and sitting in text the author is
                    // free to rewrite. Reading the clone back therefore meant
                    // parsing prose for a value that was both incomplete and
                    // editable — the projection standing in for a fact.
                    //
                    // These two columns hold the fact. The sentence stays,
                    // because a reader opening the Material should see where
                    // it came from, but it is now a rendering of these columns
                    // rather than their only home.
                    //
                    // NULL is a value: Materials imported before this version,
                    // and every document that was not imported at all, have no
                    // source. The reader shows the text it already has.
                    tx.execute_batch(
                        "ALTER TABLE documents ADD COLUMN source_digest TEXT;
                         ALTER TABLE documents ADD COLUMN source_format TEXT;",
                    )
                },
            },
            Migration {
                version: SchemaVersion(11),
                name: "material-disclosure",
                apply: |tx| {
                    // What the author permits for one document when it rides
                    // as a material (the Disclosure enum's wire spelling).
                    //
                    // NULL is a value: "never asked", which the readers treat
                    // as the enum's default. Writing the default out instead
                    // would make every pre-v11 row claim a choice the author
                    // never made — the same discipline the source columns
                    // follow.
                    tx.execute_batch("ALTER TABLE documents ADD COLUMN disclosure TEXT;")
                },
            },
            Migration {
                version: SchemaVersion(12),
                name: "text-action-history",
                apply: |tx| {
                    // The persisted undo chain: one row per executed Text
                    // Action, so undo survives a restart and the history
                    // panel can offer a rollback point.
                    //
                    // `regions` carries the full before/after text of every
                    // applied region as JSON, because undo inverts from it and
                    // the snapshot those blocks once borrowed from is gone by
                    // the next open. `edits` and `verdicts` ride as JSON for
                    // the audit; hydration re-derives what regions already
                    // say, so the row has one authority.
                    //
                    // `ordinal` is a per-document sequence assigned at insert
                    // (MAX + 1, one statement, so a crash cannot leave a gap
                    // or a duplicate). `UNIQUE(document, ordinal)` is the
                    // database's own proof of that.
                    //
                    // `undone_at` starts NULL. It is written at save time,
                    // never at undo time: undo moves session memory, and a
                    // crash must resume the pre-undo chain — a row marked
                    // undone while the disk still holds its text would be a
                    // lie the hydration walk cannot afford.
                    tx.execute_batch(
                        "CREATE TABLE text_actions (
                             id         TEXT PRIMARY KEY,
                             document   TEXT NOT NULL,
                             ordinal    INTEGER NOT NULL,
                             base       TEXT NOT NULL,
                             head       TEXT NOT NULL,
                             cause      TEXT NOT NULL,
                             regions    TEXT NOT NULL,
                             edits      TEXT NOT NULL,
                             verdicts   TEXT NOT NULL,
                             undone_at  INTEGER,
                             created_at INTEGER NOT NULL,
                             UNIQUE(document, ordinal)
                         ) STRICT;
                         CREATE INDEX text_actions_document
                             ON text_actions(document, ordinal);",
                    )
                },
            },
            Migration {
                version: SchemaVersion(13),
                name: "verdict-countermand",
                apply: |tx| {
                    // The countermanding verdict （逆向裁决）: a merged proposal
                    // is reversed by appending a `countermanded` record — the
                    // ledger stays append-only, so the pair tells the story.
                    //
                    // SQLite cannot widen a CHECK in place, so the table is
                    // rebuilt under the same name. The copy is part of the
                    // step's transaction: a crash between the drop and the
                    // rename replays the whole step on the next open, which
                    // the runner's last-write-wins version mark guarantees.
                    tx.execute_batch(
                        "CREATE TABLE verdicts_next (
                             id              TEXT PRIMARY KEY,
                             proposal_id     TEXT NOT NULL,
                             slice_id        TEXT NOT NULL,
                             kind            TEXT NOT NULL CHECK (kind IN (
                                                 'accept', 'accept-modified', 'reject',
                                                 'comment-only', 'countermanded')),
                             final_text      TEXT,
                             reason          TEXT,
                             decided_at      INTEGER NOT NULL,
                             legacy_baseline TEXT
                         ) STRICT;
                         INSERT INTO verdicts_next SELECT * FROM verdicts;
                         DROP TABLE verdicts;
                         ALTER TABLE verdicts_next RENAME TO verdicts;",
                    )
                },
            },
            Migration {
                version: SchemaVersion(14),
                name: "session-landing",
                apply: |tx| {
                    // 取得一个 Root 之后要落到哪一份正文，是项目的持久事实，不是
                    // 前端组件状态：换一台机器、重开一次窗口，作者应该回到上次写的
                    // 那一章。单行表，`id` 恒为 0，让「只有一个当前落点」由 schema
                    // 保证，而不是靠调用方记得先删后插。
                    tx.execute_batch(
                        "CREATE TABLE session_landing (
                             id       INTEGER PRIMARY KEY CHECK (id = 0),
                             path     TEXT NOT NULL,
                             opened_at INTEGER NOT NULL
                         ) STRICT;",
                    )
                },
            },
            Migration {
                version: SchemaVersion(15),
                name: "contentless-delete-search",
                apply: |tx| {
                    // 索引不再为了能删而把整份语料再存一遍。
                    //
                    // 外部内容表（`content=''`）删一行要把当初插进去的那段文本
                    // 一字不差地喂回去，FTS5 重新分词才找得到要摘掉的 posting。
                    // 喂错不报错：它摘掉本来不存在的 posting、留下真正的那些，
                    // 下一次读索引报「database disk image is malformed」。为了
                    // 不喂错，`block_search_state` 存了 `indexed_path` 与
                    // `indexed_body`——**每块 bigram 之后的全文**，也就是这个
                    // 设计明说不要的那份拷贝。
                    //
                    // `contentless_delete=1`（SQLite 3.43 起）让
                    // `DELETE ... WHERE rowid = ?` 直接成立，两列因此没有存在的
                    // 理由。实测在本机链接的 SQLite 上（
                    // `tests/contentless_delete_probe.rs`）：删只要 rowid、排序
                    // 不变、**重复 rowid 仍会双重索引且删不干净**——所以
                    // `next_rowid` 的「一个 rowid 只写一次」这条规矩照旧。
                    //
                    // 索引是派生物，所以整张丢掉重建，与 v8 同一条判断：
                    // `ensure_indexed` 下一次搜索时懒重建。清空
                    // `document_index_state` 是那句「重建」的实际写法——摘要还在
                    // 就没有人会去重建。
                    tx.execute_batch(
                        "DROP TABLE IF EXISTS block_search;
                         DROP TABLE IF EXISTS block_search_state;
                         DELETE FROM document_index_state;
                         CREATE VIRTUAL TABLE block_search USING fts5(
                             path,
                             body,
                             content='',
                             contentless_delete=1,
                             tokenize='unicode61 remove_diacritics 2',
                             detail=full
                         );
                         CREATE TABLE block_search_state (
                             rowid_of      INTEGER PRIMARY KEY,
                             document      TEXT NOT NULL,
                             ordinal       INTEGER NOT NULL,
                             kind          TEXT NOT NULL,
                             start_byte    INTEGER NOT NULL,
                             bytes         INTEGER NOT NULL,
                             UNIQUE(document, ordinal)
                         ) STRICT;
                         CREATE INDEX block_search_document
                             ON block_search_state(document);",
                    )
                },
            },
        ]
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

    /// v13 widens the verdict-kind CHECK by rebuilding the table. Two facts
    /// must survive that rebuild: rows written before it, and the new kind it
    /// exists to admit.
    #[test]
    fn the_countermand_migration_keeps_old_rows_and_admits_the_new_kind() {
        let mut db = open_in_memory().unwrap();
        db.pragma_update(None, "foreign_keys", true).unwrap();
        // Walk the ladder only to v12, the way a project written before this
        // build actually looks.
        for migration in ProjectDb::migrations()
            .iter()
            .filter(|migration| migration.version.0 <= 12)
        {
            let tx = db.transaction().unwrap();
            (migration.apply)(&tx).unwrap();
            tx.pragma_update(None, "user_version", migration.version.0)
                .unwrap();
            tx.commit().unwrap();
        }
        db.execute(
            "INSERT INTO verdicts
                 (id, proposal_id, slice_id, kind, final_text, reason, decided_at, legacy_baseline)
             VALUES ('v1', 'p1', 'p1:1', 'accept', NULL, NULL, 2, NULL)",
            [],
        )
        .unwrap();
        // The old CHECK is really in force, or the rebuild would be guarding
        // nothing: the new kind must fail before v13.
        assert!(
            db.execute(
                "INSERT INTO verdicts
                     (id, proposal_id, slice_id, kind, final_text, reason, decided_at, legacy_baseline)
                 VALUES ('v2', 'p1', 'p1:c', 'countermanded', NULL, NULL, 3, NULL)",
                [],
            )
            .is_err(),
            "the pre-v13 CHECK admitted countermanded: the injection-proof failed"
        );

        ProjectDb::migrate(&mut db).unwrap();

        let kept: String = db
            .query_row("SELECT kind FROM verdicts WHERE id = 'v1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kept, "accept", "the rebuild must carry old rows across");
        db.execute(
            "INSERT INTO verdicts
                 (id, proposal_id, slice_id, kind, final_text, reason, decided_at, legacy_baseline)
             VALUES ('v3', 'p1', 'p1:c', 'countermanded', NULL, NULL, 4, NULL)",
            [],
        )
        .unwrap();
    }
}
