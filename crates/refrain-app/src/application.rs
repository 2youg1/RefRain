//! Application-level project use case.
//!
//! One exhaustive input owns project acquisition, catalog reads, search,
//! disclosure, and deletion. Platform code supplies only a chooser. Selected
//! paths enter Rust and never cross the Native or TypeScript boundary.

use crate::dispatch::DispatchRequest;
use crate::document::{ImportedFrom, OpenDocumentDto, create_with_body, open_in_entry};
use crate::journal::{StoreJournal, into_domain, into_domain_host, into_domain_store};
use crate::native_document::AnchorSource;
use refrain_core::block_shape::{BlockKind, BlockShape};
use refrain_core::chinese_index::Precision;
use refrain_core::material_listing::Disclosure;
use refrain_core::{Block, BlockScan, Id, SliceKind};
use refrain_core::{
    DocumentRole, ErrorCode, KaraAutoEntry, KaraEvent, KaraMachine, KaraPolicy, KaraTransition,
    Manuscript, QuietEvent, RefrainError, TextAction,
};
use refrain_host::host::{
    AgentHost, DispatchAuthorization, HostCommand, HostRefusal, ReviewTask, Run,
};
use refrain_host::staging::DirectoryContext;
use refrain_store::annotations::AnnotationKind;
use refrain_store::application::{ApplicationStore, ApplicationStoreError};
use refrain_store::config::{Config, ConfigChange, ConfigStore};
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::mailbox::MailboxBoxName;
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
    /// 读材料草稿的名录：Agent 交来的草稿，等待成稿或退回。
    ReadMaterialDrafts {
        root_id: String,
    },
    /// 成稿或退回一条材料草稿。`edited_body` 是作者改后的版本；
    /// `dismiss` 退回；`as_chapter` 直接提拔成正文（否则进资料区）。
    /// 答复是刷新后的草稿名录。
    CommitMaterialDraft {
        root_id: String,
        draft_id: String,
        edited_body: Option<String>,
        dismiss: bool,
        as_chapter: bool,
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
    /// 把一段正文在全角与半角之间转换。
    ///
    /// 送原文而不是块 id：块身份由 Rust 查（与派发同一条 `locate_scope`），
    /// 让界面送块 id 等于要求它先知道块怎么切。转换本身也在 Rust：正文
    /// 编辑在 Rust（INV-4、块身份、journal），把映射表放界面等于复制一份
    /// 字符规则（`refrain_core::text_width` 是唯一权威）。
    ConvertWidth {
        root_id: String,
        path: String,
        /// 作者框住的那段字，逐字节。全文级转换时留空。
        selected: String,
        /// true 转换整篇（命令面板入口），false 只转换选中的那段。
        whole_document: bool,
        /// "to-full"（半角转全角）或 "to-half"（全角转半角）。
        direction: String,
    },
    /// 探测本机装了哪些 Harness。
    ///
    /// 不带 Root：它问的是这台机器，不是这个项目。作者在「连接」那个
    /// 去处看见的是「我能连什么」，与他打开了哪个项目无关。
    /// 探测本机装了哪些 Harness。
    ///
    /// 不带 Root：它问的是这台机器，不是这个项目。作者在「连接」那个
    /// 去处看见的是「我能连什么」，与他打开了哪个项目无关。
    ///
    /// `force` 绕过 15 秒的探测缓存：自动读与「重新探测」按钮走同一条
    /// 消息，前者传 false、后者传 true——探测要起 2 秒级的 `--version`
    /// 子进程，不能让每次打开连接页都付这个钱。
    ReadHarnesses {
        force: bool,
    },
    /// 把生成的协议装进一个 harness 的 skill 目录（作者显式点击；这是
    /// Root 之外的唯一写路径，verify-write-path 注释已登记）。返回刷新
    /// 后的整份名单——徽章立刻显示新状态。
    InstallSkill {
        harness_id: String,
    },
    /// 派发一次改写请求：选中的范围 → 冻结的请求 → 若干个就绪的 Run。
    ///
    /// 与 `HostCommand` 分开是因为它不是一条编排命令，而是三条的序列，
    /// 中间两步各要上一步生成的东西（`task_id`、编译好的 `DispatchPackage`）。
    /// 界面拼不出那些，让它拼等于把领域顺序复制到 Zig 里。
    Dispatch {
        root_id: String,
        request: Box<DispatchRequest>,
    },
    /// 预览一次派发：定位范围、编译请求包、交出清单与 digest——不铸 Run。
    /// 送出时把这份 digest 带回（`DispatchRequest.expected_digest`），对不上
    /// 就是预览之后稿子或资料变了，派发具名拒绝。
    PreviewDispatch {
        root_id: String,
        request: Box<DispatchRequest>,
    },
    /// 读一份文档上待裁决的提案。裁决台的行来自这一条。
    ReadProposals {
        root_id: String,
        path: String,
    },
    /// 读一份打开着的稿子的块清单：派发台块段（`DispatchScope.blocks`）
    /// 的行来自这一条——界面按这里的块 id 指名范围，不自己猜切法。
    ///
    /// 列的是活 Manuscript（正在写的那份），不是磁盘字节：磁盘那份可能
    /// 已经被别处改过，而块 id 只在打开着的稿子上成立（与派发同一条理由）。
    ReadBlocks {
        root_id: String,
        path: String,
        /// 翻页游标：回从它起（含）的行，取值是上一页的 `next`；`None` 从头。
        after: Option<u32>,
        /// 一页最多几行，夹到 1..=100。
        count: u32,
    },
    /// 读这个项目的资料名录：派发台「这轮给 agent 读什么」的勾选行。
    ///
    /// 只有路径过河，档位不随请求走（与派发同一条纪律的读法半边）——
    /// 名录是唯一权威，界面照它画，勾选只回传路径。
    ReadMaterials {
        root_id: String,
    },
    /// 判了就落盘：记账与提交一次完成（裁决即落盘 D1）。
    ///
    /// 与 `StageVerdict` 分开：裁决台的逐条暂存是「先看看再一起落」，饭盒的
    /// 接受/退回是「判完回到写作」——顺序知识（先记后交）收在这里，界面
    /// 不自己串两步。
    JudgeVerdict {
        root_id: String,
        path: String,
        proposal_id: String,
        kind: VerdictKindName,
        /// `AcceptModified` 的最终正文。其余裁决不带它。
        final_text: Option<String>,
        reason: Option<String>,
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
    /// 手动发射一条已授权的 Run（2.11）。
    ///
    /// 与 `HostCommand` 分开：那条要调用方自己拼 workspace，而 workspace 的
    /// 组成只有一个权威（`staging::run_workspace`）——界面只点名 run，布局
    /// 由这里算。答复与读/执行编排同形（刷新后的 host 快照），deskHost 槽
    /// 与轮询链零新机制。状态门在 host，具名拒绝照常上抛（「等上游」是作者
    /// 要读到的实话）——只有自动路径（`launch_awaiting_runs`）才吞它。
    LaunchRun {
        root_id: String,
        run_id: Id,
    },
    /// 原生编辑完成一次保存：把刚落盘的动作链 reconcile 进 text_actions，
    /// 返回最新历史。视图与 `.refrain-state.json` 同一生灭——会话里没保存
    /// 的编辑两样都不是，历史表不假装记得它们。
    NativeSaved {
        root_id: String,
        path: String,
    },
    /// 读信箱：跨全部文档合并的提案，按作者的安排排好——Pin 优先、位次
    /// 次之、没人碰过的最后。弃置的不在内。
    ///
    /// `discarded` 为 true 时读回收站那份投影：弃置的单，最近弃置的在前。
    /// 两份投影而不是一份加过滤——作者看信箱时不该看见刚放弃的那批。
    ReadMailbox {
        root_id: String,
        discarded: bool,
    },
    /// Pin 或解 Pin 一单。Pin 是「这一单不参与后续排序」的陈述，两个
    /// 方向都是作者在说话，所以都持久。
    MailboxPin {
        root_id: String,
        entry_id: String,
        box_name: MailboxBoxName,
        pinned: bool,
    },
    /// 排一单在那一格里的位次。
    MailboxRank {
        root_id: String,
        entry_id: String,
        box_name: MailboxBoxName,
        rank: u32,
    },
    /// 交换两单的位次，一次事务。相邻交换是界面唯一需要的移动语义；
    /// 两条 `MailboxRank` 拼不出原子交换（中间态两单同位次、按时间排）。
    MailboxSwap {
        root_id: String,
        entry_id: String,
        other_id: String,
    },
    /// 弃置一单：软删除。提案行与账本一行不动（INV-4），取回走
    /// `MailboxRestore`。
    MailboxDiscard {
        root_id: String,
        entry_id: String,
        box_name: MailboxBoxName,
    },
    /// 取回一弃置的单。从没弃置过是空操作，不是错误——返回的仍是刷新
    /// 后的信箱。
    MailboxRestore {
        root_id: String,
        entry_id: String,
    },
    /// 对一组已合并的提案下冲销（逆向裁决）：账本 append 冲销记录，
    /// 正文在这份稿子里回退到冻结前的字节。
    ///
    /// 与 `CommitVerdicts` 同一条纪律（D1／F-01）：账本记下「已冲销」的
    /// 那一刻磁盘必须同真，否则重载后正文带着一笔已冲销的合并。落盘走
    /// 与手工保存同一个 compare-and-swap，冲突时原样交还（`Conflict`）。
    Countermand {
        root_id: String,
        path: String,
        proposal_ids: Vec<String>,
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

/// 块清单的一行：派发台块段按 `id` 指名范围。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBlockRow {
    /// 块 id（36 字节 uuid）。
    pub id: String,
    /// 第几块，从 0 起。
    pub ordinal: u32,
    /// 块种类线名，与索引库存的是同一个（`heading:N`／`fence`／`table`／
    /// `paragraph`——见 `block_kind_wire_name` 的镜像注释）。
    pub kind: String,
    /// 前 60 个字符的行预览（char 边界安全），不是截断的正文。
    pub peek: String,
    /// 正文的字符数。
    pub chars: u32,
}

/// 一份稿子的块清单，分页给出。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBlocks {
    pub blocks: Vec<DocumentBlockRow>,
    /// 还有剩余时，下一页从这个 ordinal 起（本页末行 ordinal+1）。
    pub next: Option<u32>,
}

/// 资料名录的一行：派发台勾选什么，界面要的只有这两列。
///
/// `disclosure` 是线名（kebab-case 词）或 null——名录里没设过档位时
/// 是 null，读法（默认 = 可检索）归界面；一个新档位不该改变这里的类型
/// 形状，所以不过 `Disclosure` 枚举本身。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MaterialRow {
    pub path: String,
    pub disclosure: Option<String>,
}

/// 这个项目的资料名录。超 ~200 行截尾并说清——装不下的答复会被
/// 跨界截断层丢尾，在这里截断，作者看到的是诚实的清单。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMaterials {
    pub materials: Vec<MaterialRow>,
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
    /// 一份打开着的稿子的块清单（分页）。与 `Blocks` 分开：那是搜索命中，
    /// 这是派发台块段的行——后者列的是活 Manuscript 的每一个块。
    DocumentBlocks(DocumentBlocks),
    /// 这个项目的资料名录：派发台「这轮给 agent 读什么」的勾选行。
    Materials(ProjectMaterials),
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
    /// 信箱的当前样子：跨全部文档的提案，安排过的在前，没人碰过的在后。
    /// 每个安排动作都返回刷新后的这一份——视图与事实同一生灭，与
    /// `NativeSaved` 返回历史同一纪律。
    Mailbox(Vec<crate::mailbox::MailboxEntryView>),
    /// 一次派发的预览：编译出的请求包（清单、digest、稳定前缀、请求原文）。
    /// 不含任何编排副作用——预览不铸 Run。
    DispatchPreview(Box<refrain_core::context_compiler::DispatchPackage>),
    /// 材料草稿名录的当前样子：读、成稿、退回共用这一份——动作答复即
    /// 刷新后的名录，界面不必再发一次读。
    MaterialDrafts(Vec<MaterialDraftView>),
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

/// 一条材料草稿在界面上的样子。body 随行走：行内编辑从它起笔，
/// 不必再发一次读。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MaterialDraftView {
    pub id: String,
    pub title: String,
    /// 草稿的种类（chapter-synopsis / character-profile / …），协议词汇。
    pub kind: String,
    /// 本轮给 Agent 的文档依据（文档@修订 的 JSON）。
    pub basis: String,
    pub body: String,
}

impl From<refrain_store::materials::MaterialDraftRow> for MaterialDraftView {
    fn from(row: refrain_store::materials::MaterialDraftRow) -> Self {
        Self {
            id: row.id,
            title: row.title,
            kind: row.kind,
            basis: row.basis,
            body: row.body,
        }
    }
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

/// 资料名录一页的行数上限：超过就截尾并置 `truncated`——装不下的答复
/// 会被跨界截断层丢尾，不如在这里截断并说清。
const MATERIALS_PAGE: usize = 200;

/// 一份打开着的稿子的块清单，按 ordinal 分页。
///
/// 行列的是活 Manuscript 的每一个块（空块也在——清单的职责是让界面能按
/// id 指名任何一个块，与搜索索引「空块不占行」的取舍不同）。`after` 是
/// 上一页 `next` 给出的游标：下一页**从它起（含）**；`next` 只在还有剩余
/// 时给出。
fn read_blocks(manuscript: &Manuscript, after: Option<u32>, count: u32) -> DocumentBlocks {
    let count = count.clamp(1, 100) as usize;
    let scan = manuscript.scan();
    let blocks = manuscript.head().blocks();
    let mut rows: Vec<DocumentBlockRow> = Vec::new();
    for (ordinal, block) in blocks.iter().enumerate() {
        let ordinal = ordinal as u32;
        // 翻页游标是「从这里起（含）」：跳过它之前的行。
        if after.is_some_and(|after| ordinal < after) {
            continue;
        }
        if rows.len() == count {
            break;
        }
        let text = block.text();
        rows.push(DocumentBlockRow {
            id: block.id().to_string(),
            ordinal,
            kind: block_kind_wire_name(scan, text),
            // 前 60 个字符：按 char 取，永远不会截在半个字上。
            peek: text.chars().take(60).collect(),
            chars: text.chars().count() as u32,
        });
    }
    // 还有剩余时，下一页从本页末行的下一个 ordinal 起。空页没有下一页。
    let next = rows
        .last()
        .and_then(|last| (last.ordinal as usize + 1 < blocks.len()).then_some(last.ordinal + 1));
    DocumentBlocks { blocks: rows, next }
}

/// 块种类的线名：与索引库存的是同一个词。
///
/// 词汇的唯一权威是 refrain-store 的 `search::kind_name`，但它是
/// pub(crate)，够不着——这里镜像一份。那份没有兜底臂（新 `BlockKind`
/// 必须逼出一个命名决定），镜像同样没有。kind 的判法与
/// `searchable_block` 同一条规则：Markdown 扫描按块自己的字节判形状，
/// Plain 扫描下 `#`、栅栏、表格行都是文字，一切是段落。
fn block_kind_wire_name(scan: BlockScan, text: &str) -> String {
    let kind = match scan {
        BlockScan::Markdown => BlockShape::of(text).kind,
        BlockScan::Plain => BlockKind::Paragraph,
    };
    match kind {
        BlockKind::Paragraph => "paragraph".to_string(),
        BlockKind::Heading(level) => format!("heading:{}", level.get()),
        BlockKind::Fence => "fence".to_string(),
        BlockKind::Table(_) => "table".to_string(),
    }
}

/// 增量带稿（`CarryMode::Diff`）的裁决行：这份文档账本里还成立的裁决，
/// 按决定先后排。其余带稿模式是空——旧载荷旧行为。
fn carry_changes(
    store: &ProjectStore,
    request: &crate::dispatch::DispatchRequest,
) -> Result<Vec<refrain_core::ChangeEntry>, RefrainError> {
    if request.carry != crate::dispatch::CarryMode::Diff {
        return Ok(Vec::new());
    }
    let records = store
        .ledger()
        .for_document(&request.document)
        .map_err(into_domain_store)?;
    Ok(crate::dispatch::verdict_changes(&records))
}

/// 收取成功后发射仍在等待的下游 Run。
///
/// **接上哪个功能**：接力（Follows）与校验（Verifies）下游的自动发射
/// （2.2 回迁）。v0.2.4 是界面在 collect 成功后逐个 `LaunchRun`；原生把
/// 它收进领域层——编排语义不该由界面串。
///
/// **在全局逻辑中负责什么**：只串次序，不判条件。能不能发射由 host 在
/// `LaunchRun` 入口判：`UpstreamNotTerminal`／`UpstreamWithoutArtifact`
/// 是「上游还没终态／还没有产出」，照常等待——吞掉不算失败；其余拒绝
/// 如实上抛。没发射成的 Run 留在 awaiting（host 只 retain 成功的）。
/// 发射成功的 Run 还要喂上游产出（与 `HostCommand` 路径同一个后续动作，
/// 无边的 Run 在 `feed_upstream` 里原样返回）。
///
/// 返回这一批发射出去的 Run：runner 据此分辨哪些 `Launching` 是本会话自己
/// 提升的。host 每开一次都把账上的 `Launching` 全数放进恢复名单（§8.2-5），
/// 没有这份返回，runner 刚提升的 Run 会被当成上一会话留下的残骸而不敢派发。
pub(crate) fn launch_awaiting_runs(entry: &mut ProjectEntry) -> Result<Vec<Id>, RefrainError> {
    let launched = {
        let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
        let mut host = AgentHost::open(
            StoreJournal {
                store: &mut entry.store,
            },
            context,
        )
        .map_err(into_domain_host)?;
        // 按值取出再逐个发射：`execute` 要 &mut host，迭代借用不能跨过它。
        let awaiting = host.runs_awaiting_launch().to_vec();
        let mut launched = Vec::new();
        for run_id in awaiting {
            let Some(agent_id) = host
                .runs()
                .iter()
                .find(|run| run.id == run_id)
                .map(|run| run.agent_id)
            else {
                continue;
            };
            // workspace 的组成只有一个权威（`staging::run_workspace`，布局
            // agents/<agent-id>/runs/<run-id>/）——这里与界面都经它命名，
            // 不各自 format!。
            let workspace = refrain_host::staging::run_workspace(agent_id, run_id);
            match host.execute(HostCommand::LaunchRun { run_id, workspace }) {
                Ok(()) => launched.push(run_id),
                Err(
                    HostRefusal::UpstreamNotTerminal { .. }
                    | HostRefusal::UpstreamWithoutArtifact { .. },
                ) => {}
                Err(refusal) => return Err(into_domain_host(refusal)),
            }
        }
        launched
    };
    // host 先放掉（它借着 &mut store）：喂上游会自己再开一份 host 来读边
    // 与工作区——与 HostCommand 路径同一条次序纪律，锁不嵌套。
    for run_id in &launched {
        crate::upstream::feed_upstream(&mut entry.store, *run_id)?;
    }
    Ok(launched)
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
    let Some(report) = decision_report(outcome) else {
        return Ok(DecisionReport::Conflict);
    };
    entry.manuscripts.insert(path.to_owned(), manuscript);
    Ok(report)
}

/// `DecisionOutcome` 跨界的形状。冲突时不交回内存里那一份：磁盘上的字节
/// 不是作者盖戳时看到的，留下裁决结果会让界面显示一个盘上并不存在的正文。
fn decision_report(outcome: crate::decide::DecisionOutcome) -> Option<DecisionReport> {
    match outcome {
        crate::decide::DecisionOutcome::Durable { .. } => Some(DecisionReport::Durable),
        crate::decide::DecisionOutcome::BodyDurable { detail, .. } => {
            Some(DecisionReport::BodyDurable { detail })
        }
        crate::decide::DecisionOutcome::Conflict { .. } => None,
    }
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
            Self::DocumentBlocks(_) => "documentBlocks",
            Self::Materials(_) => "materials",
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
            Self::Mailbox(_) => "mailbox",
            Self::MaterialDrafts(_) => "materialDrafts",
            Self::DispatchPreview(_) => "dispatchPreview",
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
    /// 生产者 runner（M9）的活动表：本机握着句柄的 Run。泵在 `ReadHost`
    /// 里跑——轮询链本来就在那里，零新机制。
    runner: Mutex<crate::runner::Runner>,
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
            runner: Mutex::new(crate::runner::Runner::default()),
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

    /// 推进这个 Root 的生产者 runner 一步（M9）。泵的全部规则在 `runner`
    /// 模块；这里只把三样东西交到同一个作用域：活动表、项目、设置。
    fn pump_runs(&self, root_id: &str) -> Result<crate::runner::PumpReport, RefrainError> {
        let config = self.config()?;
        let mut runner = self.runner.lock().map_err(|_| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "lock the producer runner",
                "runner",
            )
        })?;
        self.with_project(root_id, |entry| {
            crate::runner::pump(root_id, entry, &mut runner, &config, now())
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
            } => {
                let (documents, refreshed) = self.with_project(&root_id, |entry| {
                    let documents = entry.store.search_documents_with(
                        &query,
                        precision.into(),
                        MAX_DOCUMENT_SEARCH_RESULTS,
                    )?;
                    // 懒建索引的建成时刻：这次搜索把它从「待建」变成「已建」。
                    // 取走旗标，事实归安静事件。
                    Ok((documents, entry.store.take_index_built()))
                })?;
                if refreshed {
                    self.kara_step(KaraEvent::Quiet(QuietEvent::IndexRefreshed))?;
                }
                Ok(ProjectOutput::Documents(ProjectDocuments {
                    documents,
                    truncated: false,
                }))
            }
            ProjectInput::BlockSearch {
                root_id,
                query,
                precision,
            } => {
                let (blocks, refreshed) = self.with_project(&root_id, |entry| {
                    let blocks = entry.store.search_blocks_with(
                        &query,
                        precision.into(),
                        MAX_DOCUMENT_SEARCH_RESULTS,
                    )?;
                    Ok((blocks, entry.store.take_index_built()))
                })?;
                if refreshed {
                    self.kara_step(KaraEvent::Quiet(QuietEvent::IndexRefreshed))?;
                }
                Ok(ProjectOutput::Blocks(ProjectBlocks {
                    blocks,
                    truncated: false,
                }))
            }
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
            ProjectInput::ReadHost { root_id } => {
                // M9：泵先于快照。轮询链（runs_tick → readHost）因此把全部
                // 活动 Run 推进一步，答复里就是最新的编排事实。
                let report = self.pump_runs(&root_id)?;
                // 与 CollectRun 同一条事件纪律：Run 完成记 AgentCompleted，
                // 带来提案再记 ProposalArrived——runner 收的还是那条收取。
                for (_run, proposals) in &report.completed {
                    self.kara_step(KaraEvent::Quiet(QuietEvent::AgentCompleted))?;
                    if *proposals > 0 {
                        self.kara_step(KaraEvent::Quiet(QuietEvent::ProposalArrived))?;
                    }
                }
                self.with_host(&root_id, |_| Ok(()))
                    .map(|snapshot| ProjectOutput::Host(Box::new(snapshot)))
            }
            ProjectInput::ReadMaterialDrafts { root_id } => self
                .material_draft_views(&root_id)
                .map(ProjectOutput::MaterialDrafts),
            ProjectInput::CommitMaterialDraft {
                root_id,
                draft_id,
                edited_body,
                dismiss,
                as_chapter,
            } => {
                self.commit_material_action(
                    &root_id,
                    &draft_id,
                    edited_body,
                    dismiss,
                    if as_chapter {
                        DocumentRole::Chapter
                    } else {
                        DocumentRole::Material
                    },
                )?;
                // 答复即刷新后的名录：动作与视图同一生灭，界面不再发一次读。
                self.material_draft_views(&root_id)
                    .map(ProjectOutput::MaterialDrafts)
            }
            ProjectInput::HostCommand { root_id, command } => self
                .with_project(&root_id, move |entry| {
                    // LaunchRun 的另一半在 `upstream`：请求提升之后，把上游
                    // 产出喂进工作区里的那一份。只有这一条命令带这个后续动作。
                    let launched = match &*command {
                        HostCommand::LaunchRun { run_id, .. } => Some(*run_id),
                        HostCommand::DraftTask { .. }
                        | HostCommand::AuthorizeDispatch { .. }
                        | HostCommand::CompleteDispatch { .. }
                        | HostCommand::CollectAttempt { .. }
                        | HostCommand::FailRun { .. }
                        | HostCommand::CancelRun { .. }
                        | HostCommand::RetryRun { .. }
                        | HostCommand::CloseTask { .. } => None,
                    };
                    let snapshot = {
                        let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
                        let mut host = AgentHost::open(
                            StoreJournal {
                                store: &mut entry.store,
                            },
                            context,
                        )
                        .map_err(into_domain_host)?;
                        host.execute(*command).map_err(into_domain_host)?;
                        snapshot_of(&host)
                    };
                    // host 先放掉，store 才腾得出来：喂上游要重新打开一份
                    // host 来读边与 workspace。它改的是工作区里的 request.md，
                    // 不是编排状态，快照不受它影响。喂不进去不装没发生——一个
                    // 没读到上游的 Follows Run，与没有边的 Run 做的是同一件事。
                    if let Some(run_id) = launched {
                        crate::upstream::feed_upstream(&mut entry.store, run_id)?;
                    }
                    Ok(snapshot)
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
            ProjectInput::ConvertWidth {
                root_id,
                path,
                selected,
                whole_document,
                direction,
            } => {
                let convert: fn(&str) -> String = match direction.as_str() {
                    "to-full" => refrain_core::text_width::to_full_width,
                    "to-half" => refrain_core::text_width::to_half_width,
                    other => {
                        return Err(RefrainError::new(
                            ErrorCode::InvalidInput,
                            "convert text width",
                            format!("unknown direction {other:?}"),
                        ));
                    }
                };
                self.with_project(&root_id, |entry| {
                    // 与 Annotate 同一条理由：块身份由 Rust 查，而且只在
                    // 打开着的那份稿子里存在。
                    let manuscript = entry.manuscripts.get(&path).cloned().ok_or_else(|| {
                        RefrainError::new(
                            ErrorCode::StateUnavailable,
                            "convert a manuscript that is not open",
                            path.clone(),
                        )
                    })?;
                    // 选区块：整篇取全部，选区逐字节定位。与派发同一条
                    // `locate_scope`——重复的原文不替作者选（F-02）。
                    let block_ids: Vec<Id> = if whole_document {
                        manuscript.head().blocks().iter().map(Block::id).collect()
                    } else {
                        match crate::scope::locate_scope(&manuscript, &selected) {
                            crate::scope::ScopeLocation::Unique(blocks) => blocks,
                            crate::scope::ScopeLocation::Moved => {
                                return Err(RefrainError::new(
                                    ErrorCode::StateUnavailable,
                                    "convert a scope that is no longer in the manuscript",
                                    path,
                                ));
                            }
                            crate::scope::ScopeLocation::Ambiguous(candidates) => {
                                return Err(RefrainError::new(
                                    ErrorCode::StateUnavailable,
                                    "convert a scope whose text appears more than once",
                                    format!("{}: {} places", path, candidates.len()),
                                ));
                            }
                        }
                    };
                    // 待转换原文：选区逐字节；整篇用稿子自己的分隔符拼
                    // （与 locate_scope 同一来源），转换后按同一个 scan
                    // 重新切回块。
                    let source: String = if whole_document {
                        let join = std::str::from_utf8(manuscript.scan().separator())
                            .expect("separators are ASCII");
                        let mut joined = String::new();
                        for (index, block) in manuscript.head().blocks().iter().enumerate() {
                            if index > 0 {
                                joined.push_str(join);
                            }
                            joined.push_str(block.text());
                        }
                        joined
                    } else {
                        selected.clone()
                    };
                    let converted = convert(&source);
                    if converted == source {
                        // 定义域外（例如整段中文）转换不动一个字节；执行
                        // 会以 NothingChanged 拒绝，这里先给作者一句看得懂的。
                        return Err(RefrainError::new(
                            ErrorCode::InvalidInput,
                            "convert text width",
                            "nothing to convert",
                        ));
                    }
                    let base = manuscript.head().id().to_string();
                    crate::document::apply_editor_journaled(
                        entry,
                        &path,
                        crate::document::EditorActionDto {
                            base,
                            changes: vec![crate::document::EditorChangeDto::Replace {
                                blocks: block_ids.iter().map(Id::to_string).collect(),
                                text: Some(converted),
                            }],
                        },
                    )?;
                    crate::history::recent_history(&entry.store, &path)
                })
                .map(ProjectOutput::History)
            }
            ProjectInput::ReadAnnotations { root_id, path } => self
                .with_project(&root_id, |entry| {
                    crate::history::annotations_of(&entry.store, &path)
                })
                .map(ProjectOutput::Annotations),
            // 不经 `with_project`：探测问的是这台机器，没有项目也该答得出。
            ProjectInput::ReadHarnesses { force } => {
                let statuses = if force {
                    crate::harness::probe_harnesses_forced()
                } else {
                    crate::harness::probe_harnesses()
                };
                Ok(ProjectOutput::Harnesses(statuses))
            }
            ProjectInput::InstallSkill { harness_id } => crate::harness::install_skill(&harness_id)
                .map(ProjectOutput::Harnesses)
                .map_err(|detail| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "install the protocol",
                        &harness_id,
                    )
                    .with_detail(detail)
                }),
            ProjectInput::Dispatch { root_id, request } => {
                // 接续与协议装载的事实住在 Config 与工作区里，不在请求里：
                // 请求只带作者点的东西（范围、要求、勾选的资料路径）。
                let config = self.config()?;
                self.with_project(&root_id, |entry| {
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
                    // 资料、接续与装载的事实都要在 host 借走 store 之前查完。
                    let materials =
                        crate::dispatch::resolve_materials(&mut entry.store, &request.materials)?;
                    let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
                    let mut round =
                        crate::dispatch::round_facts(&config, &context, &request, materials)?;
                    // 增量带稿的裁决行也在借走之前查：它读的是账本。
                    round.changes = carry_changes(&entry.store, &request)?;
                    let mut host = AgentHost::open(
                        StoreJournal {
                            store: &mut entry.store,
                        },
                        context,
                    )
                    .map_err(into_domain_host)?;
                    crate::dispatch::dispatch(&mut host, &manuscript, &request, &round)
                })
                .map(|dispatched| ProjectOutput::Dispatched(Box::new(dispatched)))
            }
            ProjectInput::PreviewDispatch { root_id, request } => {
                // 与 `Dispatch` 同一批事实、同一份顺序知识（`prepare_package`），
                // 但不碰编排状态——预览不铸 Run。
                let config = self.config()?;
                self.with_project(&root_id, |entry| {
                    let manuscript = entry
                        .manuscripts
                        .get(&request.document)
                        .cloned()
                        .ok_or_else(|| {
                            RefrainError::new(
                                ErrorCode::StateUnavailable,
                                "preview a dispatch on a manuscript that is not open",
                                request.document.clone(),
                            )
                        })?;
                    let materials =
                        crate::dispatch::resolve_materials(&mut entry.store, &request.materials)?;
                    let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
                    let mut round =
                        crate::dispatch::round_facts(&config, &context, &request, materials)?;
                    // 与 `Dispatch` 同一份装配：预览看到的包与送出的是同一条
                    // 规则算出来的，增量带稿的裁决行也不例外。
                    round.changes = carry_changes(&entry.store, &request)?;
                    crate::dispatch::preview(&manuscript, &request, &round)
                })
                .map(|package| ProjectOutput::DispatchPreview(Box::new(package)))
            }
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
            ProjectInput::ReadBlocks {
                root_id,
                path,
                after,
                count,
            } => self
                .with_project(&root_id, |entry| {
                    // 清单列的是正在写的那份：没打开就具名拒绝，而不是拿
                    // 磁盘上的字节顶替——那份可能已经被别处改过，而且块 id
                    // 只在打开着的稿子上成立（与 Dispatch 同一条理由）。
                    let manuscript = entry.manuscripts.get(&path).ok_or_else(|| {
                        RefrainError::new(
                            ErrorCode::StateUnavailable,
                            "list blocks of a document that is not open",
                            path.clone(),
                        )
                    })?;
                    Ok(read_blocks(manuscript, after, count))
                })
                .map(ProjectOutput::DocumentBlocks),
            ProjectInput::ReadMaterials { root_id } => self
                .with_project(&root_id, |entry| {
                    let catalog = entry.store.documents()?;
                    let mut materials: Vec<MaterialRow> = catalog
                        .iter()
                        .filter(|row| row.role == DocumentRole::Material)
                        .map(|row| MaterialRow {
                            path: row.path.clone(),
                            // 线名过河，枚举不过河：一个新档位不该改变这里
                            // 的类型形状。没设过档位是 null（默认档的读法
                            // 归界面，与 `unwrap_or_default` 同一个答案）。
                            disclosure: row.disclosure.map(|tier| tier.as_str().to_string()),
                        })
                        .collect();
                    // 超一页截尾并说清：装不下的答复会被跨界截断层丢尾，
                    // 在这里截断，作者看到的是诚实的清单。
                    let truncated = materials.len() > MATERIALS_PAGE;
                    materials.truncate(MATERIALS_PAGE);
                    Ok(ProjectMaterials {
                        materials,
                        truncated,
                    })
                })
                .map(ProjectOutput::Materials),
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
            ProjectInput::JudgeVerdict {
                root_id,
                path,
                proposal_id,
                kind,
                final_text,
                reason,
            } => self
                .with_project(&root_id, |entry| {
                    // 先记后交：账本只增，所以次序不能反。饭盒的接受/退回
                    // 走这条——判完即落盘，作者回到写作。
                    stage_verdict(
                        &mut entry.store,
                        &path,
                        &proposal_id,
                        kind,
                        final_text,
                        reason,
                    )?;
                    commit_verdicts(entry, &path)
                })
                .map(ProjectOutput::Decided),
            ProjectInput::NativeSaved { root_id, path } => {
                let history = self.with_project(&root_id, |entry| {
                    let file = entry.store.document_file(&path).map_err(into_domain)?;
                    let state_path = file.with_extension("refrain-state.json");
                    if let Some(chain) =
                        crate::native_document::read_saved_chain(&file, &state_path).map_err(
                            |error| {
                                RefrainError::new(
                                    ErrorCode::Io,
                                    "read the saved native chain",
                                    path.clone(),
                                )
                                .with_detail(error.to_string())
                            },
                        )?
                    {
                        // 每个动作的 head 是下一个动作的 base；末动作指向刚
                        // 保存的 head。链式联结是 `chain()` 能回溯的依据。
                        let heads = chain
                            .actions
                            .iter()
                            .map(|action| action.base())
                            .skip(1)
                            .chain([chain.head]);
                        for (action, head) in chain.actions.iter().zip(heads) {
                            if !entry
                                .store
                                .action_history()
                                .contains(&path, action.id())
                                .map_err(into_domain_store)?
                            {
                                entry
                                    .store
                                    .action_history()
                                    .record(&path, action, head)
                                    .map_err(into_domain_store)?;
                            }
                        }
                        // 活链是动作 id，不是块 id——sync_chain 按动作 id 判
                        // 「还在不在链上」，与 document.rs:334 的表内同步同一口径。
                        let live: Vec<Id> = chain.actions.iter().map(TextAction::id).collect();
                        entry
                            .store
                            .action_history()
                            .sync_chain(&path, &live)
                            .map_err(into_domain_store)?;
                    }
                    crate::history::recent_history(&entry.store, &path)
                })?;
                // 安静事件：保存成功。事实在领域发生处落地，不经视图转述——
                // 离场小结带读的是机器里的队列，不是界面的记忆。
                self.kara_step(KaraEvent::Quiet(QuietEvent::SaveSucceeded))?;
                Ok(ProjectOutput::History(history))
            }
            ProjectInput::ReadMailbox { root_id, discarded } => self
                .with_project(&root_id, |entry| {
                    if discarded {
                        crate::mailbox::discarded(&entry.store)
                    } else {
                        crate::mailbox::entries(&entry.store)
                    }
                })
                .map(ProjectOutput::Mailbox),
            ProjectInput::MailboxPin {
                root_id,
                entry_id,
                box_name,
                pinned,
            } => self
                .with_project(&root_id, |entry| {
                    entry
                        .store
                        .mailbox()
                        .set_pinned(&entry_id, box_name, pinned, now())
                        .map_err(into_domain_store)?;
                    crate::mailbox::entries(&entry.store)
                })
                .map(ProjectOutput::Mailbox),
            ProjectInput::MailboxRank {
                root_id,
                entry_id,
                box_name,
                rank,
            } => self
                .with_project(&root_id, |entry| {
                    entry
                        .store
                        .mailbox()
                        .set_rank(&entry_id, box_name, rank, now())
                        .map_err(into_domain_store)?;
                    crate::mailbox::entries(&entry.store)
                })
                .map(ProjectOutput::Mailbox),
            ProjectInput::MailboxSwap {
                root_id,
                entry_id,
                other_id,
            } => self
                .with_project(&root_id, |entry| {
                    entry
                        .store
                        .mailbox()
                        .swap_ranks(&entry_id, &other_id, now())
                        .map_err(into_domain_store)?;
                    crate::mailbox::entries(&entry.store)
                })
                .map(ProjectOutput::Mailbox),
            ProjectInput::MailboxDiscard {
                root_id,
                entry_id,
                box_name,
            } => self
                .with_project(&root_id, |entry| {
                    entry
                        .store
                        .mailbox()
                        .discard(&entry_id, box_name, now())
                        .map_err(into_domain_store)?;
                    crate::mailbox::entries(&entry.store)
                })
                .map(ProjectOutput::Mailbox),
            ProjectInput::MailboxRestore { root_id, entry_id } => self
                .with_project(&root_id, |entry| {
                    // 从没弃置过的单改 0 行——空操作，不是错误。照常返回
                    // 刷新后的信箱。
                    entry
                        .store
                        .mailbox()
                        .restore(&entry_id, now())
                        .map_err(into_domain_store)?;
                    crate::mailbox::entries(&entry.store)
                })
                .map(ProjectOutput::Mailbox),
            ProjectInput::Countermand {
                root_id,
                path,
                proposal_ids,
            } => self
                .with_project(&root_id, |entry| {
                    // 与 commit_verdicts 同一条纪律：冲销要在稿子里定位
                    // 当初合并进去的字节，而块 id 只在打开着的那份稿子上
                    // 成立；落盘走同一个 compare-and-swap（D1）。
                    let stamp = entry.store.open_document(&path).map_err(into_domain)?.stamp;
                    let mut manuscript =
                        entry.manuscripts.get(&path).cloned().ok_or_else(|| {
                            RefrainError::new(
                                ErrorCode::StateUnavailable,
                                "countermand in a document that is not open",
                                path.clone(),
                            )
                        })?;
                    let outcome = crate::decide::countermand_proposals(
                        &mut entry.store,
                        &mut manuscript,
                        &path,
                        &proposal_ids,
                        Some(stamp),
                        now(),
                    )?;
                    let Some(report) = decision_report(outcome) else {
                        return Ok(DecisionReport::Conflict);
                    };
                    entry.manuscripts.insert(path.clone(), manuscript);
                    Ok(report)
                })
                .map(ProjectOutput::Decided),
            ProjectInput::CollectRun { root_id, run_id } => {
                let run = run_id.parse::<Id>().map_err(|error| {
                    RefrainError::new(ErrorCode::StateUnavailable, "read a run id", run_id.clone())
                        .with_detail(error.to_string())
                })?;
                let report = self.with_project(&root_id, |entry| {
                    // 收取要把冻结的原文对回块 id，而块 id 只存在于打开着的
                    // 那份稿子里——所以送进去的是当前打开的全部稿子。
                    let manuscripts = entry.manuscripts.clone();
                    let collected = crate::collect::collect_attempt(
                        &mut entry.store,
                        &manuscripts,
                        run,
                        now(),
                    )?;
                    // 收取成功才发射等待中的下游：Waiting 什么都不发射。
                    if matches!(collected, crate::collect::Collected::Completed { .. }) {
                        launch_awaiting_runs(entry)?;
                    }
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
                })?;
                // 安静事件：Run 完成记 AgentCompleted；带来提案再记
                // ProposalArrived——两个事实，两种分量。
                if let CollectReport::Completed { proposals, .. } = &report {
                    self.kara_step(KaraEvent::Quiet(QuietEvent::AgentCompleted))?;
                    if *proposals > 0 {
                        self.kara_step(KaraEvent::Quiet(QuietEvent::ProposalArrived))?;
                    }
                }
                Ok(ProjectOutput::Collected(report))
            }
            ProjectInput::LaunchRun { root_id, run_id } => self
                .with_project(&root_id, move |entry| {
                    let snapshot = {
                        let context = DirectoryContext::new(entry.store.layout().state_dir.clone());
                        let mut host = AgentHost::open(
                            StoreJournal {
                                store: &mut entry.store,
                            },
                            context,
                        )
                        .map_err(into_domain_host)?;
                        // workspace 的组成只有一个权威（`staging::run_workspace`，
                        // 布局 agents/<agent-id>/runs/<run-id>/）——与自动发射
                        // 同一个算式，不各自 format!。
                        let Some(agent_id) = host
                            .runs()
                            .iter()
                            .find(|run| run.id == run_id)
                            .map(|run| run.agent_id)
                        else {
                            return Err(into_domain_host(HostRefusal::UnknownRun(run_id)));
                        };
                        let workspace = refrain_host::staging::run_workspace(agent_id, run_id);
                        // 状态门在 host：Upstream* 与其他拒绝都具名上抛——手动
                        // 发射时「等上游」是作者要读到的实话，只有自动路径才吞。
                        host.execute(HostCommand::LaunchRun { run_id, workspace })
                            .map_err(into_domain_host)?;
                        snapshot_of(&host)
                    };
                    // host 先放掉（它借着 &mut store）：喂上游会自己再开一份
                    // host 来读边与工作区——与 HostCommand 路径同一条次序纪律，
                    // 锁不嵌套。
                    crate::upstream::feed_upstream(&mut entry.store, run_id)?;
                    Ok(snapshot)
                })
                .map(|snapshot| ProjectOutput::Host(Box::new(snapshot))),
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

    /// 成稿或退回一条材料草稿。`role` 只接受 `Material`（收进资料区）与
    /// `Chapter`（直接提拔成正文）——后者过 `manuscript_opened`，首份正文
    /// 的 KARA 自动进场因此与拖入文件同一条路径。
    pub fn commit_material_action(
        &self,
        root_id: &str,
        draft_id: &str,
        edited_body: Option<String>,
        dismiss: bool,
        role: DocumentRole,
    ) -> Result<Option<DocumentRow>, RefrainError> {
        if !matches!(role, DocumentRole::Material | DocumentRole::Chapter) {
            return Err(RefrainError::new(
                ErrorCode::StateUnavailable,
                "commit a material draft as",
                format!("{role:?}"),
            ));
        }
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
            let kara = self.manuscript_opened(role, &draft.title)?;
            let (row, _opened) = create_with_body(entry, &draft.title, &body, role, None, kara)?;
            entry
                .store
                .material_draft_take(draft_id)
                .map_err(into_domain)?;
            Ok(Some(row))
        })
    }

    /// 材料草稿名录：等待成稿或退回的全部草稿。成稿与退回的答复就是
    /// 刷新后的这一份——视图与事实同一生灭（与信箱动作同一纪律）。
    pub fn material_draft_views(
        &self,
        root_id: &str,
    ) -> Result<Vec<MaterialDraftView>, RefrainError> {
        self.with_project(root_id, |entry| {
            Ok(entry
                .store
                .material_drafts()
                .map_err(into_domain)?
                .into_iter()
                .map(MaterialDraftView::from)
                .collect())
        })
    }

    /// 原生表面的锚定来源：这份文档的批注与待裁决提案。
    ///
    /// 待裁决 = 账本里还没有这个提案的任何裁决行。候选在提交后仍留在表里
    /// 供审计（SPEC 7.4），所以「还在表里」不等于「还没判」——判过的提案
    /// 不该再往正文上钉印点。批注直接读行（要带块内区间，不走
    /// `AnnotationView`——那是给名录界面的，丢了 start/end）。
    ///
    /// 解析规则（块没了、原文对不上、候选全落空→省略）在
    /// `native_document::DocumentSurface::anchored_ranges`，这里只收集来源。
    pub fn native_anchor_sources(
        &self,
        root_id: &str,
        relative: &str,
    ) -> Result<Vec<AnchorSource>, RefrainError> {
        self.with_project(root_id, |entry| {
            let mut sources = Vec::new();
            for row in entry.store.annotations(relative).map_err(into_domain)? {
                sources.push(AnchorSource::Annotation {
                    id: row.id,
                    block_id: row.block_id,
                    start: u64::from(row.start),
                    end: u64::from(row.end),
                    quote: row.quote,
                    comment: matches!(row.kind, AnnotationKind::Comment),
                });
            }
            let verdicts = entry
                .store
                .ledger()
                .for_document(relative)
                .map_err(into_domain_store)?;
            let decided: std::collections::HashSet<&str> = verdicts
                .iter()
                .map(|row| row.proposal_id.as_str())
                .collect();
            for row in entry.store.proposals_for(relative).map_err(into_domain)? {
                if decided.contains(row.id.as_str()) {
                    continue;
                }
                // scope 是块 id 的 JSON 数组（SPEC 9.7 的冻结格式）；多块提案
                // 只锚第一个块——多块锚定是 v0.3.0 之后的取舍。
                let Ok(scopes) = serde_json::from_str::<Vec<String>>(&row.scope) else {
                    continue;
                };
                let Some(block_id) = scopes.into_iter().next() else {
                    continue;
                };
                let Ok(proposal) = crate::review::rebuild_proposal(&row) else {
                    continue;
                };
                let candidates = proposal
                    .slices()
                    .iter()
                    .filter(|slice| matches!(slice.kind(), SliceKind::Same | SliceKind::Delete))
                    .map(|slice| slice.text().to_string())
                    .collect();
                sources.push(AnchorSource::Proposal {
                    id: row.id.clone(),
                    block_id,
                    candidates,
                });
            }
            Ok(sources)
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
}

/// 一个 Root 的编排状态，从 host 按值取出。
///
/// `with_host` 与 `HostCommand` 入口共用：快照的形状只有一个权威，两边
/// 各写一份，加字段时就会只改到一处。
fn snapshot_of(host: &AgentHost<StoreJournal<'_>, DirectoryContext>) -> HostSnapshot {
    let runs = host.runs().to_vec();
    HostSnapshot {
        tasks: host.tasks().to_vec(),
        // 截断发生在跨界那一层，所以真实条数要在这里记下——那之后
        // 就没人还知道原本有几个了。
        run_total: runs.len(),
        runs,
        authorizations: host.authorizations().to_vec(),
        runs_requiring_recovery: host.runs_requiring_recovery().to_vec(),
        runs_awaiting_launch: host.runs_awaiting_launch().to_vec(),
    }
}

impl Application {
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
            Ok(snapshot_of(&host))
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
