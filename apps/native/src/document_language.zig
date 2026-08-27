// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 文档语言：Rust 说这份稿子是什么，SDK 据此上色。
//!
//! **接上哪个功能**：正文表面的语法高亮。Rust 的 `DocumentFormat` 在打开文档
//! 时按文件名定下语言，经协议的 `document_format` 过界；这里把那个数字翻成
//! SDK `code` 部件认识的语法。
//!
//! **在全局逻辑中负责什么**：只做翻译，不做判断。「这份文件是什么语言」归
//! Rust（它是唯一看得见文件名的一侧）——视图侧看到的只是一窗字节，而一窗
//! `.rs` 与 Markdown 里的一段围栏代码长得一模一样，从字节上分不出来。
//!
//! **能复用什么**：SDK 自带 17 种语法的高亮器（`primitives/canvas/code.zig`
//! 的 `Language`），含跨块 lexer 状态，所以这里零自研着色代码。新增一种
//! 文档格式只在两张表各加一行：Rust 的 `wire_code` 与这里的 `syntaxOf`。

const std = @import("std");
const native_sdk = @import("native_sdk");

/// SDK 的语法枚举。取自 `ui.code` 的 `language` 属性。
pub const Syntax = native_sdk.canvas.code.Language;

/// 一个跨界语言号对应的 SDK 语法。
///
/// 数字来自 `DocumentFormat::wire_code`，那边写死而不是按声明顺序推导，
/// 所以两侧不会因为有人重排枚举而悄悄错位。认不出的号回落 `.plain`——
/// 猜一种语法会把普通词染成关键字，比不上色更难读。
pub fn syntaxOf(wire_code: u32) Syntax {
    return switch (wire_code) {
        0 => .markdown,
        1 => .plain, // LaTeX：SDK 没有这一门，宁可不上色也不套一门近似的
        2 => .typescript,
        3 => .rust,
        4 => .python,
        5 => .go,
        6 => .plain, // Lean 4：同上
        7 => .css,
        8 => .html,
        9 => .html, // XML 与 HTML 同一套标签着色
        10 => .plain, // TOML：SDK 无此语法，yaml 的规则会把 `[表头]` 读错
        11 => .yaml,
        else => .plain,
    };
}

/// 这份文档要不要按代码排版（等宽、不禁则断行）。
///
/// 判据是「作者在这里写的是代码还是散文」，不是「有没有语法上色」：
/// Markdown 里可以有围栏代码，但整份稿子仍按中文排版规则断行；而一份
/// `.toml` 即使没有上色，也不该被压半字或套用禁则。
///
/// 判据与 Rust 的 `DocumentFormat::is_code` 同一处权威：Markdown 与 LaTeX
/// 是写作格式（正文夹在源码里），其余按代码排。两侧漂开的后果是同一份
/// 稿子在字体与断行上各说各话。
pub fn isCode(wire_code: u32) bool {
    return wire_code != 0 and wire_code != 1;
}

test "the wire numbers match DocumentFormat::wire_code one for one" {
    // 两侧漂开一格的表现是所有代码文件都用邻居的语法上色，而两边单看都自洽。
    try std.testing.expectEqual(Syntax.markdown, syntaxOf(0));
    try std.testing.expectEqual(Syntax.typescript, syntaxOf(2));
    try std.testing.expectEqual(Syntax.rust, syntaxOf(3));
    try std.testing.expectEqual(Syntax.python, syntaxOf(4));
    try std.testing.expectEqual(Syntax.go, syntaxOf(5));
    try std.testing.expectEqual(Syntax.css, syntaxOf(7));
    try std.testing.expectEqual(Syntax.html, syntaxOf(8));
    try std.testing.expectEqual(Syntax.yaml, syntaxOf(11));
}

test "a format SDK has no grammar for stays plain instead of borrowing a neighbour" {
    // LaTeX、Lean、TOML 三门 SDK 答不了。套一门近似语法会把普通标识符染成
    // 关键字——读者据此推断的结构是错的，比没有颜色更坏。
    try std.testing.expectEqual(Syntax.plain, syntaxOf(1));
    try std.testing.expectEqual(Syntax.plain, syntaxOf(6));
    try std.testing.expectEqual(Syntax.plain, syntaxOf(10));
}

test "an unknown number falls back instead of indexing past the table" {
    // 协议升级后对面可能先送来一个新号。回落而不是崩，也不是猜。
    try std.testing.expectEqual(Syntax.plain, syntaxOf(12));
    try std.testing.expectEqual(Syntax.plain, syntaxOf(9999));
}

test "prose and code are separated by the same number, not by whether it colours" {
    // 散文是 Markdown 与 LaTeX 两种：LaTeX 虽是源码模样，但作者写的是
    // 正文（中文注释与公式文字按散文排）。其余都按代码排版，包括 SDK
    // 上不了色的那三门——上色与排版是两个问题。与 Rust 的
    // `DocumentFormat::is_code` 同一处权威。
    try std.testing.expect(!isCode(0));
    try std.testing.expect(!isCode(1));
    try std.testing.expect(isCode(3));
    try std.testing.expect(isCode(10));
}
