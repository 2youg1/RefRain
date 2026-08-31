// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 名录：一列东西，和作者此刻停在第几行。
//!
//! **接上哪个功能**：裁决、派发、信箱、连接。四个去处看起来是四张不同的界面，
//! 问的却是同一个问题——「这一列里我停在哪，能不能动」。旧前端为这四张界面各写
//! 一套会话类（1,853 行），各持一份游标、各写一遍越界钳制，于是「列表空了游标
//! 该去哪」有四个答案。
//!
//! **负责什么**：把游标收成一个不变量——**游标要么指向一个存在的行，要么是
//! `null`**。中间状态不存在，所以调用方不必在每个读取点先判一次空。名录变短
//! （收走一个 Run、弃置一封信）是这类界面最常见的改动，也正是「游标指向已消失
//! 的行」的来源。
//!
//! **与 `roster.ts` 的差别只有一处，但它是本次迁移的收获**：空名录用 `null`
//! 而不是 `-1`。`-1` 是一条要记住的约定，`?u32` 是编译器替你记。
//!
//! 规格：`RefRain-work/main+SPEC.md` §8、§10 第四步。
//! 本模块今天没有生产读者——车道切换在单元 13。

const std = @import("std");

/// 把一个游标钳进名录。
///
/// 三条规则一次答完：空名录得 `null`、越界回到最近的一端、其余原样。
/// 「回到最近的一端」而不是回到 0——收走末行时作者的注意力在末尾，把他弹回
/// 第一行是一次他没要求的跳转。
///
/// `null` 进来表示「还没有停在任何行」，名录非空时它落到第一行，与
/// `roster.ts` 对负数游标的处理同一个事实。
pub fn settle(cursor: ?u32, count: u32) ?u32 {
    if (count == 0) return null;
    const at = cursor orelse return 0;
    return if (at < count) at else count - 1;
}

/// 上下移动一行。
///
/// 不绕回：名录是一列，撞到两端就停。绕回会让「按住下键」变成无限循环，
/// 作者读不出自己已经到底了。
pub fn step(cursor: ?u32, delta: i32, count: u32) ?u32 {
    if (count == 0) return null;
    const from: i64 = settle(cursor, count) orelse 0;
    const moved = from + delta;
    if (moved <= 0) return 0;
    const limit: i64 = @intCast(count - 1);
    if (moved >= limit) return count - 1;
    return @intCast(moved);
}

/// 这个游标指向一个真实的行吗。命令按钮的可用性读它。
pub fn hasRow(cursor: ?u32, count: u32) bool {
    const at = cursor orelse return false;
    return at < count;
}

/// 名录换了一批内容之后，游标停在哪。
///
/// **这是本模块存在的理由。** 一次收取、一次弃置、一次裁决都会让名录变短，
/// 而作者的注意力在他刚处理的那一行——不是第一行。停在原位（由 `settle` 钳进
/// 新长度）让「连着处理三封」不必每次重新找位置；名录空了才交出 `null`。
pub fn afterRefresh(cursor: ?u32, count: u32) ?u32 {
    return settle(cursor, count);
}

// ------------------------------------------------------------------ 测试
// 向量逐条搬自 `roster.test.ts`，断言的是同一个事实。

const testing = std.testing;

test "空名录上的游标是 null，不是 0" {
    // 0 是一个真实的行。空名录上返回 0 会让「选中的那一行」指向不存在的东西，
    // 而调用方看不出区别——命令按钮会亮着，按下去落在空处。
    try testing.expectEqual(@as(?u32, null), settle(0, 0));
    try testing.expectEqual(@as(?u32, null), settle(5, 0));
    try testing.expect(!hasRow(null, 0));
}

test "越界的游标回到最近的一端，而不是回到第一行" {
    // 近失手：「取 min」与「回到 0」在 count=3、cursor=9 时都是合法答案，
    // 但后者把作者从末尾弹回开头。收走末行时他的注意力在末尾。
    try testing.expectEqual(@as(?u32, 2), settle(9, 3));
    // `roster.ts` 的负数游标在这里是 `null`：都表示「还没停在任何行」。
    try testing.expectEqual(@as(?u32, 0), settle(null, 3));
}

test "移动撞到两端就停，不绕回" {
    try testing.expectEqual(@as(?u32, 0), step(0, -1, 3));
    try testing.expectEqual(@as(?u32, 2), step(2, 1, 3));
    try testing.expectEqual(@as(?u32, 1), step(0, 1, 3));
    try testing.expectEqual(@as(?u32, null), step(0, 1, 0));
}

test "名录变短之后游标停在原位，只有名录空了才交出 null" {
    // 这是本模块存在的理由：连着处理三封信不该每次重新找位置。
    try testing.expectEqual(@as(?u32, 1), afterRefresh(1, 5));
    try testing.expectEqual(@as(?u32, 1), afterRefresh(4, 2));
    try testing.expectEqual(@as(?u32, null), afterRefresh(3, 0));
}

test "极端：只有一行时上下都停在那一行" {
    try testing.expectEqual(@as(?u32, 0), step(0, 1, 1));
    try testing.expectEqual(@as(?u32, 0), step(0, -1, 1));
    try testing.expect(hasRow(0, 1));
}

test "大步长不溢出，两端都钳得住" {
    // TS 侧靠 number 的宽度掩盖了这个问题；Zig 侧 i64 中转并逐端钳制。
    try testing.expectEqual(@as(?u32, 0), step(1, std.math.minInt(i32), 4));
    try testing.expectEqual(@as(?u32, 3), step(1, std.math.maxInt(i32), 4));
}
