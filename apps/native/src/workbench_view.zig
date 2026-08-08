//! 工作台的去处表与命令面板：下标在 Model，名字在这里。
//!
//! **接上哪个功能**：步骤 6 的命令面板与导航。规则（哪些去处要稿子、
//! 越界怎么落）住在 `core.ts` 的 `workbench.ts`，可在 Null platform 上单测；
//! 这里只补它答不了的那一半——中文标签。
//!
//! **在全局逻辑中负责什么**：与主题色表同一条纪律。core 子集不允许非 ASCII
//! 进 rodata（NS9001），标记里写中文字面量也会被 `native check --strict` 拦下，
//! 所以「濤」「裁决」这类字只能住在 Zig 侧。Model 记下标，这里按下标查名。
//!
//! **能复用什么**：`destinations` 的次序即 Cmd+1..8 的次序，也即面板的排序——
//! 新增一个去处只改这张表与 `workbench.ts` 的两个常量，视图不必动。

const std = @import("std");

/// 一个去处的界面事实：作者看见的名字，与它的键位。
pub const Destination = struct {
    /// 命令面板与导航栏显示的名字。
    label: []const u8,
    /// 一句话说明它管什么。面板搜索会搜它。
    hint: []const u8,
};

/// 八个去处，次序与 `workbench.ts` 的下标严格一致。
///
/// 下标含义（与 `NEEDS_DOCUMENT_MASK` 的位次同源）：
/// 0 稿子、1 文件、2 裁决、3 派发、4 信箱、5 连接、6 历史、7 设置。
pub const destinations = [_]Destination{
    .{ .label = "稿子", .hint = "正文与编辑" },
    .{ .label = "文件", .hint = "项目里的文档名录" },
    .{ .label = "裁决", .hint = "逐条处理 Agent 的提案" },
    .{ .label = "派发", .hint = "选范围、写请求、送出去" },
    .{ .label = "信箱", .hint = "送出去的那些回来了没有" },
    .{ .label = "连接", .hint = "本机 Harness 与 Agent 配置" },
    .{ .label = "历史", .hint = "这份稿子改过什么，可回档" },
    .{ .label = "设置", .hint = "主题、字体、排版与快捷键" },
};

/// 这个下标的去处。越界回落到稿子——与 `workbench.ts` 的 `destinationAt` 同规。
///
/// 两处各自钳一次不是重复：TS 侧钳的是 Model 的值，这里钳的是查表的下标，
/// 而 Zig 不能假设 Model 一定守规矩（它跨了一次 ABI）。
pub fn destinationAt(index: i32) Destination {
    if (index < 0 or index >= destinations.len) return destinations[0];
    return destinations[@intCast(index)];
}

/// 直达这个去处的键位：`workbench.ts` 的 `destinationForOrdinal` 的反查
/// （Ctrl+1 是设置、Ctrl+2 文件、Ctrl+3 稿子——不是下标顺序）。裁决与派发
/// 交空串：Ctrl+4 是动态的 Agent 去处，印上去会教作者一个按到别处的组合。
pub fn destinationChord(index: usize) []const u8 {
    return switch (index) {
        0 => "Ctrl+3",
        1 => "Ctrl+2",
        4 => "Ctrl+5",
        5 => "Ctrl+6",
        6 => "Ctrl+7",
        7 => "Ctrl+1",
        // 2 裁决、3 派发：没有固定键位。
        else => "",
    };
}

test "the destination table matches the TypeScript index vocabulary" {
    // `workbench.ts` 的 DESTINATION_COUNT 是 8。两处漂开的表现是命令面板
    // 少一行或多一行空条目，而两边单看都自洽。
    try std.testing.expectEqual(@as(usize, 8), destinations.len);
    // 下标 0 必须是稿子：它是一切拒绝的落点。
    try std.testing.expectEqualStrings("稿子", destinations[0].label);
    // 需要稿子的那四个（掩码 92 = 0b0101_1100）在这里的位置。
    try std.testing.expectEqualStrings("裁决", destinations[2].label);
    try std.testing.expectEqualStrings("派发", destinations[3].label);
    try std.testing.expectEqualStrings("信箱", destinations[4].label);
    try std.testing.expectEqualStrings("历史", destinations[6].label);
}

test "an out-of-range index falls back to the manuscript instead of reading past the table" {
    try std.testing.expectEqualStrings("稿子", destinationAt(-1).label);
    try std.testing.expectEqualStrings("稿子", destinationAt(8).label);
    try std.testing.expectEqualStrings("设置", destinationAt(7).label);
}

test "every destination carries a label and a hint" {
    // 空标签会渲染成一个点不动的空按钮，比缺一行更难归因。
    for (destinations) |destination| {
        try std.testing.expect(destination.label.len > 0);
        try std.testing.expect(destination.hint.len > 0);
    }
}

test "destination chords are the inverse of destinationForOrdinal" {
    // Ctrl+1 是设置、Ctrl+2 文件、Ctrl+3 稿子（workbench.ts 的 ordinal
    // remap），不是下标顺序。裁决与派发没有固定键位：空串。
    try std.testing.expectEqualStrings("Ctrl+3", destinationChord(0));
    try std.testing.expectEqualStrings("Ctrl+2", destinationChord(1));
    try std.testing.expectEqualStrings("", destinationChord(2));
    try std.testing.expectEqualStrings("", destinationChord(3));
    try std.testing.expectEqualStrings("Ctrl+5", destinationChord(4));
    try std.testing.expectEqualStrings("Ctrl+6", destinationChord(5));
    try std.testing.expectEqualStrings("Ctrl+7", destinationChord(6));
    try std.testing.expectEqualStrings("Ctrl+1", destinationChord(7));
}
