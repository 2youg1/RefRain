// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 作者能对手稿下的那几种命令，以及它们在被接受之前要过的形状检查。
//!
//! **接上哪个功能**：编辑器的每一次改动（F1）与裁决台的每一次合并（F6）都从
//! 这里进 `Manuscript::execute`。
//!
//! **这一层持有的不变量**：一条命令**在构造时**就必须是合法的形状——
//! `Replacement` 的块非空且不重复，`Insertion` 的每一段文本恰好是一块且不留
//! 缝隙。所以这两个类型只有 `new`：拿到一个值，就等于拿到了那些检查的结论，
//! 而 `execute` 不必再问一遍。检查放在构造上而不是执行上，是因为一条形状不合法
//! 的命令没有「一半执行」这种结果，越早具名拒绝，作者收到的话越具体。
//!
//! **为什么从 `mod.rs` 搬出来**：那个文件是十七个顶层类型，而这五个自成一簇——
//! 它们只认识 `Id`、`BlockScan` 与 `TextRefusal`，不认识 `Manuscript`、不认识
//! 快照、不认识字节序列。一簇零外部依赖的类型住在一个一千三百行的文件里，读它
//! 的人要先跳过另外十二个类型才找得到它们。
//!
//! 字段是 `pub(super)`：`manuscript` 与它的子模块（`action`、`decision`）按字段
//! 读这些值，而外面只能经 `new` 造、经 `execute` 用。

use super::TextRefusal;
use crate::manuscript::decision::DecisionBatch;
use crate::{BlockScan, Id};
use std::collections::HashSet;

/// A non-empty run of existing blocks to replace or delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Replacement {
    pub(super) blocks: Box<[Id]>,
    pub(super) text: Option<String>,
}

impl Replacement {
    pub fn new(blocks: Vec<Id>, text: Option<String>) -> Result<Self, TextRefusal> {
        if blocks.is_empty() {
            return Err(TextRefusal::EmptyRange);
        }
        let mut seen = HashSet::with_capacity(blocks.len());
        if let Some(block) = blocks.iter().find(|block| !seen.insert(**block)) {
            return Err(TextRefusal::DuplicateBlock { block: *block });
        }
        Ok(Self {
            blocks: blocks.into_boxed_slice(),
            text,
        })
    }
}

/// An ordered, non-empty group of new blocks at one existing right boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Insertion {
    pub(super) before: Option<Id>,
    pub(super) texts: Box<[String]>,
}

impl Insertion {
    pub fn new(
        before: Option<Id>,
        texts: Vec<String>,
        scan: BlockScan,
    ) -> Result<Self, TextRefusal> {
        if texts.is_empty() {
            return Err(TextRefusal::EmptyInsertion);
        }
        for (index, text) in texts.iter().enumerate() {
            let layout = scan.layout(text.as_bytes());
            let blocks = layout.blocks();
            if blocks.len() != 1 {
                return Err(TextRefusal::InvalidInsertionBlock {
                    index,
                    blocks: blocks.len(),
                });
            }
            if blocks[0].start != 0 || blocks[0].end != text.len() {
                return Err(TextRefusal::InsertionBlockHasGaps { index });
            }
        }
        Ok(Self {
            before,
            texts: texts.into_boxed_slice(),
        })
    }
}

/// One independently locatable change reported by the editor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorChange {
    Replace(Replacement),
    Insert(Insertion),
}

/// All settled editor input against one exact Text Head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorAction {
    pub(super) base: Id,
    pub(super) changes: Box<[EditorChange]>,
    pub(super) cause: String,
}

impl EditorAction {
    #[must_use]
    pub fn new(base: Id, changes: Vec<EditorChange>, cause: impl Into<String>) -> Self {
        Self {
            base,
            changes: changes.into_boxed_slice(),
            cause: cause.into(),
        }
    }
}

/// The three authorised ways to ask the manuscript to move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextCommand {
    Editor(EditorAction),
    CommitDecisionBatch(DecisionBatch),
}
