//! 外壳的共享词汇：导轨行、行数预算、当前主题与材质。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

const std = @import("std");
const themes = @import("../generated/themes.zig");
const core = @import("../core.zig");
const corners = @import("../corners.zig");
const material_recipe = @import("../material.zig");
const workbench_view = @import("../workbench_view.zig");
const core_workbench = @import("../core/workbench.zig");
const Adapter = core.App;
const Model = core.Model;

/// 一屏最多画多少张卡片行。定长而不是分配：视图每帧重建，一次分配一列
/// 几百行的节点数组会把这一帧的预算花在作者看不见的行上。
///
/// 单元 34 之前叫 `mailbox_rows`，住在信箱那一段里；它实际上同时被信箱、
/// 设置、裁决、派发台四个去处的七个调用点当作卡片行预算用。搬进共享模块
/// 而留旧名，等于给一个公共规则发一张写错了归属的权威证书。值 24 未变。
pub const card_rows = 24;

/// 界面一次最多画多少行。超出的部分由作者用名录上下键走到。
///
/// 定长而不是分配：视图每帧重建，一次分配一列几百行的节点数组会把这一帧的
/// 预算花在作者看不见的行上。
pub const max_visible_rows = 64;

/// Model 的主题下标钳进色表范围（越界回落默认——与 core `theme_select`
/// 臂的越界处理同一句话，界面与内核不各判一次）。
pub fn currentThemeIndex(model: *const Model) usize {
    return if (model.theme_index >= 0 and model.theme_index < themes.themes.len)
        @intCast(model.theme_index)
    else
        themes.default_index;
}

/// Model 的材质下标 → material.zig 的 Kind。越界回落实心——与 core 的
/// `material_select` 臂、material.zig 的 `kindFromKebab` 同一句（实心什么
/// 都不依赖，永远画得出来）。
pub fn panelMaterialKind(model: *const Model) material_recipe.Kind {
    return switch (model.panel_material) {
        1 => .acrylic,
        2 => .liquid,
        else => .solid,
    };
}

/// 根栏的内边距（px）。版心列宽、层宽（`panel_stack.layerWidth`）与纱的
/// 几何（`veil.rect`）都从它减起，所以它只能有一处。
pub const shell_padding_px: f32 = 16;

/// 导轨树里一行向右缩进一格的宽度。
///
/// 14px 是一个 CJK 字的大致半宽：窄到不把行推出版心，宽到一眼能看出
/// 这一行属于上一行。SDK 的 `tree_level` 只是语义层级（它自己的测试写明
/// “logical hierarchy metadata, not renderer-owned spacing”），几何归我们。
const rail_indent_px: f32 = 14;

/// 导轨树一行的高度（px）。
///
/// 行高 30 + 行间 6 = 36px 的步长。v0.3.0 是 24px（行高随字号 + gap 2），
/// 在真窗上读作「挤」——一叠贴在一起的行不像一棵树，像一块文本。
/// 36 是正文行高的量级：导轨与正文因此同一个呼吸，眼睛从稿子移到名录
/// 不用重新对焦。
const rail_row_height_px: f32 = 30;

pub const rail_row_gap_px: f32 = 6;

/// 导轨树里的一行。
///
/// **它拥有的规则**：树里的一行不是盒子。行本体去角（`corners.squared`），
/// 层级靠左侧的空格说，选中靠行底色说——三件事在这一处定，不在每个
/// 调用点各写一遍。调用点只说「这一行在第几层」。
///
/// 保留 `list_item` 而不自绘：命中、键盘主键、右键菜单、无障碍角色都在
/// 它身上，为了一个形状把这些重建一遍是把一条规则换成四条。
pub fn railTreeRow(ui: *Adapter.Ui, options: Adapter.Ui.ElementOptions, depth: u16, label: []const u8) Adapter.Ui.Node {
    var scoped = options;
    scoped.tree_level = depth;
    scoped.height = rail_row_height_px;
    // 根层不包缩进行，所以不能给 grow：它直接落在竖向的 column 里，
    // 而 grow 说的是主轴——在 column 里那是竖向，一行会把整列撜开。
    // 只有被横向的缩进行包住时，grow 才是「铺满剩下的宽」。
    if (depth == 0) {
        var root_item = ui.listItem(scoped, label);
        root_item.widget.style.radius = corners.squared;
        return root_item;
    }
    scoped.grow = 1;
    var item = ui.listItem(scoped, label);
    item.widget.style.radius = corners.squared;
    return ui.row(.{ .key = options.key }, .{
        ui.el(.stack, .{ .width = rail_indent_px * @as(f32, @floatFromInt(depth)) }, .{}),
        item,
    });
}

/// 「前往」节：八个去处，标签归去处表，键位是它的反查（裁决/派发没有
/// 固定键位，不印）。
pub fn paletteGoSection(ui: *Adapter.Ui, model: *const Model, query: []const u8) Adapter.Ui.Node {
    var rows: [workbench_view.destinations.len]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    for (workbench_view.destinations, 0..) |destination, index| {
        if (query.len > 0 and std.mem.indexOf(u8, destination.label, query) == null) continue;
        const chord = workbench_view.destinationChord(index);
        // 下标只在这一处变回去处：枚举让「越界的去处」不可表示，代价是从外部数字
        // 进来的边界上要过一次 `destinationFrom`——而这张表本身就是按去处序写的。
        const destination_value = core_workbench.destinationFrom(@intCast(index)) orelse continue;
        rows[count] = railTreeRow(ui, .{
            .key = .{ .index = index },
            .selected = model.destination == destination_value,
            .on_press = .{ .workbench_go = destination_value },
            .semantics = .{ .role = .treeitem, .label = destination.label },
        }, 1, if (chord.len > 0)
            ui.fmt("{s}　{s}", .{ destination.label, chord })
        else
            destination.label);
        count += 1;
    }
    if (count == 0) return ui.el(.stack, .{ .height = 0 }, .{});
    return ui.column(.{ .gap = rail_row_gap_px, .semantics = .{ .role = .tree, .label = "前往" } }, .{
        ui.text(.{}, "前往"),
        ui.column(.{ .gap = rail_row_gap_px }, @as([]const Adapter.Ui.Node, rows[0..count])),
    });
}
