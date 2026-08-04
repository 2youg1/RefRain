//! 名录的界面：一列行，和作者停在哪一行。
//!
//! **接上哪个功能**：步骤 7 的裁决、派发、信箱、连接。四个去处共用这一段——
//! 它们的形状相同（一列可选的行 + 选中项上的动作），不同的只有表头与空名录时
//! 该说的那句话。旧前端为这四张界面各写一套（1,853 行），于是「空列表显示什么」
//! 有四个答案，其中两个是什么都不显示。
//!
//! **在全局逻辑中负责什么**：只画。「游标能不能动、名录空了游标去哪」归
//! `roster.ts` 的不变量，这里不复制那条规则——复制它就会出现「界面允许点、
//! update 又拒绝」的两份判断，与命令面板同一条纪律。
//!
//! **能复用什么**：表头与空名录措辞按去处下标查表，与 `workbench_view` 的去处表
//! 同源同序。新增第五个去处只加一行表项，画法不动。中文字面量住在 Zig 而不是
//! core 子集，理由与主题名相同（NS9001：非 ASCII 进不了 rodata）。

const std = @import("std");
const workbench_view = @import("workbench_view.zig");

/// 一个去处的名录该怎么说话。
pub const Wording = struct {
    /// 名录上方的表头。
    heading: []const u8,
    /// 一行也没有时说的那句话。
    ///
    /// 空名录必须说话：什么都不画，作者读成的是「界面坏了」而不是「确实没有」。
    /// 四个去处的空状态含义不同——没有提案与没有连接不是同一件事。
    empty: []const u8,
};

/// 八个去处各自的措辞，次序与 `workbench_view.destinations` 严格一致。
///
/// 不需要名录的那些去处（稿子、文件、设置）也在表里占位，因为查表按下标——
/// 让下标错位一格比多三行表项危险得多。
pub const wordings = [_]Wording{
    .{ .heading = "稿子", .empty = "还没有打开稿子" },
    .{ .heading = "文档", .empty = "这个项目里还没有文档" },
    .{ .heading = "待裁决的提案", .empty = "没有等待裁决的提案" },
    .{ .heading = "可以派发的范围", .empty = "先选一段正文再派发" },
    .{ .heading = "送出去的那些", .empty = "信箱是空的" },
    .{ .heading = "本机 Harness", .empty = "还没有配置任何 Harness" },
    .{ .heading = "这份稿子改过什么", .empty = "还没有可回档的改动" },
    .{ .heading = "设置", .empty = "没有可改的项" },
};

/// 这个下标的措辞。越界回落到稿子——与 `workbench_view.destinationAt` 同规。
///
/// 收 i64 是因为生成的 Model 用 i64 存下标；在这里钳一次，调用方不必先转换。
pub fn wordingAt(index: i64) Wording {
    if (index < 0 or index >= wordings.len) return wordings[0];
    return wordings[@intCast(index)];
}

test "the wording table is index-aligned with the destination table" {
    // 两张表按下标配对。漂开一格的表现是裁决台顶着信箱的表头，而两边单看都自洽。
    try std.testing.expectEqual(workbench_view.destinations.len, wordings.len);
    try std.testing.expectEqualStrings("待裁决的提案", wordingAt(2).heading);
    try std.testing.expectEqualStrings("送出去的那些", wordingAt(4).heading);
}

test "every destination says something when its roster is empty" {
    // 空名录不说话就等于界面坏了。这条守的是没有一个去处忘了那句话。
    for (wordings) |wording| {
        try std.testing.expect(wording.heading.len > 0);
        try std.testing.expect(wording.empty.len > 0);
    }
}

test "an out-of-range index falls back instead of reading past the table" {
    try std.testing.expectEqualStrings("稿子", wordingAt(-1).heading);
    try std.testing.expectEqualStrings("稿子", wordingAt(8).heading);
    try std.testing.expectEqualStrings("设置", wordingAt(7).heading);
}
