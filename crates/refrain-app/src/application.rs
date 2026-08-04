//! Application-level project use case.
//!
//! One exhaustive input owns project acquisition, catalog reads, search,
//! disclosure, and deletion. Platform code supplies only a chooser. Selected
//! paths enter Rust and never cross the Native or TypeScript boundary.

use crate::dispatch::DispatchRequest;
use crate::document::{ImportedFrom, OpenDocumentDto, create_with_body, open_in_entry};
use crate::journal::{StoreJournal, into_domain, into_domain_host};
use refrain_core::Id;
use refrain_core::chinese_index::Precision;
use refrain_core::material_listing::Disclosure;
use refrain_core::{
    DocumentRole, ErrorCode, KaraAutoEntry, KaraEvent, KaraMachine, KaraPolicy, KaraTransition,
    Manuscript, RefrainError,
};
use refrain_host::host::{AgentHost, DispatchAuthorization, HostCommand, ReviewTask, Run};
use refrain_host::staging::DirectoryContext;
use refrain_store::application::{ApplicationStore, ApplicationStoreError};
use refrain_store::config::{Config, ConfigChange, ConfigStore};
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::project::{
    BackupStatus, BlockHit, DocumentPage, DocumentPageQuery, DocumentRow, MAX_DOCUMENT_PAGE_SIZE,
    MAX_DOCUMENT_SEARCH_RESULTS, ProjectStore, ProposalRow, RootLocator,
};
pub use refrain_store::root::RootKind;
use refrain_store::root::is_legal_segment;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub trait ProjectPlatform {
    fn choose_root(&self, kind: RootKind) -> Result<Option<PathBuf>, RefrainError>;
    fn choose_project_parent(&self) -> Result<Option<PathBuf>, RefrainError>;
    fn choose_import(&self, kind: ProjectImport) -> Result<Option<PathBuf>, RefrainError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectImport {
    Material,
    Manuscript,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum SearchPrecision {
    Exact,
    Loose,
}

impl From<SearchPrecision> for Precision {
    fn from(value: SearchPrecision) -> Self {
        match value {
            SearchPrecision::Exact => Self::Exact,
            SearchPrecision::Loose => Self::Loose,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    content = "value"
)]
pub enum ProjectInput {
    ChooseAndAdoptRoot {
        kind: RootKind,
    },
    ChooseAndCreateProject {
        name: String,
    },
    OpenDocument {
        root_id: String,
        path: String,
    },
    CreateDocument {
        root_id: String,
        title: String,
        role: DocumentRole,
    },
    ChooseAndImportMaterial {
        root_id: String,
    },
    ChooseAndImportManuscript {
        root_id: String,
    },
    DocumentPage {
        root_id: String,
        after: Option<String>,
    },
    DocumentSearch {
        root_id: String,
        query: String,
        precision: SearchPrecision,
    },
    BlockSearch {
        root_id: String,
        query: String,
        precision: SearchPrecision,
    },
    DeleteDocument {
        root_id: String,
        path: String,
    },
    SetDisclosure {
        root_id: String,
        path: String,
        disclosure: Disclosure,
    },
    /// 读当前设置。设置面板、字体与全局排版都从这一条拿值。
    ReadConfig,
    /// 改一项设置。变体集合由 `ConfigChange` 持有，这里不复制第二份。
    ChangeConfig(ConfigChange),
    /// 推进 KARA 状态机。机器在 Rust（INV-10），跨界只送事件、取转移。
    KaraStep(KaraEvent),
    /// 读一个 Root 的编排状态：Task、Run、授权与待恢复项。
    ReadHost {
        root_id: String,
    },
    /// 执行一条编排命令。变体集合由 `HostCommand` 持有，这里不复制第二份。
    HostCommand {
        root_id: String,
        command: Box<HostCommand>,
    },
    /// 读一份文档改过什么：持久化的 Text Action 链，重启之后仍在。
    ///
    /// 与撤销分开：撤销走的是内存里那条链（`DocumentSurface`），这一条
    /// 读的是落盘的记录——作者关掉软件第二天回来，能看见的是这一份。
    ReadHistory {
        root_id: String,
        path: String,
    },
    /// 读一份文档上的批注：高亮与评论。
    ReadAnnotations {
        root_id: String,
        path: String,
    },
    /// 在选中的一段正文上留一条批注。
    ///
    /// 送原文而不是块 id：块身份由 Rust 查（与派发同一条 `locate_scope`），
    /// 让界面送块 id 等于要求它先知道块怎么切。
    Annotate {
        root_id: String,
        path: String,
        /// 作者框住的那段字，逐字节。
        selected: String,
        /// 评论的正文。没有就是高亮——这是两者唯一的差别。
        body: Option<String>,
    },
    /// 探测本机装了哪些 Harness。
    ///
    /// 不带 Root：它问的是这台机器，不是这个项目。作者在「连接」那个
    /// 去处看见的是「我能连什么」，与他打开了哪个项目无关。
    ReadHarnesses,
    /// 派发一次改写请求：选中的范围 → 冻结的请求 → 若干个就绪的 Run。
    ///
    /// 与 `HostCommand` 分开是因为它不是一条编排命令，而是三条的序列，
    /// 中间两步各要上一步生成的东西（`task_id`、编译好的 `DispatchPackage`）。
    /// 界面拼不出那些，让它拼等于把领域顺序复制到 Zig 里。
    Dispatch {
        root_id: String,
        request: Box<DispatchRequest>,
    },
    /// 读一份文档上待裁决的提案。裁决台的行来自这一条。
    ReadProposals {
        root_id: String,
        path: String,
    },
    /// 对一条提案下裁决：记进账本并暂存进这份文档的审阅批次。
    ///
    /// **记账与提交分开**，因为它们是作者的两个动作：逐条判断，然后一次落盘。
    /// 合成一条会让「改主意」变成不可能——账本是只增的，写下去就只能再写一条
    /// 逆向裁决。
    StageVerdict {
        root_id: String,
        path: String,
        proposal_id: String,
        kind: VerdictKindName,
        /// `AcceptModified` 的最终正文。其余裁决不带它。
        final_text: Option<String>,
        reason: Option<String>,
    },
    /// 提交这份文档暂存的裁决批次。**裁决即落盘**（D1／F-01）：账本说
    /// 「已接受」的那一刻磁盘必须同真，不把「按保存」留给作者。
    CommitVerdicts {
        root_id: String,
        path: String,
    },
    /// 收取一次派发的结果。产出还没出现时是 `Waiting`，不是错误。
    CollectRun {
        root_id: String,
        run_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpened {
    pub root_id: String,
    pub backup: BackupStatus,
    pub documents: Vec<DocumentRow>,
    pub document_total: u32,
    pub document_cursor: Option<String>,
    pub opened_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPage {
    pub documents: Vec<DocumentRow>,
    pub total: u32,
    pub next: Option<String>,
}

impl From<DocumentPage> for ProjectPage {
    fn from(page: DocumentPage) -> Self {
        Self {
            documents: page.documents,
            total: page.total,
            next: page.next,
        }
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocuments {
    pub documents: Vec<DocumentRow>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBlocks {
    pub blocks: Vec<BlockHit>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum ProjectOutput {
    Cancelled,
    Opened(ProjectOpened),
    DocumentOpened(Box<OpenDocumentDto>),
    Imported(DocumentRow),
    Page(ProjectPage),
    Documents(ProjectDocuments),
    Blocks(ProjectBlocks),
    Deleted(DocumentRow),
    DisclosureSet(DocumentRow),
    /// 当前设置的完整快照。读与改返回同一形状——调用方不必分辨是哪一次。
    Config(Box<Config>),
    /// 一次 KARA 转移：新机器状态与要执行的效果。
    Kara(Box<KaraTransition>),
    /// 一个 Root 的编排快照。读与执行返回同一形状。
    Host(Box<HostSnapshot>),
    /// 一份文档改过什么，最近的在前。
    History(Vec<crate::history::HistoryEntry>),
    /// 一份文档上的批注。
    Annotations(Vec<crate::history::AnnotationView>),
    /// 本机 Harness 的名单与各自的状况。
    Harnesses(Vec<crate::harness::HarnessStatus>),
    /// 一次派发的结果：铸出了哪些 Run，请求的摘要与稳定前缀。
    ///
    /// 与 `Host` 分开：编排快照回答「现在有哪些 Run」，这一条回答「刚才这次
    /// 派发做出了什么」。合成一个，界面就要从整张名录里猜哪几行是新的。
    Dispatched(Box<crate::dispatch::Dispatched>),
    /// 一份文档上待裁决的提案，连同已经暂存进批次的那些 id。
    ///
    /// 两者一起送：界面要同时画「有哪些提案」与「哪几条已经判过」，
    /// 分两次读会让它们在两次答复之间短暂地互相矛盾。
    Proposals(ProjectProposals),
    /// 一次裁决落盘的结局。三态由 `DecisionOutcome` 决定，这里只把它讲给界面。
    Decided(DecisionReport),
    /// 一次收取的结局。产出还没出现是 `waiting`，不是错误。
    Collected(CollectReport),
}

/// 一份文档上待裁决的提案。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectProposals {
    pub proposals: Vec<ProposalView>,
    /// 已经暂存进批次的**提案** id（不是账本行 id）。
    ///
    /// 批次里存的是账本行 id，而界面画的是提案行——直接把账本 id 送过去，
    /// 界面就无法回答「这一条判过了吗」，只能退成「批次空不空」这种整体
    /// 状态。在这里配对一次，界面因此能逐行标记。
    pub staged: Vec<String>,
}

/// 一次裁决落盘的结局。
///
/// **三态而不是成功/失败二值**（D1／F-03）：正文落了盘但派生状态待修，与
/// 磁盘被别人改过，是两件不同的事；压进一个错误通道就是 F-03 的成因——
/// 重试会拿旧戳去比对自己刚写下的字节，把自己判成外部冲突。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum DecisionReport {
    /// 正文与派生状态全部落盘。
    Durable,
    /// 正文已落盘，派生状态待修复。`detail` 说明待修的是什么。
    BodyDurable { detail: String },
    /// 磁盘上的字节不是作者盖戳时看到的那一份。不能覆盖。
    Conflict,
}

/// 一次收取的结局。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum CollectReport {
    /// 结果文件还没出现，什么都没动。
    Waiting,
    Completed {
        proposals: u32,
        memos: u32,
        drafts: u32,
    },
    /// 这一次派发失败。`code` 是失败的种类，已经写进 Run 记录。
    Failed { code: String, detail: String },
}

/// 一条提案在裁决台上的样子。
///
/// **投影而不是把 `ProposalRow` 直接过河**：那是 store 的行，带着 run 与
/// baseline 这类界面用不上的列；给它加 serde derive 等于让存储层的形状变成
/// 跨界合同，此后每加一列都要想「界面会不会看见」。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    pub id: String,
    /// 这条提案要改的范围（块 id）。
    pub scope: String,
    /// Agent 当时读到的原文。
    pub before_text: String,
    /// Agent 提议的新文本。只留评论的提案没有它。
    pub after_text: Option<String>,
}

impl From<&ProposalRow> for ProposalView {
    fn from(row: &ProposalRow) -> Self {
        Self {
            id: row.id.clone(),
            scope: row.scope.clone(),
            before_text: row.before_text.clone(),
            after_text: row.after_text.clone(),
        }
    }
}

/// 现在是什么时候，毫秒。裁决与收取都要记时刻。
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// 这份文档已经判过的**提案** id。
///
/// 批次存的是账本行 id，所以要回账本取每一行对应的 proposal_id。多一次
/// 查询换界面能逐行标记——否则作者看不出自己判到第几条。
fn staged_proposal_ids(store: &ProjectStore, path: &str) -> Result<Vec<String>, RefrainError> {
    let batch = staged_ids(store, path)?;
    if batch.is_empty() {
        return Ok(Vec::new());
    }
    Ok(store
        .ledger()
        .find_many(&batch)
        .map_err(crate::journal::into_domain_store)?
        .into_iter()
        .map(|record| record.proposal_id)
        .collect())
}

/// 这份文档上的提案，投影成界面要的那几列。
fn proposal_views(store: &ProjectStore, path: &str) -> Result<Vec<ProposalView>, RefrainError> {
    Ok(store
        .proposals_for(path)
        .map_err(into_domain)?
        .iter()
        .map(ProposalView::from)
        .collect())
}

/// 这份文档已经暂存进批次的提案 id。没有批次时是空。
fn staged_ids(store: &ProjectStore, path: &str) -> Result<Vec<String>, RefrainError> {
    let Some((_cursor, batch_json)) = store.review_session_get(path).map_err(into_domain)? else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&batch_json).map_err(|error| {
        RefrainError::new(ErrorCode::StateUnavailable, "read a review batch", path)
            .with_detail(error.to_string())
    })
}

/// 对一条提案下裁决：记进账本，并把这些账本行暂存进这份文档的批次。
///
/// **一条提案可能要写多条账本行**：一次改写被切成 `[Delete, Insert]` 两片，
/// 每片各要一条裁决，提交时缺任何一片都会被具名拒绝。切片由领域层
/// （`Proposal::slices()`）说了算，不是这里数出来的——这正是「一个动作
/// 一个用例」要收进来的那种顺序知识。
///
/// **记账与提交分开**，因为它们是作者的两个动作：逐条判断，然后一次落盘。
fn stage_verdict(
    store: &mut ProjectStore,
    path: &str,
    proposal_id: &str,
    kind: VerdictKindName,
    final_text: Option<String>,
    reason: Option<String>,
) -> Result<ProjectProposals, RefrainError> {
    let row = store
        .proposals_for(path)
        .map_err(into_domain)?
        .into_iter()
        .find(|row| row.id == proposal_id)
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "judge a proposal that is not on this document",
                proposal_id.to_owned(),
            )
        })?;
    // 改写型裁决必须带最终正文：缺了它，提交那一步会指名失败，而作者读到的
    // 是一次没有解释的拒绝。在入口就拒绝，错误离作者的动作最近。
    if kind == VerdictKindName::AcceptModified && final_text.is_none() {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "accept a modified proposal without its final text",
            proposal_id.to_owned(),
        ));
    }

    // 切片从领域层重建，不在这里推断：一次改写是两片，一次纯删除是一片，
    // 而「几片」这条规则只有 `Proposal` 知道。
    let proposal = crate::review::rebuild_proposal(&row)?;
    let mut batch = staged_ids(store, path)?;
    let mut decided = 0u32;
    for slice in proposal.slices() {
        if !slice.kind().is_changed() {
            continue;
        }
        let record = VerdictRecord {
            id: Id::new().to_string(),
            proposal_id: proposal_id.to_owned(),
            slice_id: format!("{}:{}", proposal_id, slice.id().ordinal()),
            kind,
            // 只有插入片承载改写后的正文；删除片带着它会被领域层拒绝。
            final_text: if slice.kind() == refrain_core::manuscript::SliceKind::Insert {
                final_text.clone()
            } else {
                None
            },
            reason: reason.clone(),
            decided_at: now(),
            legacy_baseline: None,
        };
        store.ledger().record(&record).map_err(|error| {
            RefrainError::new(ErrorCode::StateUnavailable, "record a verdict", path)
                .with_detail(error.to_string())
        })?;
        batch.push(record.id);
        decided += 1;
    }
    if decided == 0 {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "judge a proposal that changes nothing",
            proposal_id.to_owned(),
        ));
    }

    let batch_json = serde_json::to_string(&batch).map_err(|error| {
        RefrainError::new(ErrorCode::StateUnavailable, "write a review batch", path)
            .with_detail(error.to_string())
    })?;
    store
        .review_session_set(path, 0, &batch_json)
        .map_err(into_domain)?;

    let proposals = proposal_views(store, path)?;
    let staged = staged_proposal_ids(store, path)?;
    Ok(ProjectProposals { proposals, staged })
}

/// 提交这份文档暂存的裁决批次。
///
/// **裁决即落盘**（D1／F-01）：账本说「已接受」的那一刻磁盘必须同真。
/// `expected` 取自这份文档当前注册的戳——裁决没有比手工保存更多的权力去
/// 覆盖别人的改动，所以它走同一个 compare-and-swap。
fn commit_verdicts(entry: &mut ProjectEntry, path: &str) -> Result<DecisionReport, RefrainError> {
    let stamp = entry.store.open_document(path).map_err(into_domain)?.stamp;
    let mut manuscript = entry
        .manuscripts
        .get(path)
        .ok_or_else(|| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "commit verdicts on a document that is not open",
                path,
            )
        })?
        .clone();
    let outcome =
        crate::decide::commit_decision_batch(&mut entry.store, &mut manuscript, path, Some(stamp))?;
    let report = match outcome {
        crate::decide::DecisionOutcome::Durable { .. } => DecisionReport::Durable,
        crate::decide::DecisionOutcome::BodyDurable { detail, .. } => {
            DecisionReport::BodyDurable { detail }
        }
        // 冲突时不动内存里那一份：磁盘上的字节不是作者盖戳时看到的，
        // 把裁决结果留在内存会让界面显示一个盘上并不存在的正文。
        crate::decide::DecisionOutcome::Conflict { .. } => return Ok(DecisionReport::Conflict),
    };
    entry.manuscripts.insert(path.to_owned(), manuscript);
    Ok(report)
}

/// 一个 Root 的编排状态，按值取出。
///
/// **接上哪个功能**：步骤 7 的审阅、信箱、派发与 Run。
///
/// **在全局逻辑中负责什么**：`AgentHost` 借着 `ProjectStore` 活，出不了
/// `with_project` 的作用域；这是它跨界那一刻的形状。命令的执行仍在
/// `AgentHost::execute`，这里只承载结果。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshot {
    pub tasks: Vec<ReviewTask>,
    pub runs: Vec<Run>,
    pub authorizations: Vec<DispatchAuthorization>,
    pub runs_requiring_recovery: Vec<Id>,
    pub runs_awaiting_launch: Vec<Id>,
    /// 这个 Root 上一共有几个 Run，包括为了装进 ABI 而被丢掉的那些。
    ///
    /// **为什么不让界面数 `runs.len()`**：越界时 `truncate_output` 会丢最旧的
    /// Run，于是 `runs` 短于事实。界面数它得到的是「装得下的那些」，而作者
    /// 读成的是「一共这么多」——一个 Run 就此从他的世界里消失且无人报错。
    /// 由快照自己带上真实条数，截断因此变成可见事实而不是静默损失。
    pub run_total: usize,
}

impl ProjectOutput {
    /// Take the project a caller asked to open or create.
    ///
    /// Callers that name one `ProjectInput` already know which variant answers
    /// it. Without this the failure is rebuilt at every call site behind a
    /// catch-all arm, which also hides a new variant from review. The refusal
    /// belongs here, where the variant set is defined.
    pub fn into_opened(self, action: &'static str) -> Result<ProjectOpened, RefrainError> {
        match self {
            Self::Opened(project) => Ok(project),
            other => Err(other.mismatch(action, "a project")),
        }
    }

    /// Take the document row an import produced. Same contract as
    /// [`Self::into_opened`], for the two import inputs.
    pub fn into_imported(self, action: &'static str) -> Result<DocumentRow, RefrainError> {
        match self {
            Self::Imported(row) => Ok(row),
            other => Err(other.mismatch(action, "an imported document")),
        }
    }

    /// Name the variant that arrived, so a mismatch reports what the use case
    /// actually returned instead of only what was missing.
    fn mismatch(&self, action: &'static str, expected: &str) -> RefrainError {
        let arrived = match self {
            Self::Cancelled => "cancelled",
            Self::Opened(_) => "opened",
            Self::DocumentOpened(_) => "documentOpened",
            Self::Imported(_) => "imported",
            Self::Page(_) => "page",
            Self::Documents(_) => "documents",
            Self::Blocks(_) => "blocks",
            Self::Deleted(_) => "deleted",
            Self::DisclosureSet(_) => "disclosureSet",
            Self::Config(_) => "config",
            Self::Kara(_) => "kara",
            Self::Proposals(_) => "proposals",
            Self::Decided(_) => "decided",
            Self::Collected(_) => "collected",
            Self::Host(_) => "host",
            Self::Dispatched(_) => "dispatched",
            Self::Harnesses(_) => "harnesses",
            Self::History(_) => "history",
            Self::Annotations(_) => "annotations",
        };
        RefrainError::new(
            ErrorCode::StateUnavailable,
            action,
            format!("project use case returned {arrived}, not {expected}"),
        )
    }
}

/// Live handles for one adopted Root. The fields are temporarily visible to
/// the remaining legacy command groups. Each group removes its access when it
/// migrates; the adapter disappears after the seventh group.
pub struct ProjectEntry {
    pub store: ProjectStore,
    pub manuscripts: HashMap<String, Manuscript>,
}

pub struct Application {
    store: Mutex<ApplicationStore>,
    projects: Mutex<HashMap<String, Arc<Mutex<ProjectEntry>>>>,
    kara: Mutex<KaraMachine>,
    kara_policy: Mutex<KaraPolicy>,
    /// 设置的唯一写者与它最近一次快照。
    ///
    /// 收进这里而不是留在装配层：`ConfigStore::apply` 已经是唯一写者，
    /// 但此前它住在 Tauri 的 `lib.rs`，于是原生表面够不着同一份设置。
    /// 放在 `Application` 之后两个宿主读的是同一份，步骤 10 删掉 Tauri
    /// 也不会带走设置权威。
    config: Mutex<(ConfigStore, Config)>,
}

impl Application {
    pub fn open(data_dir: &Path) -> Result<Self, RefrainError> {
        Ok(Self {
            store: Mutex::new(ApplicationStore::open(data_dir).map_err(application_store_failure)?),
            projects: Mutex::new(HashMap::new()),
            kara: Mutex::new(KaraMachine::new()),
            kara_policy: Mutex::new(KaraPolicy {
                auto_enter_on_first_manuscript: true,
            }),
            config: Mutex::new({
                let (store, snapshot) = ConfigStore::load(data_dir).map_err(|error| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "load the config",
                        error.to_string(),
                    )
                })?;
                (store, snapshot.config)
            }),
        })
    }

    /// 当前设置。读的是缓存的快照，不重读文件——`apply` 是唯一写者，
    /// 它写盘的同时更新这里，两者不会分开。
    pub fn config(&self) -> Result<Config, RefrainError> {
        self.config.lock().map(|held| held.1.clone()).map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the config", "config")
        })
    }

    /// 改一项设置，返回改完之后的完整 Config。
    ///
    /// 校验、迁移、原子写盘与「拖动值与档位互斥」这类规则都在
    /// `ConfigStore::apply` 里，这里只保证盘上与内存里的那一份同时更新。
    pub fn apply_config(&self, change: ConfigChange) -> Result<Config, RefrainError> {
        let mut held = self.config.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the config", "config")
        })?;
        let snapshot = held.0.apply(change).map_err(|error| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "apply a config change",
                error.to_string(),
            )
        })?;
        held.1 = snapshot.config.clone();
        Ok(snapshot.config)
    }

    pub fn set_kara_policy(&self, policy: KaraPolicy) -> Result<(), RefrainError> {
        *self.kara_policy.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA policy", "kara")
        })? = policy;
        Ok(())
    }

    pub fn kara_step(&self, event: KaraEvent) -> Result<KaraTransition, RefrainError> {
        let policy = *self.kara_policy.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA policy", "kara")
        })?;
        let mut kara = self.kara.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA machine", "kara")
        })?;
        let transition = kara.step(event, policy);
        *kara = transition.machine.clone();
        Ok(transition)
    }

    pub fn kara_state(&self) -> Result<KaraMachine, RefrainError> {
        self.kara.lock().map(|kara| kara.clone()).map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA machine", "kara")
        })
    }

    fn rearm_kara(&self) -> Result<(), RefrainError> {
        self.kara
            .lock()
            .map_err(|_| {
                RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA machine", "kara")
            })?
            .auto_entry = KaraAutoEntry::Pending;
        Ok(())
    }

    pub fn project(
        &self,
        platform: &impl ProjectPlatform,
        input: ProjectInput,
    ) -> Result<ProjectOutput, RefrainError> {
        match input {
            ProjectInput::ChooseAndAdoptRoot { kind } => {
                let Some(path) = platform.choose_root(kind).map_err(|error| {
                    selected_path_failure(error, "choose a Root", "selected Root")
                })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                self.adopt(RootLocator { path, kind })
                    .map_err(|error| selected_path_failure(error, "adopt a Root", "selected Root"))
                    .map(ProjectOutput::Opened)
            }
            ProjectInput::ChooseAndCreateProject { name } => {
                if !is_legal_segment(&name) {
                    return Err(RefrainError::new(
                        ErrorCode::IllegalName,
                        "create a project",
                        name,
                    ));
                }
                let Some(parent) = platform.choose_project_parent().map_err(|error| {
                    selected_path_failure(error, "choose a project location", name.clone())
                })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                let path = parent.join(&name);
                let opened = (|| -> Result<ProjectOpened, RefrainError> {
                    if path.try_exists().map_err(|error| {
                        RefrainError::new(
                            ErrorCode::Io,
                            "check the project directory",
                            path.display().to_string(),
                        )
                        .with_detail(error.to_string())
                    })? {
                        return Err(RefrainError::new(
                            ErrorCode::Occupied,
                            "create a project at",
                            path.display().to_string(),
                        ));
                    }
                    fs::create_dir(&path).map_err(|error| {
                        RefrainError::new(
                            ErrorCode::Io,
                            "create the project directory",
                            path.display().to_string(),
                        )
                        .with_detail(error.to_string())
                    })?;
                    self.adopt(RootLocator {
                        path,
                        kind: RootKind::Folder,
                    })
                })()
                .map_err(|error| selected_path_failure(error, "create a project", name.clone()))?;
                Ok(ProjectOutput::Opened(opened))
            }
            ProjectInput::OpenDocument { root_id, path } => self
                .open_document(&root_id, &path)
                .map(Box::new)
                .map(ProjectOutput::DocumentOpened),
            ProjectInput::CreateDocument {
                root_id,
                title,
                role,
            } => self
                .create_document(&root_id, &title, role)
                .map(Box::new)
                .map(ProjectOutput::DocumentOpened),
            ProjectInput::ChooseAndImportMaterial { root_id } => {
                let Some(path) =
                    platform
                        .choose_import(ProjectImport::Material)
                        .map_err(|error| {
                            selected_path_failure(error, "choose a material", "selected material")
                        })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                self.import_material(&root_id, path)
                    .map(ProjectOutput::Imported)
            }
            ProjectInput::ChooseAndImportManuscript { root_id } => {
                let Some(path) =
                    platform
                        .choose_import(ProjectImport::Manuscript)
                        .map_err(|error| {
                            selected_path_failure(
                                error,
                                "choose a manuscript",
                                "selected manuscript",
                            )
                        })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                self.import_manuscript(&root_id, path)
                    .map(ProjectOutput::Imported)
            }
            ProjectInput::DocumentPage { root_id, after } => self
                .with_project(&root_id, |entry| {
                    entry
                        .store
                        .refresh_document_page(DocumentPageQuery {
                            after,
                            limit: MAX_DOCUMENT_PAGE_SIZE,
                        })
                        .map_err(into_domain)
                })
                .map(ProjectPage::from)
                .map(ProjectOutput::Page),
            ProjectInput::DocumentSearch {
                root_id,
                query,
                precision,
            } => self
                .with_project(&root_id, |entry| {
                    entry.store.search_documents_with(
                        &query,
                        precision.into(),
                        MAX_DOCUMENT_SEARCH_RESULTS,
                    )
                })
                .map(|documents| {
                    ProjectOutput::Documents(ProjectDocuments {
                        documents,
                        truncated: false,
                    })
                }),
            ProjectInput::BlockSearch {
                root_id,
                query,
                precision,
            } => self
                .with_project(&root_id, |entry| {
                    entry.store.search_blocks_with(
                        &query,
                        precision.into(),
                        MAX_DOCUMENT_SEARCH_RESULTS,
                    )
                })
                .map(|blocks| {
                    ProjectOutput::Blocks(ProjectBlocks {
                        blocks,
                        truncated: false,
                    })
                }),
            ProjectInput::DeleteDocument { root_id, path } => self
                .with_project(&root_id, |entry| {
                    let row = entry.store.delete_document(&path).map_err(into_domain)?;
                    entry.manuscripts.remove(&path);
                    Ok(row)
                })
                .map(ProjectOutput::Deleted),
            ProjectInput::ReadConfig => self
                .config()
                .map(|config| ProjectOutput::Config(Box::new(config))),
            ProjectInput::ChangeConfig(change) => self
                .apply_config(change)
                .map(|config| ProjectOutput::Config(Box::new(config))),
            ProjectInput::KaraStep(event) => self
                .kara_step(event)
                .map(|transition| ProjectOutput::Kara(Box::new(transition))),
            ProjectInput::ReadHost { root_id } => self
                .with_host(&root_id, |_| Ok(()))
                .map(|snapshot| ProjectOutput::Host(Box::new(snapshot))),
            ProjectInput::HostCommand { root_id, command } => self
                .with_host(&root_id, move |host| {
                    host.execute(*command).map_err(into_domain_host)
                })
                .map(|snapshot| ProjectOutput::Host(Box::new(snapshot))),
            ProjectInput::ReadHistory { root_id, path } => self
                .with_project(&root_id, |entry| {
                    crate::history::recent_history(&entry.store, &path)
                })
                .map(ProjectOutput::History),
            ProjectInput::Annotate {
                root_id,
                path,
                selected,
                body,
            } => self
                .with_project(&root_id, |entry| {
                    // 批注要把原文对回块 id，而块 id 只存在于打开着的那份
                    // 稿子里——与派发、收取同一条理由。
                    let manuscript = entry.manuscripts.get(&path).cloned().ok_or_else(|| {
                        RefrainError::new(
                            ErrorCode::StateUnavailable,
                            "annotate a manuscript that is not open",
                            path.clone(),
                        )
                    })?;
                    crate::history::annotate(
                        &mut entry.store,
                        &manuscript,
                        &path,
                        &selected,
                        body,
                        now() as i64,
                    )?;
                    crate::history::annotations_of(&entry.store, &path)
                })
                .map(ProjectOutput::Annotations),
            ProjectInput::ReadAnnotations { root_id, path } => self
                .with_project(&root_id, |entry| {
                    crate::history::annotations_of(&entry.store, &path)
                })
                .map(ProjectOutput::Annotations),
            // 不经 `with_project`：探测问的是这台机器，没有项目也该答得出。
            ProjectInput::ReadHarnesses => {
                Ok(ProjectOutput::Harnesses(crate::harness::probe_harnesses()))
            }
            ProjectInput::Dispatch { root_id, request } => self
                .with_project(&root_id, |entry| {
                    // 派发要把选中的原文对回块 id，而块 id 只存在于打开着的
                    // 那份稿子里——与收取同一条理由。稿子没打开就具名拒绝，
                    // 而不是拿磁盘上的字节顶替：那份可能已经被别处改过。
                    let manuscript = entry
                        .manuscripts
                        .get(&request.document)
                        .cloned()
                        .ok_or_else(|| {
                            RefrainError::new(
                                ErrorCode::StateUnavailable,
                                "dispatch a manuscript that is not open",
                                request.document.clone(),
                            )
                        })?;
                    let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
                    let mut host = AgentHost::open(
                        StoreJournal {
                            store: &mut entry.store,
                        },
                        context,
                    )
                    .map_err(into_domain_host)?;
                    crate::dispatch::dispatch(&mut host, &manuscript, &request)
                })
                .map(|dispatched| ProjectOutput::Dispatched(Box::new(dispatched))),
            ProjectInput::SetDisclosure {
                root_id,
                path,
                disclosure,
            } => self
                .with_project(&root_id, |entry| {
                    entry
                        .store
                        .set_disclosure(&path, disclosure)
                        .map_err(into_domain)
                })
                .map(ProjectOutput::DisclosureSet),
            ProjectInput::ReadProposals { root_id, path } => self
                .with_project(&root_id, |entry| {
                    let proposals = proposal_views(&entry.store, &path)?;
                    // 批次与提案一起读：分两次会让界面在两次答复之间画出
                    // 「这条判过了」而提案已经不在的矛盾状态。
                    let staged = staged_proposal_ids(&entry.store, &path)?;
                    Ok(ProjectProposals { proposals, staged })
                })
                .map(ProjectOutput::Proposals),
            ProjectInput::StageVerdict {
                root_id,
                path,
                proposal_id,
                kind,
                final_text,
                reason,
            } => self
                .with_project(&root_id, |entry| {
                    stage_verdict(
                        &mut entry.store,
                        &path,
                        &proposal_id,
                        kind,
                        final_text,
                        reason,
                    )
                })
                .map(ProjectOutput::Proposals),
            ProjectInput::CommitVerdicts { root_id, path } => self
                .with_project(&root_id, |entry| commit_verdicts(entry, &path))
                .map(ProjectOutput::Decided),
            ProjectInput::CollectRun { root_id, run_id } => {
                let run = run_id.parse::<Id>().map_err(|error| {
                    RefrainError::new(ErrorCode::StateUnavailable, "read a run id", run_id.clone())
                        .with_detail(error.to_string())
                })?;
                self.with_project(&root_id, |entry| {
                    // 收取要把冻结的原文对回块 id，而块 id 只存在于打开着的
                    // 那份稿子里——所以送进去的是当前打开的全部稿子。
                    let manuscripts = entry.manuscripts.clone();
                    let collected = crate::collect::collect_attempt(
                        &mut entry.store,
                        &manuscripts,
                        run,
                        now(),
                    )?;
                    Ok(match collected {
                        crate::collect::Collected::Waiting => CollectReport::Waiting,
                        crate::collect::Collected::Completed {
                            proposals,
                            memos,
                            drafts,
                        } => CollectReport::Completed {
                            proposals,
                            memos,
                            drafts,
                        },
                        crate::collect::Collected::Failed { code, detail } => {
                            CollectReport::Failed { code, detail }
                        }
                    })
                })
                .map(ProjectOutput::Collected)
            }
        }
    }

    fn open_document(&self, root_id: &str, path: &str) -> Result<OpenDocumentDto, RefrainError> {
        self.with_project(root_id, |entry| {
            let opened = entry
                .store
                .open_registered_document(path)
                .map_err(into_domain)?;
            entry.store.remember_landing(path).map_err(into_domain)?;
            let kara = self.manuscript_opened(opened.row.role, path)?;
            open_in_entry(entry, path, opened, kara)
        })
    }

    fn create_document(
        &self,
        root_id: &str,
        title: &str,
        role: DocumentRole,
    ) -> Result<OpenDocumentDto, RefrainError> {
        self.with_project(root_id, |entry| {
            let created = entry
                .store
                .create(&refrain_store::project::CreateDocument {
                    title: title.to_string(),
                    role,
                })
                .map_err(into_domain)?;
            let path = created.row.path.clone();
            let kara = self.manuscript_opened(role, &path)?;
            open_in_entry(entry, &path, created, kara)
        })
    }

    fn import_material(
        &self,
        root_id: &str,
        selected: PathBuf,
    ) -> Result<DocumentRow, RefrainError> {
        let source = chosen_file(selected).map_err(|error| {
            selected_path_failure(error, "import a material", "selected material")
        })?;
        let clone_dir = self.with_project(root_id, |entry| {
            Ok(entry.store.layout().source_backup_dir.join("materials"))
        })?;
        let clone_base = clone_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let prepared = refrain_store::materials::prepare_material_source(&source, &clone_dir)
            .map_err(into_domain)
            .map_err(|error| {
                selected_path_failure(error, "prepare a material", "selected material")
            })?;
        let ingested = prepared.material;
        let source_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("source");
        let clone_display = prepared
            .clone
            .strip_prefix(&clone_base)
            .unwrap_or(&prepared.clone)
            .display();
        let header = format!(
            "> 来源：{source_name}（{} · blake3 {}）；原件克隆：{clone_display}",
            ingested.format.as_str(),
            &ingested.source_digest[..12],
        );
        let body = format!("{header}\n\n{}", ingested.text);
        self.with_project(root_id, |entry| {
            let (row, _opened) = create_with_body(
                entry,
                &ingested.title,
                &body,
                DocumentRole::Material,
                Some(ImportedFrom {
                    digest: &ingested.source_digest,
                    format: ingested.format.as_str(),
                }),
                None,
            )?;
            Ok(row)
        })
    }

    fn import_manuscript(
        &self,
        root_id: &str,
        selected: PathBuf,
    ) -> Result<DocumentRow, RefrainError> {
        let source = chosen_file(selected).map_err(|error| {
            selected_path_failure(error, "import a manuscript", "selected manuscript")
        })?;
        let bytes = refrain_store::ingest::read_source(&source).map_err(|error| {
            selected_path_failure(error, "read an imported manuscript", "selected manuscript")
        })?;
        let text_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let text = String::from_utf8(text_bytes.to_vec()).map_err(|_| {
            RefrainError::new(
                ErrorCode::UnsupportedFormat,
                "read an imported manuscript",
                "not UTF-8 text",
            )
        })?;
        let title = source
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.is_empty())
            .unwrap_or("拖入")
            .to_string();
        self.with_project(root_id, |entry| {
            let kara = self.manuscript_opened(DocumentRole::Chapter, &title)?;
            let (row, _opened) =
                create_with_body(entry, &title, &text, DocumentRole::Chapter, None, kara)?;
            Ok(row)
        })
    }

    pub fn commit_material_action(
        &self,
        root_id: &str,
        draft_id: &str,
        edited_body: Option<String>,
        dismiss: bool,
    ) -> Result<Option<DocumentRow>, RefrainError> {
        self.with_project(root_id, |entry| {
            let draft = entry
                .store
                .material_drafts()
                .map_err(into_domain)?
                .into_iter()
                .find(|row| row.id == draft_id)
                .ok_or_else(|| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "resolve a draft",
                        "no such draft",
                    )
                })?;
            if dismiss {
                entry
                    .store
                    .material_draft_take(draft_id)
                    .map_err(into_domain)?;
                return Ok(None);
            }

            let body = edited_body.unwrap_or_else(|| draft.body.clone());
            let (row, _opened) = create_with_body(
                entry,
                &draft.title,
                &body,
                DocumentRole::Material,
                None,
                None,
            )?;
            entry
                .store
                .material_draft_take(draft_id)
                .map_err(into_domain)?;
            Ok(Some(row))
        })
    }

    fn manuscript_opened(
        &self,
        role: DocumentRole,
        subject: &str,
    ) -> Result<Option<KaraTransition>, RefrainError> {
        if !matches!(role, DocumentRole::Document | DocumentRole::Chapter) {
            return Ok(None);
        }
        let auto_entry = self.kara_state()?.auto_entry;
        self.kara_step(KaraEvent::FirstManuscriptOpened(auto_entry))
            .map(Some)
            .map_err(|mut error| {
                error.subject = subject.to_string();
                error
            })
    }

    /// 在一个 Root 上开一次编排，跑一条命令，取出快照。
    ///
    /// **接上哪个功能**：步骤 7 的全部 Run 与审阅动作。
    ///
    /// **在全局逻辑中负责什么**：`AgentHost` 借着 `ProjectStore` 活，所以它
    /// 只能在这一层里存在。读与写走同一条路径——读传一个空闭包——两者因此
    /// 不会看到不同的状态。
    ///
    /// **能复用什么**：命令集合归 `HostCommand`，这里不列举它的变体，
    /// 新增一条命令不必改这个函数。
    fn with_host(
        &self,
        root_id: &str,
        run: impl FnOnce(&mut AgentHost<StoreJournal<'_>, DirectoryContext>) -> Result<(), RefrainError>,
    ) -> Result<HostSnapshot, RefrainError> {
        self.with_project(root_id, |entry| {
            let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
            let mut host = AgentHost::open(
                StoreJournal {
                    store: &mut entry.store,
                },
                context,
            )
            .map_err(into_domain_host)?;
            run(&mut host)?;
            let runs = host.runs().to_vec();
            Ok(HostSnapshot {
                tasks: host.tasks().to_vec(),
                // 截断发生在跨界那一层，所以真实条数要在这里记下——那之后
                // 就没人还知道原本有几个了。
                run_total: runs.len(),
                runs,
                authorizations: host.authorizations().to_vec(),
                runs_requiring_recovery: host.runs_requiring_recovery().to_vec(),
                runs_awaiting_launch: host.runs_awaiting_launch().to_vec(),
            })
        })
    }

    pub fn with_project<T>(
        &self,
        root_id: &str,
        use_entry: impl FnOnce(&mut ProjectEntry) -> Result<T, RefrainError>,
    ) -> Result<T, RefrainError> {
        let entry = {
            let projects = self.projects.lock().map_err(|_| {
                RefrainError::new(ErrorCode::StateUnavailable, "lock the project map", root_id)
            })?;
            Arc::clone(projects.get(root_id).ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "use a Root that is not open",
                    root_id,
                )
            })?)
        };
        let mut entry = entry.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the project", root_id)
        })?;
        use_entry(&mut entry)
    }

    fn adopt(&self, locator: RootLocator) -> Result<ProjectOpened, RefrainError> {
        let (mut store, backup) = self
            .store
            .lock()
            .map_err(|_| RefrainError::new(ErrorCode::StateUnavailable, "lock app.db", "adopt"))?
            .adopt(&locator)
            .map_err(application_store_failure)?;
        let root_id = store.permit().root_id.to_string();
        let page = store
            .refresh_document_page(DocumentPageQuery {
                after: None,
                limit: MAX_DOCUMENT_PAGE_SIZE,
            })
            .map_err(into_domain)?;
        let opened_path = store.landing_document().map_err(into_domain)?;
        self.projects
            .lock()
            .map_err(|_| {
                RefrainError::new(ErrorCode::StateUnavailable, "lock the project map", "adopt")
            })?
            .insert(
                root_id.clone(),
                Arc::new(Mutex::new(ProjectEntry {
                    store,
                    manuscripts: HashMap::new(),
                })),
            );
        self.rearm_kara()?;
        Ok(ProjectOpened {
            root_id,
            backup,
            documents: page.documents,
            document_total: page.total,
            document_cursor: page.next,
            opened_path,
        })
    }
}

fn chosen_file(path: PathBuf) -> Result<PathBuf, RefrainError> {
    let canonical = path.canonicalize().map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "use a chosen source",
            path.display().to_string(),
        )
        .with_detail(error.to_string())
    })?;
    if !canonical.is_file() {
        return Err(RefrainError::new(
            ErrorCode::UnsupportedFormat,
            "use a chosen source",
            canonical.display().to_string(),
        ));
    }
    Ok(canonical)
}

fn selected_path_failure(
    mut error: RefrainError,
    action: &'static str,
    safe_subject: impl Into<String>,
) -> RefrainError {
    error.action = action.to_string();
    error.subject = safe_subject.into();
    error.detail = None;
    error
}

fn application_store_failure(failure: ApplicationStoreError) -> RefrainError {
    match failure {
        ApplicationStoreError::Project(failure) => into_domain(failure),
        ApplicationStoreError::Io { path, source } => RefrainError::new(
            ErrorCode::Io,
            "open application storage",
            path.display().to_string(),
        )
        .with_detail(source.to_string()),
        ApplicationStoreError::Store(error) => RefrainError::new(
            ErrorCode::StateUnavailable,
            "open app.db",
            "application storage",
        )
        .with_detail(error.to_string()),
    }
}
