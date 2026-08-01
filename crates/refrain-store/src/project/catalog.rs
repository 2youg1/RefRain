//! Project document catalog.
//!
//! One module owns membership reconciliation and every read model over that
//! membership. The filesystem scan is authoritative for membership; SQLite is
//! the durable catalog. Existing rows keep identity, role, digest, confirmed
//! head, and lineage across a refresh.

use refrain_core::block_shape::BlockKind;
use refrain_core::chinese_index::Precision;
use refrain_core::search_rank::{Candidate, PathMatch, rank_top};
use refrain_core::{DocumentRole, ErrorCode, Id, RefrainError, digest};
use rusqlite::{OptionalExtension, params};

use super::{ProjectFailure, ProjectStore, infer_role};
use crate::files::index::{ScanOptions, scan_checked};
use crate::root::RootKind;

/// Name one scanned set by its paths and inferred roles.
///
/// Skip the generated ID because it changes on every scan. Sort the set because
/// filesystem traversal order is not stable. Length-prefixed parts keep paths
/// with arbitrary characters unambiguous without joining the full set first.
fn fingerprint_of(scanned: &[[String; 3]]) -> [u8; 32] {
    // 逐条哈希再异或合并。异或满足交换律，于是这个身份天然与扫描顺序无关——
    // 目录遍历的次序由文件系统决定，同一批文件两次扫描可以给出不同顺序，不做
    // 处理的话指纹每次都不同，缓存永远命不中（实测二十次连续对账无一命中）。
    //
    // 早先的做法是先把十万个 (path, role) 排序再顺序哈希，正确但慢：排序要逐字节
    // 比较字符串且缓存不友好，实测单这一步就吃掉 23ms。异或版本不排序、不额外
    // 分配，只走一遍。
    //
    // 跳过 entry[0]：那是每次扫描新生成的 Id，与「扫到了什么」无关；带上它指纹
    // 每次都不同，整个优化就永远命不中。
    //
    // 异或的代价是它对「同一条目出现两次」不敏感（两次会互相抵消）。这里安全，
    // 因为 path 是 documents 表的主键、也是扫描结果里的唯一键：同一条路径不可能
    // 在一次扫描里出现两次。fingerprint_tests 里有一条钉住这个前提。
    scanned
        .iter()
        .map(|entry| digest::sequence_bytes([entry[1].as_bytes(), entry[2].as_bytes()]))
        .fold([0u8; 32], |mut sum, one| {
            for (slot, byte) in sum.iter_mut().zip(one) {
                *slot ^= byte;
            }
            sum
        })
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
        let departed: Vec<String>;
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
                 )
                 RETURNING path",
            )?;
            // Collect the departed before the transaction closes: a document
            // the author deleted must leave the search index too, or a query
            // returns a chapter that no longer exists and opening it fails.
            departed = remove_absent
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;
        }
        transaction.commit()?;
        for path in &departed {
            let _ = super::search::forget_document(&self.db, path);
        }
        // A failed transaction leaves the cache empty so the next call retries.
        self.reconciled = Some(fingerprint);
        // The index is not built here. Reconciliation runs on every refresh and
        // must stay cheap; indexing reads every file. See `index_catalog`.
        self.index_is_fresh = false;
        Ok(())
    }

    /// Make sure the search index reflects the current catalog.
    ///
    /// Every read of the index goes through here, and the first one after the
    /// catalog or a document changed pays for the build. Later reads pay
    /// nothing.
    ///
    /// Building lazily is the point. Reconciliation runs on every refresh (21
    /// times in one performance test) and indexing reads every file on disk;
    /// hanging the second off the first cost 2.1 million file reads on the
    /// 100,000-document fixture, and opening a project waited for all of them.
    /// Opening a 10 MiB manuscript paid 104ms for the same reason, past the
    /// seven-frame budget. An author who never searches never pays.
    ///
    /// Freshness is one boolean, not a comparison of two fingerprints. The
    /// comparison read `indexed == reconciled`, which is true before either
    /// exists — a store that had never reconciled reported a current index and
    /// searched an empty one. A flag that must be *set* to claim freshness
    /// cannot make that mistake.
    pub(crate) fn ensure_indexed(&mut self) -> Result<(), RefrainError> {
        if self.index_is_fresh {
            return Ok(());
        }
        self.index_catalog().map_err(|failure| match failure {
            ProjectFailure::Domain(error) => error,
            other => RefrainError::new(
                ErrorCode::StateUnavailable,
                "build the search index",
                "refrain.db",
            )
            .with_detail(other.to_string()),
        })?;
        self.index_is_fresh = true;
        Ok(())
    }

    /// Bring the search index up to the catalog, once.
    ///
    /// Reconciliation is where a project the author already wrote first becomes
    /// visible to this process: adopting a folder of a hundred chapters
    /// produces a hundred rows, and none of those chapters has been opened or
    /// saved. Without this pass an author who adopts their own manuscript and
    /// searches it finds nothing at all — measured with a probe before this
    /// existed, and the reason it does.
    ///
    /// **This runs on the first search, not on refresh.** Reconciliation is
    /// cheap and frequent — the 100,000-document fixture refreshes 21 times in
    /// one test — while indexing reads every file on disk. Hanging one off the
    /// other made a directory refresh cost 2.1 million file reads, and opening
    /// a project waited for all of them. Membership and content are different
    /// questions asked at different moments; the fingerprint answers the first
    /// and this answers the second.
    ///
    /// The catalog's `digest` column is not usable as the freshness key here:
    /// reconciliation inserts rows with a NULL digest, because membership is
    /// decided by the scan and content by whoever reads the file. So this pass
    /// reads the bytes and digests them itself. That read is the cost, and the
    /// digest comparison inside `index_document` is what keeps it from being
    /// paid twice — a reopened project re-reads its files but rewrites no index
    /// entries. Measured over the workspace, 22,410 documents / 252MB: 20.6s
    /// cold, 197ms warm.
    ///
    /// A file that cannot be read is skipped, not fatal. A permission error on
    /// one chapter must not stop the author searching.
    ///
    /// # Why the whole pass is one transaction
    ///
    /// Each `index_document` runs two INSERTs. Outside a transaction SQLite
    /// makes each one its own implicit transaction and fsyncs it, so 2,000
    /// chapters cost 4,000 fsyncs — measured at 22 seconds, while the work
    /// itself (read 9.8ms, digest 0.3ms, freshness 3.4ms, writes 47ms) totals
    /// 60ms. **366 times the cost of the thing being done**, and none of it
    /// visible in a profile of the four steps.
    ///
    /// One transaction is the fix, not a weaker `synchronous` pragma: durability
    /// is the reason the index can be trusted after a crash. Batching keeps the
    /// guarantee and pays for it once.
    ///
    /// # Why the containment check is per directory, not per file
    ///
    /// `resolve` runs `assert_inside_root`, which walks to the nearest existing
    /// ancestor and canonicalises it — three to four syscalls per path.
    /// Symlinks are a property of directories, not of the files inside them:
    /// if `资料/` resolves inside the Root then every plain file directly in it
    /// does too. So the containment answer is cached per parent directory.
    ///
    /// (Measured honestly: this cache alone changed nothing, because fsync
    /// dominated everything. It stays because it is correct and because the
    /// syscalls do show up once the fsyncs are gone.)
    ///
    /// A file that cannot be read is skipped, not fatal. A permission error on
    /// one chapter must not stop the author searching.
    fn index_catalog(&mut self) -> Result<(), ProjectFailure> {
        let mut statement = self
            .db
            .prepare("SELECT path FROM documents")
            .map_err(crate::schema::StoreError::from)?;
        let known: Vec<String> = statement
            .query_map([], |row| row.get(0))
            .map_err(crate::schema::StoreError::from)?
            .collect::<rusqlite::Result<_>>()
            .map_err(crate::schema::StoreError::from)?;
        drop(statement);

        // Read and digest outside the transaction: file I/O must not hold a
        // write lock, and the bytes are needed before anything can be written.
        let root = self.permit.canonical_path.clone();
        let kind = self.permit.kind;
        let mut cleared: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut pending: Vec<(String, String, String)> = Vec::new();
        for path in known {
            let parent = path.rsplit_once('/').map_or("", |(head, _)| head);
            if !cleared.contains(parent) {
                let probe = if parent.is_empty() {
                    path.clone()
                } else {
                    format!("{parent}/")
                };
                if self.resolve(&probe).is_err() {
                    continue;
                }
                cleared.insert(parent.to_string());
            }
            let resolved = match kind {
                crate::root::RootKind::Folder => root.join(&path),
                crate::root::RootKind::File => root.clone(),
            };
            let Ok(bytes) = std::fs::read(&resolved) else {
                continue;
            };
            let digest = refrain_core::digest::content_hex(&bytes);
            if self.index_is_current(&path, &digest) {
                continue;
            }
            let Ok(text) = String::from_utf8(bytes) else {
                continue;
            };
            pending.push((path, digest, text));
        }

        if pending.is_empty() {
            return Ok(());
        }

        let transaction = self.db.transaction()?;
        for (path, digest, text) in &pending {
            // A single document that will not index is skipped, not fatal:
            // the rest of the manuscript should still be searchable.
            let _ = super::search::index_document(&transaction, path, digest, text);
        }
        transaction.commit()?;
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

    /// Find documents whose title or prose answers the query.
    ///
    /// Two layers, deliberately: `search` narrows the corpus with FTS5, and
    /// `refrain_core::search_rank` decides what the author sees first. The
    /// split is not ceremony — bm25 alone puts a chapter that mentions a word
    /// three times above the chapter *titled* that word, which is correct
    /// information retrieval and useless to a writer looking for their own
    /// pages. Ranking caps each signal so no amount of repetition overtakes a
    /// title.
    ///
    /// `Precision::Exact` requires every part of the query to appear; `Loose`
    /// takes documents holding any part. The two answer different questions —
    /// remembering the words versus remembering only the sense.
    ///
    /// Documents the index has not yet seen are simply absent, which is why
    /// `reindex` hangs off `register`: an author searches for what they wrote,
    /// and they wrote it through the paths that register.
    pub fn search_documents_with(
        &mut self,
        query: &str,
        precision: Precision,
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

        // 索引在第一次被读时才建，见 `ensure_indexed`。
        self.ensure_indexed()?;

        let wanted = limit.min(MAX_DOCUMENT_SEARCH_RESULTS);
        // Retrieve wider than the author will see. Ranking reorders, so cutting
        // at `wanted` here would let bm25 decide which documents ranking never
        // gets to consider — the exact ordering this layering exists to undo.
        let hits = super::search::search_with(
            &self.db,
            query,
            precision,
            wanted.saturating_mul(4).max(wanted),
        )?;
        if hits.is_empty() {
            return Ok(Vec::new());
        }

        let mut rows = self.documents_at(hits.iter().map(|hit| hit.path.as_str()))?;
        let mut candidates: Vec<Candidate> = rows
            .iter()
            .map(|row| {
                // A document is represented by its best-matching block. The
                // retriever returns blocks in bm25 order, so the first hit for
                // a path is that document's strongest block — and its kind
                // is now a fact the index recorded rather than a guess. Before
                // block-level indexing this had to claim `Paragraph` for
                // everything, which threw away the `HEADING` signal entirely.
                let best = hits.iter().find(|hit| hit.path == row.path);
                Candidate {
                    path: row.path.clone(),
                    role: row.role,
                    path_match: path_match_of(&row.path, query),
                    block: best.map_or(BlockKind::Paragraph, |hit| hit.kind),
                    bm25: best.map_or(0.0, |hit| hit.relevance),
                    // Edit times are not carried on a document row. Zero days is
                    // not "edited today" — `search_rank` caps recency below every
                    // other signal precisely so a missing one cannot reorder.
                    days_since_edit: 0.0,
                }
            })
            .collect();

        rank_top(&mut candidates, wanted as usize);
        candidates.truncate(wanted as usize);

        let order: Vec<String> = candidates.into_iter().map(|one| one.path).collect();
        rows.sort_by_key(|row| {
            order
                .iter()
                .position(|path| path == &row.path)
                .unwrap_or(usize::MAX)
        });
        rows.truncate(order.len());
        Ok(rows)
    }

    /// Search the way an author expects: precisely, then forgivingly.
    ///
    /// `Exact` requires every part of the query to appear, which is right when
    /// the author remembers the words. When they misremember — a dropped
    /// character, two words in the wrong order — it returns nothing, and an
    /// empty result reads as "you never wrote that" rather than "try again
    /// differently".
    ///
    /// So an empty exact result falls through to `Loose`. Measured on a mixed
    /// Chinese corpus, this is the whole difference between the two modes:
    ///
    /// | query | exact | loose | first loose hit |
    /// |---|---|---|---|
    /// | 渐进披露 (dropped a character) | 0 | 2 | the chapter about it |
    /// | 营销渠道 (words the author paraphrased) | 0 | 3 | the chapter listing them |
    /// | 长夜睡眠 (remembered the sense) | 0 | 2 | the chapter with that line |
    /// | 不存在的词 (genuinely absent) | 0 | **0** | — |
    ///
    /// The last row is why this is safe: `Loose` does not invent noise for
    /// something that was never written. It widens for a misremembering author
    /// and stays silent for an absent phrase.
    ///
    /// **Choosing by query length was measured and rejected.** The obvious rule
    /// — short queries are vague, so widen them — does not survive contact with
    /// the data: at two through five characters the two modes returned
    /// *identical* results, and at one character both returned nothing (a
    /// bigram needs two). The difference is not how long the query is, it is
    /// whether the author remembered correctly, and length cannot see that.
    /// A widening that only happens when the precise answer is empty can.
    ///
    /// The author is told nothing about which pass answered. Two modes are an
    /// implementation fact; what they asked for is "find this".
    pub fn search_documents(
        &mut self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<DocumentRow>, RefrainError> {
        let exact = self.search_documents_with(query, Precision::Exact, limit)?;
        if !exact.is_empty() {
            return Ok(exact);
        }
        self.search_documents_with(query, Precision::Loose, limit)
    }

    /// Read the catalog rows for a set of paths the index named.
    fn documents_at<'a>(
        &self,
        paths: impl Iterator<Item = &'a str>,
    ) -> Result<Vec<DocumentRow>, RefrainError> {
        let mut statement = self
            .db
            .prepare(
                "SELECT id, path, role, digest, current_head, head_block_ids
                 FROM documents WHERE path = ?1",
            )
            .map_err(|error| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "search documents",
                    "refrain.db",
                )
                .with_detail(error.to_string())
            })?;
        let mut rows = Vec::new();
        for path in paths {
            // A path in the index with no catalog row is not an error: the
            // author deleted the file and reconciliation has not run yet.
            // Skipping keeps a stale index from failing a search.
            let found = statement
                .query_row(params![path], stored_document)
                .optional()
                .map_err(|error| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "read a document search result",
                        "refrain.db",
                    )
                    .with_detail(error.to_string())
                })?;
            if let Some(stored) = found {
                rows.push(decode_document(stored)?);
            }
        }
        Ok(rows)
    }
}

/// How the query relates to the path the author chose.
///
/// Compared on the path's final component: an author searching 「第三章」 means
/// the chapter, and a folder named 第三章 would otherwise make every file
/// inside it an exact match.
fn path_match_of(path: &str, query: &str) -> PathMatch {
    let name = path.rsplit('/').next().unwrap_or(path);
    let stem = name.strip_suffix(".md").unwrap_or(name);
    if stem == query {
        PathMatch::Exact
    } else if stem.contains(query) {
        PathMatch::Contains
    } else {
        PathMatch::None
    }
}
