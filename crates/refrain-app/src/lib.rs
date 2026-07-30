//! Use cases: the multi-step flows that need both the store and the host.
//!
//! 这个 crate 存在的理由，是有几条流程既不是纯领域、也不只是持久化或编排。收取
//! 一次派发结果要读回冻结的请求、按契约校验、映射到当前打开的稿子，再分三步写
//! 进 host 与 store——它此前是 `lib.rs` 里一个 183 行的命令体，除了开一个 Tauri
//! 窗口以外没有别的办法验证它。
//!
//! 这里不认识 Tauri。

pub mod collect;
pub mod journal;
pub mod scope;

pub use collect::{Collected, collect_attempt};
pub use journal::{
    StoreJournal, entity_of, into_domain, into_domain_host, json_of, run_kind, run_row, task_kind,
    task_row,
};
pub use scope::{before_sections, find_scope_blocks};
