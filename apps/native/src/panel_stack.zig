// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 面板的像素几何：去处占比到层宽的换算。
//!
//! **接上哪个功能**：功能栏的地与分栏线（`app_main.railEdgeX`）。栏的语义
//! （哪个去处、要不要稿子、Escape 退到哪）归 `core/workbench.zig`；这里只有
//! 「这个占比在这扇窗上是几个像素」这一件事。
//!
//! **多层并排（2.9）删于 v0.3.4 救援**：`fittingDepth` 画层数、`visibleLayerAt`
//! 排层序，两个数在窗宽不够时不相等，被裁掉的恰是作者刚按的那一页；且每个
//! 侧层都是整张去处视图，「导入正文」因此在屏上出现两枚。单层 split 之后，
//! 本模块只剩这一条换算——进场动画（panel-in）随层一起删，切换过渡由 split
//! 的 fraction tween 担任。

const std = @import("std");

/// 一层的宽（px）：与 split 第一 pane 同一个换算——版心列宽
/// （窗宽减根栏 padding 16×2）× layoutFraction。v0.2.4 的 --panel-width
/// （默认 400px ≈ 0.32 × 1248）就是这条路的来源。
pub fn layerWidth(window_width: f32, fraction: f32) f32 {
    return @max(0, window_width - 32) * fraction;
}

test "layer width is the split pane's own arithmetic" {
    // 1280 窗、0.32：层宽 = 1248 × 0.32 = 399.36（v0.2.4 的 400px 面板同源）。
    try std.testing.expectApproxEqAbs(@as(f32, 399.36), layerWidth(1280, 0.32), 0.01);
    // 窗尺寸未到时不猜：宽 0。
    try std.testing.expectEqual(@as(f32, 0), layerWidth(0, 0.32));
}
