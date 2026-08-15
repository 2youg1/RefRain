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
const core = @import("core.zig");
const motion = @import("motion.zig");

const canvas = native_sdk.canvas;

const Model = core.Model;
const TsUiApp = core.App;

/// 可见层数上限（workbench.ts 的 MAX_VISIBLE_LAYERS）：超出藏最旧。
pub const MAX_VISIBLE_LAYERS = 3;
/// 栈的层数上限（workbench.ts 的 PANEL_STACK_MAX_DEPTH）。
pub const STACK_MAX_DEPTH = 8;
// 进场动效数值（300ms 减速）已迁入 motion.zig（panel_enter_ms/enter_easing）——
// 界面任何一处动画不自带数字，这里只消费。

// 位压缩的栈解码曾经住在这里（`stackDepth`／`layerAt`／`visibleDepth`／
// `visibleLayerAt`／`isWholeStage`，逐条对着 `workbench.ts` 抄）。单元 13 之后
// 那些规则只有一份权威：`core/workbench.zig` 的 `PanelStack` 与 `Destination`。
// 本模块只留像素几何——哪一层是哪个去处是语义，能不能画得下是像素。

/// 一层的宽（px）：与单层时 split 第一 pane 同一个换算——版心列宽
/// （窗宽减根栏 padding 16×2）× layoutFraction。v0.2.4 的 --panel-width
/// （默认 400px ≈ 0.32 × 1248）就是这条路的来源。
pub fn layerWidth(window_width: f32, fraction: f32) f32 {
    return @max(0, window_width - 32) * fraction;
}

/// 这扇窗真能并排几层：舊台至少留住一层宽。
///
/// **为什么在这里**：哪一层是哪个去处是语义，归 `workbench.ts`；
/// 能不能画得下是像素，归这里——两边各管各的，不复制对方的规则。
///
/// **为什么需要它**：`MAX_VISIBLE_LAYERS = 3` 是一个常数，而层宽是窗宽的
/// 一个分数。默认 0.32 下三层吃掉 96%：实测 1250px 窗上走一轮
/// 文件→设置→信箱，舊台只剩 60px。「正文永远不被挤变形」这条
/// v0.2.4 的承诺因此是窗宽的函数，不是一个常数。作者把分隔条拖窄
/// （fraction 变小）就能换回第三层——选权在作者手里，不在常数里。
pub fn fittingDepth(window_width: f32, fraction: f32, depth: usize) usize {
    if (depth <= 1) return depth;
    const width = layerWidth(window_width, fraction);
    if (width <= 0) return depth;
    const room = @max(0, window_width - 32) - width;
    if (room <= 0) return 1;
    const fits: usize = @intFromFloat(@floor(room / width));
    return @max(1, @min(depth, fits));
}

/// 当前层（最右）那根面板的稳定 id：进场动画按它寻址。global_key 的
/// id 算法归 SDK（`globalWidgetId`），这里只声明键名。
pub fn currentLayerId() u64 {
    return canvas.globalWidgetId(.panel, .{ .str = "panel-current" });
}

/// 上一帧的当前层：进场检测只认「换层」这条边。
/// `null` = 还没画过一帧（旧形用 −1 占这个位，而 −1 不是一个去处）。
var last_current: ?core.Destination = null;

/// `Options.animations` 的一段：换到面板层时给它一条 panel-in（左滑
/// 100% 层宽 + 淡入，300ms emphasized）。独占层不做（它不是侧来的面板）。
/// 重建重挂的窗口纪律与 veil 同一条（状态窗口内重建会重播一次）。
pub fn enterAnimation(model: *const Model, start_ns: u64, out: []canvas.CanvasRenderAnimation) usize {
    const current = model.destination;
    const changed = last_current == null or last_current.? != current;
    last_current = current;
    if (out.len == 0 or !changed) return 0;
    if (current.isWholeStage()) return 0;
    const width = layerWidth(
        @floatCast(@max(model.window.width, 0)),
        @floatCast(model.layout_fraction),
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

// 位压缩栈的两条解码测试也随那半边一起删：它们逐条对着 `workbench.test.ts` 的
// 向量测一个已经不存在的解码。同事实的测试在 `core/workbench.zig` 里，测的是
// `PanelStack` 这个有界数组——那才是今天唯一的权威。


test "the stage keeps at least one layer's width, so three layers need a narrower rail" {
    // 1280 窗、0.32：层宽 = 1248 × 0.32 = 399.36。两层占 798.72，舊台剩
    // 449.28 ≥ 一层；三层占 1198，舊台只剩 49.9 ——不准。
    try std.testing.expectApproxEqAbs(@as(f32, 399.36), layerWidth(1280, 0.32), 0.01);
    try std.testing.expectEqual(@as(usize, 2), fittingDepth(1280, 0.32, 3));
    try std.testing.expectEqual(@as(usize, 2), fittingDepth(1280, 0.32, 2));
    // 拖窄到 0.24：三层占 898.6，舊台剩 349.4 ≥ 299.5，三层画得下。
    try std.testing.expectEqual(@as(usize, 3), fittingDepth(1280, 0.24, 3));
    // 单层与无层原样交回；窗尺寸未到时不猜（层宽 0）。
    try std.testing.expectEqual(@as(usize, 1), fittingDepth(1280, 0.32, 1));
    try std.testing.expectEqual(@as(usize, 0), fittingDepth(1280, 0.32, 0));
    try std.testing.expectEqual(@as(usize, 3), fittingDepth(0, 0.32, 3));
    // 分数大到一层就吃掉大半屏：只剩得下一层。
    try std.testing.expectEqual(@as(usize, 1), fittingDepth(1280, 0.6, 3));
}
