//! 信箱服务：把「Agent 提了什么」与「作者怎么安排」合成一屏（SPEC 9.6）。
//!
//! # 为什么在这
//!
//! 存储层各管一半事实：`proposals` 表记得提案本身，`mailbox_standing` 表
//! 记得作者的安排（次序、Pin、弃置）。界面要的一行是两者的合成——这一单
//! 讲什么、现在在哪一格、排没排。把合成放给界面，两个界面就会各判一次
//! 而结论不同。
//!
//! # 这一层做的事
//!
//! - 有安排行的单，格、位次、Pin 全用行里的——那是作者明说过的。
//! - 没有行的提案按账本判：一行裁决都没有是未读（Unread），有过裁决是
//!   已处理（Done）。账本只增，所以「已处理」不会被后来洗掉；退回
//!   （revert）删掉的是还没合并的裁决行，删干净了就回到未读。
//! - 弃置（`discarded_at` 有值）是软删除：单不进默认列表，提案行与账本
//!   原封不动（INV-4）。`discarded()` 单独投影回收站，最近弃置的在前。
//!
//! 次序就是 `mailbox().all()` 的次序——Pin 优先、位次次之、没排过的
//! 最后——这一层不重排。存储层已经按作者的意图排好，这里再排一次就多
//! 一个说谎的地方。
//!
//! # ReviewTask 为什么不进这个列表
//!
//! 信箱 entry 的 id 可以是提案 id 也可以是任务 id（schema 9 如此），但
//! 这一屏的列全是提案事实：原文、提议、范围。任务没有这些列——它带的
//! 是 prompt 与进度，并且已经借 `HostSnapshot.tasks` 过界。把任务并进
//! 同一个视图，每一列都得变成可选，而可选就是界面猜的开始。指着任务的
//! 安排行在这一版被跳过：行原地留着，任务那一侧的信箱落地时再并进来，
//! 存储形状不用变。

use std::collections::{HashMap, HashSet};

use refrain_core::RefrainError;
use refrain_store::mailbox::MailboxBoxName;
use refrain_store::project::{ProjectStore, ProposalRow};

use crate::journal::{into_domain, into_domain_store};
use crate::root::ProjectEntry;

/// 一单在信箱里的样子。
///
/// **投影而不是把 store 的行直接过河**：`ProposalRow` 带 run 与 baseline，
/// `MailboxStanding` 带弃置与更新时刻——界面要的是已经判好的样子：这一单
/// 在哪一格、排没排。理由与 `ProposalView` 相同：给存储行加 serde，就是
/// 让存储层的形状变成跨界合同。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MailboxEntryView {
    /// 这一单的稳定身份：提案 id。
    pub id: String,
    /// 提案落在哪份文档（Root 相对路径）。信箱跨文档合并，界面按它归组。
    pub document: String,
    /// 这条提案要改的范围（块 id）。
    pub scope: String,
    /// Agent 当时读到的原文。
    pub before_text: String,
    /// Agent 提议的新文本。只留评论的提案没有它。
    pub after_text: Option<String>,
    /// 解析之后这一单在哪一格：有安排行用行里的，没有的按账本判。
    pub box_name: MailboxBoxName,
    /// 位次。`None` 表示作者没排过它。
    pub rank: Option<u32>,
    /// Pin 与置顶不同：这一单不参与后续排序。
    pub pinned: bool,
}

/// 读信箱的默认列表：安排过的在前（Pin 优先、位次次之），没人碰过的提案
/// 按到来的次序殿后，弃置的不在内。
///
/// # Errors
///
/// 项目库读不出来——提案、账本或安排表的任何一处——具名失败。
pub fn entries(store: &ProjectStore) -> Result<Vec<MailboxEntryView>, RefrainError> {
    // 提案按文档取，所以先收全部文档。用 `documents()` 而不是分页：分页是
    // 给界面翻页用的，这一层合成的是同一屏信箱，要全部。也不必 reconcile
    // ——提案只会落在注册过的文档上。
    let mut proposals = Vec::new();
    let mut decided = HashSet::new();
    for document in store.documents()? {
        proposals.extend(store.proposals_for(&document.path).map_err(into_domain)?);
        decided.extend(
            store
                .ledger()
                .for_document(&document.path)
                .map_err(into_domain_store)?
                .into_iter()
                .map(|row| row.proposal_id),
        );
    }
    let by_id: HashMap<&str, &ProposalRow> =
        proposals.iter().map(|row| (row.id.as_str(), row)).collect();

    let standings = store.mailbox().all().map_err(into_domain_store)?;
    let mut views = Vec::with_capacity(proposals.len());
    let mut has_row: HashSet<&str> = HashSet::new();
    // 安排行的次序就是列表的次序，不重排。弃置的不进默认列表；指着任务
    // 或已消失提案的行跳过——行原地留着，理由见模块头。
    for standing in &standings {
        has_row.insert(standing.entry_id.as_str());
        if standing.discarded_at.is_some() {
            continue;
        }
        let Some(row) = by_id.get(standing.entry_id.as_str()) else {
            continue;
        };
        views.push(view_of(
            row,
            standing.box_name,
            standing.rank,
            standing.pinned,
        ));
    }
    // 第二遍只收真正没有行的提案：格按账本判，没位次、没 Pin。弃置的单
    // 也有行——它属于回收站，不从这一遍回到默认列表。
    for row in &proposals {
        if has_row.contains(row.id.as_str()) {
            continue;
        }
        let box_name = if decided.contains(row.id.as_str()) {
            MailboxBoxName::Done
        } else {
            MailboxBoxName::Unread
        };
        views.push(view_of(row, box_name, None, false));
    }
    Ok(views)
}

/// 回收站：弃置的单，最近弃置的在前（次序沿用存储层，不重排）。
///
/// 它与默认列表是两份投影而不是一份加过滤：作者看信箱时不该看见他刚
/// 放弃的那批，看回收站时只想看见那批。单上带的格是它被弃置时所在的
/// 那一格——取回之后它还回那里。
///
/// # Errors
///
/// 项目库读不出来时具名失败，与 `entries` 同一类。
pub fn discarded(store: &ProjectStore) -> Result<Vec<MailboxEntryView>, RefrainError> {
    let mut proposals = Vec::new();
    for document in store.documents()? {
        proposals.extend(store.proposals_for(&document.path).map_err(into_domain)?);
    }
    let by_id: HashMap<&str, &ProposalRow> =
        proposals.iter().map(|row| (row.id.as_str(), row)).collect();
    Ok(store
        .mailbox()
        .discarded()
        .map_err(into_domain_store)?
        .iter()
        .filter_map(|standing| {
            by_id
                .get(standing.entry_id.as_str())
                .map(|row| view_of(row, standing.box_name, standing.rank, standing.pinned))
        })
        .collect())
}

/// Pin 或解 Pin 一单。Pin 是「这一单不参与后续排序」的陈述，两个方向都是
/// 作者在说话，所以都持久。答复即刷新后的信箱——视图与事实同一生灭。
///
/// # Errors
///
/// 安排表写不进去、或刷新信箱失败时具名失败。
pub fn set_pinned(
    project: &mut ProjectEntry,
    entry_id: &str,
    box_name: MailboxBoxName,
    pinned: bool,
    now: u64,
) -> Result<Vec<MailboxEntryView>, RefrainError> {
    project
        .store
        .mailbox()
        .set_pinned(entry_id, box_name, pinned, now)
        .map_err(into_domain_store)?;
    entries(&project.store)
}

/// 排一单在那一格里的位次。
///
/// # Errors
///
/// 与 [`set_pinned`] 相同。
pub fn set_rank(
    project: &mut ProjectEntry,
    entry_id: &str,
    box_name: MailboxBoxName,
    rank: u32,
    now: u64,
) -> Result<Vec<MailboxEntryView>, RefrainError> {
    project
        .store
        .mailbox()
        .set_rank(entry_id, box_name, rank, now)
        .map_err(into_domain_store)?;
    entries(&project.store)
}

/// 交换两单的位次，一次事务。相邻交换是界面唯一需要的移动语义；两条
/// [`set_rank`] 拼不出原子交换（中间态两单同位次、按时间排）。
///
/// # Errors
///
/// 与 [`set_pinned`] 相同。
pub fn swap_ranks(
    project: &mut ProjectEntry,
    entry_id: &str,
    other_id: &str,
    now: u64,
) -> Result<Vec<MailboxEntryView>, RefrainError> {
    project
        .store
        .mailbox()
        .swap_ranks(entry_id, other_id, now)
        .map_err(into_domain_store)?;
    entries(&project.store)
}

/// 弃置一单：软删除。提案行与账本一行不动（INV-4），取回走 [`restore`]。
///
/// # Errors
///
/// 与 [`set_pinned`] 相同。
pub fn discard(
    project: &mut ProjectEntry,
    entry_id: &str,
    box_name: MailboxBoxName,
    now: u64,
) -> Result<Vec<MailboxEntryView>, RefrainError> {
    project
        .store
        .mailbox()
        .discard(entry_id, box_name, now)
        .map_err(into_domain_store)?;
    entries(&project.store)
}

/// 取回一弃置的单。从没弃置过改 0 行——空操作，不是错误，照常返回
/// 刷新后的信箱。
///
/// # Errors
///
/// 与 [`set_pinned`] 相同。
pub fn restore(
    project: &mut ProjectEntry,
    entry_id: &str,
    now: u64,
) -> Result<Vec<MailboxEntryView>, RefrainError> {
    project
        .store
        .mailbox()
        .restore(entry_id, now)
        .map_err(into_domain_store)?;
    entries(&project.store)
}

/// 一行提案投影成界面要的那几列；格、位次与 Pin 由调用方判好送进来。
fn view_of(
    row: &ProposalRow,
    box_name: MailboxBoxName,
    rank: Option<u32>,
    pinned: bool,
) -> MailboxEntryView {
    MailboxEntryView {
        id: row.id.clone(),
        document: row.document_path.clone(),
        scope: row.scope.clone(),
        before_text: row.before_text.clone(),
        after_text: row.after_text.clone(),
        box_name,
        rank,
        pinned,
    }
}
