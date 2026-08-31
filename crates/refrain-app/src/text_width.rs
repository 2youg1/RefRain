// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 全角与半角之间的转换，落成一次正文编辑。
//!
//! # 接上哪个功能
//!
//! F15「宽度转换」。字符映射表是 `refrain_core::text_width` 的唯一权威；
//! 这一层回答的是「转换哪一段、转完怎么落盘」。
//!
//! # 这一层持有的不变量
//!
//! **转换是一次 Text Action，不是一次特殊写入。** 它走
//! `document::apply_editor_journaled`，因此与作者自己打字共用撤销链、共用
//! compare-and-swap 落盘、共用历史表。一条绕过它的「批量替换」会写出一份
//! 历史解释不了的正文。
//!
//! **块身份由 Rust 查，且只在打开着的稿子上成立**（与派发、批注同一条理由）：
//! 界面送的是作者框住的原文，不是块 id——让界面送块 id 等于要求它先知道块
//! 怎么切。整篇转换时用稿子自己的分隔符把块拼起来，转换后按同一个 scan
//! 切回去，因此不会凭空多出或少掉一个块边界。
//!
//! **定义域外不算成功。** 一整段中文里没有一个字节可转，执行层会以
//! `NothingChanged` 拒绝；在这里先给作者一句看得懂的话，而不是让他读到一条
//! 关于内部状态的拒绝。

use refrain_core::{Block, ErrorCode, Id, RefrainError};

use crate::document::{EditorActionDto, EditorChangeDto, apply_editor_journaled};
use crate::history::{HistoryEntry, recent_history};
use crate::root::ProjectEntry;
use crate::scope::{ScopeLocation, locate_scope};

/// 转换一段（或整篇）正文的字符宽度，返回刷新后的历史。
///
/// `direction` 是线名：`"to-full"` 半角转全角，`"to-half"` 全角转半角。
/// `whole_document` 为真时 `selected` 留空。
///
/// # Errors
///
/// 线名不认识、稿子没打开、选区已经不在稿子里或出现多处、以及没有一个字节
/// 可转时，各自具名失败。
pub fn convert(
    entry: &mut ProjectEntry,
    path: &str,
    selected: &str,
    whole_document: bool,
    direction: &str,
) -> Result<Vec<HistoryEntry>, RefrainError> {
    let convert: fn(&str) -> String = match direction {
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
    let manuscript = entry.manuscripts.get(path).cloned().ok_or_else(|| {
        RefrainError::new(
            ErrorCode::StateUnavailable,
            "convert a manuscript that is not open",
            path.to_owned(),
        )
    })?;
    // 选区块：整篇取全部，选区逐字节定位。与派发同一条 `locate_scope`
    // ——重复的原文不替作者选（F-02）。
    let block_ids: Vec<Id> = if whole_document {
        manuscript.head().blocks().iter().map(Block::id).collect()
    } else {
        match locate_scope(&manuscript, selected) {
            ScopeLocation::Unique(blocks) => blocks,
            ScopeLocation::Moved => {
                return Err(RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "convert a scope that is no longer in the manuscript",
                    path.to_owned(),
                ));
            }
            ScopeLocation::Ambiguous(candidates) => {
                return Err(RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "convert a scope whose text appears more than once",
                    format!("{}: {} places", path, candidates.len()),
                ));
            }
        }
    };
    // 待转换原文：选区逐字节；整篇用稿子自己的分隔符拼（与 locate_scope
    // 同一来源），转换后按同一个 scan 重新切回块。
    let source: String = if whole_document {
        let join = manuscript.scan().separator();
        let mut joined = String::new();
        for (index, block) in manuscript.head().blocks().iter().enumerate() {
            if index > 0 {
                joined.push_str(join);
            }
            joined.push_str(block.text());
        }
        joined
    } else {
        selected.to_owned()
    };
    let converted = convert(&source);
    if converted == source {
        return Err(RefrainError::new(
            ErrorCode::InvalidInput,
            "convert text width",
            "nothing to convert",
        ));
    }
    let base = manuscript.head().id().to_string();
    apply_editor_journaled(
        entry,
        path,
        EditorActionDto {
            base,
            changes: vec![EditorChangeDto::Replace {
                blocks: block_ids.iter().map(Id::to_string).collect(),
                text: Some(converted),
            }],
        },
    )?;
    recent_history(&entry.store, path)
}
