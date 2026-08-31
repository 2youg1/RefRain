// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 在一个 Root 里找东西：按文档找，或按块找。
//!
//! # 接上哪个功能
//!
//! F5「搜索与跳转」的应用侧。分词、排序与 FTS5 查询分别归
//! `refrain_core::chinese_index`、`search_rank` 与 `refrain-store` 的
//! `project/search`；这一层只做两件事——把两次检索的形状对齐，以及把
//! 「索引是这一次才建成的」这个事实带出项目锁。
//!
//! # 这一层持有的不变量
//!
//! **索引建成只报一次。** 索引是懒建的：第一次检索会把它从「待建」变成
//! 「已建」，`take_index_built` 取走旗标。事实归安静事件，而安静事件要在项目
//! 锁**外**发（KARA 的锁不与项目锁嵌套），所以这一层把它随结果一起交出去，
//! 由路由发。谁忘了取这面旗，作者就会在每一次检索后重复读到「索引已刷新」。
//!
//! # 能复用什么
//!
//! 两条检索的答复形状一致（命中数组 + `truncated`），界面因此可以用同一段
//! 逻辑读它们。

use refrain_core::RefrainError;
use refrain_core::chinese_index::Precision;
use refrain_store::project::{BlockHit, DocumentRow, MAX_DOCUMENT_SEARCH_RESULTS};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::root::ProjectEntry;

/// 作者要的是哪一种命中。精确找不到时回落到宽松（存储层的规则）。
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

/// 一次检索的命中，加上一个只有这一层知道的事实。
pub struct Searched<T> {
    /// 跨界的答复。
    pub hits: T,
    /// 索引是在这一次检索里建成的吗。真时由调用方记一次安静事件。
    pub index_built: bool,
}

/// 按文档检索的答复。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDocuments {
    pub documents: Vec<DocumentRow>,
    pub truncated: bool,
}

/// 按块检索的答复。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBlocks {
    pub blocks: Vec<BlockHit>,
    pub truncated: bool,
}

/// 按文档找：命中的是文档行。
///
/// # Errors
///
/// 索引读不出来、或查询在存储层被拒绝时具名失败。
pub fn documents(
    entry: &mut ProjectEntry,
    query: &str,
    precision: SearchPrecision,
) -> Result<Searched<ProjectDocuments>, RefrainError> {
    let documents =
        entry
            .store
            .search_documents_with(query, precision.into(), MAX_DOCUMENT_SEARCH_RESULTS)?;
    Ok(Searched {
        hits: ProjectDocuments {
            documents,
            truncated: false,
        },
        index_built: entry.store.take_index_built(),
    })
}

/// 按块找：命中的是块，带各自的文档与位置。
///
/// # Errors
///
/// 与 [`documents`] 相同。
pub fn blocks(
    entry: &mut ProjectEntry,
    query: &str,
    precision: SearchPrecision,
) -> Result<Searched<ProjectBlocks>, RefrainError> {
    let blocks =
        entry
            .store
            .search_blocks_with(query, precision.into(), MAX_DOCUMENT_SEARCH_RESULTS)?;
    Ok(Searched {
        hits: ProjectBlocks {
            blocks,
            truncated: false,
        },
        index_built: entry.store.take_index_built(),
    })
}
