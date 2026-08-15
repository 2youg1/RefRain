//! 文件去处：文件树、行菜单、打开／删除／披露／导入。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

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
        // 自己给出入口，而不是显示一句「没有项目」。
        return ui.column(.{ .gap = 12, .padding = 16 }, .{
            // 「前往」节与命令面板同一份（paletteGoSection，单一来源）：
            // 空项目时也画全八个去处——够不着的由 core 的 navigate 具名拒绝，
            // 作者由此学会键位，而不是发现不了功能存在（v0.3.0 走查问题 1）。
            shell_view.paletteGoSection(ui, model, ""),
            ui.text(.{}, "还没有打开项目"),
            ui.row(.{ .gap = 8 }, .{
                ui.button(.{
                    .variant = .primary,
                    .on_press = adoptRootMsg(true),
                    .semantics = .{ .label = "打开一个项目文件夹" },
                }, "打开项目"),
                ui.button(.{
                    .on_press = adoptRootMsg(false),
                    .semantics = .{ .label = "打开单独一份稿子" },
                }, "打开文档"),
            }),
        });
    }
    const opened = replies.borrow(.project);
    // 文件树只画 `opened` 形状的答复：一次搜索会把公共槽换成命中，而在
    // 命中里数出来的行数会让这一屏画出别的东西。
    const documents: []const wire.DocumentRow = if (opened.head(.opened)) |head|
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
        rows[index] = if (rendered) |shown|
            shell_view.railTreeRow(ui, .{
                .key = .{ .index = index },
                .on_press = openDocumentMsg(model, shown.label),
                // Enter 打开：与点击同一条消息（list_item 键图的行主键）。
                .on_submit = openDocumentMsg(model, shown.label),
                // 对这一行做的事属于这一行：打开、删除、改披露都在菜单里，
                // 作者不必先选中再去屏幕底部瞄一排按钮。
                .context_menu = documentRowMenu(ui, model, shown.label),
                .semantics = .{ .role = .treeitem, .label = shown.label },
            }, 1, ui.fmt("{s} · {s}", .{ shown.label, shown.detail }))
        else
            shell_view.railTreeRow(ui, .{ .key = .{ .index = index }, .disabled = true }, 1, "这一行读不出来");
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        // 「前往」节置顶：八个去处的鼠标入口与键位提示（paletteGoSection，
        // 与命令面板同一份，单一来源）。树状排列与键位印行上，服务慢鼠标
        // 画像——不大幅移鼠标也够得着全部功能（v0.3.0 走查问题 1）。
        shell_view.paletteGoSection(ui, model, ""),
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
    return .{ .project_request = request.bytes };
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
) []const Adapter.Ui.ContextMenuItem {
    const items = ui.arena.alloc(Adapter.Ui.ContextMenuItem, 6) catch return &.{};
    items[0] = .{ .label = "打开", .msg = openDocumentMsg(model, path) };
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
    return .{ .project_request = request.bytes };
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
    return .{ .project_request = request.bytes };
}

/// 打开项目或单份稿子。路径由 Rust 的系统选择器给出，界面不碰它。
fn adoptRootMsg(comptime folder: bool) ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.chooseAndAdoptRoot(&writer, folder) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 打开文件树里的一份文档。
///
/// 送的是 `rootId\n相对路径`，绝对路径由 Rust 解析——这条边界是「界面无法
/// 指定任意文件」的实现处，不是一条约定。
/// 文件树行的打开引用池：`document_open` 的 reference 与 project_request
/// 同一条借用纪律——SDK 在点击时才读它，栈 buffer 活不到那一刻。64 槽
/// 按渲染顺序轮换，同帧的文件树行互不覆盖。
pub const DOCUMENT_REFERENCE_SLOTS: usize = 64;

pub var document_reference_pool: [DOCUMENT_REFERENCE_SLOTS][1024]u8 = undefined;

pub var document_reference_slot: usize = 0;

pub fn openDocumentMsg(model: *const Model, path: []const u8) ?Msg {
    document_reference_slot = (document_reference_slot + 1) % DOCUMENT_REFERENCE_SLOTS;
    const buffer: []u8 = document_reference_pool[document_reference_slot][0..];
    const reference = project_view.documentReference(buffer, model.root_id.slice(), path) orelse return null;
    return .{ .document_open = reference };
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
    return .{ .project_request = request.bytes };
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
    return .{ .project_request = request.bytes };
}
