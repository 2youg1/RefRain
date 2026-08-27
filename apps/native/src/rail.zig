// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 功能栏的表面：地与墨同出一门（M12 的链）。
//!
//! **接上哪个功能**：七套主题各自推导的四色 `rail`／`rail-ink`／`rail-faint`／
//! `rail-rule`（`scripts/generate-themes.ts` 是它们的唯一权威，色值在
//! `generated/themes.zig`）。在这个文件出现之前，`generated/themes.zig` 之外
//! 没有一个 Zig 文件读过它们：功能栏画的是 `surface`，离纸只有四级，工具面与
//! 稿子读成同一张纸，舞台规则的两个区不再是可见的区。
//!
//! **在全局逻辑中负责什么**：「功能栏长什么样」这一条规则的唯一权威。
//! 三个平面在生成器的审计里就是分开的（`[rail, paper, sheet]` 的明度跨度是
//! 一条硬门槛），本模块把那三层照搬到绘制上——
//!
//! - **栏是桌面**：`ground` 是桌面本身，`dress` 把它落到一棵子树上；
//! - **桌上的字是栏的墨**：`dress` 递归给 `.text` 叶上 `rail-ink`；
//! - **桌上的物自带地**：卡片、面板、按钮、输入框、可编辑代码面各有各的
//!   地与墨（卡片就是「摊在桌上的一张纸」，生成器里的 sheet 那一层），
//!   所以着墨在它们那里停住，不往里翻。
//!
//! 地与墨没有各自的出口——`dress` 是唯一入口。这正是 M12 记的那一条：
//! 「一个屏不可能只取到一半」，只上地不上墨会发出一栏读不出的字。
//!
//! **能复用什么**：`controlTokens` 交给 `manuscriptTokens` 并进
//! `DesignTokenOverrides`——SDK 自己的 `ControlVisualTokens` 就是「这一类控件
//! 有自己的色寄存器」的机制，行（`list_item`）整类只出现在栏里，所以整类移
//! 过去是准确而不是近似；右键菜单（`menu_item`）浮在正文上，明写纸 register
//! 挡住 SDK 的逐字段回落。
//!
//! **交互设计**：栏是页面的一栏，不是纸上的一只盒子——不取弧边、不取外框
//! （`corners.zig` 的 `.control` 留给手直接作用的控件、`.bento` 留给停在正文
//! 旁的小窗）。分栏由壳里那一条通高细线说，不由任何一层的边说。

const std = @import("std");
const native_sdk = @import("native_sdk");
const core = @import("core.zig");
const corners = @import("corners.zig");
const themes = @import("generated/themes.zig");
const material = @import("material.zig");
const material_paint = @import("material_paint.zig");

const canvas = native_sdk.canvas;
const Color = canvas.Color;
const Theme = themes.Theme;
const Ui = core.App.Ui;

/// 选中一行时印色覆在栏上的浓度。
///
/// 选中是一棵树里唯一需要一眼认出的状态，而印色（accent）是这套主题里
/// 「这一处是重点」的唯一说法——所以选中不另造一个颜色，只把印色以 wash
/// 覆在桌面上。0.34 是覆得住桌面的深浅、又不至于压掉行上的字：更淡时
/// 深色主题上的选中看不出来，更浓时印色开始与 `rail-ink` 争对比。
const selected_wash_alpha: f32 = 0.34;

/// 按下那一瞬的浓度：比选中再实一档，手指抬起就回。
const pressed_wash_alpha: f32 = 0.46;

/// 选中行铺满整行用的同一款 wash。
///
/// **接上哪个功能**：`shell.railTreeRow` 的缩进段。选中底色由 SDK 按
/// `controlTokens` 给行本体，而缩进是行外的一段 stack——不同色就会在
/// 选中行左侧露出一截地（作者把它读成「很难看的浮窗缺了一角」）。
/// 两处共用这一个浓度，选中因此永远是一整条。
pub fn selectedWash(theme: *const Theme) Color {
    return wash(theme, selected_wash_alpha);
}

/// 功能栏的地。**永远实心**，与作者选的面板材质无关。
///
/// 材质表的前提写在 `material.zig` 的模块头里：`surface_mix < 1` 的配方
/// 「只给停在正文旁边的表面」——面板、饭盒、回来卡、菜单、命令面板。那些
/// 表面浮在纸上，所以向纸色折进 (1−mix) 份是它们真实的合成。栏不浮在纸上，
/// 栏是与纸并列的另一面地；向纸折它等于把桌子刷成纸色。实测（tou）：
/// 亚克力把栏地从 #223b60 冲到 #5c6c83，而栏的墨是 M12 按 `rail` 调的，
/// 于是禁用行整类掉到读不出。
///
/// 液态玻璃还多一条：整条带铺满窗高，配方最大的那档背景模糊挂在它上面，
/// 参考渲染器（`automate screenshot`）因此抓不到帧。地实心之后这条带不再
/// 带模糊，材质仍在它被设计的地方生效。
pub fn ground(theme: *const Theme) Color {
    return material_paint.railPaint(.solid, theme);
}

/// 分栏线。它属于栏与正文的分界，不属于任何一层，所以层叠得再深也只有
/// 这一条——壳画它，`layeredBody` 不画。
pub fn rule(theme: *const Theme) Color {
    return theme.rail_rule;
}

/// 完全透明。用在「这里不画东西」而不是「这里画白色」的地方。
fn transparent() Color {
    return Color.rgba(0, 0, 0, 0);
}

/// 把印色按浓度覆成一层 wash。主题没定印色时退回分栏线色——桌面上总有
/// 一档比桌面更亮的颜色可用。
fn wash(theme: *const Theme, alpha: f32) Color {
    var paint = theme.colors.accent orelse theme.rail_rule;
    paint.a = alpha;
    return paint;
}

/// 栏内控件的色寄存器。`manuscriptTokens` 每帧把它并进
/// `DesignTokenOverrides.controls`。
///
/// **为什么可以整类移过去**：`.list_item` 在整个界面里只出现在七个工具屏
/// 内（九个调用点逐个核对过），所以「行 = 栏的行」是事实而不是近似。
/// `.menu_item` 是右键菜单，浮在正文上、坐在纸 register 的菜单面上，
/// 而 SDK 的合并是逐字段回落（`menu_item` 缺的字段读 `list_item`），
/// 所以它必须把每一个字段都明写出来，否则栏色会从回落里漏过去。
pub fn controlTokens(theme: *const Theme) canvas.ControlTokenOverrides {
    const paper = theme.colors.background orelse theme.colors.surface orelse theme.colors.text.?;
    return .{
        .list_item = .{
            .foreground = theme.rail_ink,
            // 读不出的行、此刻用不了的命令：栏的次墨。生成器已按
            // APCA |45| 拦过「侧栏次/侧」，所以这一档在七套主题上都读得出。
            .disabled_foreground = theme.rail_faint,
            .hover_background = theme.rail_rule,
            .active_background = wash(theme, selected_wash_alpha),
            .pressed_background = wash(theme, pressed_wash_alpha),
        },
        .menu_item = .{
            .foreground = theme.colors.text orelse theme.rail_ink,
            .disabled_foreground = theme.colors.text_muted orelse theme.rail_faint,
            .hover_background = theme.colors.surface_subtle orelse paper,
            .active_background = theme.colors.surface_pressed orelse paper,
            .pressed_background = theme.colors.surface_pressed orelse paper,
        },
    };
}

/// 栏的地与分栏线：一次给出，不能只取一半。
pub const Band = struct {
    /// 地：铺满窗高的一条带，画在壳的最底层。
    ground: Ui.Node,
    /// 分栏线：地的右缘，同样铺满窗高。
    rule: Ui.Node,
};

/// 栏的地：从窗口左缘到 `edge_x`、从窗顶到窗底的一条带，右缘立一条
/// 发丝。
///
/// **为什么铺满窗高而不是跟着 body 行**：栏是页面的一栏，一栏到头到尾。
/// 跟着 body 行它就永远够不到窗口的上下缘，读作一只有头有尾的盒子。
/// 材质（背景模糊与透光度）挂在这一条带上，栏内各层因此是透的——
/// 层叠得再深也只有一层地、一条线。
pub fn band(
    ui: *Ui,
    theme: *const Theme,
    edge_x: f32,
    window_height: f32,
) Band {
    var ground_node = ui.el(.stack, .{
        .frame = native_sdk.geometry.RectF.init(0, 0, edge_x, window_height),
    }, .{});
    ground_node.widget.style.background = ground(theme);
    // 栏不取弧边、不取外框：分栏只由右缘那一条发丝说。
    ground_node.widget.style.radius = corners.squared;
    ground_node.widget.style.border = transparent();
    var rule_node = ui.el(.stack, .{
        .frame = native_sdk.geometry.RectF.init(edge_x - 1, 0, 1, window_height),
    }, .{});
    rule_node.widget.style.background = rule(theme);
    return .{ .ground = ground_node, .rule = rule_node };
}

/// 一棵子树穿上栏的衣服：去盒（不取弧边、不取外框、不自带地），
/// 墨递归落到每一片读得出的叶子上。
///
/// **与 `band` 同一个判据**：M12 记下的那一条链是「地换了而墨没换的屏
/// 会发出一栏读不出的字」。两半都住在这一个模块里，且壳用同一个
/// 「这一帧有没有栏」的判据叫它们，所以一个屏不可能只取到一半。
pub fn dress(ui: *Ui, theme: *const Theme, node: Ui.Node) Ui.Node {
    var dressed = node;
    // 地只有一层，就是 `band`。栏内各层必须是透的：`.panel` 不声明背景时
    // SDK 的 chrome 会自己铺一层 `surface`（纸 register），把地盖掉——那一帧
    // 地是纸、墨是栏的墨，整栏字就消失了。真窗探针正是这样抓到它的。
    dressed.widget.style.background = transparent();
    dressed.widget.style.radius = corners.squared;
    dressed.widget.style.border = transparent();
    dressed.nodes = inkChildren(ui, node.nodes, theme);
    return dressed;
}

/// 递归着墨。`ui.arena` 新分配子数组而不是原地改：`Node.nodes` 是
/// `[]const Node`，绕过那个 const 省下的是每帧几百次 arena 分配，
/// 买来的是一条没有人守的假设。分配失败时原样交回——少一次上色，
/// 不是崩一帧。
fn inkChildren(ui: *Ui, nodes: []const Ui.Node, theme: *const Theme) []const Ui.Node {
    if (nodes.len == 0) return nodes;
    const next = ui.arena.alloc(Ui.Node, nodes.len) catch return nodes;
    for (nodes, 0..) |child, index| next[index] = inkNode(ui, child, theme);
    return next;
}

fn inkNode(ui: *Ui, node: Ui.Node, theme: *const Theme) Ui.Node {
    if (ownsItsGround(node.widget.kind)) return node;
    var inked = node;
    if (node.widget.kind == .text and
        node.widget.style.foreground == null and
        node.style_tokens.foreground == null)
    {
        inked.widget.style.foreground = theme.rail_ink;
    }
    inked.nodes = inkChildren(ui, node.nodes, theme);
    return inked;
}

/// 这个部件自带地吗——自带地的部件把它内部的字带回纸 register，着墨
/// 到它为止。
///
/// 卡片、面板与各类浮面是「摊在桌上的一张纸」（生成器审计里的 sheet 那
/// 一层）；可编辑代码面自带语法色板，那套色是按纸调的。控件（按钮、
/// 输入框）不在这张表上，因为它们的字是 `widget.text` 而不是子节点，
/// 递归根本走不进去——它们各自的色寄存器仍归 SDK 的 token 阶梯。
fn ownsItsGround(kind: canvas.WidgetKind) bool {
    return switch (kind) {
        .card,
        .panel,
        .alert,
        .dialog,
        .drawer,
        .sheet,
        .popover,
        .tooltip,
        .menu_surface,
        .dropdown_menu,
        .textarea,
        .input_group,
        => true,
        else => false,
    };
}

test "栏地永远实心，且不等于面板的表面色" {
    const day = &themes.themes[0]; // 濤（昼）
    // 实心：mix = 1，折完仍是 rail 本身，alpha 不透。
    const paint = ground(day);
    try std.testing.expectApproxEqAbs(day.rail.r, paint.r, 0.001);
    try std.testing.expectApproxEqAbs(day.rail.g, paint.g, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 1), paint.a, 0.001);
    // 地不等于面板的表面色——这是 M12 的缺口：改之前两者是同一个值。
    const surface = material_paint.surfacePaint(.solid, day);
    try std.testing.expect(@abs(paint.r - surface.r) + @abs(paint.b - surface.b) > 0.1);
    // 作者选哪档材质都不动栏地：七套主题各验一次。
    for (themes.themes) |theme| {
        const opaque_ground = ground(&theme);
        try std.testing.expectApproxEqAbs(theme.rail.r, opaque_ground.r, 0.001);
        try std.testing.expectApproxEqAbs(@as(f32, 1), opaque_ground.a, 0.001);
    }
}

test "行的寄存器给栏，菜单的寄存器明写成纸——七套主题都不回落" {
    for (themes.themes) |theme| {
        const tokens = controlTokens(&theme);
        try std.testing.expectEqual(theme.rail_ink, tokens.list_item.foreground.?);
        try std.testing.expectEqual(theme.rail_faint, tokens.list_item.disabled_foreground.?);
        // 菜单浮在正文上：每一个字段都必须自己说，不能读行的回落。
        try std.testing.expectEqual(theme.colors.text.?, tokens.menu_item.foreground.?);
        try std.testing.expectEqual(theme.colors.text_muted.?, tokens.menu_item.disabled_foreground.?);
        try std.testing.expect(tokens.menu_item.hover_background != null);
        try std.testing.expect(tokens.menu_item.active_background != null);
        try std.testing.expect(tokens.menu_item.pressed_background != null);
    }
}

test "分栏线读主题自己的 rail-rule，不读纸面的 border" {
    for (themes.themes) |theme| {
        try std.testing.expectEqual(theme.rail_rule, rule(&theme));
    }
}

test "自带地的部件到此为止，其余的字都上栏的墨" {
    try std.testing.expect(ownsItsGround(.card));
    try std.testing.expect(ownsItsGround(.textarea));
    try std.testing.expect(!ownsItsGround(.column));
    try std.testing.expect(!ownsItsGround(.text));
    try std.testing.expect(!ownsItsGround(.list_item));
}
