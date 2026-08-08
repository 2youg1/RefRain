//! Use cases: the multi-step flows that need both the store and the host.
//!
//! 这个 crate 存在的理由，是有几条流程既不是纯领域、也不只是持久化或编排。收取
//! 一次派发结果要读回冻结的请求、按契约校验、映射到当前打开的稿子，再分三步写
//! 进 host 与 store——它此前是 `lib.rs` 里一个 183 行的命令体，除了开一个 Tauri
//! 窗口以外没有别的办法验证它。
//!
//! 这里不认识 Tauri。
//!
//! 也不写 unsafe：这个 crate 全是流程编排与领域判断，没有 FFI、没有裸指针、
//! 没有需要绕过借用检查的数据结构。`forbid` 让这句话由编译器执行，而不是
//! 靠下一个人读到这段注释。产品里唯一一处 unsafe 在 `display.rs` 的 Win32
//! 调用，那里没有安全封装可用；`verify:unsafe-surface` 守着它不扩散。
#![forbid(unsafe_code)]

pub mod application;
pub mod cancel;
pub mod collect;
pub mod decide;
pub mod dispatch;
pub mod document;
pub mod harness;
pub mod history;
pub mod journal;
pub mod mailbox;
pub mod native;
pub mod native_document;
pub mod review;
pub mod scope;
pub mod upstream;

pub use application::{
    Application, CollectReport, DecisionReport, DocumentBlockRow, DocumentBlocks, ProjectBlocks,
    ProjectDocuments, ProjectEntry, ProjectImport, ProjectInput, ProjectOpened, ProjectOutput,
    ProjectPage, ProjectPlatform, ProjectProposals, ProposalView, RootKind, SearchPrecision,
};
pub use cancel::{cancel_and_read_back, progress_of, refuse_cancel_without_handle};
pub use collect::{Collected, collect_attempt};
pub use decide::{commit_decision_batch, countermand_proposals};
pub use document::{
    BlockDto, EditorActionDto, EditorChangeDto, OpenDocumentDto, SaveOutcomeDto, TextTransitionDto,
    to_domain_action, transition_dto,
};
pub use journal::{
    StoreJournal, entity_of, into_domain, into_domain_host, json_of, run_kind, run_row, task_kind,
    task_row,
};
pub use native::{NativeHealth, NativeHealthError, native_health};
pub use native_document::{AnchorKind, AnchorSource, AnchoredRange};
pub use refrain_store::config::{Config, ConfigChange};
pub use review::rebuild_proposal;
pub use scope::{ScopeLocation, before_sections, locate_scope};
