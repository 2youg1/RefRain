//! 信箱的安排（SPEC 9.6 的次序面）：作者对收件面的显式意图。
//!
//! 三种事实，全部由作者做出，因而全部持久：
//!
//! - **次序**（`rank`）：置顶置底排出来的先后。可以手工重排，所以丢了只是麻烦。
//! - **Pin**（`pinned`）：与置顶不同——置顶是一次排序，新单进来照样压得下去；
//!   Pin 说的是「这一单不参与后续排序」。它是一句陈述，不是一次动作。
//! - **弃置**（`discarded_at`）：作者放弃了这批提案。**只做软删除**：
//!   提案行原地不动、账本一行不少、磁盘一个字节不碰（INV-4 不允许任何一层做
//!   永久删除）。谁在什么时候放弃了哪批提案，与裁决同属一类事实。
//!
//! 没有行就是默认安排：没人碰过的信箱不占一行。

use rusqlite::{Connection, params};

use crate::schema::StoreError;

/// 信箱三格。格名进数据库，所以它在这里定形，不由调用方拼字符串。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum MailboxBoxName {
    Draft,
    Unread,
    Done,
}

impl MailboxBoxName {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Unread => "unread",
            Self::Done => "done",
        }
    }

    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "draft" => Some(Self::Draft),
            "unread" => Some(Self::Unread),
            "done" => Some(Self::Done),
            _ => None,
        }
    }
}

/// 一条安排。`rank` 缺席表示作者没排过它——那一格的自然次序说了算。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MailboxStanding {
    pub entry_id: String,
    pub box_name: MailboxBoxName,
    /// 位次。`u32` 而非 `i64`：位次是列表里的下标，非负，而桥上不许
    /// BigInt 型（Specta 会拒绝导出）。
    pub rank: Option<u32>,
    pub pinned: bool,
    /// 弃置时刻（Unix 毫秒）。有值即已弃置，而行仍在。
    #[serde(with = "crate::project::u64_string_option")]
    #[specta(type = Option<String>)]
    pub discarded_at: Option<u64>,
}

/// 信箱安排是项目库上的一个视图，从不是第二个存储。
pub struct MailboxStandings<'a> {
    db: &'a Connection,
}

impl<'a> MailboxStandings<'a> {
    #[must_use]
    pub fn new(db: &'a Connection) -> Self {
        Self { db }
    }

    /// 全部安排。读的一方拿它去投影自己那一格。
    ///
    /// Pin 优先于一切位次；其余按位次。**没排过的排在最后**——`rank` 缺席
    /// 表示作者从未动过它，而 SQLite 里 NULL 小于任何数字，直接 `ORDER BY
    /// rank` 会把没排过的顶到排过的前面（实测：解 Pin 后那一单仍旧居首）。
    pub fn all(&self) -> Result<Vec<MailboxStanding>, StoreError> {
        let mut statement = self.db.prepare(
            "SELECT entry_id, box_name, rank, pinned, discarded_at
                 FROM mailbox_standing
                 ORDER BY pinned DESC, rank IS NULL, rank, updated_at",
        )?;
        let rows = statement
            .query_map([], read_standing)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 交换两单的位次，一次事务。相邻交换是界面唯一需要的移动语义，
    /// 而两条独立 `set_rank` 之间有中间态（同 rank、按 updated_at 排）——
    /// 交换是一个原子操作，不该由调用方拼。
    ///
    /// 双方都须已有位次；任一缺席是空操作（返回 Ok，行未动）——界面在
    /// 按钮上已经按「双方都有位次」启用，这里只是不把「没排过的」读成错误。
    pub fn swap_ranks(
        &self,
        entry_id_a: &str,
        entry_id_b: &str,
        now: u64,
    ) -> Result<(), StoreError> {
        let both = self
            .db
            .prepare(
                "SELECT entry_id, rank FROM mailbox_standing
                 WHERE entry_id IN (?1, ?2)",
            )?
            .query_map(params![entry_id_a, entry_id_b], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<u32>>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if both.len() != 2 {
            return Ok(()); // 有一个没排过（或不存在）：无事可换。
        }
        let (Some(rank_a), Some(rank_b)) = (both[0].1, both[1].1) else {
            return Ok(());
        };
        // `unchecked_transaction` is rusqlite's documented way to take a
        // transaction behind `&self` (Connection is a RefCell inside).
        let tx = self.db.unchecked_transaction()?;
        tx.execute(
            "UPDATE mailbox_standing SET rank = ?2, updated_at = ?3 WHERE entry_id = ?1",
            params![entry_id_a, rank_b, now as i64],
        )?;
        tx.execute(
            "UPDATE mailbox_standing SET rank = ?2, updated_at = ?3 WHERE entry_id = ?1",
            params![entry_id_b, rank_a, now as i64],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// 排一单：写下它在那一格里的位次。
    pub fn set_rank(
        &self,
        entry_id: &str,
        box_name: MailboxBoxName,
        rank: u32,
        now: u64,
    ) -> Result<(), StoreError> {
        self.db.execute(
            "INSERT INTO mailbox_standing (entry_id, box_name, rank, pinned, discarded_at, updated_at)
                 VALUES (?1, ?2, ?3, 0, NULL, ?4)
             ON CONFLICT(entry_id) DO UPDATE SET
                 box_name   = excluded.box_name,
                 rank       = excluded.rank,
                 updated_at = excluded.updated_at",
            params![entry_id, box_name.as_str(), rank, now as i64],
        )?;
        Ok(())
    }

    /// Pin 或解 Pin。两个方向都要能走：钉住是意图，取消也是。
    pub fn set_pinned(
        &self,
        entry_id: &str,
        box_name: MailboxBoxName,
        pinned: bool,
        now: u64,
    ) -> Result<(), StoreError> {
        self.db.execute(
            "INSERT INTO mailbox_standing (entry_id, box_name, rank, pinned, discarded_at, updated_at)
                 VALUES (?1, ?2, NULL, ?3, NULL, ?4)
             ON CONFLICT(entry_id) DO UPDATE SET
                 box_name   = excluded.box_name,
                 pinned     = excluded.pinned,
                 updated_at = excluded.updated_at",
            params![entry_id, box_name.as_str(), i64::from(pinned), now as i64],
        )?;
        Ok(())
    }

    /// 弃置一单。软删除：只写下时刻，提案与裁决原封不动。
    pub fn discard(
        &self,
        entry_id: &str,
        box_name: MailboxBoxName,
        now: u64,
    ) -> Result<(), StoreError> {
        self.db.execute(
            "INSERT INTO mailbox_standing (entry_id, box_name, rank, pinned, discarded_at, updated_at)
                 VALUES (?1, ?2, NULL, 0, ?3, ?3)
             ON CONFLICT(entry_id) DO UPDATE SET
                 box_name     = excluded.box_name,
                 discarded_at = excluded.discarded_at,
                 updated_at   = excluded.updated_at",
            params![entry_id, box_name.as_str(), now as i64],
        )?;
        Ok(())
    }

    /// 取回一单：弃置是可逆的，这就是回收站的那一半。
    pub fn restore(&self, entry_id: &str, now: u64) -> Result<usize, StoreError> {
        let restored = self.db.execute(
            "UPDATE mailbox_standing
                 SET discarded_at = NULL, updated_at = ?2
                 WHERE entry_id = ?1 AND discarded_at IS NOT NULL",
            params![entry_id, now as i64],
        )?;
        Ok(restored)
    }

    /// 回收站里的单，最近弃置的在前。
    pub fn discarded(&self) -> Result<Vec<MailboxStanding>, StoreError> {
        let mut statement = self.db.prepare(
            "SELECT entry_id, box_name, rank, pinned, discarded_at
                 FROM mailbox_standing
                 WHERE discarded_at IS NOT NULL
                 ORDER BY discarded_at DESC",
        )?;
        let rows = statement
            .query_map([], read_standing)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

fn read_standing(row: &rusqlite::Row<'_>) -> rusqlite::Result<MailboxStanding> {
    let box_text: String = row.get(1)?;
    let box_name = MailboxBoxName::from_wire(&box_text).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            format!("unknown mailbox box {box_text}").into(),
        )
    })?;
    Ok(MailboxStanding {
        entry_id: row.get(0)?,
        box_name,
        rank: row.get::<_, Option<i64>>(2)?.map(|value| value as u32),
        pinned: row.get::<_, i64>(3)? != 0,
        discarded_at: row.get::<_, Option<i64>>(4)?.map(|value| value as u64),
    })
}
