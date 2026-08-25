//! 命令的唯一权威：每个 command id 的中文标签与键位显示串。
//!
//! **接上哪个功能**：`app.zon` 的 shortcuts/menus（SDK 的 on_command 通道）、
//! `core.zig` 的 `commandMsg`（id 的落点）与 `keyMsg`（Alt 系台内键位），以及
//! 一切把键位印在界面上的地方——按钮文案、右键菜单、命令面板。
//!
//! **在全局逻辑中负责什么**：一处回答「这个命令叫什么、按什么」。此前键位
//! 硬编码在各处按钮文案里，改一个键要满仓库找；现在表改一处，处处跟着。
//! `verify:command-space` 钉住表与 app.zon 的交集（zon 的 id 必须在表里）。
//!
//! **能复用什么**：`hintOf`／`labelOf` 按 id 查；`withHint` 拼「标签　键位」
//! 的菜单显示串。Alt 系键位不在 app.zon（它们走 keyMsg），表比 zon 大是
//! 允许且刻意的。

const std = @import("std");

/// 一条命令的界面事实：点名的 id、作者看见的名字、印在界面上的键位。
pub const Command = struct {
    id: []const u8,
    label: []const u8,
    /// 键位显示串（"Alt+A"、"Ctrl+S"、"Esc"）。空 = 没有键位。
    hint: []const u8,
};

/// 全部命令。zon 系（快捷键与菜单）在前，Alt 系（keyMsg 台内键位）在后。
///
/// **Ctrl+N 的真实顺序以 `core/workbench.zig` 的 `destinationForOrdinal`
/// 为准**：Ctrl+1 是设置、Ctrl+2 文件、Ctrl+3 稿子、
/// Ctrl+4 是动态的 Agent 去处——不是去处表的下标顺序。标签与 app.zon
/// 菜单同一套字（门禁比对），它们不是去处名下标。
pub const commands = [_]Command{
    // app.zon shortcuts/menus 的全集。
    .{ .id = "go.1", .label = "设置", .hint = "Ctrl+1" },
    .{ .id = "go.2", .label = "文件", .hint = "Ctrl+2" },
    .{ .id = "go.3", .label = "稿子", .hint = "Ctrl+3" },
    .{ .id = "go.4", .label = "Agent", .hint = "Ctrl+4" },
    .{ .id = "go.5", .label = "信箱", .hint = "Ctrl+5" },
    .{ .id = "go.6", .label = "连接", .hint = "Ctrl+6" },
    .{ .id = "go.7", .label = "历史", .hint = "Ctrl+7" },
    .{ .id = "go.8", .label = "设置", .hint = "Ctrl+8" },
    .{ .id = "palette", .label = "命令面板", .hint = "Ctrl+K" },
    .{ .id = "roster.next", .label = "下一行", .hint = "Ctrl+J" },
    .{ .id = "roster.previous", .label = "上一行", .hint = "Ctrl+Shift+K" },
    .{ .id = "document.save", .label = "保存", .hint = "Ctrl+S" },
    .{ .id = "document.undo", .label = "撤销", .hint = "Ctrl+Z" },
    .{ .id = "search", .label = "查找", .hint = "Ctrl+F" },
    .{ .id = "panel.back", .label = "返回", .hint = "Esc" },
    .{ .id = "panel.back.bracket", .label = "返回", .hint = "Ctrl+[" },
    .{ .id = "theme.next", .label = "换主题", .hint = "Ctrl+Shift+T" },
    .{ .id = "kara.toggle", .label = "专注写作", .hint = "Ctrl+Enter" },
    .{ .id = "app.quit", .label = "退出", .hint = "Ctrl+Q" },
    // Alt 系：`core.zig` 的 `keyMsg` 台内键位（裁决台），不在 app.zon。
    .{ .id = "verdict.accept", .label = "接受", .hint = "Alt+A" },
    .{ .id = "verdict.reject", .label = "退回", .hint = "Alt+B" },
    .{ .id = "verdict.revise", .label = "改写", .hint = "Alt+E" },
    .{ .id = "verdict.settle", .label = "合并", .hint = "Alt+Enter" },
    .{ .id = "review.reason", .label = "理由", .hint = "Alt+R" },
    .{ .id = "review.peer", .label = "竞争稿", .hint = "Alt+P" },
    .{ .id = "roster.step.next", .label = "下移", .hint = "Alt+J" },
    .{ .id = "roster.step.previous", .label = "上移", .hint = "Alt+K" },
};

/// 这个 id 的键位显示串。不认识的 id 交空串——调用方据此不印括号，
/// 而不是印出一个按不出的组合。
pub fn hintOf(id: []const u8) []const u8 {
    for (&commands) |command| {
        if (std.mem.eql(u8, command.id, id)) return command.hint;
    }
    return "";
}

/// 这个 id 的中文标签。不认识的 id 原样交回 id——总有个东西可显示，
/// 而 id 本身也是线索。
pub fn labelOf(id: []const u8) []const u8 {
    for (&commands) |command| {
        if (std.mem.eql(u8, command.id, id)) return command.label;
    }
    return id;
}

/// 「标签　键位」的菜单显示串（全角空格，浏览器右键同款）。没有键位的
/// 命令只回标签——印一对空括号会教作者找一个不存在的键。
pub fn withHint(buf: []u8, id: []const u8) []const u8 {
    const hint = hintOf(id);
    if (hint.len == 0) return labelOf(id);
    return std.fmt.bufPrint(buf, "{s}　{s}", .{ labelOf(id), hint }) catch labelOf(id);
}

test "every zon command id has a label and a hint in the table" {
    // zon 系全集（快捷键 + 菜单引用的 id）。缺一条，门禁也会红——这里的
    // 红更早：写完表当场知道。
    const zon_ids = [_][]const u8{
        "go.1",       "go.2",        "go.3",            "go.4",          "go.5",          "go.6",   "go.7",       "go.8",
        "palette",    "roster.next", "roster.previous", "document.save", "document.undo", "search", "panel.back", "panel.back.bracket",
        "theme.next", "kara.toggle", "app.quit",
    };
    for (zon_ids) |id| {
        try std.testing.expect(hintOf(id).len > 0);
        try std.testing.expect(labelOf(id).len > 0);
    }
    // Alt 系在表而不在 zon：表比 zon 大是刻意的。
    try std.testing.expectEqualStrings("Alt+A", hintOf("verdict.accept"));
    // 不认识的 id：hint 空、label 回 id，不猜。
    try std.testing.expectEqualStrings("", hintOf("brand.new"));
    try std.testing.expectEqualStrings("brand.new", labelOf("brand.new"));
}

test "withHint joins the label and the key with an ideographic space" {
    var buf: [64]u8 = undefined;
    try std.testing.expectEqualStrings("保存　Ctrl+S", withHint(&buf, "document.save"));
    // 没键位的命令不印空括号。
    try std.testing.expectEqualStrings("brand.new", withHint(&buf, "brand.new"));
}
