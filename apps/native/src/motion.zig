// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 动效的唯一权威（2.7）：时长、easing、循环形状。
//!
//! **接上哪个功能**：界面任何一处动画——veil 的纱、面板层进场、饭盒、
//! 印点、呼吸墨线、分栏 settle。具名时长从 v0.2.4 的 CSS 变量回迁。
//!
//! **在全局逻辑中负责什么**：只收数值，不画。收编原则（无硬编码纪律）：
//! 界面任何一处动画不自带数字——时长按名字从这里取，easing 只有一对
//! （进减速 / 出加速），循环只有「呼吸」一种形状（ping_pong）。
//!
//! **边界（两个读者各管一段）**：`core.zig` 的定时器（裁决前进 120ms、
//! 搜索防抖 120ms、轮询 2500ms、回来卡 600ms、打断 4000ms、离开 8000ms、
//! Leaving 12s）是**消息调度**不是渲染动效，留在核心不进这张表——一个是
//! 「什么时候发一条消息」，一个是「一段动画多长」，合成一张表只会让两边都
//! 改错那一格。
//!
//! **easing 的诚实记录**：SDK 的 `Easing` 没有 ease-in——v0.2.4 的离场
//! 加速 `cubic-bezier(0.64,0,0.78,0)` 用 standard（对称 S）近似；进场减速
//! `cubic-bezier(0.22,1,0.36,1)` 与 emphasized 同形。近似只登记在这里，
//! 不再散落在各处注释里。

const std = @import("std");
const native_sdk = @import("native_sdk");
const canvas = native_sdk.canvas;

/// 进场 easing：减速（v0.2.4 的 cubic-bezier(0.22,1,0.36,1) → SDK emphasized）。
pub const enter_easing: canvas.Easing = .emphasized;
/// 离场 easing：加速的最近合法值（模块头注释记了这个近似）。
pub const exit_easing: canvas.Easing = .standard;

/// 面板层进场（v0.2.4 的 --panel-motion）。
pub const panel_enter_ms: u32 = 300;
/// 分栏拖完的 settle：与面板进场同节奏（面板的一切调整一个呼吸），
/// 但名字分开——哪天想让分栏更快，不该碰到面板进场。
pub const split_settle_ms: u32 = 300;
/// 饭盒进场（v0.2.4 的 VerdictBento 260ms）。
pub const bento_enter_ms: u32 = 260;
/// 印点 fade+scale-in（v0.2.4 的 700ms）。
pub const dot_enter_ms: u32 = 700;
/// veil 进场减速与离场上抬淡出。
pub const veil_enter_ms: u32 = 700;
pub const veil_exit_ms: u32 = 400;
/// 呼吸墨线的 easing：对称 S（ping_pong 往返，两端都到）——与离场同值
/// 不同义，名字按用途分开。
pub const breath_easing: canvas.Easing = .standard;
/// 呼吸墨线一次起伏的时长：ping_pong 循环（SDK 动画的 caret-blink 形状）。
pub const ink_breath_ms: u32 = 1600;
/// 呼吸墨线的几何：36×2px（v0.2.4 原值），不透明度在两端之间起伏。
pub const ink_width: f32 = 36;
pub const ink_height: f32 = 2;
pub const ink_dim_opacity: f32 = 0.25;
pub const ink_full_opacity: f32 = 0.9;

test "the named durations keep the v0.2.4 values" {
    try std.testing.expectEqual(@as(u32, 300), panel_enter_ms);
    try std.testing.expectEqual(@as(u32, 300), split_settle_ms);
    try std.testing.expectEqual(@as(u32, 260), bento_enter_ms);
    try std.testing.expectEqual(@as(u32, 700), dot_enter_ms);
    try std.testing.expectEqual(@as(u32, 700), veil_enter_ms);
    try std.testing.expectEqual(@as(u32, 400), veil_exit_ms);
    try std.testing.expectEqual(@as(u32, 1600), ink_breath_ms);
}

test "the easing pair is one decelerate and one near-accelerate" {
    try std.testing.expectEqual(canvas.Easing.emphasized, enter_easing);
    try std.testing.expectEqual(canvas.Easing.standard, exit_easing);
}
