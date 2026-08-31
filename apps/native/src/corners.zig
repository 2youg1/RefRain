// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 曲率连续的弧边（超椭圆）：RefRain 所有非网格表面的形状权威。
//!
//! **接上哪个功能**：面板、卡片、按钮、饭盒、胶囊——凡是要圆角的表面。
//! 迁自旧前端 `apps/desktop/src/shell/corners.ts`；SDK 只有正圆半径
//! （`RadiusTokens` 的 sm/md/lg/xl），画不出曲率连续的角。
//!
//! **在全局逻辑中负责什么**：一处回答三件事——各档叫什么、路径怎么算、
//! 每档取到第几阶。这三件事散在三处就会漂开，样式里二十九个裸半径数字
//! 每个单看都对，合起来说不清「面板与按钮的角为什么不一样」。
//!
//! **能复用什么**：`path()` 输出 SDK 的 `PathElement`，任何要描边或填充的
//! 部件直接用；不必先转成字符串再解析。
//!
//! ## 为什么不是正圆角
//!
//! 正圆弧在直边交接处曲率从 0 突变到 1/r——G1 连续（切线连续、曲率不连续）。
//! 眼睛看得见：角落那一小段显得比周围「紧」，一排卡片并排时像被啃了一口。
//! 超椭圆 `|x/a|^n + |y/b|^n = 1` 让曲率长出来而不是跳上去。
//!
//! ## 连续阶由指数决定，不是「够方就叫 G4」
//!
//! 拐角与直边相接处曲率沿弧长的行为是 κ ∝ s^(n−2)，连续性阶数取决于 κ 从
//! 第几阶导数开始跳变：
//!
//! | n | κ 的行为 | 从哪一阶跳变 | 阶 |
//! |---|---|---|---|
//! | 2 | κ 为常数 | κ 本身 | G1 |
//! | 3 | κ ∝ s | κ′ | G2 |
//! | 4 | κ ∝ s² | κ″ | G3 |
//! | 5 | κ ∝ s³ | κ‴ | **G4** |
//!
//! 所以 G4 要 n = 5。旧代码一度写着「n ≈ 4~5 就是 G4」，那是把「拐角够顺」
//! 当成阶数判据——n = 4.2 实际约 G3.2，一个非整数阶。名字要么给得准，
//! 要么别给：一个叫 G4 而实为 G3.2 的模块，会让后来的人以为这个问题已经
//! 解决到那一档了。

const std = @import("std");
const native_sdk = @import("native_sdk");
const geometry = native_sdk.geometry;
const PointF = geometry.PointF;
const RectF = geometry.RectF;
const PathElement = native_sdk.canvas.PathElement;
const PathVerb = native_sdk.canvas.PathVerb;

/// 一档角。名字说的是**用在什么上**，不是它有多大。
pub const Scale = enum {
    /// 小饭盒：右键菜单、待解决面板这类停在正文旁边的小窗口。
    bento,
    /// 面板：占一整条竖带的表面。
    panel,
    /// 卡片：列表里的一格。
    card,
    /// 控件：按钮、输入框、标签。
    control,
    /// 徽标：计数、圆点这类必须读作圆的东西。
    pill,

    /// 名义半径（px）：超椭圆在轴向上的半长。
    ///
    /// `pill` 用一个大到必然被尺寸钳住的值，因为「胶囊」的意思是半径取到
    /// 短边的一半，而不是某个具体像素。
    pub fn radius(self: Scale) f32 {
        return switch (self) {
            .bento => 12,
            .panel => 10,
            .card => 7,
            .control => 5,
            .pill => 999,
        };
    }

    /// 超椭圆指数。决定连续阶：κ ∝ s^(n−2)，n = 5 才是 G4。
    ///
    /// 各档按「这一档需要到哪一阶」定，不按「看起来够不够顺」——后者是感受，
    /// 前者可以被门禁验证。
    pub fn exponent(self: Scale) f32 {
        return switch (self) {
            // 饭盒停在正文旁边，与正文那条直边并排——曲率突变在这种并排关系里
            // 最显眼，所以它是唯一需要 G4 的一档。
            .bento => 5,
            // 面板占一整条竖带，它的角旁边没有别的直边可比，G3 足够。
            .panel => 4,
            // 列表里的一格：数量多、尺寸小，G2 已经看不出突变。
            .card => 3,
            .control => 3,
            // 徽标必须读作一个圆，所以退回正圆。给它超椭圆会让一个本该是圆点的
            // 东西看起来像被压扁的方块。
            .pill => 2,
        };
    }

    /// 这一档的曲率连续阶。
    ///
    /// κ 从第 (n−2) 阶导数开始跳变，所以阶数是 n − 1。非整数指数给出非整数阶
    /// （n = 4.2 → 约 G3.2），如实返回而不取整——取整会把「差一点」说成「到了」。
    pub fn continuity(self: Scale) f32 {
        return self.exponent() - 1;
    }
};

/// 不取角。
///
/// 这不是又一档角，是角的缺席，所以它不在 `Scale` 里。它存在是为了让
/// 「这个表面不是盒子」也有一个可引用的名字——写 `0` 只是一个数，
/// 下一个人不知道那是裁定还是漏写。
///
/// **裁定**：只有手直接作用的东西才取盒子的形状——按钮与输入框
/// （`.control`），以及浮在正文旁边的小窗（`.bento`、`.panel`）。
/// 导轨树里的一行不是盒子：它靠向右缩进和行底色说自己在哪一层。
/// 给每一行一个圆角方块，整屏就读成一叠饭盒，层级反而看不出来。
pub const squared: f32 = 0;

/// 每个角采样多少点。
///
/// 12 点在 12px 的角上已经看不出与更密采样的差别，而元素数量随之线性增长——
/// 这条路径每帧都要走一遍。
pub const corner_samples: usize = 12;

/// 一条闭合路径需要多少个元素：四个角各 `corner_samples` 点，加收尾的 `close`。
///
/// 第一个采样点本身就是 `move_to`，不额外占一格——把它算成两格会让缓冲区
/// 的拒绝阈值差一位，而那一位只在恰好卡边时才看得出来。
pub const max_elements: usize = corner_samples * 4 + 1;

/// 把一档角画在一个矩形上，写进调用方给的缓冲区。
///
/// 返回写入的元素切片。缓冲区不足时返回 null，而不是截断——半条路径画出来
/// 是一个缺口，比不画更糟。
///
/// 半径按短边的一半钳住：`pill` 的 999 因此在任何尺寸上都得到胶囊，
/// 而一个比自己还小的圆角不会把两个角画到交叉。
pub fn path(scale: Scale, rect: RectF, out: []PathElement) ?[]const PathElement {
    if (out.len < max_elements) return null;
    const half_min = @min(rect.width, rect.height) / 2;
    const r = @min(scale.radius(), half_min);
    if (r <= 0) return null;
    const n = scale.exponent();
    // 超椭圆的参数式：单位角上 x = |cos t|^(2/n)，y = |sin t|^(2/n)。
    const power = 2.0 / n;

    var count: usize = 0;
    // 四个角的圆心与象限方向。次序是右下、左下、左上、右上，与顺时针一致。
    const corners = [4][4]f32{
        .{ rect.x + rect.width - r, rect.y + rect.height - r, 1, 1 },
        .{ rect.x + r, rect.y + rect.height - r, -1, 1 },
        .{ rect.x + r, rect.y + r, -1, -1 },
        .{ rect.x + rect.width - r, rect.y + r, 1, -1 },
    };
    for (corners, 0..) |corner, corner_index| {
        const cx = corner[0];
        const cy = corner[1];
        const sx = corner[2];
        const sy = corner[3];
        var sample: usize = 0;
        while (sample < corner_samples) : (sample += 1) {
            // 每个角走四分之一圈。终点包含在内，所以除以 (samples − 1)。
            const t = (@as(f32, @floatFromInt(sample)) /
                @as(f32, @floatFromInt(corner_samples - 1))) *
                (std.math.pi / 2.0);
            // 象限内 cos/sin 均非负，取绝对值只为避免浮点噪声产生负底数。
            const ux = std.math.pow(f32, @abs(@cos(t)), power);
            const uy = std.math.pow(f32, @abs(@sin(t)), power);
            // 右下角从「正右」走到「正下」；其余象限靠 sx/sy 镜像，
            // 所以四个角共用同一段采样代码。
            const point = PointF.init(cx + sx * r * ux, cy + sy * r * uy);
            const verb: PathVerb = if (corner_index == 0 and sample == 0) .move_to else .line_to;
            out[count] = .{ .verb = verb, .points = .{ point, PointF.zero(), PointF.zero() } };
            count += 1;
        }
    }
    out[count] = .{ .verb = .close };
    count += 1;
    return out[0..count];
}

/// 一档角的名义半径，供 SDK 的半径 token 取用。
///
/// **接上哪个功能**：SDK 自绘的每一个表面——右键菜单、下拉、对话框、卡片、
/// 按钮。它们的圆角读 `DesignTokens.radius` 的四档，而那四档的默认值
/// （6/8/10/14）与 RefRain 的角权威无关。把两者接起来，菜单与面板的角就
/// 与正文旁边的饭盒同源，不必为它们各写一遍描边。
///
/// **为什么只给半径不给曲率**：SDK 按半径画正圆角，接口里没有指数。给它
/// 我们的半径已经让「大小」统一；曲率连续留给我们自绘的表面（`path()`）。
/// 把这条说清楚，好过让后来的人以为菜单也是 G4。
pub fn radiusTokens() native_sdk.canvas.RadiusTokenOverrides {
    return .{
        .sm = Scale.control.radius(),
        .md = Scale.card.radius(),
        .lg = Scale.panel.radius(),
        .xl = Scale.bento.radius(),
    };
}

test "不取角是裁定，不是某一档角碰巧为零" {
    // 这条守的是「树里的一行不是盒子」：`squared` 必须真的是零，而五档角
    // 必须都不是零——若哪天某一档被调成 0，调用点就会分不清自己要的是
    // 「没有角」还是「那一档刚好为零」，两个意思一旦重叠就再也分不开。
    try std.testing.expectEqual(@as(f32, 0), squared);
    inline for (.{ Scale.bento, Scale.panel, Scale.card, Scale.control, Scale.pill }) |scale| {
        try std.testing.expect(scale.radius() != squared);
    }
}

test "the SDK radius tokens come from the one corner authority" {
    // 两套半径各写一份就会漂开：菜单圆一点、面板方一点，而两边单看都对。
    const overrides = radiusTokens();
    try std.testing.expectEqual(Scale.control.radius(), overrides.sm.?);
    try std.testing.expectEqual(Scale.card.radius(), overrides.md.?);
    try std.testing.expectEqual(Scale.panel.radius(), overrides.lg.?);
    try std.testing.expectEqual(Scale.bento.radius(), overrides.xl.?);
    // 四档全部具名覆盖：留一个 null 的表现是那一类表面悄悄退回 SDK 默认，
    // 而它与我们的某一档碰巧相同（panel 与 lg 都是 10），所以看不出来。
    // 这条守的正是「接上了」而不是「碰巧相同」。
    const applied = overrides.apply(.{});
    try std.testing.expectEqual(Scale.bento.radius(), applied.xl);
    try std.testing.expectEqual(Scale.card.radius(), applied.md);
    try std.testing.expect(applied.xl != (native_sdk.canvas.RadiusTokens{}).xl);
}

test "G4 is n = 5, and each scale reports the order it actually reaches" {
    // 这条守的是那次纠错：叫 G4 就必须是 n = 5，不是「看起来够顺」。
    try std.testing.expectEqual(@as(f32, 5), Scale.bento.exponent());
    try std.testing.expectEqual(@as(f32, 4), Scale.bento.continuity());
    try std.testing.expectEqual(@as(f32, 3), Scale.panel.continuity());
    try std.testing.expectEqual(@as(f32, 2), Scale.card.continuity());
    // 胶囊退回正圆：G1。给它超椭圆会让一个圆点看起来像压扁的方块。
    try std.testing.expectEqual(@as(f32, 2), Scale.pill.exponent());
    try std.testing.expectEqual(@as(f32, 1), Scale.pill.continuity());
}

test "a superellipse corner bulges past the circular arc it replaces" {
    // 判据不是「画出来好看」，而是同一半径下超椭圆比正圆更靠外——那正是
    // 曲率被摊开的表现。取角上 45° 那一点比较。
    var square: [max_elements]PathElement = undefined;
    var round: [max_elements]PathElement = undefined;
    const rect = RectF.init(0, 0, 200, 200);
    const bento = path(.bento, rect, &square).?;
    const pill = path(.pill, rect, &round).?;

    // 每个角的中间那一点就是 45°。右下角是第一个角。
    const mid = corner_samples / 2;
    const bento_point = bento[mid].points[0];
    const pill_point = pill[mid].points[0];
    // pill 的半径被钳到 100，bento 是 12，所以直接比坐标没有意义；
    // 改比「离各自圆心多远」相对于各自半径的比值。
    const bento_r: f32 = 12;
    const pill_r: f32 = 100;
    const bento_cx = 200 - bento_r;
    const bento_cy = 200 - bento_r;
    const pill_cx = 200 - pill_r;
    const pill_cy = 200 - pill_r;
    const bento_reach = std.math.hypot(bento_point.x - bento_cx, bento_point.y - bento_cy) / bento_r;
    const pill_reach = std.math.hypot(pill_point.x - pill_cx, pill_point.y - pill_cy) / pill_r;
    // 正圆在任何角度上 reach 都是 1；超椭圆在 45° 上必然大于 1。
    try std.testing.expectApproxEqAbs(@as(f32, 1), pill_reach, 0.001);
    try std.testing.expect(bento_reach > 1.05);
}

test "the path closes, stays inside its rect, and refuses a buffer it would overrun" {
    var buffer: [max_elements]PathElement = undefined;
    const rect = RectF.init(10, 20, 300, 120);
    const elements = path(.panel, rect, &buffer).?;

    try std.testing.expectEqual(@as(usize, max_elements), elements.len);
    try std.testing.expectEqual(PathVerb.move_to, elements[0].verb);
    try std.testing.expectEqual(PathVerb.close, elements[elements.len - 1].verb);
    for (elements[1 .. elements.len - 1]) |element| {
        try std.testing.expectEqual(PathVerb.line_to, element.verb);
    }
    // 每个点都在矩形内：一个越界的角会被裁掉，而裁掉的样子与「角太小」难以区分。
    for (elements[0 .. elements.len - 1]) |element| {
        try std.testing.expect(element.points[0].x >= rect.x - 0.01);
        try std.testing.expect(element.points[0].x <= rect.x + rect.width + 0.01);
        try std.testing.expect(element.points[0].y >= rect.y - 0.01);
        try std.testing.expect(element.points[0].y <= rect.y + rect.height + 0.01);
    }

    // 缓冲区差一个就拒绝，而不是画半条路径留一个缺口。
    var tight: [max_elements - 1]PathElement = undefined;
    try std.testing.expect(path(.panel, rect, &tight) == null);
    // 尺寸为零的矩形没有形状可画。
    try std.testing.expect(path(.panel, RectF.init(0, 0, 0, 0), &buffer) == null);
}

test "the radius is clamped to half the short side so a pill reads as a pill" {
    var buffer: [max_elements]PathElement = undefined;
    // 40 高的胶囊：999 的名义半径必须被钳到 20，否则两个角会画到交叉。
    const elements = path(.pill, RectF.init(0, 0, 200, 40), &buffer).?;
    for (elements[0 .. elements.len - 1]) |element| {
        try std.testing.expect(element.points[0].y >= -0.01);
        try std.testing.expect(element.points[0].y <= 40.01);
    }
    // 左右两端各自到达外缘：胶囊的两头是半圆，不是被削平的方角。
    var min_x: f32 = 1000;
    var max_x: f32 = -1000;
    for (elements[0 .. elements.len - 1]) |element| {
        min_x = @min(min_x, element.points[0].x);
        max_x = @max(max_x, element.points[0].x);
    }
    try std.testing.expectApproxEqAbs(@as(f32, 0), min_x, 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 200), max_x, 0.01);
}
