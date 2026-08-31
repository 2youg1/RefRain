// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! Project document catalog.
//!
//! One module owns membership reconciliation and every read model over that
//! membership. The filesystem scan is authoritative for membership; SQLite is
//! the durable catalog. Existing rows keep identity, role, digest, confirmed
//! head, and lineage across a refresh.

use refrain_core::block_shape::BlockKind;
use refrain_core::chinese_index::Precision;
use refrain_core::material_listing::Disclosure;
use refrain_core::search_rank::{Candidate, PathMatch, rank_top};
use refrain_core::{DocumentRole, ErrorCode, Id, RefrainError, digest};
use rusqlite::{OptionalExtension, params};

use std::collections::BTreeSet;

use super::{ProjectFailure, ProjectStore, infer_role};
use crate::files::index::{ScanOptions, scan_checked};
use crate::root::RootKind;

/// 搜索索引相对磁盘的状态。
///
/// 两种不新鲜的代价差一个数量级，而布尔标志说不出它们的区别：从未建过要读
/// 全部文档，而作者新建一份只欠这一份。两者共用 `false` 时，后者按前者付钱：
/// 实测新建一份后的首次检索，400 份语料 51ms、800 份 95ms、1600 份 190ms——
/// 每份恒定 119µs，即一次全语料的读盘与摘要，而稳态检索只要 1.8ms。
/// 见 `tests/index_growth_probe.rs`。
///
/// 新鲜仍然必须由一次成功的构建**声张**，这是旧布尔字段守住的那条：比两个
/// `Option` 曾经在两者都不存在时报「当前」，于是从未对账的库搜一个空索引，说
/// 稿子里什么都没有。`Unbuilt` 正是那条声张的类型化：它只能被构建走掉。
#[derive(Debug)]
pub(crate) enum IndexFreshness {
    /// 从未建过。下一次检索读全部文档——采纳一个作者早就写好的目录走这里。
    Unbuilt,
    /// 建过了。集合是自那以后到达或改动、尚未入索引的路径；空集即完全新鲜。
    Built(BTreeSet<String>),
}

impl IndexFreshness {
    /// 记下一条路径欠着入索引。尚未建过时不记：全量那一趟本就包含它。
    pub(crate) fn owe(&mut self, path: &str) {
        if let Self::Built(owed) = self {
            owed.insert(path.to_string());
        }
    }
}

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

/// One block the index matched, with the text it matched on.
///
/// Carries the excerpt so the shell can show what was found rather than only
/// where. `start_byte` is what makes the hit navigable — the shell opens the
/// document and puts the caret there.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BlockHit {
    pub path: String,
    /// Which block of that document, counting from zero.
    pub ordinal: u32,
    /// What the author made this block: `heading`, `fence`, `table`, `paragraph`.
    ///
    /// Crosses the bridge as the same wire name the index stores, not as a
    /// serialisable `BlockKind`. Deriving serde on the domain enum would make
    /// every future variant an implicit part of the wire contract, and the
    /// shell only needs to tell a heading from prose.
    pub kind: String,
    /// Byte offset of the block within the document, for navigation.
    pub start_byte: u32,
    /// The block's text as it stood when this search ran.
    pub text: String,
    /// Larger is more relevant, matching `search_rank`'s convention.
    pub relevance: f64,
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
    /// For an imported Material: the digest of the file it came from, which
    /// names its immutable clone. `None` for anything not imported, and for
    /// Materials imported before schema v10.
    pub source_digest: Option<String>,
    /// The imported file's format, which completes the clone's filename.
    pub source_format: Option<String>,
    /// What the author permits for this document when it rides as a material.
    /// `None` is "never asked": the readers treat it as the enum's default,
    /// which is exactly what a pre-v11 row means.
    pub disclosure: Option<Disclosure>,
}

/// One `documents` row as SQLite hands it over, before the id and role are
/// parsed.
///
/// A struct rather than a tuple: five of these eight fields are
/// `Option<String>`, so a tuple lets two of them swap places without the
/// compiler noticing — the reader would see one document's lineage attached to
/// another's source. Names cost nothing here and the swap becomes impossible.
pub(super) struct StoredDocument {
    id: String,
    path: String,
    role: String,
    digest: Option<String>,
    current_head: Option<String>,
    head_block_ids: Option<String>,
    source_digest: Option<String>,
    source_format: Option<String>,
    disclosure: Option<String>,
}

pub(super) fn stored_document(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredDocument> {
    Ok(StoredDocument {
        id: row.get(0)?,
        path: row.get(1)?,
        role: row.get(2)?,
        digest: row.get(3)?,
        current_head: row.get(4)?,
        head_block_ids: row.get(5)?,
        source_digest: row.get(6)?,
        source_format: row.get(7)?,
        disclosure: row.get(8)?,
    })
}

pub(super) fn decode_document(stored: StoredDocument) -> Result<DocumentRow, RefrainError> {
    let StoredDocument {
        id,
        path,
        role,
        digest,
        current_head,
        head_block_ids,
        source_digest,
        source_format,
        disclosure,
    } = stored;
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
    let disclosure = disclosure
        .as_deref()
        .map(|value| {
            Disclosure::from_wire(value).ok_or_else(|| {
                RefrainError::new(ErrorCode::StateUnavailable, "read a disclosure", &path)
            })
        })
        .transpose()?;
    Ok(DocumentRow {
        id,
        path,
        role,
        digest,
        current_head,
        head_block_ids,
        source_digest,
        source_format,
        disclosure,
    })
}

impl ProjectStore {
    /// 取得这个 Root 之后应该打开哪一份正文。
    ///
    /// 「打开一个项目」这个用例只承诺一件事：作者看见自己的字。落点属于名录，
    /// 因为只有名录同时知道 Root 是单文件还是文件夹、有哪些 Chapter、以及上次
    /// 停在哪里；把它留给外壳，外壳就只能猜「第一行大概就是刚才那个文件」。
    ///
    /// 三条规则，按优先级：单文件 Root 就是那一份；否则回到记下的上次文档，
    /// 但它必须仍在名录里（文件被删掉时记录会指向不存在的路径）；再否则取目录
    /// 序第一篇 Chapter。项目确实没有 Chapter 时返回 `None`，那是唯一允许
    /// 停在空工作区的情形。
    pub fn landing_document(&mut self) -> Result<Option<String>, ProjectFailure> {
        let documents = self.refresh_documents()?;
        if self.permit.kind == RootKind::File {
            return Ok(documents.first().map(|row| row.path.clone()));
        }
        let remembered = self.remembered_landing()?;
        if let Some(path) = remembered
            && documents.iter().any(|row| row.path == path)
        {
            return Ok(Some(path));
        }
        Ok(documents
            .iter()
            .find(|row| row.role == DocumentRole::Chapter)
            .map(|row| row.path.clone()))
    }

    fn remembered_landing(&self) -> Result<Option<String>, ProjectFailure> {
        self.db
            .query_row("SELECT path FROM session_landing WHERE id = 0", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .map_err(|error| {
                ProjectFailure::Domain(
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "read the session landing",
                        "refrain.db",
                    )
                    .with_detail(error.to_string()),
                )
            })
    }

    /// 记下作者此刻在写哪一份，好让下次取得同一个 Root 时回到这里。
    pub fn remember_landing(&mut self, relative: &str) -> Result<(), ProjectFailure> {
        self.db
            .execute(
                "INSERT INTO session_landing (id, path, opened_at) VALUES (0, ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET path = excluded.path, opened_at = excluded.opened_at",
                params![relative, super::now_millis() as i64],
            )
            .map_err(|error| {
                ProjectFailure::Domain(
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "record the session landing",
                        "refrain.db",
                    )
                    .with_detail(error.to_string()),
                )
            })?;
        Ok(())
    }

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
        let arrived: Vec<String>;
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
                 ON CONFLICT(path) DO NOTHING
                 RETURNING path",
            )?;
            // 到达的路径与离开的路径同一个机制取：`RETURNING` 让 upsert 自己说出它真
            // 插了谁，比事后拿扫描结果减去目录少一次来源。`DO NOTHING` 吹掉的行
            // 不进这个集合，正是想要的：早就在目录里的篇目没有到达。
            arrived = insert_new
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?;

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
        //
        // 欠的只是到达的那几条。成员身份变了并不意味着旧篇目的内容变了，而把
        // 整个索引判为陈旧会让下一次检索重读全语料：作者每新建一章就付一次
        // 全语料的钱，那正是「越用越卡」。离开的那几条上面已经 `forget_document`
        // 过，不该再欠。内容改动不走这里，走 `invalidate_index_if_stale`。
        if let IndexFreshness::Built(owed) = &mut self.index_freshness {
            owed.extend(arrived);
            for path in &departed {
                owed.remove(path);
            }
        }
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
        // 欠账在进构建前就取走：一趟失败不该把路径守在集合里等下一趟，因为
        // `index_document` 已经按摘要自己判断该不该重写；读不到的文件被跳过，
        // 它下一次被打开时由 `invalidate_index_if_stale` 重新欠上。
        let owed = match &mut self.index_freshness {
            IndexFreshness::Built(owed) if owed.is_empty() => return Ok(()),
            IndexFreshness::Built(owed) => Some(std::mem::take(owed)),
            IndexFreshness::Unbuilt => None,
        };
        self.index_catalog(owed.as_ref())
            .map_err(|failure| match failure {
                ProjectFailure::Domain(error) => error,
                other => RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "build the search index",
                    "refrain.db",
                )
                .with_detail(other.to_string()),
            })?;
        self.index_freshness = IndexFreshness::Built(BTreeSet::new());
        // 建成是一次事实：立起一次性旗标，让「索引刷新」这个安静事件有据可依。
        self.index_built_pending = true;
        Ok(())
    }

    /// 取走「索引刚建成」的一次性事实：有则真并清零，无则假。
    /// 应用层在搜索用例成功后问一次，据它产 KARA 的安静事件。
    pub fn take_index_built(&mut self) -> bool {
        std::mem::take(&mut self.index_built_pending)
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
    ///
    /// # 为什么它接一个路径集合
    ///
    /// `None` 是全量那一趟（采纳一个已写好的目录），上面那些数字都是它的。
    /// `Some` 是作者写作时的常态：新建一章只欠一章，读盘量从整份语料降到
    /// 改动本身。循环体两者共用，包括包含性缓存与那一个事务——差别只在读谁。
    fn index_catalog(&mut self, owed: Option<&BTreeSet<String>>) -> Result<(), ProjectFailure> {
        let known: Vec<String> = match owed {
            Some(paths) => paths.iter().cloned().collect(),
            None => {
                let mut statement = self
                    .db
                    .prepare("SELECT path FROM documents")
                    .map_err(crate::schema::StoreError::from)?;
                let all = statement
                    .query_map([], |row| row.get(0))
                    .map_err(crate::schema::StoreError::from)?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(crate::schema::StoreError::from)?;
                drop(statement);
                all
            }
        };

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

        let mut transaction = self.db.transaction()?;
        for (path, digest, text) in &pending {
            // A single document that will not index is skipped, not fatal: the
            // rest of the manuscript should still be searchable. The savepoint
            // is what makes "skipped" mean "left nothing behind".
            //
            // `index_document` writes two rows per block, and it writes the
            // document's digest last. A failure in the middle used to be
            // swallowed here and then committed with everything else: the
            // blocks it had already indexed stayed in `block_search`, while
            // `block_search_state` and `document_index_state` had no record of
            // them. Nothing could reach those postings again — `forget_document`
            // deletes by the rowids the state table holds, and `next_rowid`
            // counts from the same table, so the next attempt handed out the
            // very same rowids. A rowid written twice answers as two blocks
            // and no delete clears the older one (measured,
            // `tests/contentless_delete_probe`), so one interrupted index left
            // the author searching a sentence that is no longer in the
            // manuscript — exactly what `search.rs` opens by promising not to do.
            let mut document = transaction.savepoint()?;
            match super::search::index_document(&document, path, digest, text) {
                Ok(_) => document.commit()?,
                Err(_) => document.rollback()?,
            }
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
                "SELECT id, path, role, digest, current_head, head_block_ids, source_digest, source_format, disclosure
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
                "SELECT id, path, role, digest, current_head, head_block_ids, source_digest, source_format, disclosure
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
    /// An exact pass that finds nothing is retried loose: the same widening
    /// `search_documents` performs, because an empty result reads as "you
    /// never wrote that" when the author only misremembered. A caller that
    /// passes `Loose` has already widened; nothing follows it.
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
        let widened = wanted.saturating_mul(4).max(wanted);
        let hits = super::search::search_with(&self.db, query, precision, widened)?;
        let hits = if hits.is_empty() && precision == Precision::Exact {
            super::search::search_with(&self.db, query, Precision::Loose, widened)?
        } else {
            hits
        };
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

    /// Search and keep the blocks, with the text each one matched on.
    ///
    /// `search_documents_with` folds every hit into the document that holds
    /// it, because a file list is what the shell shows. That fold throws away
    /// the two facts a reader needs to recognise a hit: which block, and what
    /// it says. Without them the result panel can only show a path — and a
    /// path cannot be highlighted, because the query words are not in it.
    ///
    /// The text is read from disk rather than stored in the index. The index
    /// holds offsets precisely so it does not become a second copy of the
    /// manuscript: a copy would be stale the moment the author typed, and a
    /// stale excerpt shown as a search result is worse than no excerpt.
    ///
    /// An exact pass that finds nothing is retried loose, the same widening
    /// `search_documents` performs; a caller that passes `Loose` has already
    /// widened, and nothing follows it.
    pub fn search_blocks_with(
        &mut self,
        query: &str,
        precision: Precision,
        limit: u32,
    ) -> Result<Vec<BlockHit>, RefrainError> {
        let query = query.trim();
        if query.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        if query.len() > MAX_DOCUMENT_SEARCH_BYTES {
            return Err(
                RefrainError::new(ErrorCode::IllegalName, "search blocks", "query").with_detail(
                    format!("query exceeds {MAX_DOCUMENT_SEARCH_BYTES} UTF-8 bytes"),
                ),
            );
        }

        self.ensure_indexed()?;
        let wanted = limit.min(MAX_DOCUMENT_SEARCH_RESULTS);
        let hits = super::search::search_with(&self.db, query, precision, wanted)?;
        let hits = if hits.is_empty() && precision == Precision::Exact {
            super::search::search_with(&self.db, query, Precision::Loose, wanted)?
        } else {
            hits
        };
        if hits.is_empty() {
            return Ok(Vec::new());
        }

        let root = self.permit.canonical_path.clone();
        let kind = self.permit.kind;
        // One read per document, not per block: a query that matches eight
        // blocks of one chapter would otherwise read that chapter eight times.
        let mut loaded: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let mut found = Vec::new();
        for hit in hits {
            let text = match loaded.get(&hit.path) {
                Some(text) => text,
                None => {
                    let resolved = match kind {
                        crate::root::RootKind::Folder => root.join(&hit.path),
                        crate::root::RootKind::File => root.clone(),
                    };
                    // A file the index knows and the disk no longer has is not
                    // an error the author should see mid-search; it is a stale
                    // index row, and the next reconcile removes it.
                    let Ok(bytes) = std::fs::read(&resolved) else {
                        continue;
                    };
                    let Ok(text) = String::from_utf8(bytes) else {
                        continue;
                    };
                    loaded.entry(hit.path.clone()).or_insert(text)
                }
            };

            let start = hit.start_byte as usize;
            let end = start.saturating_add(hit.bytes as usize).min(text.len());
            // The offsets came from an index that may predate the author's
            // last keystroke. Slicing on a boundary that is no longer a
            // character boundary panics, so check rather than trust.
            if start > end || !text.is_char_boundary(start) || !text.is_char_boundary(end) {
                continue;
            }
            found.push(BlockHit {
                path: hit.path,
                ordinal: hit.ordinal,
                kind: hit.kind.wire_name(),
                start_byte: hit.start_byte,
                text: text[start..end].to_string(),
                relevance: hit.relevance,
            });
        }
        Ok(found)
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
                "SELECT id, path, role, digest, current_head, head_block_ids, source_digest, source_format, disclosure
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
