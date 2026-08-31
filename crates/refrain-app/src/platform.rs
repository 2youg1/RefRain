// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 系统对话框这条缝，以及它的答案永远不进错误这条规则。
//!
//! # 接上哪个功能
//!
//! F4 采用 Root、F13 导入资料与正文。平台侧只提供**选择器**：作者点了哪个
//! 路径。选完之后的一切——校验、克隆、登记——都在 Rust 里，路径不再过河。
//!
//! # 这一层持有的不变量
//!
//! **作者选的路径不进错误。** 一条错误会跨界走到界面、进日志、被贴进 issue，
//! 而绝对路径同时泄露作者的身份与磁盘布局（`docs/CONTRIBUTING.md` 的三问之
//! 二）。所以选择器一路上的失败在离开这一层之前被改写：动作照说，主语换成
//! 「选中的那份」，`detail` 整个丢掉——底层错误里往往嵌着完整路径。
//!
//! # 能复用什么
//!
//! 任何新的「让作者选一个路径」的功能都实现 [`ProjectPlatform`] 的一条方法，
//! 并在失败路径上过一次 [`selected_path_failure`]；自动化通道（e2e）替换的是
//! 这一层的实现，产品路径与回归路径因此逐字相同。

use refrain_core::RefrainError;
use std::path::PathBuf;

use crate::root::RootKind;

/// 选择器：这一层唯一向平台要的东西。
pub trait ProjectPlatform {
    /// 选一个要采用的 Root。`None` 是作者取消了。
    ///
    /// # Errors
    ///
    /// 对话框起不来、或返回的路径不能用时失败。
    fn choose_root(&self, kind: RootKind) -> Result<Option<PathBuf>, RefrainError>;

    /// 选一个新项目建在哪。`None` 是作者取消了。
    ///
    /// # Errors
    ///
    /// 与 [`Self::choose_root`] 相同。
    fn choose_project_parent(&self) -> Result<Option<PathBuf>, RefrainError>;

    /// 选一份要导入的文件。`None` 是作者取消了。
    ///
    /// # Errors
    ///
    /// 与 [`Self::choose_root`] 相同。
    fn choose_import(&self, kind: ProjectImport) -> Result<Option<PathBuf>, RefrainError>;
}

/// 导入的两种去处：资料区，或正文。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectImport {
    Material,
    Manuscript,
}

/// 把一次失败改写成不带真实路径的形状。
///
/// `action` 说清作者在做什么，`safe_subject` 是一个不指向任何磁盘位置的主语。
/// `detail` 丢掉：底层错误的 detail 里往往就嵌着那条路径。
#[must_use]
pub fn selected_path_failure(
    mut error: RefrainError,
    action: &'static str,
    safe_subject: impl Into<String>,
) -> RefrainError {
    error.action = action.to_string();
    error.subject = safe_subject.into();
    error.detail = None;
    error
}
