//! 多层面板栈：层深到几何的投影（2.9）。
//!
//! **接上哪个功能**：`panelStack`（core 记离开的去处，3 bit×8 层编码、低 3
//! 位栈底）与它的可见规则。`Escape`／同键关最上层露出下一层（panel_back
//! 本就 pop）。
//!
//! **在全局逻辑中负责什么**：只读不写。语义的唯一权威是 `workbench.ts`
//! （`visibleDepth`／`visibleLayerAt`／`isWholeStage` 与编码），这里复刻同
//! 一套规则把层画出来——测试向量与 `workbench.test.ts` 同一份，两个读者
//! 各钉各的，漂开就有一边红。
//!
//! **交互设计**：多层并排是作者拍板的 v0.2.4 完整回迁。工具从同侧依次
//! 排开（栈底在左、当前层最右），Escape/同键关最上层露下一层。正文永远
//! 不被挤变形：版心列宽不变（=不断行），多出的层宽换算成正文轨的右滑
//! （v0.2.4 的 `translateX(panel-reserve / 2)`，见 `trackShift` 的出处
//! 注释）。独占去处（稿子/裁决）当前时没有侧层，照旧独占。

const std = @import("std");
const native_sdk = @import("native_sdk");
const core = @import("refrain_core");
const motion = @import("motion.zig");

const canvas = native_sdk.canvas;

const Model = core.Model;
const TsUiApp = native_sdk.TsUiApp(core);

/// 可见层数上限（workbench.ts 的 MAX_VISIBLE_LAYERS）：超出藏最旧。
pub const MAX_VISIBLE_LAYERS = 3;
/// 栈的层数上限（workbench.ts 的 PANEL_STACK_MAX_DEPTH）。
pub const STACK_MAX_DEPTH = 8;
// 进场动效数值（300ms 减速）已迁入 motion.zig（panel_enter_ms/enter_easing）——
// 界面任何一处动画不自带数字，这里只消费。

/// 独占去处（整舞台）：0 稿子、2 裁决。workbench.ts 的 isWholeStage。
pub fn isWholeStage(index: i64) bool {
    return index == 0 or index == 2;
}

/// 越界回落稿子——workbench.ts 的 destinationAt 同规。
fn destinationAt(index: i64) i64 {
    if (index < 0 or index >= 8) return 0;
    return index;
}

/// 栈的层数。非正或溢出按 0——workbench.ts 的 stackDepth 同规（3 bit
/// 一组，逐组右移；`>> 3` 是 ÷8 不是 >>2，NS1016）。
pub fn stackDepth(stack: i64) usize {
    if (stack <= 0) return 0;
    var depth: usize = 0;
    var rest = stack;
    while (rest > 0 and depth < STACK_MAX_DEPTH) {
        rest = rest >> 3;
        depth += 1;
    }
    return depth;
}

/// 第 depth 层的去处（0 = 栈底）。越界回落稿子——workbench.ts 的 layerAt。
pub fn layerAt(stack: i64, depth: usize) i64 {
    if (depth >= stackDepth(stack)) return 0;
    const shift: u6 = @intCast(depth * 3);
    return destinationAt((stack >> shift) & 7);
}

/// 可见层数：当前层是独占去处时没有侧层（0）；否则栈里的面板层（跳过
/// 独占层）+ 当前层，上限 MAX_VISIBLE_LAYERS。workbench.ts 的 visibleDepth。
pub fn visibleDepth(stack: i64, current: i64) usize {
    if (isWholeStage(current)) return 0;
    var panels: usize = 0;
    const depth = stackDepth(stack);
    for (0..depth) |index| {
        if (!isWholeStage(layerAt(stack, index))) panels += 1;
    }
    return @min(panels + 1, MAX_VISIBLE_LAYERS);
}

/// 可见的第 at 层（0 = 最左/栈底侧，当前层最右）。超出交回当前层——
/// workbench.ts 的 visibleLayerAt：栈里的独占层跳过，超出上限藏最旧。
pub fn visibleLayerAt(stack: i64, current: i64, at: usize) i64 {
    const depth = visibleDepth(stack, current);
    if (at >= depth) return destinationAt(current);
    if (at == depth - 1) return destinationAt(current);
    var panels: usize = 0;
    const total = stackDepth(stack);
    for (0..total) |index| {
        if (!isWholeStage(layerAt(stack, index))) panels += 1;
    }
    const window = depth - 1; // 侧层（当前层不算）
    const skip = if (panels > window) panels - window else 0;
    var seen: usize = 0;
    for (0..total) |index| {
        const layer = layerAt(stack, index);
        if (isWholeStage(layer)) continue;
        if (seen < skip) {
            seen += 1;
            continue;
        }
        if (seen == skip + at) return layer;
        seen += 1;
    }
    return destinationAt(current);
}

/// 一层的宽（px）：与单层时 split 第一 pane 同一个换算——版心列宽
/// （窗宽减根栏 padding 16×2）× layoutFraction。v0.2.4 的 --panel-width
/// （默认 400px ≈ 0.32 × 1248）就是这条路的来源。
pub fn layerWidth(window_width: f32, fraction: f32) f32 {
    return @max(0, window_width - 32) * fraction;
}

/// 正文轨的右滑量（px）。v0.2.4 的公式（surfaces.css L3334，出处）：
/// `translateX(calc(var(--panel-reserve, 0px) / 2))`——reserve 是各层
/// --panel-width 之和（panel-spine.ts 的 panelReserve）。我们的单层基准
/// 已经经 split 让出一层宽，所以 reserve 在这里是「多出的层宽」：
/// (depth − 1) × 层宽，滑它的一半。多层时版心列宽不变——不断行。
pub fn trackShift(window_width: f32, fraction: f32, depth: usize) f32 {
    if (depth <= 1) return 0;
    const extra = layerWidth(window_width, fraction) * @as(f32, @floatFromInt(depth - 1));
    return extra / 2;
}

/// 当前层（最右）那根面板的稳定 id：进场动画按它寻址。global_key 的
/// id 算法归 SDK（`globalWidgetId`），这里只声明键名。
pub fn currentLayerId() u64 {
    return canvas.globalWidgetId(.panel, .{ .str = "panel-current" });
}

/// 上一帧的当前层：进场检测只认「换层」这条边。
var last_current: i64 = -1;

/// `Options.animations` 的一段：换到面板层时给它一条 panel-in（左滑
/// 100% 层宽 + 淡入，300ms emphasized）。独占层不做（它不是侧来的面板）。
/// 重建重挂的窗口纪律与 veil 同一条（状态窗口内重建会重播一次）。
pub fn enterAnimation(model: *const Model, start_ns: u64, out: []canvas.CanvasRenderAnimation) usize {
    const current = model.destinationIndex;
    const changed = current != last_current;
    last_current = current;
    if (out.len == 0 or !changed) return 0;
    if (isWholeStage(current)) return 0;
    const width = layerWidth(
        @floatCast(@max(model.windowWidth, 0)),
        @floatCast(model.layoutFraction),
    );
    out[0] = .{
        .id = currentLayerId(),
        .start_ns = start_ns,
        .duration_ms = motion.panel_enter_ms,
        .easing = motion.enter_easing,
        .from_opacity = 0,
        .to_opacity = 1,
        .from_transform = canvas.Affine.translate(-width, 0),
        .to_transform = canvas.Affine.identity(),
    };
    return 1;
}

test "the 3-bit stack decodes bottom-first like workbench.ts" {
    // 与 workbench.test.ts 同一份向量：stack=25 → 底 1 文件、顶 3 派发。
    try std.testing.expectEqual(@as(usize, 2), stackDepth(25));
    try std.testing.expectEqual(@as(i64, 1), layerAt(25, 0));
    try std.testing.expectEqual(@as(i64, 3), layerAt(25, 1));
    // 281 = 1 + (3<<3) + (4<<6)：三层，底 1、中 3、顶 4。
    try std.testing.expectEqual(@as(usize, 3), stackDepth(281));
    try std.testing.expectEqual(@as(i64, 1), layerAt(281, 0));
    try std.testing.expectEqual(@as(i64, 3), layerAt(281, 1));
    try std.testing.expectEqual(@as(i64, 4), layerAt(281, 2));
    // 空栈与越界。
    try std.testing.expectEqual(@as(usize, 0), stackDepth(0));
    try std.testing.expectEqual(@as(i64, 0), layerAt(25, 2));
}

test "visible layers skip whole-stage entries and cap at three, current last" {
    // workbench.test.ts 的向量：stack=1、当前 3（派发）。
    try std.testing.expectEqual(@as(usize, 2), visibleDepth(1, 3));
    try std.testing.expectEqual(@as(i64, 1), visibleLayerAt(1, 3, 0));
    try std.testing.expectEqual(@as(i64, 3), visibleLayerAt(1, 3, 1));
    // 当前层是独占去处（2 裁决）：没有侧层。
    try std.testing.expectEqual(@as(usize, 0), visibleDepth(1, 2));
    // 三层栈 + 当前 5：上限 3，最旧的（1 文件）藏起。
    try std.testing.expectEqual(@as(usize, 3), visibleDepth(281, 5));
    try std.testing.expectEqual(@as(i64, 3), visibleLayerAt(281, 5, 0));
    try std.testing.expectEqual(@as(i64, 4), visibleLayerAt(281, 5, 1));
    try std.testing.expectEqual(@as(i64, 5), visibleLayerAt(281, 5, 2));
    // 栈里压着独占层（2）：跳过它，不计入可见。
    const mixed = 1 + (2 << 3);
    try std.testing.expectEqual(@as(usize, 2), visibleDepth(mixed, 3));
    try std.testing.expectEqual(@as(i64, 1), visibleLayerAt(mixed, 3, 0));
    try std.testing.expectEqual(@as(i64, 3), visibleLayerAt(mixed, 3, 1));
}

test "the track shifts by half the extra layer width (v0.2.4 formula)" {
    // 1280 窗、0.32：层宽 = 1248 × 0.32 = 399.36。单层不滑；两层滑
    // extra/2 = 199.68；三层（多两层）滑 399.36。
    try std.testing.expectApproxEqAbs(@as(f32, 0), trackShift(1280, 0.32, 1), 0.001);
    try std.testing.expectApproxEqAbs(@as(f32, 199.68), trackShift(1280, 0.32, 2), 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 399.36), trackShift(1280, 0.32, 3), 0.01);
    try std.testing.expectApproxEqAbs(@as(f32, 399.36), layerWidth(1280, 0.32), 0.01);
}
