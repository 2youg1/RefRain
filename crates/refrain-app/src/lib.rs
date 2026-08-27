// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Use cases: the multi-step flows that need both the store and the host.
//!
//! 这个 crate 存在的理由，是有几条流程既不是纯领域、也不只是持久化或编排。收取
//! 一次派发结果要读回冻结的请求、按契约校验、映射到当前打开的稿子，再分三步写
//! 进 host 与 store——它此前是 `lib.rs` 里一个 183 行的命令体，除了开一个 Tauri
//! 窗口以外没有别的办法验证它。
//!
//! 一条输入进 `application` 这个路由，路由把它交给持有那条规则的模块：
//! 采用与目录在 `root`，检索在 `search`，资料与导入在 `materials`，编排会话在
//! `host_session`，KARA 在 `kara`。路由的臂里不写规则——写在那里的规则没有名字。
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
pub mod host_session;
pub mod journal;
pub mod kara;
pub mod mailbox;
pub mod materials;
pub mod native;
pub mod native_document;
pub mod platform;
pub mod project_channel;
pub mod review;
pub mod root;
pub mod runner;
pub mod scope;
pub mod search;
pub mod text_width;
pub mod upstream;

pub use application::Application;
pub use cancel::{cancel_and_read_back, progress_of, refuse_cancel_without_handle};
pub use collect::{CollectReport, Collected, collect_attempt};
pub use decide::{DecisionReport, commit_decision_batch, countermand_proposals};
pub use document::{
    BlockDto, EditorActionDto, EditorChangeDto, OpenDocumentDto, SaveOutcomeDto, TextTransitionDto,
    to_domain_action, transition_dto,
};
pub use host_session::HostSnapshot;
pub use journal::{
    StoreJournal, entity_of, into_domain, into_domain_host, json_of, run_kind, run_row, task_kind,
    task_row,
};
pub use kara::Kara;
pub use materials::{MaterialDraftView, MaterialRow, ProjectMaterials};
pub use native::{NativeHealth, NativeHealthError, native_health};
pub use native_document::{AnchorKind, AnchorSource, AnchoredRange};
pub use platform::{ProjectImport, ProjectPlatform};
pub use project_channel::{ProjectInput, ProjectOutput};
pub use refrain_store::config::{Config, ConfigChange};
pub use review::{ProjectProposals, ProposalView, rebuild_proposal};
pub use root::{ProjectEntry, ProjectOpened, ProjectPage, RootKind};
pub use scope::{DocumentBlockRow, DocumentBlocks, ScopeLocation, before_sections, locate_scope};
pub use search::{ProjectBlocks, ProjectDocuments, SearchPrecision};
