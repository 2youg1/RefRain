// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! W5「project channel」的词汇：作者能问什么，以及能得到什么答复。
//!
//! # 接上哪个功能
//!
//! 全部。原生宿主把一次动作编成一条 [`ProjectInput`]，路由（`application`）
//! 交给持有那条规则的用例模块，答复装成一条 [`ProjectOutput`] 回去。
//!
//! # 这一层持有的不变量
//!
//! **一条链路一份词汇。** 输入集合是穷尽的，答复集合是有界的：新增一种动作
//! 必须在这里留下名字，因此没有第二条路能走到用例层。跨界的类型形状由
//! serde 与 specta 从这里生成，两侧不各写一份。
//!
//! **答复的类型住在产出它的模块里。** `Mailbox` 是 `mailbox` 的，`Decided`
//! 是 `decide` 的——这里只列举，不定义。答复形状与产出它的规则同处一地，
//! 加一列时只改一个文件。
//!
//! # 能复用什么
//!
//! [`ProjectOutput::into_opened`] 与 [`ProjectOutput::into_imported`]：调用方
//! 点名一条输入时已经知道哪个变体回答它，拒绝的措辞因此收在变体集合定义处，
//! 而不是在每个调用点后面各写一条兜底臂。

use refrain_core::context_compiler::DispatchPackage;
use refrain_core::material_listing::Disclosure;
use refrain_core::{DocumentRole, ErrorCode, Id, KaraEvent, KaraTransition, RefrainError};
use refrain_host::host::HostCommand;
use refrain_store::config::{Config, ConfigChange};
use refrain_store::ledger::VerdictKindName;
use refrain_store::mailbox::MailboxBoxName;
use refrain_store::project::DocumentRow;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::collect::CollectReport;
use crate::decide::DecisionReport;
use crate::dispatch::{DispatchRequest, Dispatched};
use crate::document::OpenDocumentDto;
use crate::harness::HarnessStatus;
use crate::history::{AnnotationView, HistoryEntry};
use crate::host_session::HostSnapshot;
use crate::mailbox::MailboxEntryView;
use crate::materials::{MaterialDraftView, ProjectMaterials};
use crate::review::ProjectProposals;
use crate::root::{ProjectOpened, ProjectPage, RootKind};
use crate::scope::DocumentBlocks;
use crate::search::{ProjectBlocks, ProjectDocuments, SearchPrecision};

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
    /// 要读到的实话）——只有自动路径（`host_session::launch_awaiting`）才吞它。
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

/// 一条输入的全部可能答复。
///
/// 每个变体的类型住在产出它的用例模块里——`Mailbox` 是 `mailbox` 的，
/// `Decided` 是 `decide` 的。答复形状与产出它的规则同处一地，加一列时只改
/// 一个文件。
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
    History(Vec<HistoryEntry>),
    /// 一份文档上的批注。
    Annotations(Vec<AnnotationView>),
    /// 本机 Harness 的名单与各自的状况。
    Harnesses(Vec<HarnessStatus>),
    /// 一次派发的结果：铸出了哪些 Run，请求的摘要与稳定前缀。
    ///
    /// 与 `Host` 分开：编排快照回答「现在有哪些 Run」，这一条回答「刚才这次
    /// 派发做出了什么」。合成一个，界面就要从整张名录里猜哪几行是新的。
    Dispatched(Box<Dispatched>),
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
    Mailbox(Vec<MailboxEntryView>),
    /// 一次派发的预览：编译出的请求包（清单、digest、稳定前缀、请求原文）。
    /// 不含任何编排副作用——预览不铸 Run。
    DispatchPreview(Box<DispatchPackage>),
    /// 材料草稿名录的当前样子：读、成稿、退回共用这一份——动作答复即
    /// 刷新后的名录，界面不必再发一次读。
    MaterialDrafts(Vec<MaterialDraftView>),
}

impl ProjectOutput {
    /// Take the project a caller asked to open or create.
    ///
    /// Callers that name one `ProjectInput` already know which variant answers
    /// it. Without this the failure is rebuilt at every call site behind a
    /// catch-all arm, which also hides a new variant from review. The refusal
    /// belongs here, where the variant set is defined.
    ///
    /// # Errors
    ///
    /// Any other variant, naming the one that arrived.
    pub fn into_opened(self, action: &'static str) -> Result<ProjectOpened, RefrainError> {
        match self {
            Self::Opened(project) => Ok(project),
            other => Err(other.mismatch(action, "a project")),
        }
    }

    /// Take the document row an import produced. Same contract as
    /// [`Self::into_opened`], for the two import inputs.
    ///
    /// # Errors
    ///
    /// Any other variant, naming the one that arrived.
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
