//! 面板材质：solid / acrylic / liquid——同一表面的三种「密度」，不是三套皮肤。
//! 本文件是这个功能的门面与唯一数值权威：Kind 与配方表，纯数据，零依赖。
//!
//! **接上哪个功能**：Rust 配置 `appearance.panel_material`
//! （crates/refrain-store/src/config.rs，serde kebab-case）。那边的注释明说
//! 「数字住在渲染器」——这里就是那个渲染器侧的唯一权威：配置只记选择，
//! 全部数值只活在本文件的配方表里。串过界后由 `kindFromKebab` 接住。
//!
//! **在全局逻辑中负责什么**：一张配方表（`recipe`），别的什么都没有。
//! 把表变成像素是另一个文件的活：`material_paint.zig`（表面色换算、部件
//! 赋值 `apply`、sheen/高光的绘制计划）。两个文件各有各的变化理由——
//! 调材质数值不改绘制，改绘制通道（SDK 字段、chrome 纪律、渐变几何）
//! 不改数值——所以分开住，谁也不牵连谁。
//!
//! ## 三种密度：透光度递增
//!
//! solid 是纸（不透），acrylic 是磨砂玻璃（厚、透光少），liquid 是液态
//! 玻璃（薄、透光多、有边缘光）。表里每一列沿同一个方向单调：混合比与
//! 描边递减，模糊、sheen、高光递增——查表的人一眼能验出「密度」这个
//! 语义没有被哪一格破坏。
//!
//! ## 正文区永远实心（红线）
//!
//! 正文轨（`documentView` 的编辑面）不使用本表：半透明的正文底下透出
//! 别的字是可读性事故，不是风格。配方表因此没有「正文」用法——
//! `surface_mix < 1` 的配方只给停在正文旁边的表面：面板、饭盒、回来卡、
//! 菜单、命令面板。
//!
//! ## 为什么表面色给「混合比」而不是裸 alpha
//!
//! 裸 alpha 的合成是 backdrop×(1−a) + surface×a——观感随背后内容漂移。
//! 七套主题里有两套夜间主题：半透明的深色表面盖上透上来的深色文字，
//! 糊成一片。所以表里这一列是「表面色与纸色的混合比」：先把 (1−mix) 份
//! 纸色折进表面色本身，再以 mix 为 alpha 盖上。一份保底的纸色因此在任何
//! backdrop 上都参与合成，七套主题横向可比——与 veil 只用纸色做渐变
//! 能在昼夜都成立是同一条换算。换算的代码在 `material_paint.zig`，
//! 换算为什么是这样，归这里说。

const std = @import("std");

/// 一种密度。与 Rust `PanelMaterial` 的三个变体一一对应。
pub const Kind = enum { solid, acrylic, liquid };

/// 从 serde 的 kebab 串还原材质。未知串 → solid——与 Rust 的 `#[default]`
/// （config.rs：「Solid by default: it costs nothing to draw」）同一句：
/// 一个没听说过的材质绝不换成更贵的画法；实心什么都不依赖（无模糊、
/// 无叠加），永远画得出来。
pub fn kindFromKebab(name: []const u8) Kind {
    if (std.mem.eql(u8, name, "acrylic")) return .acrylic;
    if (std.mem.eql(u8, name, "liquid")) return .liquid;
    return .solid;
}

/// 一种材质的全部数值。唯一的字面量出处是 `recipe` 的表与紧挨它的
/// 停点表；`material_paint.zig` 只做换算，不持有第二个数。
pub const Recipe = struct {
    /// 表面色与纸色的混合比，同时是盖上时的 alpha（换算见模块头）。
    surface_mix: f32,
    /// 背景模糊半径（px）：SDK `Widget.backdrop_blur` 的取值。
    blur_radius: f32,
    /// 顶部 sheen 渐变的停点：offset ∈ [0,1] 单调递增，alpha ∈ [0,1]。
    /// 空表 = 不画（绘制侧发零尺寸命令占位）。
    sheen_offsets: []const f32,
    sheen_alphas: []const f32,
    /// 顶缘高光的不透明度（0 = 不画）。
    edge_alpha: f32,
    /// 描边不透明度：密度越低，边缘越少靠描边、越多靠高光定义。
    border_alpha: f32,
    /// 投影深度（模糊半径 px，0 = 不投影）。
    shadow_blur: f32,
};

/// 亚克力的 sheen：一道弱光，压在面板顶就收掉。
const acrylic_sheen_offsets = [2]f32{ 0.0, 1.0 };
const acrylic_sheen_alphas = [2]f32{ 0.10, 0.0 };
/// 液态玻璃的 sheen：三停——顶上最亮，中段留一点余光再收没，比两停
/// 更像「一道光扫过有厚度的表面」。
const liquid_sheen_offsets = [3]f32{ 0.0, 0.5, 1.0 };
const liquid_sheen_alphas = [3]f32{ 0.22, 0.06, 0.0 };

/// 停点数的表上限（liquid 的三停）。绘制侧的停点池按它开。
pub const max_sheen_stops: usize = 3;

/// 配方表：本模块唯一的字面量出处。三行沿「透光度递增」单调——
/// 混合比与描边递减，模糊、sheen、高光递增。
pub fn recipe(kind: Kind) Recipe {
    return switch (kind) {
        // 纸：不透（混合比 1 = 全表面色），不模糊，不光——纸的质感来自
        // 颜色本身与一根全强描边。投影 8 是登记不是新画：SDK 的 panel
        // chrome 在不透明填充下自动带上 tokens.shadow.sm（blur 8，
        // widget_render_surfaces.zig），这一格与它同值，免得两张表各说各话。
        .solid => .{
            .surface_mix = 1.0,
            .blur_radius = 0,
            .sheen_offsets = &.{},
            .sheen_alphas = &.{},
            .edge_alpha = 0,
            .border_alpha = 1.0,
            .shadow_blur = 8,
        },
        // 磨砂玻璃：85% 靠自己，透上来的 15% 先经 16px 模糊——一个正文
        // 字号量级的模糊让背后的笔画像霜：看得见层次，读不出内容。
        // 描边退到 0.60：边缘开始由「面与光」定义，描边只是底线。
        .acrylic => .{
            .surface_mix = 0.85,
            .blur_radius = 16,
            .sheen_offsets = &acrylic_sheen_offsets,
            .sheen_alphas = &acrylic_sheen_alphas,
            .edge_alpha = 0.12,
            .border_alpha = 0.60,
            // SDK 纪律：透明填充不投影（投影会读成一块透出来的暗斑）。
            .shadow_blur = 0,
        },
        // 液态玻璃：55% 靠自己，近一半交给后面；32px（两个字号量级）
        // 的模糊让背后只剩色块与明暗的流动。0.30 的边缘高光是这种材质
        // 的签名——棱上那道亮线让「薄」读得出来；描边再退到 0.35。
        .liquid => .{
            .surface_mix = 0.55,
            .blur_radius = 32,
            .sheen_offsets = &liquid_sheen_offsets,
            .sheen_alphas = &liquid_sheen_alphas,
            .edge_alpha = 0.30,
            .border_alpha = 0.35,
            .shadow_blur = 0,
        },
    };
}

test "kebab 串解析：三个名字各归各位，未知串落实心" {
    try std.testing.expectEqual(Kind.solid, kindFromKebab("solid"));
    try std.testing.expectEqual(Kind.acrylic, kindFromKebab("acrylic"));
    try std.testing.expectEqual(Kind.liquid, kindFromKebab("liquid"));
    // 未知串 → solid：与 Rust 的 #[default] 同一句——没听说过的材质
    // 绝不换成更贵的画法。空串、拼错的、未来的第四种都一样。
    try std.testing.expectEqual(Kind.solid, kindFromKebab(""));
    try std.testing.expectEqual(Kind.solid, kindFromKebab("glass"));
    try std.testing.expectEqual(Kind.solid, kindFromKebab("Acrylic"));
}

test "三种密度的配方：值域合法，透光度沿表单调递增" {
    const solid = recipe(.solid);
    const acrylic = recipe(.acrylic);
    const liquid = recipe(.liquid);
    inline for (.{ solid, acrylic, liquid }) |r| {
        try std.testing.expect(r.surface_mix > 0 and r.surface_mix <= 1);
        try std.testing.expect(r.blur_radius >= 0);
        try std.testing.expect(r.border_alpha >= 0 and r.border_alpha <= 1);
        try std.testing.expect(r.edge_alpha >= 0 and r.edge_alpha <= 1);
        try std.testing.expect(r.shadow_blur >= 0);
    }
    // 密度语义：混合比递减 = 透光递增；模糊、高光递增；描边递减。
    try std.testing.expect(solid.surface_mix > acrylic.surface_mix);
    try std.testing.expect(acrylic.surface_mix > liquid.surface_mix);
    try std.testing.expect(solid.blur_radius < acrylic.blur_radius);
    try std.testing.expect(acrylic.blur_radius < liquid.blur_radius);
    try std.testing.expect(solid.edge_alpha < acrylic.edge_alpha);
    try std.testing.expect(acrylic.edge_alpha < liquid.edge_alpha);
    try std.testing.expect(solid.border_alpha > acrylic.border_alpha);
    try std.testing.expect(acrylic.border_alpha > liquid.border_alpha);
    // 实心登记 SDK 自动带的 shadow.sm（blur 8）；半透明按 SDK 纪律不投。
    try std.testing.expectEqual(@as(f32, 8), solid.shadow_blur);
    try std.testing.expectEqual(@as(f32, 0), acrylic.shadow_blur);
    try std.testing.expectEqual(@as(f32, 0), liquid.shadow_blur);
}

test "sheen 停点：offset 单调递增收在 [0,1]，alpha ∈ [0,1]，实心为空表" {
    try std.testing.expectEqual(@as(usize, 0), recipe(.solid).sheen_offsets.len);
    inline for (.{ Kind.acrylic, Kind.liquid }) |kind| {
        const r = recipe(kind);
        try std.testing.expect(r.sheen_offsets.len >= 2);
        try std.testing.expect(r.sheen_offsets.len <= max_sheen_stops);
        try std.testing.expectEqual(r.sheen_offsets.len, r.sheen_alphas.len);
        var previous: f32 = -1;
        for (r.sheen_offsets, r.sheen_alphas) |offset, alpha| {
            try std.testing.expect(offset > previous);
            try std.testing.expect(offset >= 0 and offset <= 1);
            try std.testing.expect(alpha >= 0 and alpha <= 1);
            previous = offset;
        }
        // 首停钉在面板顶（0），尾停放完（1）。
        try std.testing.expectEqual(@as(f32, 0), r.sheen_offsets[0]);
        try std.testing.expectEqual(@as(f32, 1), r.sheen_offsets[r.sheen_offsets.len - 1]);
    }
}
