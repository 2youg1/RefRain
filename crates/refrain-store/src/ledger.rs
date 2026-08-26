//! The Verdict Ledger: every human judgment is first-class data (SPEC 1.2).
//!
//! Ported behaviour (legacy `ledger.ts` via `store.test.ts`, owned here since
//! C3):
//!
//! - Recording is idempotent by id: a duplicate id cannot rewrite the
//!   original audit record.
//! - Verdicts return in decision order.
//! - An unstated reason stays absent; it never becomes an empty string.
//! - Search escapes LIKE's wildcards: `_`, `%`, and `\` in the author's query
//!   are characters, not operators. The parameter was always bound, but the
//!   unescaped fragment quietly returned rows that did not match, and the
//!   author had no way to notice.

use rusqlite::{Connection, OptionalExtension, params};

use crate::schema::StoreError;

/// The persisted shape of one judgment. `AcceptModified` carries its final
/// text in `final_text`; the kind column alone never tells that story.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum VerdictKindName {
    Accept,
    AcceptModified,
    Reject,
    CommentOnly,
    /// A reversal of a merged verdict: the ledger stays append-only, so the
    /// countermand is a new record — nothing is deleted, and the pair tells
    /// the whole story (逆向裁决).
    Countermanded,
}

impl VerdictKindName {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::AcceptModified => "accept-modified",
            Self::Reject => "reject",
            Self::CommentOnly => "comment-only",
            Self::Countermanded => "countermanded",
        }
    }

    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "accept" => Some(Self::Accept),
            "accept-modified" => Some(Self::AcceptModified),
            "reject" => Some(Self::Reject),
            "comment-only" => Some(Self::CommentOnly),
            "countermanded" => Some(Self::Countermanded),
            _ => None,
        }
    }
}

/// One row of the ledger. Ids stay strings here: legacy rows arrive with
/// legacy ids during migration (INV-9), and the ledger must hold both
/// without rewriting either.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VerdictRecord {
    pub id: String,
    pub proposal_id: String,
    pub slice_id: String,
    pub kind: VerdictKindName,
    pub final_text: Option<String>,
    pub reason: Option<String>,
    /// Milliseconds since the Unix epoch (string on the bridge: Specta
    /// forbids BigInt-style exports).
    #[serde(with = "crate::project::u64_string")]
    #[specta(type = String)]
    pub decided_at: u64,
    /// The baseline spelling a legacy row arrived with, kept byte-for-byte.
    pub legacy_baseline: Option<String>,
}

/// The ledger is a view over the project database, never a second store.
pub struct VerdictLedger<'a> {
    db: &'a Connection,
}

impl<'a> VerdictLedger<'a> {
    #[must_use]
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// Records a judgment. A repeated id keeps the original row: the audit
    /// trail is not writable by accident of retry.
    ///
    /// **Idempotent by id, and by nothing else.** This was `INSERT OR IGNORE`,
    /// which ignores every constraint the table has — a `NOT NULL`, a `CHECK`, a
    /// second unique index — and still answers `Ok(())`. The module's stated
    /// intent is one exception, the repeated id, so the statement now names it:
    /// `ON CONFLICT(id) DO NOTHING`. Every other refusal reaches the caller,
    /// which is what SPEC 1.2 means by first-class data — a judgment the
    /// database declined to keep must not read as a judgment that was recorded.
    pub fn record(&self, verdict: &VerdictRecord) -> Result<(), StoreError> {
        self.db.execute(
            "INSERT INTO verdicts
                 (id, proposal_id, slice_id, kind, final_text, reason, decided_at, legacy_baseline)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO NOTHING",
            params![
                verdict.id,
                verdict.proposal_id,
                verdict.slice_id,
                verdict.kind.as_str(),
                verdict.final_text,
                verdict.reason,
                verdict.decided_at as i64,
                verdict.legacy_baseline,
            ],
        )?;
        Ok(())
    }

    /// Every verdict, in decision order (ties broken by insertion order).
    pub fn all(&self) -> Result<Vec<VerdictRecord>, StoreError> {
        let mut statement = self.db.prepare(
            "SELECT id, proposal_id, slice_id, kind, final_text, reason, decided_at, legacy_baseline
                 FROM verdicts ORDER BY decided_at, rowid",
        )?;
        let rows = statement
            .query_map([], read_record)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// One document's verdicts, oldest first: the `<changes>` stream's
    /// source (SPEC 8.5). Verdicts carry no document column; the proposal
    /// they judge does.
    pub fn for_document(&self, path: &str) -> Result<Vec<VerdictRecord>, StoreError> {
        let mut statement = self.db.prepare(
            "SELECT v.id, v.proposal_id, v.slice_id, v.kind, v.final_text, v.reason,
                    v.decided_at, v.legacy_baseline
                 FROM verdicts v
                 JOIN proposals p ON p.id = v.proposal_id
                 WHERE p.document_path = ?1
                 ORDER BY v.decided_at, v.rowid",
        )?;
        let rows = statement
            .query_map(params![path], read_record)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Rows by id, in decision order. The commit path rebuilds its batch
    /// from these; a missing id is a defect, not a skip.
    pub fn find_many(&self, ids: &[String]) -> Result<Vec<VerdictRecord>, StoreError> {
        let all = self.all()?;
        ids.iter()
            .map(|id| {
                all.iter()
                    .find(|row| &row.id == id)
                    .cloned()
                    .ok_or(StoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
            })
            .collect()
    }

    /// Forget judgments by id: the recall path （已裁决 → 已回复）. Only rows
    /// that never reached a commit should pass through here — the caller owns
    /// that check, because the ledger cannot see batches.
    pub fn forget(&self, ids: &[String]) -> Result<usize, StoreError> {
        let mut forgotten = 0;
        for id in ids {
            forgotten += self
                .db
                .execute("DELETE FROM verdicts WHERE id = ?1", params![id])?;
        }
        Ok(forgotten)
    }

    /// Full-text-free fragment search over the author's stated reasons. The
    /// fragment is escaped so its wildcards are characters.
    pub fn search(&self, fragment: &str) -> Result<Vec<VerdictRecord>, StoreError> {
        let escaped = fragment
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let mut statement = self.db.prepare(
            "SELECT id, proposal_id, slice_id, kind, final_text, reason, decided_at, legacy_baseline
             FROM verdicts
             WHERE reason LIKE ?1 ESCAPE '\\'
             ORDER BY decided_at, rowid",
        )?;
        let rows = statement
            .query_map(params![format!("%{escaped}%")], read_record)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn count(&self) -> Result<u64, StoreError> {
        let count: i64 = self
            .db
            .query_row("SELECT count(*) FROM verdicts", [], |row| row.get(0))
            .optional()?
            .unwrap_or(0);
        Ok(count as u64)
    }
}

fn read_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<VerdictRecord> {
    let kind_text: String = row.get(3)?;
    let kind = VerdictKindName::from_wire(&kind_text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            3,
            rusqlite::types::Type::Text,
            format!("unknown verdict kind {kind_text}").into(),
        )
    })?;
    Ok(VerdictRecord {
        id: row.get(0)?,
        proposal_id: row.get(1)?,
        slice_id: row.get(2)?,
        kind,
        final_text: row.get(4)?,
        reason: row.get(5)?,
        decided_at: row.get::<_, i64>(6)? as u64,
        legacy_baseline: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::{VerdictKindName, VerdictLedger, VerdictRecord};
    use crate::schema::{Database, ProjectDb, open_in_memory};
    use rusqlite::Connection;

    fn ledger_db() -> Connection {
        let mut db = open_in_memory().unwrap();
        ProjectDb::migrate(&mut db).unwrap();
        db
    }

    fn verdict(id: &str, proposal: &str) -> VerdictRecord {
        VerdictRecord {
            id: id.to_owned(),
            proposal_id: proposal.to_owned(),
            slice_id: "slice-1".to_owned(),
            kind: VerdictKindName::Accept,
            final_text: None,
            reason: Some("读过了".to_owned()),
            decided_at: 1_700_000_000_000,
            legacy_baseline: None,
        }
    }

    /// 重复的 id 保留原记录，且**只有**重复的 id 被放过。
    ///
    /// 旧写法是 `INSERT OR IGNORE`，它放过这张表的每一条约束——`NOT NULL`、
    /// `CHECK`、任何第二个唯一索引——然后照样返回 `Ok(())`。模块头声明的意图
    /// 是「按 id 幂等」，一条；于是语句现在只写那一条。
    ///
    /// 第二个唯一索引是这里能造出的、**不是 id** 的那一类约束失败。它不假想
    /// 一个不存在的场景：SPEC 1.2 说每一次人的判断都是一等数据，而一条被数据库
    /// 拒收的判断不许读成一条已被记录的判断。
    #[test]
    fn a_repeated_id_is_kept_out_and_every_other_refusal_reaches_the_caller() {
        let db = ledger_db();
        let ledger = VerdictLedger::new(&db);

        ledger.record(&verdict("v-1", "p-1")).unwrap();
        let mut rewritten = verdict("v-1", "p-1");
        rewritten.reason = Some("改写审计记录".to_owned());
        ledger.record(&rewritten).unwrap();
        assert_eq!(
            ledger
                .all()
                .unwrap()
                .first()
                .and_then(|row| row.reason.clone()),
            Some("读过了".to_owned()),
            "重复的 id 不得改写原始审计记录"
        );

        db.execute_batch("CREATE UNIQUE INDEX one_verdict_per_proposal ON verdicts(proposal_id);")
            .unwrap();
        let refused = ledger.record(&verdict("v-2", "p-1"));
        assert!(
            refused.is_err(),
            "一条被数据库拒收的判断返回了 Ok；它会读成一条已被记录的判断"
        );
        assert_eq!(ledger.all().unwrap().len(), 1);
    }

    /// 裁决种类的闭集只有一个权威：`VerdictKindName`。
    ///
    /// 表上原本还有一份 `CHECK (kind IN (…五个串…))`，与那个枚举逐字重复。
    /// 两份名单只在有人记得同时改时才一致，而不一致的后果是：加第六个变体、
    /// 忘了写迁移，那一类裁决在写入时被数据库拒掉。`STRICT` 保证列的类型，
    /// 「哪五个串合法」是领域规则，归 Rust。
    ///
    /// 两个方向都钉住：写出去的五个串各不相同，读回来的每一个都还原成它自己，
    /// 而认不得的串是一次具名失败，不是一条静默读到的假裁决。
    #[test]
    fn the_kind_closed_set_has_one_authority_and_survives_the_round_trip() {
        let db = ledger_db();
        let ledger = VerdictLedger::new(&db);
        let kinds = [
            VerdictKindName::Accept,
            VerdictKindName::AcceptModified,
            VerdictKindName::Reject,
            VerdictKindName::CommentOnly,
            VerdictKindName::Countermanded,
        ];

        for (index, kind) in kinds.iter().enumerate() {
            let mut record = verdict(&format!("v-{index}"), &format!("p-{index}"));
            record.kind = *kind;
            record.decided_at = 1_700_000_000_000 + index as u64;
            ledger.record(&record).unwrap();
        }

        let stored: Vec<VerdictKindName> = ledger
            .all()
            .unwrap()
            .into_iter()
            .map(|row| row.kind)
            .collect();
        assert_eq!(stored, kinds, "五个变体按决定顺序原样读回");

        // 读回来的一边也守着：一个本构建不认得的串是一次具名失败。
        db.execute(
            "INSERT INTO verdicts(id, proposal_id, slice_id, kind, decided_at)
             VALUES ('v-x', 'p-x', 'slice-1', 'invented', 1)",
            [],
        )
        .unwrap();
        assert!(
            ledger.all().is_err(),
            "认不得的种类必须是一次失败，不是一条读到的假裁决"
        );
    }
}
