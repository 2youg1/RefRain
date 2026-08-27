// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 文件去处：文件树、行菜单、打开／删除／披露／导入。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

const std = @import("std");
const core = @import("../core.zig");
const replies = @import("../core/replies.zig");
const wire = @import("../generated/wire.zig");
const project_request = @import("../project_request.zig");
const project_view = @import("../project_view.zig");
const Adapter = core.App;
const Model = core.Model;
const Msg = core.Msg;
const shell_view = @import("shell.zig");
const search_view = @import("search.zig");
const view_harness = @import("harness.zig");

/// 文件树：项目里的文档名录，点一行就打开它。
///
/// **接上哪个功能**：`ChooseAndAdoptRoot`、`DocumentPage`、`OpenDocument`、
/// `CreateDocument`、`DeleteDocument`、导入。没有这一屏，作者打不开任何东西，
/// 其余去处全部够不着——这是接线顺序把它排在第一位的理由。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。行文字与角色归
/// `project_view.documentRow`，请求的写法归 `project_request`，路径解析在
/// Rust 里——跨界的是 Root id 加相对路径，界面无法指定任意文件。
/// 文件树那一张虚拟列表的声明。**一处**，因为窗口的解算与建树必须按同一组
/// 参数问同一个问题：`virtualWindow` 用它算出该建哪一段，`virtualList` 用它
/// 把那一段交给运行时；两处写岔一个数，画出来的行与滚动条说的就不是一回事。
fn tree_window(total: usize) Adapter.Ui.VirtualListOptions {
    const stride = shell_view.rail_row_height_px + shell_view.rail_row_gap_px;
    // 盒子的高度是「装得下的那些行」，与旧形一字不差：少于一屏时它恰好包住
    // 自己的行，不在按钮上方留一片空白。
    //
    // **高度必须是确定值，不能只给 `grow`。** 虚拟列表是一个 `scroll_view`，
    // 而滚动容器的主轴尺寸不由子节点决定；旧形的 `ui.list` 由子节点撑开。
    // 真窗实测：只给 `grow = 1` 时这一屏量到 `bounds=(28,566 205.71x0)`，
    // 树高为零、一行都不可见，而回放的指纹**照样全绿**——录制那一侧才看得见
    // （`docs/AGENTS.md`「What green does not prove」第 1 条）。
    const visible = @min(total, shell_view.max_visible_rows);
    return .{
        .id = "files.tree",
        .item_count = total,
        // 行高由 `railTreeRow` 写死，不随文本长度变——那一行本就不换行。
        // 这是虚拟列表 v1 契约（行高一致）在这一屏成立的全部依据。
        .item_extent = shell_view.rail_row_height_px,
        .gap = shell_view.rail_row_gap_px,
        .height = @as(f32, @floatFromInt(visible)) * stride,
        // 没有运行时滚动状态时（裸构建：测试、预览）假设的视口高，与上面同一个
        // 数：裸构建看见的行数因此与真窗第一帧一致。
        .viewport_fallback = @as(f32, @floatFromInt(visible)) * stride,
        .semantics = .{ .role = .tree, .label = "项目里的文档" },
    };
}

pub fn filesView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.root_id.slice().len == 0) {
        // 还没有项目：这一屏是作者第一次打开软件看到的东西，所以它必须
        // 自己给出入口，而不是显示一句「没有项目」。「前往」树不在这里：
        // 它是栏的常驻件，由 `app_main.documentView` 给每个面板去处统一戴上
        //（v0.3.4 救援：旧形只有本视图带树，离开文件页导航就消失）。
        return ui.column(.{ .gap = 12, .padding = 16 }, .{
            ui.text(.{}, "还没有打开项目"),
            // 入口只有一个（v0.3.4 作者裁定：两颗按钮打架就删一颗，留下的必须
            // 绝对能用）：项目文件夹是产品的真模型，单文件 Root 的能力留在
            // Rust（RootKind::File），不占第一屏的入口。
            ui.button(.{
                .variant = .primary,
                .on_press = adoptRootMsg(true),
                .semantics = .{ .label = "打开一个项目文件夹" },
            }, "打开项目文件夹"),
        });
    }
    // 树有自己的槽（v0.3.4 救援）：探测、搜索、信箱都冲不掉它——旧形下
    // 点一次「重新探测」这一屏就永久空白，作者读到的是「打不开任何文档」。
    // 两种形状同一张树：打开项目是 `.opened`，翻页与刷新是 `.page`——只认
    // 前者时，按一次「再读一页」树就消失。
    const opened = replies.borrow(.documents);
    const documents: []const wire.DocumentRow = if (opened.head(.opened)) |head|
        opened.rows(wire.DocumentRow, head.documents)
    else if (opened.head(.page)) |head|
        opened.rows(wire.DocumentRow, head.documents)
    else
        &[_]wire.DocumentRow{};
    // 行数当场数——答复里那个数组就是权威。Model 里曾经另存一个
    // `documentCount`，它去找一个 Rust 从未发过的字段名，恒为 0，于是
    // 这一屏恒画零行——作者打开项目以后什么都看不见。
    // 树改走 SDK 的虚拟列表。
    //
    // **前提已量**：虚拟列表的 v1 契约要求行高一致，而树行的高度是
    // `shell_view.railTreeRow` 写死的 `rail_row_height_px`——不随文本长度变，
    // 因为那一行本就不换行。前提因此是构造上成立的，不是挑一屏量出来的。
    //
    // **它换掉了什么**：旧形把行建在一个长 64 的栈上数组里，于是一页 256 份
    // 文档里只有 64 份能被画出来——剩下的 192 份作者看不见，而那不是一个
    // 滚动问题，是他的项目里有三分之二的稿子不存在。现在建的只是可见窗口
    // 加 overscan，而总数由 `item_count` 告诉运行时，滚动条与键盘导航都按总数算。
    const window_range = ui.virtualWindow(tree_window(documents.len));
    const window = window_range.itemCount();
    var rows: [shell_view.max_visible_rows]Adapter.Ui.Node = undefined;
    var index: usize = 0;
    while (index < window and index < rows.len) : (index += 1) {
        const absolute = window_range.start_index + index;
        const rendered = project_view.documentRow(opened, documents[absolute]);
        rows[index] = if (rendered) |shown| row: {
            // 一行只借一次：点击、Enter、菜单首项是同一个动作，借三次只会把
            // 同一帧里后面的行挤出预算。
            const open = openDocumentMsg(model, shown.label);
            // 这一帧的引用字节用完了：行画成不可按并说出原因。默默接下点击
            // 却不动，作者读到的是「这份稿子坏了」。
            if (open == null) break :row shell_view.railTreeRow(
                ui,
                model,
                .{ .key = .{ .index = absolute }, .disabled = true, .semantics = .{ .role = .treeitem, .label = shown.label } },
                1,
                ui.fmt("{s} · 这一屏放不下这一行的动作", .{shown.label}),
            );
            break :row shell_view.railTreeRow(ui, model, .{
                .key = .{ .index = absolute },
                .on_press = open,
                // Enter 打开：与点击同一条消息（list_item 键图的行主键）。
                .on_submit = open,
                // 对这一行做的事属于这一行：打开、删除、改披露都在菜单里，
                // 作者不必先选中再去屏幕底部瞄一排按钮。
                .context_menu = documentRowMenu(ui, model, shown.label, open),
                .semantics = .{ .role = .treeitem, .label = shown.label },
            }, 1, ui.fmt("{s} · {s}", .{ shown.label, shown.detail }));
        } else shell_view.railTreeRow(ui, model, .{ .key = .{ .index = absolute }, .disabled = true }, 1, "这一行读不出来");
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "文档"),
            // 读进来的与一共有多少分开说：作者据此知道还有没读到的。画出来的
            // 不再是那个数——虚拟列表只建窗口，而本页每一行都滚得到。
            ui.text(.{}, ui.fmt("{d} / {d}", .{ documents.len, model.document.total })),
        }),
        // 搜索与文件树在同一屏：作者找一份稿子时不必先想「该去哪个去处」。
        search_view.searchView(ui, model),
        ui.virtualList(tree_window(documents.len), window_range, @as([]const Adapter.Ui.Node, rows[0..index])),
        // 四个动作两行两列，不是一行四个：栏是这一屏最窄的一层（文件去处
        // 的 layoutFraction 最小），一行四个在默认窗宽下把后两个挤出右缘——
        // 实测 1250px 窗上「导入正文」被切、「导入资料」整个看不见。SDK 的
        // 行不做流式换行（`ui.zig`：rows never flow-wrap their children），
        // 所以换行是版式的事，写成两行。
        ui.column(.{ .gap = 8 }, .{
            ui.row(.{ .gap = 8 }, .{
                ui.button(.{
                    .grow = 1,
                    .disabled = model.document.cursor.slice().len == 0,
                    .on_press = documentPageMsg(model),
                    .semantics = .{ .label = "读下一页文档名录" },
                }, "再读一页"),
                ui.button(.{
                    // 新建用搜索框里的字当标题：作者刚打完一个找不到的名字，
                    // 下一步多半就是建它。空框时按钮灰着，不发一条会被拒绝的请求。
                    .grow = 1,
                    .disabled = model.search.query.slice().len == 0,
                    .on_press = createDocumentMsg(model),
                    .semantics = .{ .label = "用搜索框里的名字新建一篇正文" },
                }, "新建正文"),
            }),
            ui.row(.{ .gap = 8 }, .{
                ui.button(.{
                    .grow = 1,
                    .on_press = importMsg(model, true),
                    .semantics = .{ .label = "把一份文本导入为正文" },
                }, "导入正文"),
                ui.button(.{
                    .grow = 1,
                    .on_press = importMsg(model, false),
                    .semantics = .{ .label = "把一份来源导入为资料" },
                }, "导入资料"),
            }),
        }),
    });
}

/// 新建一份正文。标题取搜索框里的字——作者刚打完一个找不到的名字，
/// 下一步多半就是建它，所以两处共用一个输入框而不是再开一个。
fn createDocumentMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.search.query.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.createDocument(
        &writer,
        model.root_id.slice(),
        model.search.query.slice(),
        "chapter",
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 文件树一行上的右键菜单：打开、删除、改披露权限。
///
/// **接上哪个功能**：`OpenDocument`、`DeleteDocument`、`SetDisclosure`。
/// 这三件事都是「对这一行做」，所以它们属于这一行，而不是屏幕底部的一排
/// 按钮——后者要求作者先选中再瞄准，两次动作做一件事。
///
/// 删除进系统回收站（语义在 Rust，界面只送意图），所以菜单里不必再问一次
/// 「确定吗」——可撤销的动作不该拦一道。
fn documentRowMenu(
    ui: *Adapter.Ui,
    model: *const Model,
    path: []const u8,
    open: ?Msg,
) []const Adapter.Ui.ContextMenuItem {
    const items = ui.arena.alloc(Adapter.Ui.ContextMenuItem, 6) catch return &.{};
    // 打开用行已经借好的那一条：菜单首项与行主键是同一个动作。
    items[0] = .{ .label = "打开", .msg = open };
    items[1] = .{ .separator = true };
    // 披露三档：Agent 能看到这份材料的多少。默认是可检索。
    // 名字是 kebab-case（`Disclosure` 的 serde 口径，实测自 wire_shapes），
    // 与 `ProjectInput` 的 camelCase 不同——两者按同一种猜会被静默拒绝。
    items[2] = .{ .label = "只给目录", .msg = disclosureMsg(model, path, "outline-only") };
    items[3] = .{ .label = "可检索", .msg = disclosureMsg(model, path, "retrievable") };
    items[4] = .{ .label = "全文可读", .msg = disclosureMsg(model, path, "full") };
    items[5] = .{ .label = "删除（进回收站）", .msg = deleteDocumentMsg(model, path) };
    return items;
}

/// 改一份材料对 Agent 的披露权限。
fn disclosureMsg(model: *const Model, path: []const u8, disclosure: []const u8) ?Msg {
    if (model.root_id.slice().len == 0 or path.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.setDisclosure(
        &writer,
        model.root_id.slice(),
        path,
        disclosure,
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 删除一份文档。进系统回收站，不是抹掉——语义归 Rust。
fn deleteDocumentMsg(model: *const Model, path: []const u8) ?Msg {
    if (model.root_id.slice().len == 0 or path.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.deleteDocument(
        &writer,
        model.root_id.slice(),
        path,
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 打开项目或单份稿子。路径由 Rust 的系统选择器给出，界面不碰它。
fn adoptRootMsg(comptime folder: bool) ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.chooseAndAdoptRoot(&writer, folder) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 打开文件树里的一份文档。
///
/// 送的是 `rootId\n相对路径`，绝对路径由 Rust 解析——这条边界是「界面无法
/// 指定任意文件」的实现处，不是一条约定。
/// 一行文件树向 `document_open` 借的那段 `rootId\n相对路径`。
///
/// 字节先编在栈上，再搬进这一道 build 的 arena（`project_request.keepBytes`）：
/// SDK 在点击时才读它，栈活不到那一刻，而 arena 与树同生共死、开着的菜单
/// 另有世代钉住。之前两代都把字节放在模块级：64 个轮换的槽（一行借三次，
/// 一屏 64 行就是 192 次，第 22 行起前面那些行的引用已改成后面行的路径），
/// 后来是一帧一块的帧缓冲（同帧不再互覆，但菜单活过下一帧时仍被切掉）。
///
/// 文件树行与搜索命中共用它，所以借用的记账只此一处：搜索那侧曾自己推
/// 池的游标，两个写者共管一个游标。
const reference_max_bytes: usize = 1024;

pub fn borrowDocumentReference(root_id: []const u8, path: []const u8) ?[]const u8 {
    var scratch: [reference_max_bytes]u8 = undefined;
    const reference = project_view.documentReference(&scratch, root_id, path) orelse return null;
    return project_request.keepBytes(reference);
}

pub fn openDocumentMsg(model: *const Model, path: []const u8) ?Msg {
    const reference = borrowDocumentReference(model.root_id.slice(), path) orelse return null;
    return .{ .document_open = reference };
}

test "sixty-five tree rows keep their own document reference" {
    // F-01 的另一半：一行借三次（`on_press`、`on_submit`、菜单首项），
    // 64 行就是 192 次进 64 个槽。画出来的行文字是对的（它来自答复），
    // 锿上去的引用不是——无障碍指纹因此也看不见它。
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    project_request.bindBuildArena(arena.allocator());
    defer project_request.bindBuildArena(null);
    var model: Model = .{};
    try model.root_id.set("r1");
    const first = openDocumentMsg(&model, "第一.md").?.document_open;
    var index: usize = 0;
    while (index < 64) : (index += 1) _ = openDocumentMsg(&model, "后来.md");
    try std.testing.expect(std.mem.indexOf(u8, first, "第一.md") != null);
}

test "a build with nowhere to keep a reference refuses instead of lending the stack" {
    // 拒绝是可见的：`filesView` 拿到 null 就把那一行画成不可按并说出原因。
    // 未绑定与分配失败走同一条拒绝路；两者都不得把栈上那段交给 SDK。
    project_request.bindBuildArena(null);
    try std.testing.expect(borrowDocumentReference("r1", "第一.md") == null);
    project_request.bindBuildArena(std.testing.failing_allocator);
    defer project_request.bindBuildArena(null);
    try std.testing.expect(borrowDocumentReference("r1", "第一.md") == null);
}

/// 文件树的下一页。游标由 Rust 给，界面原样送回。
fn documentPageMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.documentPage(
        &writer,
        model.root_id.slice(),
        model.document.cursor.slice(),
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 导入正文或资料。文件由 Rust 的选择器给出，来源永不写回。
fn importMsg(model: *const Model, comptime manuscript: bool) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.chooseAndImport(
        &writer,
        model.root_id.slice(),
        manuscript,
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

test "A1：三十行文件树，每一行的点击打开的是它自己那一行" {
    // `Surface-memory-SPEC.md` 的 A1。借用层的等价断言已经在上面（一行借三次、
    // 六十五行仍各说各的话），这一条是**视图层**的：把 `filesView` 真的建出来，
    // 逐行取它绑上去的 `on_press`，问那段请求字节里写的是不是这一行的路径。
    //
    // 为什么两条都要：借用层证明 `borrowDocumentReference` 不覆写，视图层证明
    // 这一屏**把哪一个引用绑给了哪一行**。F-01 死在第二件事上——画出来的行文字
    // 一直是对的（它来自答复），所以无障碍指纹看不见它。
    //
    // 三十行不是随手取的数：F-01 的触发阈值是可见文档 ≥ 22 份。
    var reply_bytes: [8192]u8 = undefined;
    var paths: [30][]const u8 = undefined;
    var names: [30][16]u8 = undefined;
    for (0..30) |index| {
        paths[index] = std.fmt.bufPrint(&names[index], "第{d:0>3}章.md", .{index}) catch unreachable;
    }
    view_harness.storeOpened(&reply_bytes, "r1", &paths);
    defer replies.clearAll();

    var surface = view_harness.Surface.init(std.testing.allocator);
    defer surface.deinit();
    var model: Model = .{};
    try model.root_id.set("r1");
    const tree = surface.build(&model, filesView);

    var found: [64]view_harness.Node = undefined;
    const count = view_harness.rows(tree, .treeitem, &found);
    try std.testing.expectEqual(@as(usize, 30), count);
    for (found[0..count], 0..) |row, index| {
        const request = view_harness.requestBytes(row.on_press);
        try std.testing.expect(request.len > 0);
        try std.testing.expect(std.mem.indexOf(u8, request, paths[index]) != null);
        // 而且**只**含它自己那一行：`第000章.md` 是 `第0000章.md` 的前缀这类
        // 巧合在三位数编号下不成立，但断言写成「行标签也是它自己」更直接。
        try std.testing.expect(std.mem.indexOf(u8, row.widget.semantics.label, paths[index]) != null);
    }
}

test "A2：菜单开着时的一次重建不动它的载荷" {
    // `Surface-memory-SPEC.md` 的 A2。SDK 为呈现中的菜单钉住它建自的 arena
    // 世代，于是开着的菜单能活过任意多次重建（`ui_app.zig:6317`）。钉住保护的
    // 是 arena；静态帧缓冲在它底下照转，那是 F-03。
    //
    // 这条断言的形状：拿住第一行菜单首项的载荷，再建一道，然后问**手里那段
    // 字节**还说不说同一句话。载荷在 arena 上时它说；在一块每帧从头切的缓冲上
    // 时，第二道会把它写成别的行的请求。
    var reply_bytes: [8192]u8 = undefined;
    var paths: [30][]const u8 = undefined;
    var names: [30][16]u8 = undefined;
    for (0..30) |index| {
        paths[index] = std.fmt.bufPrint(&names[index], "第{d:0>3}章.md", .{index}) catch unreachable;
    }
    view_harness.storeOpened(&reply_bytes, "r1", &paths);
    defer replies.clearAll();

    var surface = view_harness.Surface.init(std.testing.allocator);
    defer surface.deinit();
    var model: Model = .{};
    try model.root_id.set("r1");

    const first_build = surface.build(&model, filesView);
    var found: [64]view_harness.Node = undefined;
    const count = view_harness.rows(first_build, .treeitem, &found);
    try std.testing.expect(count >= 30);
    const menu = found[0].context_menu;
    try std.testing.expect(menu.len > 0);
    const pinned = view_harness.requestBytes(menu[0].msg);
    try std.testing.expect(std.mem.indexOf(u8, pinned, paths[0]) != null);

    // 重建，不复位 arena——与 SDK 钉住世代时做的事同形。
    _ = surface.rebuildPinned(&model, filesView);
    try std.testing.expect(std.mem.indexOf(u8, pinned, paths[0]) != null);
}
