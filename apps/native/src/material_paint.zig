// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 面板材质的绘制一侧：把 `material.zig` 的配方表变成像素。
//!
//! **接上哪个功能**：`material.zig` 的 `recipe`——本文件是它唯一的读者。
//! 两文件各有各的变化理由：那边调材质数值，这里不动；这里改绘制通道
//! （SDK 字段、chrome 纪律、渐变几何），那边不动。数值的唯一权威在
//! 那边，本文件不持有第二个数。
//!
//! **在全局逻辑中负责什么**：三条换算——表面色（`surfacePaint`，
//! 「为什么给混合比不给裸 alpha」的语义归 `material.zig` 的模块头，
//! 这里只做换算）、部件赋值（`apply`，与 SDK Widget 的适配胶）、
//! sheen/顶缘高光的绘制计划（`paintSheen`，chrome suffix_commands
//! 通道，veil 同款）。颜色只读 `generated/themes.zig` 的纸/表面/描边
//! 三色（带 alpha 的派生，与 veil 同一条纪律），弧边内缩量读
//! `corners.zig`。
//!
//! **能复用什么**：`Widget.backdrop_blur` 是 SDK 部件的真背景模糊字段
//! （采样 framebuffer），直接赋——先例是 `editor.widget.text_size`。
//! `style.background`／`style.border` 是 per-widget 覆盖，优先于 token
//! fallback（widget_render_style.zig）。渐变停点的双槽轮换复用 veil 的
//! 借用纪律。

const std = @import("std");
const native_sdk = @import("native_sdk");
const corners = @import("corners.zig");
const themes = @import("generated/themes.zig");
const material = @import("material.zig");

const canvas = native_sdk.canvas;
const geometry = native_sdk.geometry;
const Color = canvas.Color;
const Theme = themes.Theme;
const Kind = material.Kind;

/// sheen 带的高度（px）：两行界面文字的量级。再小渐变看不见，
/// 再大压到面板顶部的内容。
pub const sheen_height: f32 = 24;
/// 顶缘高光带的高度（px）：一根头发丝。
pub const edge_height: f32 = 1;
/// 高光与面板顶的距离（px）：让开 panel chrome 自己画的那根 1px 描边，
/// 高光贴着它内侧，而不是盖在它上。
pub const edge_inset: f32 = 1;

/// 主题的纸色。生成的色表七套都定义 background/surface/text——
/// 缺一是生成器的 bug，panic 比画一块错色诚实。
fn paperOf(theme: *const Theme) Color {
    return theme.colors.background orelse
        theme.colors.surface orelse
        theme.colors.text orelse unreachable;
}

/// 表面色：向纸色折进 (1−mix) 份再盖上，alpha 取混合比本身
/// （换算的理由见 `material.zig` 的模块头）。
pub fn surfacePaint(kind: Kind, theme: *const Theme) Color {
    return planePaint(kind, theme.colors.surface orelse paperOf(theme), theme);
}

/// 功能栏的地：同一份配方，折的是主题自己的 `rail` 那一面。
///
/// 分成两个入口而不是一个带参数的：调用点说的是「这是哪一面」，
/// 不是「折哪个颜色」——两处读者各自具名，材质语言仍然只有一条。
pub fn railPaint(kind: Kind, theme: *const Theme) Color {
    return planePaint(kind, theme.rail, theme);
}

/// 配方折算本身：任何一面向纸色折进 (1−mix) 份再盖上，alpha 取混合比。
fn planePaint(kind: Kind, plane: Color, theme: *const Theme) Color {
    const paper = paperOf(theme);
    const mix = material.recipe(kind).surface_mix;
    var paint = blend(paper, plane, mix);
    paint.a = mix;
    return paint;
}

/// 描边色：主题的 border，alpha 按配方退。七套主题都定义 border。
pub fn borderPaint(kind: Kind, theme: *const Theme) Color {
    var paint = theme.colors.border orelse paperOf(theme);
    paint.a = material.recipe(kind).border_alpha;
    return paint;
}

/// rgb 的线性折：a×(1−t) + b×t。alpha 不在这里折——它由配方单独给。
fn blend(a: Color, b: Color, t: f32) Color {
    return .{
        .r = a.r * (1.0 - t) + b.r * t,
        .g = a.g * (1.0 - t) + b.g * t,
        .b = a.b * (1.0 - t) + b.b * t,
        .a = 1,
    };
}

/// 一行接线：把材质落到一个 panel 类部件上——背景模糊半径、表面色、
/// 描边色（`material_paint.apply(&panel.widget, kind, theme)`，先例同
/// `editor.widget.text_size` 的直接赋值）。
///
/// 投影不在此列：SDK 的 panel chrome 只在不透明填充下自己带投影，
/// 半透明材质按 SDK 纪律不投（见配方表 `shadow_blur` 的注）。
pub fn apply(widget: *canvas.Widget, kind: Kind, theme: *const Theme) void {
    widget.backdrop_blur = material.recipe(kind).blur_radius;
    widget.style.background = surfacePaint(kind, theme);
    widget.style.border = borderPaint(kind, theme);
}

/// sheen 停点按帧填：offset 是表，颜色随主题（纸色 + 停点 alpha，
/// 与 veil 同一个光源）。双槽轮换而不是单缓冲：SDK 可能对上一帧的
/// 显示列表做 diff，重写唯一缓冲会让旧列表读到新值（与 veil、
/// project_request 的池同一条借用纪律）。
var stops_pool: [2][material.max_sheen_stops]canvas.GradientStop = undefined;
var stops_slot: usize = 0;

fn sheenStops(r: material.Recipe, theme: *const Theme) []canvas.GradientStop {
    stops_slot = (stops_slot + 1) % stops_pool.len;
    const stops = stops_pool[stops_slot][0..r.sheen_offsets.len];
    const paper = paperOf(theme);
    for (r.sheen_offsets, r.sheen_alphas, 0..) |offset, alpha, index| {
        var color = paper;
        color.a = alpha;
        stops[index] = .{ .offset = offset, .color = color };
    }
    return stops;
}

/// 顶部光泽的绘制计划：sheen 渐变 + 顶缘高光，恒发两条命令。
///
/// **接在哪里**：chrome 的 suffix_commands（veil 那条通道）——画在
/// 部件树之后、不进命中树。恒两条是 SDK 的 exact 纪律（命令数漂移是
/// teaching error）：不画的那条发零尺寸透明命令占位，suffix_commands
/// 的数目因此可按常量声明。
///
/// 左右两端按 `scale` 的半径内缩：sheen 与高光是直角矩形，不探出
/// 面板弧边（corners.zig）的两个上角。ids 由调用方给稳定常量——
/// 每个表面一组，diff 与渲染动画按它寻址。
pub fn paintSheen(
    builder: *canvas.Builder,
    kind: Kind,
    rect: geometry.RectF,
    scale: corners.Scale,
    theme: *const Theme,
    ids: [2]u64,
) anyerror!void {
    const r = material.recipe(kind);
    const visible = rect.width > 0 and rect.height > 0;
    const inset = @min(scale.radius(), rect.width / 2);
    if (r.sheen_offsets.len == 0 or !visible) {
        try builder.fillRect(.{
            .id = ids[0],
            .rect = geometry.RectF.zero(),
            .fill = .{ .color = Color.rgba8(0, 0, 0, 0) },
        });
    } else {
        const band = geometry.RectF.init(
            rect.x + inset,
            rect.y,
            rect.width - 2 * inset,
            @min(sheen_height, rect.height),
        );
        try builder.fillRect(.{
            .id = ids[0],
            .rect = band,
            .fill = .{ .linear_gradient = .{
                .start = geometry.PointF.init(band.x, band.y),
                .end = geometry.PointF.init(band.x, band.y + band.height),
                .stops = sheenStops(r, theme),
            } },
        });
    }
    if (r.edge_alpha <= 0 or !visible) {
        try builder.fillRect(.{
            .id = ids[1],
            .rect = geometry.RectF.zero(),
            .fill = .{ .color = Color.rgba8(0, 0, 0, 0) },
        });
    } else {
        var edge = paperOf(theme);
        edge.a = r.edge_alpha;
        try builder.fillRect(.{
            .id = ids[1],
            .rect = geometry.RectF.init(
                rect.x + inset,
                rect.y + edge_inset,
                rect.width - 2 * inset,
                edge_height,
            ),
            .fill = .{ .color = edge },
        });
    }
}

test "表面色：实心是表面色本身，亚克力折进纸色——昼夜两套都成立" {
    const day = &themes.themes[0]; // 濤（昼）
    var night = themes.bySlug("sumi"); // 墨（夜）
    // 实心：mix = 1，折完仍是表面色，alpha 1——纸不透。
    const solid_day = surfacePaint(.solid, day);
    try std.testing.expectApproxEqAbs(day.colors.surface.?.r, solid_day.r, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 1), solid_day.a, 0.001);
    // 亚克力：rgb = 纸×0.15 + 表面×0.85，alpha 取混合比本身。
    const acrylic_day = surfacePaint(.acrylic, day);
    const paper = day.colors.background.?;
    const surface = day.colors.surface.?;
    try std.testing.expectApproxEqAbs(paper.r * 0.15 + surface.r * 0.85, acrylic_day.r, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 0.85), acrylic_day.a, 0.001);
    // 夜间主题：折进纸色让 paint ≠ 裸表面色——「裸 alpha 夜间会糊」的
    // 那条换算在这里生效。夜间纸色比表面更深，折完 b 通道被拉向纸。
    const acrylic_night = surfacePaint(.acrylic, &night);
    const night_paper = night.colors.background.?;
    const night_surface = night.colors.surface.?;
    try std.testing.expectApproxEqAbs(
        night_paper.b * 0.15 + night_surface.b * 0.85,
        acrylic_night.b,
        0.001,
    );
    try std.testing.expect(acrylic_night.b < night_surface.b);
    try std.testing.expect(acrylic_night.r >= 0 and acrylic_night.r <= 1);
}

test "描边色取主题 border，alpha 按配方退" {
    const day = &themes.themes[0];
    const liquid = borderPaint(.liquid, day);
    try std.testing.expectApproxEqAbs(day.colors.border.?.r, liquid.r, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 0.35), liquid.a, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 1), borderPaint(.solid, day).a, 0.001);
}

test "apply 落到部件：模糊半径、背景、描边各归各位" {
    const day = &themes.themes[0];
    var widget = canvas.Widget{ .kind = .panel };
    apply(&widget, .acrylic, day);
    try std.testing.expectEqual(@as(f32, 16), widget.backdrop_blur);
    try std.testing.expectApproxEqAbs(@as(f32, 0.85), widget.style.background.?.a, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 0.60), widget.style.border.?.a, 0.001);
    // 实心：模糊 0、背景不透明（SDK 因此自动带投影）、描边全强。
    var solid_widget = canvas.Widget{ .kind = .panel };
    apply(&solid_widget, .solid, day);
    try std.testing.expectEqual(@as(f32, 0), solid_widget.backdrop_blur);
    try std.testing.expectEqual(@as(f32, 1), solid_widget.style.background.?.a);
}

test "paintSheen 恒发两条命令：有料画渐变与高光，没料画零尺寸占位" {
    const day = &themes.themes[0];
    const rect = geometry.RectF.init(16, 12, 400, 200);
    // 液态：sheen 是三停线性渐变，顶缘高光 alpha 0.30。
    var commands: [2]canvas.CanvasCommand = undefined;
    var builder = canvas.Builder{ .commands = &commands };
    try paintSheen(&builder, .liquid, rect, .panel, day, .{ 101, 102 });
    try std.testing.expectEqual(@as(usize, 2), builder.len);
    const sheen = commands[0].fill_rect;
    try std.testing.expectEqual(@as(u64, 101), sheen.id);
    const stops = sheen.fill.linear_gradient.stops;
    try std.testing.expectEqual(@as(usize, 3), stops.len);
    try std.testing.expectApproxEqAbs(@as(f32, 0.30), stops[0].color.a, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 0), stops[2].color.a, 0.001);
    // 高光在顶缘内侧（让开 1px 描边），高 1px，alpha 取表；两端按
    // panel 半径内缩，不探出弧边的上角。
    const edge = commands[1].fill_rect;
    try std.testing.expectApproxEqAbs(rect.y + edge_inset, edge.rect.y, 0.001);
    try std.testing.expectApproxEqAbs(edge_height, edge.rect.height, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 0.30), edge.fill.color.a, 0.001);
    try std.testing.expectApproxEqAbs(rect.x + corners.Scale.panel.radius(), edge.rect.x, 0.001);

    // 实心：两条零尺寸透明占位——命令数不变（SDK 的 exact 纪律）。
    var placeholders: [2]canvas.CanvasCommand = undefined;
    var solid_builder = canvas.Builder{ .commands = &placeholders };
    try paintSheen(&solid_builder, .solid, rect, .panel, day, .{ 201, 202 });
    try std.testing.expectEqual(@as(usize, 2), solid_builder.len);
    for (placeholders) |command| {
        try std.testing.expect(command.fill_rect.rect.isEmpty());
        try std.testing.expectApproxEqAbs(@as(f32, 0), command.fill_rect.fill.color.a, 0.001);
    }
}
