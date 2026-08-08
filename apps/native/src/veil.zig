//! KARA 的纱（veil）：专注写作时正文轨顶那一条渐隐的纸色。
//!
//! **接上哪个功能**：2.3a 的 KARA 进出——进场（Entering）淡入，写作/在读/
//! 离开中常驻，离场（Leaving）上抬淡出。状态机与全部计时（失焦 8s、进场
//! 700ms、离场 12s）在 core（core.ts），这里只把状态翻译成像素。
//!
//! **在全局逻辑中负责什么**：veil 的全部数值只活在这里——22% 窗高、三停
//! 渐变、动效时长与 easing。颜色只读生成色表的纸色（`tokens.colors.background`，
//! 与 `manuscriptTokens` 同一张表，昼夜主题因此都成立）。画在 chrome 的
//! suffix_commands：chrome 画在部件树之后、不进命中树、天然穿透——作者
//! 点得到纱下面的字。
//!
//! **交互设计**：纱是「专注中」唯一的持续信号——不抢读（渐变到全透明），
//! 不挡点（chrome 无命中）。离场不是消失而是「升走」：上抬 8% 同时淡出。

const std = @import("std");
const native_sdk = @import("native_sdk");
const core = @import("refrain_core");
const motion = @import("motion.zig");

const canvas = native_sdk.canvas;
const geometry = native_sdk.geometry;
const Model = core.Model;

/// veil 的显示列表命令 id：稳定常量——渲染动画（`CanvasRenderAnimation`）
/// 按 id 找到这条命令。
const command_id: u64 = 0x6b61_7261_7665_696c; // "karaveil" 的十六进制

/// 高：窗高的 22%。
pub const height_ratio: f32 = 0.22;
/// 三停渐变：纸色 alpha 0.88（顶）→ 0.62（46% 处）→ 0（底）。
pub const stop_offsets = [3]f32{ 0.0, 0.46, 1.0 };
pub const stop_alphas = [3]f32{ 0.88, 0.62, 0.0 };
// 进退场时长与 easing（700 进 / 400 出）已迁入 motion.zig——界面任何一处
// 动画不自带数字，这里只消费。
/// 离场上抬：veil 高的 8%。
pub const exit_lift_ratio: f32 = 0.08;

/// veil 的框。
pub const Rect = struct {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
};

/// veil 的几何：宽与正文轨同式（根栏 padding 16×2，轨在右时让出左 pane
/// 的宽），顶对齐正文轨顶——从窗底向上量：底 padding 16、栏脚行、栏间距
/// 12、视口高。这些常数是根栏版心列已有的数（app_main 的 column），不是
/// 新几何。
pub fn rect(
    window_width: f32,
    window_height: f32,
    viewport_height: f32,
    footer_height: f32,
    track_share: f32,
) Rect {
    const content_width = @max(0, window_width - 32);
    const width = content_width * track_share;
    return .{
        .x = 16 + (content_width - width),
        .y = window_height - 16 - footer_height - 12 - viewport_height,
        .width = width,
        .height = height_ratio * window_height,
    };
}

/// 三停渐变的停点：offset 是常量，颜色随主题——停点表因此按帧填。
/// 双槽轮换而不是单缓冲：SDK 可能对上一帧的显示列表做 diff，重写唯一
/// 缓冲会让旧列表读到新值（与 `project_request` 的池同一条借用纪律）。
var stops_pool: [2][3]canvas.GradientStop = undefined;
var stops_slot: usize = 0;

fn gradientStops(paper: canvas.Color) []canvas.GradientStop {
    stops_slot = (stops_slot + 1) % stops_pool.len;
    const stops: []canvas.GradientStop = stops_pool[stops_slot][0..];
    for (stop_offsets, stop_alphas, 0..) |offset, alpha, index| {
        var color = paper;
        color.a = alpha;
        stops[index] = .{ .offset = offset, .color = color };
    }
    return stops;
}

/// 栏脚行高：与 `documentLineHeightPx`（app_main）同式——栏脚只有一行
/// 文字，行高即它的高。
fn footerHeight(model: *const Model) f32 {
    const size: f32 = @floatCast(model.typographyTextSize);
    const percent: f32 = @floatFromInt(model.typographyLineHeightPercent);
    if (size <= 0 or percent <= 0) return 0;
    return size * percent / 100;
}

/// 正文轨占版心列的几分之几：稿子与裁决（stage 例外）独占，其余去处
/// 正文在 split 的右 pane。
fn trackShare(model: *const Model) f32 {
    return switch (model.destinationIndex) {
        0, 2 => 1.0,
        else => 1.0 - @as(f32, @floatCast(model.layoutFraction)),
    };
}

/// `ChromeOptions.build`：画出或藏起这条纱。
///
/// suffix_commands 恒为 1（SDK 的 exact 纪律：命令数漂移是 teaching
/// error），所以不可见（karaState == 0）时画一条零尺寸的——数量不变，
/// 内容为空。
pub fn build(
    model: *const Model,
    builder: *canvas.Builder,
    size: geometry.SizeF,
    tokens: canvas.DesignTokens,
) anyerror!void {
    _ = size;
    if (model.karaState < 1 or model.karaState > 5) {
        try builder.fillRect(.{
            .id = command_id,
            .rect = geometry.RectF.zero(),
            .fill = .{ .color = canvas.Color.rgba8(0, 0, 0, 0) },
        });
        return;
    }
    const frame = rect(
        // windowWidth 是 f64（契约混合类型），其余两个是 i64。
        @floatCast(@max(model.windowWidth, 0)),
        @floatFromInt(@max(model.windowHeight, 0)),
        @floatFromInt(@max(model.documentViewportHeight, 0)),
        footerHeight(model),
        trackShare(model),
    );
    try builder.fillRect(.{
        .id = command_id,
        .rect = geometry.RectF.init(frame.x, frame.y, frame.width, frame.height),
        .fill = .{ .linear_gradient = .{
            .start = geometry.PointF.init(frame.x, frame.y),
            .end = geometry.PointF.init(frame.x, frame.y + frame.height),
            .stops = gradientStops(tokens.colors.background),
        } },
    });
}

/// `Options.animations`：进场淡入、离场上抬淡出。
///
/// SDK 在每次重建后用最新帧时间重挂动画（start_ns 即当时）：状态窗口内
/// 若另有重建，动画重新起播一次——窗口很短（700ms／400ms），记录这个
/// 近似而不是为它发明幂等键。
pub fn animations(
    model: *const Model,
    tree: *const TsUiTree,
    start_ns: u64,
    out: []canvas.CanvasRenderAnimation,
) usize {
    _ = tree;
    if (out.len == 0) return 0;
    switch (model.karaState) {
        // Entering：opacity 0→1。
        1 => {
            out[0] = .{
                .id = command_id,
                .start_ns = start_ns,
                .duration_ms = motion.veil_enter_ms,
                .easing = motion.enter_easing,
                .from_opacity = 0,
                .to_opacity = 1,
            };
            return 1;
        },
        // Leaving：上抬 8% 同时 opacity 1→0。
        5 => {
            const lift = exit_lift_ratio * height_ratio *
                @as(f32, @floatFromInt(@max(model.windowHeight, 0)));
            out[0] = .{
                .id = command_id,
                .start_ns = start_ns,
                .duration_ms = motion.veil_exit_ms,
                .easing = motion.exit_easing,
                .from_opacity = 1,
                .to_opacity = 0,
                .from_transform = canvas.Affine.identity(),
                .to_transform = canvas.Affine.translate(0, -lift),
            };
            return 1;
        },
        else => return 0,
    }
}

// `Options.animations` 的 tree 形参类型：经 TsUiApp 实例化一次，与
// app_main 的 Adapter 是同一个类型。
const TsUiApp = native_sdk.TsUiApp(core);
const TsUiTree = TsUiApp.Ui.Tree;

/// 打断码的中文读法（KARA 小结/打断的文案表）。不认识的码原样显示——
/// 译一个没见过的码，作者照着做的可能是另一件事。
pub fn interruptLabel(code: []const u8) []const u8 {
    if (std.mem.eql(u8, code, "save-failed")) return "保存失败";
    if (std.mem.eql(u8, code, "disk-unwritable")) return "磁盘写不进";
    if (std.mem.eql(u8, code, "root-identity-changed")) return "项目身份变了";
    if (std.mem.eql(u8, code, "external-conflict")) return "磁盘上的字被别人改过";
    return code;
}

test "veil 的框：22% 窗高、与正文轨同宽同式、顶对齐轨顶" {
    // 1280×800 的窗、视口 650、栏脚 32、正文独占（share 1.0）。
    const full = rect(1280, 800, 650, 32, 1.0);
    try std.testing.expectApproxEqAbs(@as(f32, 176), full.height, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 16), full.x, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 1248), full.width, 0.001);
    // 轨顶 = 800 − 16（底 padding）− 32（栏脚）− 12（间距）− 650（视口）。
    try std.testing.expectApproxEqAbs(@as(f32, 90), full.y, 0.001);

    // 正文在右 pane（share 0.5）：宽减半，x 让出左 pane。
    const half = rect(1280, 800, 650, 32, 0.5);
    try std.testing.expectApproxEqAbs(@as(f32, 624), half.width, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 640), half.x, 0.001);
}

test "三停渐变：offset 与 alpha 是 0.88/0.62/0 这条曲线" {
    try std.testing.expectEqual([3]f32{ 0.0, 0.46, 1.0 }, stop_offsets);
    try std.testing.expectEqual([3]f32{ 0.88, 0.62, 0.0 }, stop_alphas);
    const stops = gradientStops(canvas.Color.rgb8(250, 248, 240));
    try std.testing.expectEqual(@as(usize, 3), stops.len);
    // 纸色不变，只动 alpha。
    try std.testing.expect(stops[0].color.r > 0.9);
    try std.testing.expectApproxEqAbs(@as(f32, 0.88), stops[0].color.a, 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 0), stops[2].color.a, 0.001);
}

test "打断码翻成中文，不认识的码原样显示" {
    try std.testing.expectEqualStrings("保存失败", interruptLabel("save-failed"));
    try std.testing.expectEqualStrings("磁盘写不进", interruptLabel("disk-unwritable"));
    try std.testing.expectEqualStrings("项目身份变了", interruptLabel("root-identity-changed"));
    try std.testing.expectEqualStrings("磁盘上的字被别人改过", interruptLabel("external-conflict"));
    try std.testing.expectEqualStrings("brand-new-code", interruptLabel("brand-new-code"));
}
