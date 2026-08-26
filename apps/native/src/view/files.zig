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

/// 文件树：项目里的文档名录，点一行就打开它。
///
/// **接上哪个功能**：`ChooseAndAdoptRoot`、`DocumentPage`、`OpenDocument`、
/// `CreateDocument`、`DeleteDocument`、导入。没有这一屏，作者打不开任何东西，
/// 其余去处全部够不着——这是接线顺序把它排在第一位的理由。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。行文字与角色归
/// `project_view.documentRow`，请求的写法归 `project_request`，路径解析在
/// Rust 里——跨界的是 Root id 加相对路径，界面无法指定任意文件。
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
    const window = @min(documents.len, shell_view.max_visible_rows);
    var rows: [shell_view.max_visible_rows]Adapter.Ui.Node = undefined;
    var index: usize = 0;
    while (index < window) : (index += 1) {
        const rendered = project_view.documentRow(opened, documents[index]);
        rows[index] = if (rendered) |shown| row: {
            // 一行只借一次：点击、Enter、菜单首项是同一个动作，借三次只会把
            // 同一帧里后面的行挤出预算。
            const open = openDocumentMsg(model, shown.label);
            // 这一帧的引用字节用完了：行画成不可按并说出原因。默默接下点击
            // 却不动，作者读到的是「这份稿子坏了」。
            if (open == null) break :row shell_view.railTreeRow(
                ui,
                model,
                .{ .key = .{ .index = index }, .disabled = true, .semantics = .{ .role = .treeitem, .label = shown.label } },
                1,
                ui.fmt("{s} · 这一屏放不下这一行的动作", .{shown.label}),
            );
            break :row shell_view.railTreeRow(ui, model, .{
                .key = .{ .index = index },
                .on_press = open,
                // Enter 打开：与点击同一条消息（list_item 键图的行主键）。
                .on_submit = open,
                // 对这一行做的事属于这一行：打开、删除、改披露都在菜单里，
                // 作者不必先选中再去屏幕底部瞄一排按钮。
                .context_menu = documentRowMenu(ui, model, shown.label, open),
                .semantics = .{ .role = .treeitem, .label = shown.label },
            }, 1, ui.fmt("{s} · {s}", .{ shown.label, shown.detail }));
        } else shell_view.railTreeRow(ui, model, .{ .key = .{ .index = index }, .disabled = true }, 1, "这一行读不出来");
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "文档"),
            // 画出来的与一共有多少分开说：作者据此知道还有没读到的。
            ui.text(.{}, ui.fmt("{d} / {d}", .{ window, model.document.total })),
        }),
        // 搜索与文件树在同一屏：作者找一份稿子时不必先想「该去哪个去处」。
        search_view.searchView(ui, model),
        ui.list(
            .{ .gap = shell_view.rail_row_gap_px, .semantics = .{ .role = .tree, .label = "项目里的文档" } },
            @as([]const Adapter.Ui.Node, rows[0..window]),
        ),
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
