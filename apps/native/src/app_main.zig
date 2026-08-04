const std = @import("std");
const builtin = @import("builtin");
const runner = @import("runner");
const native_sdk = @import("native_sdk");
const manifest = @import("app_manifest_zon");
const protocol = @import("generated/protocol.zig");
const themes = @import("generated/themes.zig");
pub const core = @import("refrain_core");
const host_bridge = @import("host_bridge.zig");
const corners = @import("corners.zig");
const workbench_view = @import("workbench_view.zig");
const roster_view = @import("roster_view.zig");
const snapshot = @import("snapshot.zig");
const project_request = @import("project_request.zig");
const project_view = @import("project_view.zig");
const document_language = @import("document_language.zig");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);
pub const Model = core.Model;
pub const Msg = core.Msg;

const Adapter = native_sdk.TsUiApp(core);
const manuscript_font_id = native_sdk.canvas.min_registered_font_id;
const manuscript_font_bytes = @embedFile("manuscript_font");
const shell_scene = native_sdk.app_manifest.shellConfigFrom(manifest);
const canvas_label = native_sdk.app_manifest.firstGpuSurfaceLabel(shell_scene);
const app_permissions = manifestStringList(manifest, "permissions");
pub const app_markup = @embedFile("app.native");
const CompiledView = native_sdk.canvas.CompiledMarkupView(Model, Msg, app_markup);

test {
    std.testing.refAllDecls(host_bridge);
    std.testing.refAllDecls(corners);
    std.testing.refAllDecls(workbench_view);
    std.testing.refAllDecls(roster_view);
    std.testing.refAllDecls(snapshot);
    std.testing.refAllDecls(project_request);
    std.testing.refAllDecls(project_view);
    std.testing.refAllDecls(document_language);
}

test "generated C ABI layouts match the Rust repr C contract" {
    // The request borrows its text through a pointer instead of inlining a
    // 12,000-byte array and the response lends its projection instead of\n    // inlining 40 KiB, so one keystroke crosses the ABI in 80 + 128 bytes.
    try std.testing.expectEqual(@as(usize, 96), @sizeOf(protocol.RefrainNativeRequest));
    try std.testing.expectEqual(@as(usize, 152), @sizeOf(protocol.RefrainNativeResponse));
}

test "bundled manuscript font fits the registry and covers the fixture scripts" {
    try std.testing.expect(manuscript_font_bytes.len <= 24 * 1024 * 1024);
    const face = try native_sdk.canvas.font_ttf.Face.parse(manuscript_font_bytes);
    for ([_]u21{ 'A', '0', 0x4e2d, 0x6587, 0x3068, 0x65e5, 0x672c, 0x8a9e }) |codepoint| {
        try std.testing.expect(face.glyphIndex(codepoint) != 0);
    }
}

test "document track preserves one bounded projection at the top and tail" {
    const text = "a\n\nb";
    const top = documentLayout(.{
        .text = text,
        .window_start = 0,
        .window_end = text.len,
        .first_block = 0,
        .block_count = 2,
        .document_selection_start = 0,
        .document_selection_end = 0,
        .selection = null,
        .composition = null,
        .line_count = 3,
        .format = 0,
    }, 100);
    try std.testing.expectEqual(@as(f32, 0), top.leading);
    try std.testing.expectApproxEqAbs(@as(f32, 3600), top.leading + top.projection + top.trailing, 0.001);

    const tail = documentLayout(.{
        .text = text,
        .window_start = 1000 - text.len,
        .window_end = 1000,
        .first_block = 98,
        .block_count = 2,
        .document_selection_start = 0,
        .document_selection_end = 0,
        .selection = null,
        .composition = null,
        .line_count = 3,
        .format = 0,
    }, 100);
    try std.testing.expectApproxEqAbs(@as(f32, 3600), tail.leading + tail.projection + tail.trailing, 0.001);
    try std.testing.expectEqual(@as(f32, 0), tail.trailing);
}

/// 把 Model 选中的那套 RefRain 主题交给 SDK。
///
/// **接上哪个功能**：七套主题的原生渲染。SDK 的 `manifestThemePack()` 只有一套
/// 中性灰；这里改为按 `model.themeIndex` 从生成色表取色。
///
/// **在全局逻辑中负责什么**：只做「下标 → 色值」这一次查表。Model 不持有颜色，
/// 色表不认识 Model，两边都不知道对方的内部结构。
///
/// **能复用什么**：色表由 `scripts/generate-themes.ts` 从与 `themes.css` 相同的
/// 四个锚点推导，所以原生表面与旧前端逐字节同色；`themeWithOverrides` 保留
/// SDK 的间距、圆角、动效等非颜色 token，只覆盖颜色与正文字体。
fn manuscriptTokens(model: *const Model) native_sdk.canvas.DesignTokens {
    const index: usize = if (model.themeIndex >= 0 and model.themeIndex < themes.themes.len)
        @intCast(model.themeIndex)
    else
        themes.default_index;
    const theme = themes.themes[index];
    return native_sdk.canvas.DesignTokens.themeWithOverrides(
        .{
            .pack = runner.manifestThemePack(),
            // 昼夜不是同一套配色的正反两面，但滚动条与焦点环这类 SDK 自绘的
            // 部件仍要知道自己在哪个时段，否则夜间主题上会出现亮色滚动槽。
            .color_scheme = if (theme.night) .dark else .light,
        },
        .{
            .colors = theme.colors,
            // 界面文字与正文共用这一份 Noto Sans SC。
            //
            // **少了 `font_id` 中文会渲染成方块**：SDK 的默认 sans 没有 CJK
            // 字形，而 RefRain 的界面文字（去处名、按钮、空状态）全是中文。
            // 只覆盖 `mono_font_id` 时正文正常、面板标签变成一条实心色块——
            // 真窗口截图正是这样抓到它的，两处单看都「有字」。
            .typography = .{
                .font_id = manuscript_font_id,
                .mono_font_id = manuscript_font_id,
            },
            // 圆角与颜色走同一条覆盖路径：SDK 自绘的菜单、下拉、对话框因此
            // 与正文旁边的表面同一套几何，不必为它们各写一遍描边。
            .radius = corners.radiusTokens(),
        },
    );
}

/// 菜单栏上的常驻项：正文有多长，以及不打开窗口就能做的几件事。
///
/// **接上哪个功能**：SDK 的 `status_item_fn`。标题与菜单都由 Model 派生，
/// 选中一项经 `on_command` 走 `commandMsg`——与快捷键、系统菜单、右键菜单
/// 同一个 command id 空间，所以四个入口不会说出不同的话。
///
/// **为什么对写作工具值得**：作者最常问的一句是「今天写了多少」。把它放在
/// 菜单栏上，这个问题不再需要切回窗口；而「保存」「去裁决」出现在同一处，
/// 是因为它们正是作者在别的应用里工作时会想起来的两件事。
///
/// 标题写进 SDK 给的暂存区，所以不必在 Model 里再存一份格式化后的字符串。
fn statusItem(model: *const Model, scratch: *Adapter.App.StatusItemScratch) Adapter.App.StatusItemState {
    const title = std.fmt.bufPrint(
        &scratch.title_buffer,
        "RefRain · {d} 字节",
        .{model.documentBytes},
    ) catch "RefRain";
    scratch.items[0] = .{ .id = 1, .label = "保存", .command = "document.save" };
    scratch.items[1] = .{ .id = 2, .label = "撤销", .command = "document.undo" };
    scratch.items[2] = .{ .id = 3, .separator = true };
    scratch.items[3] = .{ .id = 4, .label = "去裁决", .command = "go.3" };
    scratch.items[4] = .{ .id = 5, .label = "去信箱", .command = "go.5" };
    return .{ .title = title, .items = scratch.items[0..5] };
}

pub fn main(init: std.process.Init) !void {
    const app_state = try Adapter.create(std.heap.page_allocator, .{}, .{
        .name = manifest.name,
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .view = documentView,
        .tokens_fn = manuscriptTokens,
        .status_item_fn = statusItem,
        // 快捷键、系统菜单与菜单栏常驻项都经这一条进 core。
        //
        // **必须由接线显式设置**：`TsUiApp` 只自动接 `frameMsg`／`keyMsg` 那几个
        // 通道（它们按导出名 comptime 探测），`on_command` 不在其中。少了这一行，
        // `app.zon` 声明的 14 个快捷键与整张菜单栏全部静默——按下去毫无反应，
        // 而 `commandMsg` 的单元测试仍然全绿，因为它们测的是翻译，不是接线。
        // 真窗口探针正是这样抓到它的：widget 点击有反应，command 通道没有。
        .on_command = core.commandMsg,
        .fonts = &.{.{
            .id = manuscript_font_id,
            .name = "NotoSansSC-Variable.ttf",
            .ttf = manuscript_font_bytes,
        }},
        .markup = if (builtin.mode == .Debug)
            .{ .source = app_markup, .watch_path = "src/app.native", .io = init.io }
        else
            null,
    });
    defer app_state.destroy();

    host_bridge.bind(&app_state.effects);
    try runner.runWithOptions(app_state.app(), .{
        .app_name = manifest.name,
        .window_title = comptime windowTitle(),
        .bundle_id = manifest.id,
        .icon_path = "assets/icon.png",
        .default_frame = comptime defaultFrame(),
        .restore_state = comptime restoreState(),
        .js_window_api = false,
        .security = .{ .permissions = app_permissions, .navigation = .{ .allowed_origins = &.{} } },
    }, init);
}

const document_viewport_height: f32 = 650;
const document_block_height: f32 = @floatCast(protocol.virtual_block_height);
const document_line_height: f32 = 18;

const DocumentLayout = struct {
    leading: f32,
    projection: f32,
    trailing: f32,
};

fn documentLayout(document: host_bridge.DocumentView, total_blocks: u64) DocumentLayout {
    const track = @max(document_viewport_height, @as(f32, @floatFromInt(total_blocks)) * document_block_height);
    const projection_height = @max(document_viewport_height, @as(f32, @floatFromInt(document.line_count)) * document_line_height);
    const bounded_projection_height = @min(track, projection_height);
    const max_first_block = total_blocks -| @as(u64, document.block_count);
    const travel = track - bounded_projection_height;
    const leading = if (max_first_block == 0)
        0
    else
        travel * @as(f32, @floatFromInt(@min(document.first_block, max_first_block))) /
            @as(f32, @floatFromInt(max_first_block));
    return .{
        .leading = leading,
        .projection = bounded_projection_height,
        .trailing = @max(0, track - leading - bounded_projection_height),
    };
}

/// 名录：一列行，和作者停在哪一行。四个去处共用它。
///
/// **接上哪个功能**：裁决、派发、信箱、连接。行文字来自最近一次 Rust 答复
/// （`projectResult`，读法在 `snapshot.zig`），行数与游标来自 Model，措辞按
/// 去处下标查 `roster_view` 的表。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。「游标能不能动」归 `roster.ts`
/// 的不变量，「这一行允许什么动作」归 `project_view.runActions`——这里一条
/// 规则也不复制。空名录说话而不是留白：什么都不画会被读成界面坏了。
///
/// **能复用什么**：新增第五个去处只加一行措辞表项，这段不动。
fn rosterView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const wording = roster_view.wordingAt(model.destinationIndex);
    if (model.rosterCount <= 0) {
        return ui.column(.{ .gap = 8, .padding = 12 }, .{
            ui.text(.{}, wording.heading),
            ui.text(.{}, wording.empty),
        });
    }
    const host = snapshot.value(model.projectResult);
    const runs = snapshot.array(host, "runs");
    const count: usize = @intCast(@max(model.rosterCount, 0));
    // 一次只画看得见的那些：名录可以有几百条，而作者读的是他停留的附近。
    const window = @min(count, max_visible_rows);
    var rows: [max_visible_rows]Adapter.Ui.Node = undefined;
    var index: usize = 0;
    while (index < window) : (index += 1) {
        const selected = model.rosterCursor == @as(i64, @intCast(index));
        const rendered = if (runs.at(index)) |row|
            project_view.runRow(row)
        else
            null;
        rows[index] = if (rendered) |shown|
            ui.listItem(.{
                .key = .{ .index = index },
                .selected = selected,
                .semantics = .{ .role = .listitem },
            }, ui.fmt("{s} · {s}", .{ shown.label, shown.detail }))
        else
            // 读不出的行照实说。画一个空行，作者会以为那里真有一条 Run。
            ui.listItem(.{
                .key = .{ .index = index },
                .selected = selected,
                .disabled = true,
            }, "这一行读不出来");
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, wording.heading),
            // 真实条数与画出来的条数分开说：截断是可见事实，不是静默损失。
            ui.text(.{}, ui.fmt("{d} / {d}", .{ model.rosterCursor + 1, model.rosterCount })),
        }),
        ui.list(.{ .gap = 2, .semantics = .{ .role = .list, .label = wording.heading } }, @as([]const Adapter.Ui.Node, rows[0..window])),
        rosterActions(ui, model, host, runs),
    });
}

/// 界面一次最多画多少行。超出的部分由作者用名录上下键走到。
///
/// 定长而不是分配：视图每帧重建，一次分配一列几百行的节点数组会把这一帧的
/// 预算花在作者看不见的行上。
const max_visible_rows = 64;

/// 选中行上的动作。允许什么由状态说，不由界面猜。
///
/// **这是 F-08 的修法。** 旧栈为所有非终态 Run 显示「取消」，于是重启后的
/// Dispatched Run 上有一个后端必然拒绝的按钮。现在按钮来自
/// `project_view.runActions`，它读的是状态本身与待恢复名单。
fn rosterActions(
    ui: *Adapter.Ui,
    model: *const Model,
    host: snapshot.Value,
    runs: snapshot.Array,
) Adapter.Ui.Node {
    if (model.rosterCursor < 0) return ui.el(.stack, .{ .height = 0 }, .{});
    const row = runs.at(@intCast(model.rosterCursor)) orelse
        return ui.el(.stack, .{ .height = 0 }, .{});
    const run_id = snapshot.stringField(row, "id") orelse
        return ui.el(.stack, .{ .height = 0 }, .{});
    const actions = project_view.runActions(
        snapshot.field(row, "progress"),
        project_view.needsRecovery(host, run_id),
    );
    return ui.row(.{
        .gap = 8,
        .cross = .center,
        // 同一批动作的第二个入口：菜单开在行上，作者不必把手移到屏幕底部。
        .context_menu = rosterMenu(ui, model, actions, run_id),
    }, .{
        ui.button(.{
            // 两个条件都要：游标要指着一个真实的行（`rosterHasRow`，不变量
            // 归 `roster.ts`），且那一行的状态允许这个动作。少一个的表现
            // 分别是「空名录上按钮仍可点」与「点下去被 Rust 拒绝」。
            .disabled = !model.rosterHasRow or !actions.cancellable,
            .on_press = runCommandMsg("cancelRun", model, run_id),
            .semantics = .{ .label = "取消这一次派发" },
        }, "取消"),
        ui.button(.{
            .disabled = !model.rosterHasRow or !actions.retryable,
            .on_press = runCommandMsg("retryRun", model, run_id),
            .semantics = .{ .label = "重试这一次派发" },
        }, "重试"),
        ui.button(.{
            // 收取随时可按：结果还没出现是 `waiting` 那一态，不是错误。
            .disabled = !model.rosterHasRow,
            .on_press = collectRunMsg(model, run_id),
            .semantics = .{ .label = "收取这一次派发的结果" },
        }, "收取"),
        // 待恢复不是一个诊断字段，是作者必须能读到的产品状态。
        if (actions.needs_recovery)
            ui.text(.{}, "这一条需要恢复：重启后它没有活着的进程")
        else
            ui.spacer(1),
    });
}

/// 名录行上的右键菜单：选中行的动作，开在行上而不是屏幕底部。
///
/// 与正文菜单同一条纪律：它派的是与按钮完全相同的 Msg，所以两个入口不会
/// 说出不同的话。允许什么仍由 `project_view.runActions` 判——菜单里那两项
/// 会随状态灰掉，而不是点下去被 Rust 拒绝。
fn rosterMenu(
    ui: *Adapter.Ui,
    model: *const Model,
    actions: project_view.RunActions,
    run_id: []const u8,
) []const Adapter.Ui.ContextMenuItem {
    const items = ui.arena.alloc(Adapter.Ui.ContextMenuItem, 4) catch return &.{};
    items[0] = .{
        .label = "取消",
        .enabled = actions.cancellable,
        .msg = runCommandMsg("cancelRun", model, run_id),
    };
    items[1] = .{
        .label = "重试",
        .enabled = actions.retryable,
        .msg = runCommandMsg("retryRun", model, run_id),
    };
    items[2] = .{ .separator = true };
    items[3] = .{ .label = "回到正文", .msg = .{ .workbench_key = 1 } };
    return items;
}

/// 一条只带 Run id 的编排命令，编成 `project_request` 消息。
///
/// 编码缓冲每次现取：请求出不了这一帧——它随 Msg 提交时被复制进 Model 的
/// 堆，这正是它的寿命。
fn runCommandMsg(
    comptime command: []const u8,
    model: *const Model,
    run_id: []const u8,
) ?Msg {
    if (model.rootId.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.hostRunCommand(
        &writer,
        model.rootId,
        command,
        run_id,
        // 宿主自己没有钟：时刻随命令过河，它的事实才可重放。
        if (std.mem.eql(u8, command, "retryRun")) null else 0,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 文件树：项目里的文档名录，点一行就打开它。
///
/// **接上哪个功能**：`ChooseAndAdoptRoot`、`DocumentPage`、`OpenDocument`、
/// `CreateDocument`、`DeleteDocument`、导入。没有这一屏，作者打不开任何东西，
/// 其余去处全部够不着——这是接线顺序把它排在第一位的理由。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。行文字与角色归
/// `project_view.documentRow`，请求的写法归 `project_request`，路径解析在
/// Rust 里——跨界的是 Root id 加相对路径，界面无法指定任意文件。
fn filesView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.rootId.len == 0) {
        // 还没有项目：这一屏是作者第一次打开软件看到的东西，所以它必须
        // 自己给出入口，而不是显示一句「没有项目」。
        return ui.column(.{ .gap = 12, .padding = 16 }, .{
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
    const opened = snapshot.value(model.projectResult);
    const documents = snapshot.array(opened, "documents");
    const count: usize = @intFromFloat(@max(model.documentCount, 0));
    const window = @min(count, max_visible_rows);
    var rows: [max_visible_rows]Adapter.Ui.Node = undefined;
    var index: usize = 0;
    while (index < window) : (index += 1) {
        const row = documents.at(index);
        const rendered = if (row) |entry| project_view.documentRow(entry) else null;
        rows[index] = if (rendered) |shown|
            ui.listItem(.{
                .key = .{ .index = index },
                .on_press = openDocumentMsg(model, shown.label),
                // 对这一行做的事属于这一行：打开、删除、改披露都在菜单里，
                // 作者不必先选中再去屏幕底部瞄一排按钮。
                .context_menu = documentRowMenu(ui, model, shown.label),
                .semantics = .{ .role = .listitem, .label = shown.label },
            }, ui.fmt("{s} · {s}", .{ shown.label, shown.detail }))
        else
            ui.listItem(.{ .key = .{ .index = index }, .disabled = true }, "这一行读不出来");
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "文档"),
            // 画出来的与一共有多少分开说：作者据此知道还有没读到的。
            ui.text(.{}, ui.fmt("{d} / {d}", .{ model.documentCount, model.documentTotal })),
        }),
        // 搜索与文件树在同一屏：作者找一份稿子时不必先想「该去哪个去处」。
        searchView(ui, model),
        ui.list(
            .{ .gap = 2, .semantics = .{ .role = .list, .label = "项目里的文档" } },
            @as([]const Adapter.Ui.Node, rows[0..window]),
        ),
        ui.row(.{ .gap = 8 }, .{
            ui.button(.{
                .disabled = model.documentCursor.len == 0,
                .on_press = documentPageMsg(model),
                .semantics = .{ .label = "读下一页文档名录" },
            }, "再读一页"),
            ui.button(.{
                // 新建用搜索框里的字当标题：作者刚打完一个找不到的名字，
                // 下一步多半就是建它。空框时按钮灰着，不发一条会被拒绝的请求。
                .disabled = model.searchQuery.len == 0,
                .on_press = createDocumentMsg(model),
                .semantics = .{ .label = "用搜索框里的名字新建一篇正文" },
            }, "新建正文"),
            ui.button(.{
                .on_press = importMsg(model, true),
                .semantics = .{ .label = "把一份文本导入为正文" },
            }, "导入正文"),
            ui.button(.{
                .on_press = importMsg(model, false),
                .semantics = .{ .label = "把一份来源导入为资料" },
            }, "导入资料"),
        }),
    });
}

/// 新建一份正文。标题取搜索框里的字——作者刚打完一个找不到的名字，
/// 下一步多半就是建它，所以两处共用一个输入框而不是再开一个。
fn createDocumentMsg(model: *const Model) ?Msg {
    if (model.rootId.len == 0 or model.searchQuery.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.createDocument(
        &writer,
        model.rootId,
        model.searchQuery,
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
    if (model.rootId.len == 0 or path.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.setDisclosure(
        &writer,
        model.rootId,
        path,
        disclosure,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 删除一份文档。进系统回收站，不是抹掉——语义归 Rust。
fn deleteDocumentMsg(model: *const Model, path: []const u8) ?Msg {
    if (model.rootId.len == 0 or path.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.deleteDocument(
        &writer,
        model.rootId,
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
fn openDocumentMsg(model: *const Model, path: []const u8) ?Msg {
    var buffer: [1024]u8 = undefined;
    const reference = project_view.documentReference(&buffer, model.rootId, path) orelse return null;
    return .{ .document_open = reference };
}

/// 文件树的下一页。游标由 Rust 给，界面原样送回。
fn documentPageMsg(model: *const Model) ?Msg {
    if (model.rootId.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.documentPage(
        &writer,
        model.rootId,
        model.documentCursor,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 导入正文或资料。文件由 Rust 的选择器给出，来源永不写回。
fn importMsg(model: *const Model, comptime manuscript: bool) ?Msg {
    if (model.rootId.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.chooseAndImport(
        &writer,
        model.rootId,
        manuscript,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 设置：读当前值，改一项，立刻落盘。
///
/// **接上哪个功能**：`ReadConfig` 与 `ChangeConfig`。旧栈的设置只住在 Tauri 的
/// `lib.rs` 里，原生表面够不着同一份；现在两边读的是 `ConfigStore` 那一份。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。值的合法性归 `ConfigChange`
/// 的变体集合，落盘归 `ConfigStore`——界面不校验，也不缓存第二份。
fn settingsView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const config = snapshot.value(model.projectResult);
    const appearance = snapshot.field(config, "appearance");
    const theme = if (appearance) |shown|
        snapshot.stringField(shown, "theme") orelse ""
    else
        "";
    return ui.column(.{ .gap = 12, .padding = 16 }, .{
        ui.text(.{}, "设置"),
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "主题"),
            // 落盘那一份才是真的：显示读回来的值，而不是 Model 里的下标。
            // 两者漂开的表现是「界面看着换了、重开又变回去」。
            ui.text(.{}, if (theme.len > 0) theme else "还没读到"),
            ui.button(.{
                .on_press = .{ .theme_next = {} },
                .semantics = .{ .label = "换下一套主题" },
            }, "换一套"),
        }),
        // KARA：写作状态机的手动开关。⌘Enter 也走同一条消息——
        // 两个入口一条路径，不会出现「按钮开了但快捷键以为还关着」。
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "专注写作（KARA）"),
            ui.button(.{
                .on_press = karaToggleMsg(),
                .semantics = .{ .label = "进入或退出专注写作" },
            }, "切换"),
        }),
        // 排版三项：字号、行高、行长。只列这三项是因为它们决定一行有
        // 多少字、字有多大、行与行隔多远——作者真正会反复调的就是这些。
        // 其余（首行缩进、基线网格、页边距）定下来就不动。
        typographyRow(ui, "字号", "textSize", 5),
        typographyRow(ui, "行高", "lineHeight", 5),
        typographyRow(ui, "行长", "measure", 10),
        ui.button(.{
            .on_press = readConfigMsg(),
            .semantics = .{ .label = "重新读取设置" },
        }, "读取设置"),
    });
}

/// 排版里一项的加减。
///
/// **接上哪个功能**：`ConfigChange::AdjustTypography`。送增量而不是绝对值——
/// 按钮做的就是「大一点」，而送绝对值要界面先持有当前值，那份值在并发下
/// 可能已经旧了。
///
/// **在全局逻辑中负责什么**：只派 Msg。范围钳在 Rust（上下界是那些字段
/// 自己的性质），所以这里不判「还能不能再大」——判了就会与 Rust 各说
/// 各话，而作者看到的是按钮灰着但值其实还能动。
///
/// 步长按字段给：行长的单位是十分之一 em，与字号的十分之一像素不同量纲，
/// 共用一个步长会让其中一项每次只动一丝。
fn typographyRow(
    ui: *Adapter.Ui,
    comptime label: []const u8,
    comptime field: []const u8,
    comptime step: i64,
) Adapter.Ui.Node {
    return ui.row(.{ .gap = 8, .cross = .center }, .{
        ui.text(.{ .grow = 1 }, label),
        ui.button(.{
            .on_press = adjustTypographyMsg(field, -step),
            .semantics = .{ .label = label ++ "小一点" },
        }, "−"),
        ui.button(.{
            .on_press = adjustTypographyMsg(field, step),
            .semantics = .{ .label = label ++ "大一点" },
        }, "+"),
    });
}

fn adjustTypographyMsg(comptime field: []const u8, comptime delta: i64) ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.adjustTypography(&writer, field, delta) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 手动切换 KARA。
///
/// **接上哪个功能**：`KaraEvent::ManualToggle`——六态机在 Rust（INV-10），
/// 这边只送事件、取转移。界面不判「现在是开还是关」：判了就会与那台
/// 状态机各说各话，而作者看到的是按钮说开着、正文却没进专注。
fn karaToggleMsg() ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.karaStep(&writer, "manualToggle") orelse return null;
    return .{ .project_request = request.bytes };
}

/// 读当前设置。没有 value：`ReadConfig` 是无字段变体。
fn readConfigMsg() ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.readConfig(&writer) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 搜索：文档名与块级两种，规则都在 Rust。
///
/// **接上哪个功能**：`DocumentSearch` 与 `BlockSearch`。中文用与查询同构的
/// 重叠 bigram，精确无果才回退宽松——这些都在 Rust，界面只送词和档位。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。查询词住在 Model（`searchQuery`），
/// 不住在部件状态里：放在部件里一次重绘就会被冲掉，作者读成的是输入框自己
/// 清空了。
fn searchView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const Input = @FieldType(Msg, "search_typed");
    const results = snapshot.value(model.projectResult);
    const kind = snapshot.kind(model.projectResult);
    const is_blocks = std.mem.eql(u8, kind, "blocks");
    const rows = snapshot.array(results, if (is_blocks) "blocks" else "documents");
    const count = @min(rows.count(), max_visible_rows);
    var nodes: [max_visible_rows]Adapter.Ui.Node = undefined;
    var index: usize = 0;
    while (index < count) : (index += 1) {
        const row = rows.at(index).?;
        // 块命中带上下文，文档命中带路径。两种形状都认，认不出说读不出来。
        const label = snapshot.stringField(row, "path") orelse
            snapshot.stringField(row, "text") orelse
            "这一行读不出来";
        nodes[index] = ui.listItem(.{
            .key = .{ .index = index },
            .on_press = openDocumentMsg(model, snapshot.stringField(row, "path") orelse ""),
            .semantics = .{ .role = .listitem },
        }, label);
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.text(.{}, "搜索"),
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.textField(.{
                .grow = 1,
                .text = model.searchQuery,
                .placeholder = "搜索文档或正文",
                .on_input = Adapter.Ui.translatedInputMsg(.search_typed, Input),
                .semantics = .{ .label = "搜索词" },
            }),
            ui.button(.{
                .on_press = .{ .search_precision = {} },
                .semantics = .{ .label = "切换精确与宽松" },
            }, if (model.searchExact) "精确" else "宽松"),
        }),
        ui.row(.{ .gap = 8 }, .{
            ui.button(.{
                .on_press = searchMsg(model, false),
                .semantics = .{ .label = "按文档名搜索" },
            }, "找文档"),
            ui.button(.{
                .on_press = searchMsg(model, true),
                .semantics = .{ .label = "在正文里搜索" },
            }, "找正文"),
        }),
        ui.list(
            .{ .gap = 2, .semantics = .{ .role = .list, .label = "搜索结果" } },
            @as([]const Adapter.Ui.Node, nodes[0..count]),
        ),
    });
}

/// 一次搜索。空查询不发请求——空词在 Rust 那边是一次有名拒绝，
/// 而作者读成的是「搜索坏了」。
fn searchMsg(model: *const Model, comptime blocks: bool) ?Msg {
    if (model.rootId.len == 0 or model.searchQuery.len == 0) return null;
    var writer = project_request.Writer{};
    const request = if (blocks)
        project_request.blockSearch(&writer, model.rootId, model.searchQuery, model.searchExact)
    else
        project_request.documentSearch(&writer, model.rootId, model.searchQuery, model.searchExact);
    return .{ .project_request = (request orelse return null).bytes };
}

/// 正文上的右键菜单：把边栏的常用动作带到光标旁边。
///
/// **接上哪个功能**：保存、撤销、去文件树、去裁决台、去信箱、换主题。它们
/// 本来只住在窗口边缘的工具栏与侧栏里。
///
/// **在全局逻辑中负责什么**：只是同一批 Msg 的第二个入口，不是第二套规则——
/// 每一项派的都是 `commandMsg` 那些消息，所以菜单、快捷键、工具栏三处必然
/// 一致。「这个去处现在够不够得着」仍由 `update` 里的 `navigate` 判。
///
/// **为什么值得做**：KARA 模式下正文占满屏幕，而作者的手在触控板上——去一趟
/// 屏幕边缘要一次长距离移动加一次瞄准。菜单开在光标处，同样的动作是一次
/// 短按。macOS 的触控板习惯（双指轻点）本来就落在这个入口上。
///
/// 呈现由平台决定：有原生菜单宿主就用 `NSMenu`／`TrackPopupMenu`，没有就退回
/// SDK 自绘的一层——而那一层读的是 `manuscriptTokens`，所以昼间主题上它是
/// 纸色的，不是一块黑板。
fn manuscriptMenu(model: *const Model) []const Adapter.Ui.ContextMenuItem {
    // 菜单在一帧内消费完，所以用一个静态缓冲而不是每帧分配。它只在
    // 这个函数里写，写完立刻被 SDK 读走。
    const State = struct {
        var table: [10]Adapter.Ui.ContextMenuItem = undefined;
    };
    const selected = selectedText(host_bridge.documentView());
    // 高亮要有选区才有意义。灰掉而不是移除：一个时有时无的菜单项会让
    // 作者以为自己记错了菜单的样子。
    State.table = .{
        .{ .label = "高亮这一段", .msg = annotateMsg(model, selected), .enabled = selected.len > 0 },
        .{ .separator = true },
        .{ .label = "保存", .msg = .{ .document_save = {} } },
        .{ .label = "撤销", .msg = .{ .document_undo = {} } },
        .{ .separator = true },
        // 三个最常用的去处直达。八个全列会让菜单变成一张目录，
        // 而目录已经是命令面板（⌘K）的活。
        .{ .label = "文件", .msg = .{ .workbench_key = 2 } },
        .{ .label = "裁决", .msg = .{ .workbench_key = 3 } },
        .{ .label = "派发", .msg = .{ .workbench_key = 4 } },
        .{ .separator = true },
        .{ .label = "命令面板", .msg = .{ .palette_toggle = {} } },
    };
    return &State.table;
}

/// 在选中的一段正文上留一条高亮。
///
/// 只做高亮不做评论：评论要作者写一段字，而右键菜单按下即执行。
/// 评论走批注面板（尚未接）。
fn annotateMsg(model: *const Model, selected: []const u8) ?Msg {
    if (model.rootId.len == 0 or model.documentPath.len == 0) return null;
    if (selected.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.annotate(
        &writer,
        model.rootId,
        model.documentPath,
        selected,
        // 空 body 即高亮。
        "",
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 裁决台：一列提案，每条带前后文与三个裁决动作。
///
/// **接上哪个功能**：`ReadProposals`、`StageVerdict`、`CommitVerdicts`。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。判过没判过归 Rust 送来的
/// `staged`（它已按账本配对到提案 id），落盘的三态归 `DecisionReport`——
/// 界面不自己记「我判了几条」，那会与账本漂开。
///
/// **为什么前后文都画**：作者判的是「这一改值不值得」，只看新文本判不了。
fn reviewView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.rootId.len == 0 or model.documentPath.len == 0) {
        return ui.column(.{ .gap = 8, .padding = 12 }, .{
            ui.text(.{}, "待裁决的提案"),
            ui.text(.{}, "先打开一份稿子"),
        });
    }
    const listing = snapshot.value(model.projectResult);
    const total = project_view.proposalCount(listing);
    const window = @min(total, max_visible_rows);
    var rows: [max_visible_rows]Adapter.Ui.Node = undefined;
    var index: usize = 0;
    while (index < window) : (index += 1) {
        rows[index] = proposalRow(ui, model, listing, index);
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "待裁决的提案"),
            ui.text(.{}, ui.fmt("{d}", .{total})),
            ui.button(.{
                .on_press = readProposalsMsg(model),
                .semantics = .{ .label = "重新读取待裁决的提案" },
            }, "读取"),
            ui.button(.{
                .variant = .primary,
                .on_press = commitVerdictsMsg(model),
                .semantics = .{ .label = "把判过的这些落盘" },
            }, "提交裁决"),
        }),
        if (total == 0)
            ui.text(.{}, "没有等待裁决的提案")
        else
            ui.list(
                .{ .gap = 6, .semantics = .{ .role = .list, .label = "待裁决的提案" } },
                @as([]const Adapter.Ui.Node, rows[0..window]),
            ),
        // 落盘的结局要说出来：三态各说各的，`decisionMessage` 判。
        ui.text(.{}, project_view.decisionMessage(model.projectResult)),
    });
}

/// 一条提案：范围、原文、改后，以及三个裁决。
fn proposalRow(
    ui: *Adapter.Ui,
    model: *const Model,
    listing: snapshot.Value,
    index: usize,
) Adapter.Ui.Node {
    const proposal = project_view.proposalAt(listing, index) orelse
        return ui.text(.{}, "这一条读不出来");
    // 正在改写的是不是这一条。只有这一条展开编辑区——同时展开多条会让
    // 作者以为可以一次改好几处，而每次提交只带一条的最终正文。
    const revising = model.revisingProposal.len > 0 and
        std.mem.eql(u8, model.revisingProposal, proposal.id);
    return ui.el(.card, .{ .key = .{ .index = index }, .padding = 8 }, .{
        ui.column(.{ .gap = 4 }, .{
            ui.row(.{ .gap = 8, .cross = .center }, .{
                ui.text(.{ .grow = 1 }, proposal.scope),
                // 判过的行标出来，作者据此知道自己判到第几条。
                ui.text(.{}, if (proposal.staged) "已判" else ""),
            }),
            ui.text(.{}, proposal.before_text),
            // 只留评论的提案没有改后文本，那一行就不画——一个空的「改成」
            // 会被读成「改成空」。
            if (proposal.after_text.len > 0)
                ui.text(.{}, proposal.after_text)
            else
                ui.text(.{}, "（只留评论，不改正文）"),
            ui.row(.{ .gap = 8 }, .{
                ui.button(.{
                    .disabled = proposal.staged,
                    .on_press = verdictMsg(model, proposal.id, "accept"),
                    .semantics = .{ .label = "接受这一条" },
                }, "接受"),
                ui.button(.{
                    // 只留评论的提案没有可改的正文：改写它等于凭空写一段，
                    // 那是「拒绝后自己写」，不是改写。
                    .disabled = proposal.staged or proposal.after_text.len == 0,
                    .on_press = beginRevisionMsg(listing, index),
                    .semantics = .{ .label = "改写这一条再接受" },
                }, "改写"),
                ui.button(.{
                    .disabled = proposal.staged,
                    .on_press = verdictMsg(model, proposal.id, "reject"),
                    .semantics = .{ .label = "拒绝这一条" },
                }, "拒绝"),
                ui.button(.{
                    .disabled = proposal.staged,
                    .on_press = verdictMsg(model, proposal.id, "comment-only"),
                    .semantics = .{ .label = "只留评论，不改正文" },
                }, "只评论"),
            }),
            if (revising) revisionEditor(ui, model) else ui.el(.stack, .{ .height = 0 }, .{}),
        }),
    });
}

/// 改写区：作者把 Agent 的建议改成自己要的样子。
///
/// **接上哪个功能**：改写型裁决的编辑与提交。文字住在 Model
/// （`revisionText`），编辑规则在 `core.ts` 的 `revisionAfterEdit`——放在
/// 部件状态里，一次重绘就会把作者写的字冲掉。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。「改写型必须带最终正文」这条
/// 规则在 Rust 的入口（`stage_verdict`），这里不复制它；按钮在文字为空时
/// 灰掉，是为了让作者在按下之前就知道，而不是收到一次拒绝。
fn revisionEditor(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const Input = @FieldType(Msg, "revision_typed");
    return ui.column(.{ .gap = 6, .padding = 6 }, .{
        ui.text(.{}, "改成："),
        // 用 `ui.code(editable)` 而不是 `textField`：一段改写文字可以有多行，
        // 而 `textField` 是单行。SDK 的 code 部件在 editable 时正是引擎的
        // 多行编辑器（内部就是 textarea），顺带按稿子的语法上色——作者改的
        // 是这份稿子的一段，看到的颜色因此与正文一致。
        ui.code(.{
            .language = document_language.syntaxOf(host_bridge.documentView().format),
            .editable = true,
            .wrap = true,
            .on_input = Adapter.Ui.translatedInputMsg(.revision_typed, Input),
            .semantics = .{ .label = "改写后的正文" },
        }, model.revisionText),
        ui.row(.{ .gap = 8 }, .{
            ui.button(.{
                .variant = .primary,
                .disabled = model.revisionText.len == 0,
                .on_press = commitRevisionMsg(model),
                .semantics = .{ .label = "按我改的这版接受" },
            }, "按我改的接受"),
            ui.button(.{
                .on_press = @as(?Msg, .revision_cancel),
                .semantics = .{ .label = "放弃这次改写" },
            }, "取消"),
        }),
    });
}

/// 对一条提案下裁决。
///
/// 改写型（`accept-modified`）走 `commitRevisionMsg`：它多带一段作者写的
/// 正文，而这三种不带。空切片编成 `null` 而不是空串——「不改」与「改成空」
/// 是两件事，后者会把那一段抹掉。
fn verdictMsg(model: *const Model, proposal_id: []const u8, kind: []const u8) ?Msg {
    if (model.rootId.len == 0 or model.documentPath.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.stageVerdict(
        &writer,
        model.rootId,
        model.documentPath,
        proposal_id,
        kind,
        "",
        "",
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 开始改写一条提案：以 Agent 建议的改后文字为起点。
///
/// **接上哪个功能**：改写型裁决。起点在这里读而不是在 core 读——core 子集
/// 没有 JSON 解析器，那份答复只有 `snapshot.zig` 读得动。
///
/// 起点用建议而不是空白：作者多数时候只改一两个词。从空白开始等于让他
/// 重打一遍，那会把「改写」变成「拒绝后自己重写」。
fn beginRevisionMsg(listing: snapshot.Value, index: usize) ?Msg {
    const proposal = project_view.proposalAt(listing, index) orelse return null;
    return .{ .revision_begin = .{
        .proposalId = proposal.id,
        .seed = proposal.after_text,
    } };
}

/// 提交改写：作者写的那一段成为最终正文。
///
/// 与其余三种裁决共用 `stageVerdict`，只是多带 `final_text`。Rust 侧在入口
/// 就拒绝「改写型但没有最终正文」，所以这里不必自己判——但空文字仍然拦下，
/// 让作者在按钮上就知道还没写，而不是按下去收到一次拒绝。
fn commitRevisionMsg(model: *const Model) ?Msg {
    if (model.rootId.len == 0 or model.documentPath.len == 0) return null;
    if (model.revisingProposal.len == 0 or model.revisionText.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.stageVerdict(
        &writer,
        model.rootId,
        model.documentPath,
        model.revisingProposal,
        "accept-modified",
        model.revisionText,
        "",
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 提交暂存的裁决批次。裁决即落盘（D1／F-01）。
fn commitVerdictsMsg(model: *const Model) ?Msg {
    if (model.rootId.len == 0 or model.documentPath.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.commitVerdicts(
        &writer,
        model.rootId,
        model.documentPath,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 读这份文档上待裁决的提案。
fn readProposalsMsg(model: *const Model) ?Msg {
    if (model.rootId.len == 0 or model.documentPath.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readProposals(
        &writer,
        model.rootId,
        model.documentPath,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 收取选中那一条 Run 的结果。
fn collectRunMsg(model: *const Model, run_id: []const u8) ?Msg {
    if (model.rootId.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.collectRun(&writer, model.rootId, run_id) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 历史：这份稿子改过什么，可回档。
///
/// **接上哪个功能**：`refrain_app::history::recent_history`。读的是落盘的
/// 记录，不是内存里那条撤销链——作者关掉软件第二天回来，看得见的是这一份。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。已撤销的行仍然显示（灰着），
/// 因为它们是作者做过的事；从列表里消失会让他以为自己记错了。
fn historyView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const listing = snapshot.value(model.projectResult);
    var rows: [24]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const change = project_view.changeAt(listing, count) orelse break;
        rows[count] = ui.listItem(
            .{ .key = .{ .index = count }, .disabled = change.undone },
            ui.fmt("{d} · {s}{s}", .{
                change.ordinal,
                change.cause,
                if (change.undone) " · 已撤销" else "",
            }),
        );
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "这份稿子改过什么"),
            ui.button(.{
                .on_press = readHistoryMsg(model),
                .semantics = .{ .label = "重新读改动记录" },
            }, "刷新"),
        }),
        if (count == 0)
            ui.text(.{}, "还没有可回档的改动")
        else
            ui.column(
                .{ .gap = 2, .semantics = .{ .role = .list, .label = "改动记录" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// 读这份文档的改动记录。没打开稿子就没有可读的——按钮因此返回 null。
fn readHistoryMsg(model: *const Model) ?Msg {
    if (model.rootId.len == 0 or model.documentPath.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readHistory(
        &writer,
        model.rootId,
        model.documentPath,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 连接：这台机器上能派活给谁。
///
/// **接上哪个功能**：`refrain_app::harness::probe_harnesses`。名单固定
/// （认识几个适配器就是几行），所以一台什么都没装的机器上作者仍然看得见
/// 「可以连这两个」——只报装了的，那个界面是空的，而空界面读起来与
/// 「这个功能坏了」一样。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。「装了没有」「能做到哪一层」
/// 都由 Rust 探测，这里一条也不猜。中文标签住在 `project_view` 的翻译里。
fn connectionsView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const listing = snapshot.value(model.projectResult);
    var rows: [8]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const harness = project_view.harnessAt(listing, count) orelse break;
        // 一行装不下三件事（程序名、状况、能做什么），所以用卡片——
        // 与裁决台的提案行同族，不新起一套画法。
        rows[count] = ui.el(.card, .{ .key = .{ .index = count }, .padding = 8 }, .{
            ui.column(.{ .gap = 2 }, .{
                ui.row(.{ .gap = 8, .cross = .center }, .{
                    ui.text(.{ .grow = 1 }, harness.program),
                    ui.text(.{}, harness.state),
                }),
                // 探不到时不画等级：一个「只能写文件」会被读成它装好了
                // 而只是能力弱，而实际上它根本没装。
                ui.text(.{}, if (harness.ready) harness.tier else ""),
                ui.text(.{}, harness.version),
            }),
        });
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "本机 Harness"),
            ui.button(.{
                .on_press = readHarnessesMsg(),
                .semantics = .{ .label = "重新探测本机装了什么" },
            }, "重新探测"),
        }),
        if (count == 0)
            ui.text(.{}, "按「重新探测」看这台机器上能连什么")
        else
            ui.column(
                .{ .gap = 4, .semantics = .{ .role = .list, .label = "本机 Harness" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// 探测本机装了哪些 Harness。不带 Root——它问的是这台机器。
fn readHarnessesMsg() ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.readHarnesses(&writer) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 三种排法：作者看见的名字，与跨界送的那个词。
///
/// 下标在 Model，名字在这里——与去处表、主题名同一条纪律（中文进不了
/// core 子集的 rodata）。跨界那个词是 kebab-case，实测自 `wire_shapes.rs`。
const orchestrations = [_]struct {
    label: []const u8,
    wire: []const u8,
    hint: []const u8,
}{
    .{ .label = "并列", .wire = "alternates", .hint = "各写各的，互相看不见" },
    .{ .label = "接力", .wire = "follows", .hint = "后一个读前一个的完整产出" },
    .{ .label = "验证", .wire = "verifies", .hint = "第一个写，其余只出批注" },
};

/// 这个下标的排法。越界回落并列——它是唯一不给 Run 之间强加顺序的那种。
fn orchestrationAt(index: i64) @TypeOf(orchestrations[0]) {
    if (index < 0 or index >= orchestrations.len) return orchestrations[0];
    return orchestrations[@intCast(index)];
}

/// 派发台：选一段正文，写一句请求，送给一个或几个 agent。
///
/// **接上哪个功能**：`refrain_app::dispatch`。三步（起任务、授权、铸 Run）
/// 收在 Rust 里，这边只送「派发这一段」。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。范围来自正文当前的选区——
/// 作者在正文里框一段，切到这里就看见它。「这段原文还在不在稿子里」由
/// Rust 在派发入口判（对不回块就具名拒绝），这里不复制那条规则；空选区
/// 时按钮灰掉，是为了让作者在按下之前就知道。
///
/// **能复用什么**：请求框与改写框共用 `draftAfterEdit` 的编辑规则——两者
/// 都是「临时写的一段字，写好整段送出去」。
fn dispatchView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const Input = @FieldType(Msg, "dispatch_typed");
    const document = host_bridge.documentView();
    const selected = selectedText(document);
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.text(.{}, "派发"),
        // 先让作者看见他要派发的是哪一段。派发出去之后请求就冻结了，
        // 而这一刻是他唯一能核对范围的地方。
        if (selected.len > 0)
            ui.text(.{}, selected)
        else
            ui.text(.{}, "先在正文里选一段要改的文字"),
        ui.text(.{}, "要求："),
        ui.code(.{
            .language = .markdown,
            .editable = true,
            .wrap = true,
            .on_input = Adapter.Ui.translatedInputMsg(.dispatch_typed, Input),
            .semantics = .{ .label = "写给 agent 的要求" },
        }, model.dispatchPrompt),
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "agent"),
            ui.button(.{
                .on_press = .{ .dispatch_agents = -1 },
                .semantics = .{ .label = "少派一个" },
            }, "−"),
            ui.text(.{}, ui.fmt("{d}", .{model.dispatchAgents})),
            ui.button(.{
                .on_press = .{ .dispatch_agents = 1 },
                .semantics = .{ .label = "多派一个" },
            }, "+"),
        }),
        // 排法只在多于一个 agent 时有意义。一个 agent 时仍然画出来但灰掉，
        // 而不是整行消失——一行凭空出现的控件会让作者以为界面刚才坏了。
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, orchestrationAt(model.dispatchOrchestration).hint),
            ui.button(.{
                .disabled = model.dispatchAgents < 2,
                .on_press = @as(?Msg, .dispatch_orchestration),
                .semantics = .{ .label = "换一种排法" },
            }, orchestrationAt(model.dispatchOrchestration).label),
        }),
        ui.button(.{
            .variant = .primary,
            .disabled = selected.len == 0 or model.dispatchPrompt.len == 0,
            .on_press = dispatchMsg(model, selected),
            .semantics = .{ .label = "把这一段和要求送出去" },
        }, "送出去"),
    });
}

/// 作者此刻选中的那段正文。
///
/// 从投影里切：选区的偏移是相对 `document.text` 的，而那正是 Rust 送过来
/// 的那一窗字节。空选区返回空切片——不猜「他大概想派发整段」。
fn selectedText(document: host_bridge.DocumentView) []const u8 {
    const selection = document.selection orelse return &.{};
    const start = @min(selection.anchor, selection.focus);
    const end = @max(selection.anchor, selection.focus);
    if (end <= start or end > document.text.len) return &.{};
    return document.text[start..end];
}

/// 送出一次派发。
///
/// 范围的名字用固定的 `s1`：一次只送一段，标签只在请求里当位置标记给
/// agent 看。要让作者给范围命名，得先有多范围选择。
fn dispatchMsg(model: *const Model, selected: []const u8) ?Msg {
    if (model.rootId.len == 0 or model.documentPath.len == 0) return null;
    if (selected.len == 0 or model.dispatchPrompt.len == 0) return null;
    const agents: u64 = @intCast(@max(1, model.dispatchAgents));
    var writer = project_request.Writer{};
    const request = project_request.dispatchScope(
        &writer,
        model.rootId,
        model.documentPath,
        model.dispatchPrompt,
        "s1",
        selected,
        agents,
        // 一个 agent 时排法无意义，送并列：让 Rust 那边少一个「作者选了
        // 接力却只派了一个」的边角情况。
        if (model.dispatchAgents < 2) "alternates" else orchestrationAt(model.dispatchOrchestration).wire,
        "result.md",
        64 * 1024,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

fn documentView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const Input = @FieldType(Msg, "document_input");
    const Scroll = @FieldType(Msg, "document_scroll");
    const document = host_bridge.documentView();
    const total_blocks: u64 = @intCast(@max(model.documentBlocks, 0));
    const layout = documentLayout(document, total_blocks);
    var editor = ui.code(.{
        // 语法由 Rust 在打开文档时按文件名定，经协议过界（`document_language`
        // 那张表做翻译）。SDK 自带 17 门语法的高亮器，所以这一行接上之后
        // 代码文件就有色，零自研着色代码。散文走 markdown 语法。
        .language = document_language.syntaxOf(document.format),
        .editable = model.documentSession != 0,
        .on_input = Adapter.Ui.translatedInputMsg(.document_input, Input),
        .wrap = true,
        .height = layout.projection,
        .semantics = .{ .label = "RefRain manuscript" },
    }, document.text);
    editor.widget.text_selection = document.selection;
    editor.widget.text_composition = document.composition;
    const track = ui.scroll(.{
        .value = @floatCast(model.documentScroll),
        .on_scroll = Adapter.Ui.translatedScrollMsg(.document_scroll, Scroll),
        .grow = 1,
        // 右键菜单挂在正文的滚动区上：作者在正文里任意一处都够得到它，
        // 而不必先把光标移到某个特定部件上。
        .context_menu = manuscriptMenu(model),
        .semantics = .{ .label = "RefRain manuscript track" },
    }, .{
        ui.column(.{}, .{
            ui.el(.stack, .{ .height = layout.leading }, .{}),
            editor,
            ui.el(.stack, .{ .height = layout.trailing }, .{}),
        }),
    });
    // 一次只画一个去处——这正是把八个去处收成一个下标的用处：两个布尔可以
    // 同时为真，一个下标不可能同时是两个值。
    //
    // 文件与搜索是例外，它们与正文分栏并排：作者找一份稿子时不该失去手上
    // 这一份。分栏用 SDK 的 `split`，分割条自带键盘调节与 ARIA separator
    // 语义——零自研拖拽代码。
    const body: Adapter.Ui.Node = switch (model.destinationIndex) {
        0 => track,
        1 => ui.split(.{ .grow = 1 }, .{
            filesView(ui, model),
            track,
        }),
        // 裁决台画提案，不画 Run 名录：作者在这里判的是「这一改值不值得」。
        2 => reviewView(ui, model),
        // 派发台画的是「送什么出去」，不是「送出去了什么」——后者在信箱。
        3 => dispatchView(ui, model),
        // 连接问的是这台机器有什么，不是这个项目有什么。
        5 => connectionsView(ui, model),
        // 历史读的是落盘的记录，不是内存里那条撤销链。
        6 => historyView(ui, model),
        7 => settingsView(ui, model),
        else => rosterView(ui, model),
    };
    return ui.column(.{ .gap = 12, .padding = 16 }, .{
        CompiledView.build(ui, model),
        commandPalette(ui, model),
        body,
        ui.text(.{}, ui.fmt(
            "visible blocks {d}–{d} of {d} · bytes {d}–{d} · selection {d}..{d} · one Rust manuscript",
            .{
                document.first_block,
                document.first_block + document.block_count,
                model.documentBlocks,
                document.window_start,
                document.window_end,
                document.document_selection_start,
                document.document_selection_end,
            },
        )),
    });
}

/// 命令面板：八个去处，中文名归 `workbench_view` 的表，下标归 Model。
///
/// **接上哪个功能**：`palette_toggle` 打开它，`workbench_go` 选一个去处。
/// 标记里画不出这一段——中文标签进不了 core 子集，所以它落在 Zig 视图侧，
/// 与主题色表同一条纪律。
///
/// **在全局逻辑中负责什么**：只把表画出来并派 Msg。「这个去处现在够不够得着」
/// 由 `core.ts` 的 `navigate` 判，这里不复制那条规则——复制它就会出现
/// 「面板允许点、update 又拒绝」的两份判断。
fn commandPalette(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (!model.paletteOpen) return ui.el(.stack, .{ .height = 0 }, .{});
    var items: [workbench_view.destinations.len]Adapter.Ui.Node = undefined;
    for (workbench_view.destinations, 0..) |destination, index| {
        items[index] = ui.listItem(.{
            .selected = model.destinationIndex == @as(i32, @intCast(index)),
            .on_press = .{ .workbench_go = @intCast(index) },
            .semantics = .{ .label = destination.hint },
        }, ui.fmt("{d} · {s}", .{ index + 1, destination.label }));
    }
    return ui.el(.panel, .{ .padding = 8 }, .{
        ui.column(.{ .gap = 2 }, @as([]const Adapter.Ui.Node, &items)),
    });
}

fn windowTitle() []const u8 {
    if (shell_scene.windows.len > 0) {
        if (shell_scene.windows[0].title) |title| return title;
    }
    return manifest.display_name;
}

fn defaultFrame() native_sdk.geometry.RectF {
    if (shell_scene.windows.len == 0) return native_sdk.geometry.RectF.init(0, 0, 1280, 800);
    const window = shell_scene.windows[0];
    return native_sdk.geometry.RectF.init(
        window.x orelse 0,
        window.y orelse 0,
        window.width,
        window.height,
    );
}

fn restoreState() bool {
    if (shell_scene.windows.len == 0) return true;
    return shell_scene.windows[0].restore_state;
}

fn manifestStringList(comptime value: anytype, comptime field: []const u8) []const []const u8 {
    comptime {
        if (!@hasField(@TypeOf(value), field)) return &.{};
        var out: []const []const u8 = &.{};
        for (@field(value, field)) |entry| out = out ++ &[_][]const u8{entry};
        return out;
    }
}
