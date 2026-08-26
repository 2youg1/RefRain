const std = @import("std");
const builtin = @import("builtin");
const runner = @import("runner");
const native_sdk = @import("native_sdk");
const manifest = @import("app_manifest_zon");
const protocol = @import("generated/protocol.zig");
const themes = @import("generated/themes.zig");
/// 状态机。单元 13 之前这里写的是 `@import("refrain_core")`（转译过的 `core.ts`）；
/// 现在它直指 Zig 核心，那个名字落到唯一的权威上。
pub const core = @import("core.zig");
const replies = @import("core/replies.zig");
const host_bridge = @import("host_bridge.zig");
const corners = @import("corners.zig");
const veil = @import("veil.zig");
const commands = @import("commands.zig");
const motion = @import("motion.zig");
// 名字避开派发台资料区的局部 `material`（materialAt 行）：这个模块是配方权威。
const material_recipe = @import("material.zig");
const material_paint = @import("material_paint.zig");
const rail = @import("rail.zig");
const panel_stack = @import("panel_stack.zig");
const workbench_view = @import("workbench_view.zig");
const wire = @import("generated/wire.zig");
const project_request = @import("project_request.zig");
const project_view = @import("project_view.zig");
const document_language = @import("document_language.zig");
// 回放缝：Zig 核心问 Rust 的唯一出口。`core.zig` 的 `update` 与握手都经它，
// 录制与回放因此看见同一条记录。
const replay_seam = @import("replay_seam.zig");
// 单元 12 的规则层：去处/导航/面板栈与名录游标。
const core_workbench = @import("core/workbench.zig");
const core_roster = @import("core/roster.zig");
const core_text = @import("core/text.zig");
const core_msg = @import("core/msg.zig");
const core_model = @import("core/model.zig");
// 单元 34：一去处一个文件，路由留在这里。共享词汇在 `view/shell.zig`。
const connections_view = @import("view/connections.zig");
const desk_view = @import("view/desk.zig");
const document_view = @import("view/document.zig");
const files_view = @import("view/files.zig");
const history_view = @import("view/history.zig");
const kara_view = @import("view/kara.zig");
const mailbox_view = @import("view/mailbox.zig");
const review_view = @import("view/review.zig");
// 搜索住在文件树那一栏里，所以只有 `view/files.zig` 叫得到它；这里导入它是为了
// 下面那条 `refAllDecls` —— 十一个去处模块的测试与声明都要被引用到，否则新文件
// 里的红在 `test:null` 上是看不见的。
const search_view = @import("view/search.zig");
const settings_view = @import("view/settings.zig");
const shell_view = @import("view/shell.zig");
// 视图层的测试接缝：`Ui` 建在 arena 上，节点树按语义角色可遍历。它自己没有
// 生产调用方，所以只有下面那条 `refAllDecls` 让它的声明被检查到。
const view_harness = @import("view/harness.zig");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);
pub const Model = core.Model;
pub const Msg = core.Msg;

/// `UiApp(Model, Msg)` 而不再是 `TsUiApp(core)`：后者多出来的那一层（模型镜像、
/// 字节桥、按导出名 comptime 探测入口）只为转译核心而存在。代价是四个入口必须
/// 在下面显式接线——漏一行，那条通道静默，而它自己的单元测试仍然全绿。
const Adapter = core.App;
const manuscript_font_id = native_sdk.canvas.min_registered_font_id;
const manuscript_font_bytes = @embedFile("manuscript_font");
// 三槽（SPEC 9.8）的另外两张：Latin 用 Antic Didone，日文用 Zen Kaku
// Gothic New。SDK 一个文本节点只挂一张字面，逐字回退还不存在，所以它们
// 目前是注册进运行时的可用面，正稿与界面仍由 manuscript_font 一张画出。
const latin_font_id = native_sdk.canvas.min_registered_font_id + 1;
const japanese_font_id = native_sdk.canvas.min_registered_font_id + 2;
const latin_font_bytes = @embedFile("latin_font");
const japanese_font_bytes = @embedFile("japanese_font");
const shell_scene = native_sdk.app_manifest.shellConfigFrom(manifest);
const canvas_label = native_sdk.app_manifest.firstGpuSurfaceLabel(shell_scene);
const app_permissions = manifestStringList(manifest, "permissions");

test {
    std.testing.refAllDecls(host_bridge);
    std.testing.refAllDecls(corners);
    std.testing.refAllDecls(veil);
    std.testing.refAllDecls(commands);
    std.testing.refAllDecls(panel_stack);
    std.testing.refAllDecls(rail);
    std.testing.refAllDecls(workbench_view);
    std.testing.refAllDecls(wire);
    std.testing.refAllDecls(project_request);
    std.testing.refAllDecls(project_view);
    std.testing.refAllDecls(document_language);
    std.testing.refAllDecls(replay_seam);
    std.testing.refAllDecls(core_workbench);
    std.testing.refAllDecls(core_roster);
    std.testing.refAllDecls(core_text);
    std.testing.refAllDecls(core_msg);
    std.testing.refAllDecls(core_model);
    std.testing.refAllDecls(core);
    std.testing.refAllDecls(replies);
    // 单元 34 的十一个去处模块。少一行，那个文件里的测试不跑而门禁照样绿。
    std.testing.refAllDecls(view_harness);
    std.testing.refAllDecls(shell_view);
    std.testing.refAllDecls(document_view);
    std.testing.refAllDecls(kara_view);
    std.testing.refAllDecls(files_view);
    std.testing.refAllDecls(search_view);
    std.testing.refAllDecls(settings_view);
    std.testing.refAllDecls(review_view);
    std.testing.refAllDecls(desk_view);
    std.testing.refAllDecls(mailbox_view);
    std.testing.refAllDecls(history_view);
    std.testing.refAllDecls(connections_view);
}

// 删除：「编译车道没有混形糖」那条测试随车道一起死。它守的是一条只对转译核心
// 成立的纪律（`update` 恒返 `[Model, Cmd]`，因为 facade 对混形的窄化在编译产物里
// 断裂，v0.3.0 真窗首派崩溃的根因）。Zig 的 `update_fx` 就地改 `*Model`，没有元组
// 可返，也就没有那条纪律可违——缺陷的形状本身不再可表示。

test "generated C ABI layouts match the Rust repr C contract" {
    // The request borrows its text through a pointer instead of inlining a
    // 12,000-byte array and the response lends its projection instead of\n    // inlining 40 KiB, so one keystroke crosses the ABI in 80 + 128 bytes.
    try std.testing.expectEqual(@as(usize, 96), @sizeOf(protocol.RefrainNativeRequest));
    try std.testing.expectEqual(@as(usize, 168), @sizeOf(protocol.RefrainNativeResponse));
    // 一条锚定区间恰好 48 字节：坐标三元组 + 36 字节身份，线上条目同形。
    try std.testing.expectEqual(@as(usize, 48), @sizeOf(protocol.AnchorRangeWire));
}

test "bundled manuscript font fits the registry and covers the fixture scripts" {
    try std.testing.expect(manuscript_font_bytes.len <= 24 * 1024 * 1024);
    const face = try native_sdk.canvas.font_ttf.Face.parse(manuscript_font_bytes);
    for ([_]u21{ 'A', '0', 0x4e2d, 0x6587, 0x3068, 0x65e5, 0x672c, 0x8a9e }) |codepoint| {
        try std.testing.expect(face.glyphIndex(codepoint) != 0);
    }
}

test "the latin and japanese slots parse and cover their own scripts" {
    // 每张面只担保自己那一槽：Antic Didone 是纯 Latin 面，缺 CJK 不是缺陷；
    // Zen Kaku Gothic New 担保假名与和制汉字。混入别人的字种会让「覆盖」
    // 变成没有人签的字。
    const latin = try native_sdk.canvas.font_ttf.Face.parse(latin_font_bytes);
    for ([_]u21{ 'A', 'z', '0', 0xe9, 0x2014 }) |codepoint| {
        try std.testing.expect(latin.glyphIndex(codepoint) != 0);
    }
    // 正向覆盖签不出这一槽装错了谁——CJK 面照样画得出 'A' 与 em dash，上面
    // 五个码位在 Latin 槽误指 Noto 时全绿。能分辨身份的只有反向断言：纯
    // Latin 面必然缺 CJK，这里的缺失是身份证明，不是缺陷。
    for ([_]u21{ 0x4e2d, 0x6587, 0x3042 }) |codepoint| {
        try std.testing.expect(latin.glyphIndex(codepoint) == 0);
    }
    const japanese = try native_sdk.canvas.font_ttf.Face.parse(japanese_font_bytes);
    for ([_]u21{ 'A', 0x3042, 0x30a2, 0x65e5, 0x672c }) |codepoint| {
        try std.testing.expect(japanese.glyphIndex(codepoint) != 0);
    }
}

/// 把 Model 选中的那套 RefRain 主题交给 SDK。
///
/// **接上哪个功能**：七套主题的原生渲染。SDK 的 `manifestThemePack()` 只有一套
/// 中性灰；这里改为按 `model.theme_index` 从生成色表取色。
///
/// **在全局逻辑中负责什么**：只做「下标 → 色值」这一次查表。Model 不持有颜色，
/// 色表不认识 Model，两边都不知道对方的内部结构。
///
/// **能复用什么**：色表由 `scripts/generate-themes.ts` 从与 `themes.css` 相同的
/// 四个锚点推导，所以原生表面与旧前端逐字节同色；`themeWithOverrides` 保留
/// SDK 的间距、圆角、动效等非颜色 token，只覆盖颜色与正文字体。
fn manuscriptTokens(model: *const Model) native_sdk.canvas.DesignTokens {
    const theme = &themes.themes[shell_view.currentThemeIndex(model)];
    // 面板材质的 token 一侧（2.10 方案 a）：右键菜单、下拉这类 SDK 自绘的
    // 面只读 token、不吃 app 侧部件字段——把表面/描边两色按材质配方换掉，
    // 菜单与功能区的面一起换肤（模糊是部件级接线，menu_surface 的模糊要
    // SDK 补丁，另立项）。纸色与正文底色不动：正文区恒实心（红线）。
    const kind = model.panel_material;
    var colors = theme.colors;
    if (kind != .solid) {
        colors.surface = material_paint.surfacePaint(kind, theme);
        colors.border = material_paint.borderPaint(kind, theme);
    }
    return native_sdk.canvas.DesignTokens.themeWithOverrides(
        .{
            .pack = runner.manifestThemePack(),
            // 昼夜不是同一套配色的正反两面，但滚动条与焦点环这类 SDK 自绘的
            // 部件仍要知道自己在哪个时段，否则夜间主题上会出现亮色滚动槽。
            .color_scheme = if (theme.night) .dark else .light,
        },
        .{
            .colors = colors,
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
            // 控件的色寄存器（M12 的一半）：行整类住在功能栏里，所以整类
            // 走栏的墨；右键菜单浮在正文上，明写纸 register 挡住 SDK 的
            // 逐字段回落。哪一类归哪一边的裁定在 `rail.controlTokens`。
            .controls = rail.controlTokens(theme),
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
fn statusItem(model: *const Model, scratch: *Adapter.StatusItemScratch) Adapter.StatusItemState {
    const title = std.fmt.bufPrint(
        &scratch.title_buffer,
        "RefRain · {d} 字节",
        .{model.document.bytes},
    ) catch "RefRain";
    scratch.items[0] = .{ .id = 1, .label = "保存", .command = "document.save" };
    scratch.items[1] = .{ .id = 2, .label = "撤销", .command = "document.undo" };
    scratch.items[2] = .{ .id = 3, .separator = true };
    scratch.items[3] = .{ .id = 4, .label = "去裁决", .command = "go.3" };
    scratch.items[4] = .{ .id = 5, .label = "去信箱", .command = "go.5" };
    return .{ .title = title, .items = scratch.items[0..5] };
}

/// chrome 动画的唯一登记口：veil（KARA 的纱）与呼吸墨线（保存在飞）共用
/// `Options.animations` 这一条通道，按段拼接。panel-in 随多层渲染一起删
///（v0.3.4 救援）：去处切换的过渡由 split 的 fraction tween 担任。
fn chromeAnimations(
    model: *const Model,
    tree: *const TsUiTree,
    start_ns: u64,
    out: []native_sdk.canvas.CanvasRenderAnimation,
) usize {
    const used = veil.animations(model, tree, start_ns, out);
    return used + inkAnimation(model, start_ns, out[used..]);
}

/// 呼吸墨线的一段（2.6/2.7）：保存答复未回时，状态行那条 36×2 的墨线
/// 以 ping_pong 起伏（1.6s 一次呼吸）——答复落地即不再声明，循环就此
/// 停下。等待是原子的：起伏只报「还活着」，不假装百分比。
/// 墨线是部件树里的元素（不是 suffix 定位）：栏脚高随 KARA 行变化，
/// 部件树给的位置永远是对的。
fn inkAnimation(model: *const Model, start_ns: u64, out: []native_sdk.canvas.CanvasRenderAnimation) usize {
    if (out.len == 0 or !model.document.save_pending) return 0;
    out[0] = .{
        .id = native_sdk.canvas.globalWidgetId(.stack, .{ .str = "busy-ink" }),
        .start_ns = start_ns,
        .duration_ms = motion.ink_breath_ms,
        .easing = motion.breath_easing,
        .from_opacity = motion.ink_dim_opacity,
        .to_opacity = motion.ink_full_opacity,
        .loop = .ping_pong,
    };
    return 1;
}

/// `Options.animations` 的 tree 形参类型（与 veil.zig 同一个实例化）。
const TsUiTree = Adapter.Ui.Tree;

pub fn main(init: std.process.Init) !void {
    // 分配器选 smp_allocator 而非 page_allocator：后者每次小分配占一整页，
    // UI 树每帧重建的临时结构会把已触碰的页越堆越多——实测空首屏私有
    // 工作集因此多占 ~20MB。smp_allocator 按 slab 字节粒度分配、块内复用，
    // 页池按需触碰（Zig 0.16 的 GPA 后继）。
    const app_state = try Adapter.create(std.heap.smp_allocator, .{
        .name = manifest.name,
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .view = documentView,
        .tokens_fn = manuscriptTokens,
        .status_item_fn = statusItem,
        // 状态机本体与开场的一次握手。
        .update_fx = core.update,
        .init_fx = core.initFx,
        // 四个入口都在这里显式接线。转译核心那条车道按导出名 comptime 探测
        // `frameMsg`／`keyMsg`，Zig 核心没有那层探测：**漏一行，那条通道就静默**，
        // 而它自己的单元测试仍然全绿——因为那些测试测的是翻译，不是接线。
        // 真窗口探针曾经就是这样抓到 `on_command` 漏接的：widget 点击有反应，
        // command 通道没有。`core.zig` 里有一条测试问另一半（每个 id 有没有落点），
        // 接没接上只有真窗口能答。
        .on_command = core.commandMsg,
        .on_lifecycle = core.lifecycleMsg,
        .on_frame = core.frameMsg,
        .on_key = core.keyMsg,
        // KARA 的纱：chrome 画在部件树之后、不进命中树（veil.zig 拥有它的
        // 几何与材质）；suffix 恒为 1 条命令。
        .chrome = .{
            .prefix_commands = 0,
            .suffix_commands = 1,
            .build = veil.build,
        },
        // 纱的进场淡入与离场上抬淡出（karaState 1/5 时各声明一条）；
        // 面板层的 panel-in 进场（换层边沿触发）同一条通道。
        .animations = chromeAnimations,
        .fonts = &.{
            .{
                .id = manuscript_font_id,
                // 这个名字必须与 `build.zig` 嵌入的字节相同。
                // 界面的每一个字都由这一副字面画（`typography.font_id`），
                // 而 SDK 不做逐码位跨字面回落：缺一个码位就画一个方块。
                // `verify:font-coverage` 逐字对这副字面的 cmap 验界面词表。
                .name = "NotoSansSC-Variable.ttf",
                .ttf = manuscript_font_bytes,
            },
            .{
                .id = latin_font_id,
                .name = "AnticDidone-Regular.ttf",
                .ttf = latin_font_bytes,
            },
            .{
                .id = japanese_font_id,
                .name = "ZenKakuGothicNew-Regular.ttf",
                .ttf = japanese_font_bytes,
            },
        },
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

fn documentView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    // Msg 的载荷、打开引用、失败原因标签都是向 SDK 借出去的字节，而 SDK 在
    // 点击时才读它们，开着的菜单还能活过任意多次重建（SDK 为此钉住 arena
    // 世代）。所以它们一律出自这一道 build 的 arena——SDK 自己的话是“model
    // storage or this same build arena”（`ui_app.zig:6317`）。这一行是那句话在
    // 这一层的实现处：绑定只此一处，与 SDK 在每道 build 前 reset arena 同一拍
    //（`ui_app.zig` 的 `while (true)` 重试循环重建整棵树，所以“视图函数开头”
    // 与“一道 build”在这里是同一件事）。
    project_request.bindBuildArena(ui.arena);
    const Scroll = @FieldType(Msg, "document_scroll");
    const document = host_bridge.documentView();
    const total_blocks: u64 = @intCast(@max(model.document.blocks, 0));
    // 行高/视口高/列宽都从 Model 换算（同一式各只有一处），滚动布局与
    // 部件绘制因此必然一致——旧的 650/18 硬编码的错误正是两处各写一份。
    const line_height = document_view.documentLineHeightPx(model);
    const layout = document_view.documentLayout(document, total_blocks, document_view.documentViewportHeightPx(model), line_height);
    var editor = ui.code(.{
        // 语法由 Rust 在打开文档时按文件名定，经协议过界（`document_language`
        // 那张表做翻译）。SDK 自带 17 门语法的高亮器，所以这一行接上之后
        // 代码文件就有色，零自研着色代码。散文走 markdown 语法。
        .language = document_language.syntaxOf(document.format),
        .editable = model.document.session != 0,
        .on_input = Adapter.Ui.inputMsg(.document_input),
        .wrap = true,
        // 列宽 = 生效行长 × 字号：作者调的「行长」在这里真正生效；0（帧前）
        // 自动宽。SDK 按这个宽度换行，Rust 按同一字身数断行，两处不换两套。
        .width = document_view.documentColumnWidthPx(model),
        .height = layout.projection,
        .semantics = .{ .label = "RefRain manuscript" },
    }, document.text);
    editor.widget.text_selection = document.selection;
    editor.widget.text_composition = document.composition;
    // 字号与行高进部件（SDK 侧的 RefRain 补丁：0 回落 token 阶梯）。
    // 滚动布局的行高与这里是同一个 line_height——光标、选区、滚动位置
    // 因此都落在真实行界上。
    editor.widget.text_size = @floatCast(model.typography.text_size);
    editor.widget.text_line_height = line_height;
    // 禁则断行进绘制：Rust 按 CLREQ 断好的行首交给部件照断——SDK 自己的
    // 换行搜索只认 space/tab，断不了中文（散文一个字也不会有断点）。
    editor.widget.hard_breaks = document.line_starts;
    // 提案印点与就地饭盒：叠在编辑区上（stack 的子元素不占流高），跟随
    // 滚动内容——印点的 y 由禁则行首推，x 在版心右缘内侧。
    const column_width = document_view.documentColumnWidthPx(model);
    var overlay: [document_view.max_anchor_dots + 2]Adapter.Ui.Node = undefined;
    overlay[0] = editor;
    var overlay_count: usize = 1;
    for (document.ranges) |range| {
        if (range.kind != 3) continue; // 2.1a 只画提案印点；批注的呈现随后
        if (overlay_count > document_view.max_anchor_dots) break;
        overlay[overlay_count] = document_view.anchorDot(ui, model, range, column_width, line_height, document.line_starts);
        overlay_count += 1;
    }
    if (document_view.verdictBento(ui, model, document, column_width, line_height)) |bento| {
        overlay[overlay_count] = bento;
        overlay_count += 1;
    }
    const editor_stack = ui.el(.stack, .{}, @as([]const Adapter.Ui.Node, overlay[0..overlay_count]));
    // 版心居中：列宽小于轨宽时两侧让出（旧版稿列的 margin auto 同源）；
    // 列宽为 0（帧前）时 spacer 收没，正文占满全宽。
    const centered_editor = ui.row(.{}, .{
        ui.spacer(1),
        editor_stack,
        ui.spacer(1),
    });
    const track = ui.scroll(.{
        .value = @floatCast(model.viewport.scroll),
        .on_scroll = Adapter.Ui.translatedScrollMsg(.document_scroll, Scroll),
        .grow = 1,
        // 右键菜单挂在正文的滚动区上：作者在正文里任意一处都够得到它，
        // 而不必先把光标移到某个特定部件上。
        .context_menu = document_view.manuscriptMenu(model),
        .semantics = .{ .label = "RefRain manuscript track" },
    }, .{
        ui.column(.{}, .{
            ui.el(.stack, .{ .height = layout.leading }, .{}),
            centered_editor,
            ui.el(.stack, .{ .height = layout.trailing }, .{}),
        }),
    });
    // 回来卡叠在正文轨顶：stack 的子元素不占流高、不随滚动走——它钉在
    // 轨顶（舞台规则豁免的浮层，见 karaReturnCard）。
    const track_with_card = ui.el(.stack, .{}, .{ track, kara_view.karaReturnCard(ui, model, column_width, line_height) });
    // 一处常驻的 split 承载全部去处（V0.2.4 的浮层+让位模型，SDK 的
    // split 是其原生等价）：去处切换 = fraction 变化 + 300ms 先快后慢
    // tween（旧版 panel-in 动效），正文不重建、不重排全文。
    //
    // **单侧极简（旧版 UI 哲学）**：一切从左侧出现——左 pane 恒画**当前去处
    // 一层**，正文恒在最右；右键菜单与 notice 是仅有的两个浮在正文上的
    // 东西。裁决是 stage 例外：独占整屏（旧版 takesWholeStage）。
    //
    // **多层并排删于 v0.3.4 救援（rescue+SPEC §1 R4/R6）**：那套渲染画层数用
    // 像素钳过的 `fittingDepth`，排序却按未钳的可见深度，窗宽不够时**被裁掉
    // 的正是作者刚按的那一页**；且每个侧层都是整张去处视图，导入入口因此
    // 被画两份。面板栈本体留在 core（Escape 退层读它），只是不再并排。
    // 左 pane 的内容：命令面板住在功能区（打开时整个换成它——模式替换，
    // 舞台规则不许浮层，关掉回原来的去处），否则是当前去处。
    const leading_content = if (model.palette.open)
        palettePanel(ui, model)
    else if (model.layout_fraction < 0.999)
        // 前往树是栏的常驻件（v0.3.4 救援）：任何面板去处的左栏都以它开头，
        // 站在信箱／设置上时鼠标导航不消失（旧形只有文件视图带它，作者一离开
        // 文件页就无处可点）。唯一权威在这里；文件视图不再自带副本。
        // 独占去处（稿子／裁决，fraction 1.0）不包：舞台规则不许侧面。
        ui.column(.{ .gap = 8 }, .{
            ui.column(.{ .padding = 12 }, .{shell_view.paletteGoSection(ui, model, "")}),
            destinationView(ui, model, track_with_card, model.destination),
        })
    else
        destinationView(ui, model, track_with_card, model.destination);
    // 探头态的感应面（2.13）：栏是贴左缘探出来的且作者还没用过它——
    // 指针移出整个栏宽发 `rail_peek_close` 收回稿子。感应面只在探头态挂：
    // 手动开的栏（railPeek==0）永不自动收，这条分支不进。迟滞 = 栏宽天然
    // 提供（开 4px、关约 248px）。只挂 leave 即可：SDK 对链上元素先捕获
    // 配对的 leave 再谈 enter，悬停对不因缺 enter 消息而哑（ui_app.zig
    // 悬停批处理注释）。
    const leading_hosted = if (!model.palette.open and model.rail_peek)
        ui.el(.stack, .{
            .grow = 1,
            .on_hover_leave = .{ .rail_peek_close = {} },
            .semantics = .{ .label = "探头功能栏" },
        }, .{leading_content})
    else
        leading_content;
    // 功能栏穿上自己的地与墨（M12）。稿子去处的左 pane 就是正文轨本身，
    // 不着栏色——那一帧根本没有栏。
    const leading = if (railHasGround(model))
        rail.dress(ui, &themes.themes[shell_view.currentThemeIndex(model)], leading_hosted)
    else
        leading_hosted;
    // 栏占掉的那一段宽：通知条与状态行都是正文那一栏的事（状态行报的是
    // 稿子的保存点与选区），所以它们从栏的右缘开始，而不是铺到窗左缘
    // 去压在栏上。
    const rail_lead = if (railEdgeX(model)) |edge|
        @max(0, edge - shell_view.shell_padding_px)
    else
        0;
    const body: Adapter.Ui.Node = ui.split(.{
        .value = @floatCast(model.layout_fraction),
        .resize_duration = motion.split_settle_ms,
        .resize_easing = motion.enter_easing,
        .on_resize = Adapter.Ui.translatedValueMsg(.split_resize, f64),
        .grow = 1,
    }, .{
        leading,
        switch (model.destination) {
            // 除了稿子与裁决（独占），正文恒在右 pane——作者做任何事时
            // 都不失去手上这一份（旧版正文让位同源）。
            .files, .dispatch, .mailbox, .connections, .history, .settings => track_with_card,
            // 面板开着时正文让位到右 pane（稿子本来独占，裁决仍独占）。
            else => if (model.palette.open and model.destination == .manuscript)
                track_with_card
            else
                ui.el(.stack, .{ .grow = 1 }, .{}),
        },
    });
    const root = ui.column(.{ .gap = 12, .padding = shell_view.shell_padding_px }, .{
        // 通知条横跨整窗，不让位给功能栏：它报的是具名的拒绝（「那个去处要
        // 先打开一份稿子」），而拒绝往往正发生在栏占满窗宽的时候——让位会
        // 把它振成一个读不出的碎片（真窗探针拍到过：三层时只剩一个
        // 「Dism」）。它自带地（`.alert` 的 chrome），所以跨在栏上也读得出。
        noticeBar(ui, model),
        body,
        kara_view.karaInterruptLine(ui, model),
        kara_view.karaSummaryStrip(ui, model),
        // 栏脚：只有状态行（2.6 语义化，每一句话都要值得那一行）。
        // 舞台规则：正文层之上不放交互件——KARA 的开关在设置页
        // （settingsView）与快捷键/菜单（commands.zig "kara.toggle"），
        // 栏脚不摆按钮。
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.el(.stack, .{ .width = rail_lead }, .{}),
            // 呼吸墨线：保存答复未回时在状态行左侧起伏（2.7，ping_pong）。
            // 在飞才有，走了就撤——栏脚不为「没在等什么」留一条死线。
            if (model.document.save_pending)
                ui.el(.stack, .{
                    .global_key = .{ .str = "busy-ink" },
                    .width = motion.ink_width,
                    .height = motion.ink_height,
                    .style_tokens = .{ .background = .accent },
                }, .{})
            else
                ui.spacer(0),
            ui.text(.{ .grow = 1 }, document_view.statuslineText(ui, model, document)),
        }),
    });
    // 壳上的两件叠加物：分栏线与悬停探头条。两件都要窗口的上下缘，
    // 而只有壳知道那两条缘在哪里。
    var shell_layers: [4]Adapter.Ui.Node = undefined;
    var shell_count: usize = 0;
    const railband = if (railEdgeX(model)) |edge| rail.band(
        ui,
        &themes.themes[shell_view.currentThemeIndex(model)],
        edge,
        @floatCast(@max(model.window.height, 0)),
    ) else null;
    // 地在最底层（栏内各层透它），线在最上层（它是分界，不能被任何
    // 一层盖住）。
    if (railband) |value| {
        shell_layers[shell_count] = value.ground;
        shell_count += 1;
    }
    shell_layers[shell_count] = root;
    shell_count += 1;
    if (railband) |value| {
        shell_layers[shell_count] = value.rule;
        shell_count += 1;
    }
    // 悬停开栏（2.13）：稿子全宽且面板没开时，窗口最左缘叠一条 4px 宽的
    // 探头条，指针贴上去（hover_enter）发 `rail_peek_open`——core 与 Ctrl+2
    // 同一条落地开栏并立起探头标记。条只在「栏没开」时存在，栏一开它就
    // 撤掉（去处下标不再是稿子），开与关的迟滞因此天然成立：开 4px、
    // 关要移出整个栏宽（约 248px，感应面见 split 左 pane 的 railPeek 分支）。
    // 高度取实窗高；窗尺寸未到时帧事件会立刻补上，不做无边界的猜测高度。
    if (!railOpen(model)) {
        const window_height: f32 = @floatCast(@max(model.window.height, 0));
        shell_layers[shell_count] = ui.el(.stack, .{
            .frame = native_sdk.geometry.RectF.init(0, 0, 4, window_height),
            .on_hover_enter = .{ .rail_peek_open = {} },
            .semantics = .{ .label = "悬停打开功能栏" },
        }, .{});
        shell_count += 1;
    }
    if (shell_count == 1) return root;
    return ui.el(.stack, .{}, @as([]const Adapter.Ui.Node, shell_layers[0..shell_count]));
}

/// 这一帧有没有功能栏。稿子去处且命令面板没开时正文占满全宽，没有栏——
/// 地、墨与分栏线三件事都读这一个判据。
fn railOpen(model: *const Model) bool {
    return model.palette.open or model.destination != .manuscript;
}

/// 栏这一帧有没有**自己的地**。墨跟着地走，否则就会出现「纸的地 + 栏的墨」
/// 那一帧（`rail.zig` 的注释记着它第一次是怎么被真窗探针抓到的）。
///
/// 独占去处（裁决）就是这个口子：`railOpen` 对它为真，而 `railEdgeX` 在
/// `layoutFraction ≥ 0.999` 时不铺地——于是整屏裁决台是纸底上的栏墨，实测
/// 下几乎读不出字。两件事同一个判据之后，那一帧回到纸的 register。
fn railHasGround(model: *const Model) bool {
    return railOpen(model) and model.layout_fraction < 0.999;
}

/// 功能栏的右缘在哪里（窗口坐标 px）。地、分栏线与页脚的让位共用这一个
/// 几何权威，所以三者不可能对不齐。
///
/// **出处**：根栏左 padding + 层宽，层宽走 `panel_stack.layerWidth`——与
/// `veil.rect` 量正文轨宽时同一式，不新造第二份版式算术。
///
/// **什么时候没有**：没有栏时；栏独占整屏时（`layoutFraction == 1`，稿子
/// 与裁决）——没有第二栏就没有分界，也无从让位；窗尺寸未到时（不猜）。
fn railEdgeX(model: *const Model) ?f32 {
    if (!railOpen(model)) return null;
    const fraction: f32 = @floatCast(model.layout_fraction);
    if (fraction >= 0.999) return null;
    const window_width: f32 = @floatCast(@max(model.window.width, 0));
    if (window_width <= 0 or model.window.height <= 0) return null;
    return shell_view.shell_padding_px + panel_stack.layerWidth(window_width, fraction);
}

/// 一条具名的拒绝。null = 无事，画一个零高的占位。
///
/// 单元 13 之前这一条住在 `app.native`（声明式标记）里，绑的是 `{noticeShown}` 与
/// `{notice}` 两个字段。Zig 核心的 `notice` 是 `?Line`——「没有话说」就是 null，
/// 那个伴生的布尔不再存在（`core/model.zig` 记的那条裁定）。标记的绑定器从
/// 可选的结构里取不出字串（`valueOf` 对 `.optional` 只能交出内层的值，而内层
/// 是一个结构），所以两者只能留一个：要么把伴生布尔请回来养标记，要么把这
/// 十行标记搬成 Zig。我选后者：一个为了渲染器而存在的状态字段会与真正的状态
/// 漂开，而这个界面剩下的 4,000 行本来就是 Zig 画的——十行标记不值一个第二权威。
fn noticeBar(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.notice == null) return ui.el(.stack, .{ .height = 0 }, .{});
    // 借模型的内存，不借栈拷贝：部件树在本函数返回后才读文本，`orelse`
    // 解包出的局部 Line 那时已死——真窗拄到过：提示条画出 24 个空格，
    // 恰是「先打开一份稿子。」的字节数（rescue+SPEC §1 R2）。
    const notice = &model.notice.?;
    return ui.el(.alert, .{
        .variant = .secondary,
        .semantics = .{ .label = "提示" },
    }, .{
        // 文本与「知道了」紧挨着，剩余宽度留白：条跨整窗时把 × 推到 1200px
        // 外，读者会把它读成一个无主的浮标（作者截图里正是如此）。
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{}, notice.slice()),
            ui.el(.button, .{
                .variant = .secondary,
                .icon = "x",
                .semantics = .{ .label = "知道了" },
                .on_press = .notice_dismiss,
            }, .{}),
            ui.spacer(1),
        }),
    });
}

/// 一个去处的视图：多层栈与 split 单点共用这份映射（一处改，两处同）。
/// 独占去处（0 稿子/2 裁决）不会出现在侧层——`visibleLayerAt` 跳过它们。
fn destinationView(
    ui: *Adapter.Ui,
    model: *const Model,
    track: Adapter.Ui.Node,
    destination: core.Destination,
) Adapter.Ui.Node {
    // 枚举而不是裸下标：那条 `else => track` 兵底随之消失，新增一个去处而忘了画它，
    // 编译器的穷尽性检查先红——而不是作者看到一屏正文。
    return switch (destination) {
        // 稿子：正文占满（右 pane 空）。文件：文件树最左，可拖宽。
        .manuscript => track,
        .files => files_view.filesView(ui, model),
        // 裁决台画提案，不画 Run 名录：作者在这里判的是「这一改值不值得」。
        .review => review_view.reviewView(ui, model),
        // 派发台画的是「送什么出去」，不是「送出去了什么」——后者在信箱。
        .dispatch => desk_view.dispatchView(ui, model),
        .mailbox => mailbox_view.mailboxView(ui, model),
        // 连接问的是这台机器有什么，不是这个项目有什么。
        .connections => connections_view.connectionsView(ui),
        // 历史读的是落盘的记录，不是内存里那条撤销链。
        .history => history_view.historyView(ui, model),
        .settings => settings_view.settingsView(ui, model),
    };
}

// `layeredBody`（多层并排）删于 v0.3.4 救援：它把每个历史层画成整张去处
// 视图（导入入口 ×2），窗宽不够时被裁掉的又恰好是当前页。单层 split
// 是现在唯一的版式；面板栈只供 Escape 退层（`core/workbench.zig`）。

/// 命令面板：住在功能区（rail）里，不是浮层。
///
/// **接上哪个功能**：`palette_toggle` 开合（开时清空查询，core 管）、
/// `palette_query` 过滤词、`workbench_go` 与各命令臂是行的落点。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。「这个去处现在够不够得着」
/// 由 `core/workbench.zig` 的 `navigate` 判，这里不复制那条规则。
///
/// **交互设计**：舞台规则不许浮层——面板打开时功能区整个换成它（模式
/// 替换），关掉回原来的去处；正文让位到右 pane，作者不失去手上这份。
/// 打开那帧焦点进过滤框（autofocus 边沿），Escape 关（panel_back 的分层
/// 已接）。命令分节渐进披露：前往／文档／视图／系统；标签子串过滤，
/// 空节不画。当前不可用的命令灰掉并在行尾说为什么（v0.2.4 的
/// availability 提示）——作者是慢鼠标画像，每个键位都印在行上让人学会。
fn palettePanel(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const query = model.palette.query.slice();
    // 命令面板住功能区成树（舞台规则），所以它与功能栏同形：包一层 .panel
    // 交给 `rail.dress`（调用处在 `documentView`）——地、墨、去盒三件事不
    // 在这里再写一遍，否则它会在已经去了盒的栏里再套一只盒。
    return ui.el(.panel, .{ .grow = 1 }, .{
        ui.column(.{ .gap = 8, .padding = 12 }, .{
            ui.textField(.{
                .text = query,
                .placeholder = "输入以过滤命令",
                .on_input = Adapter.Ui.inputMsg(.palette_query),
                // 边沿触发：面板随挂载出现，这一帧 false→true 拉一次焦点。
                .autofocus = true,
                .semantics = .{ .label = "过滤命令" },
            }),
            shell_view.paletteGoSection(ui, model, query),
            paletteCommandSection(ui, model, query, "文档", &.{ "document.save", "document.undo", "search" }),
            paletteCommandSection(ui, model, query, "视图", &.{ "theme.next", "kara.toggle" }),
            paletteCommandSection(ui, model, query, "系统", &.{"app.quit"}),
        }),
    });
}

/// 一节命令：标签子串过滤（UTF-8 安全——中文子串即字节子串），过滤后
/// 为空就不画这一节。
fn paletteCommandSection(
    ui: *Adapter.Ui,
    model: *const Model,
    query: []const u8,
    title: []const u8,
    ids: []const []const u8,
) Adapter.Ui.Node {
    var rows: [8]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    for (ids) |id| {
        if (query.len > 0 and std.mem.indexOf(u8, commands.labelOf(id), query) == null) continue;
        rows[count] = paletteCommandRow(ui, model, id);
        count += 1;
    }
    if (count == 0) return ui.el(.stack, .{ .height = 0 }, .{});
    return ui.column(.{ .gap = 2 }, .{
        ui.text(.{}, title),
        ui.column(.{ .gap = 2 }, @as([]const Adapter.Ui.Node, rows[0..count])),
    });
}

/// 一条命令行：标签 + 键位。不可用的灰掉并在行尾说为什么；on_press
/// 为 null（这里不认识的命令）同样灰掉——可点却没反应是最难归因的。
fn paletteCommandRow(ui: *Adapter.Ui, model: *const Model, id: []const u8) Adapter.Ui.Node {
    const msg = paletteMsg(id);
    const available = paletteAvailable(model, id);
    const label = commands.labelOf(id);
    const hint = commands.hintOf(id);
    const shown = if (!available)
        ui.fmt("{s}（需要先打开稿子）", .{label})
    else if (hint.len > 0)
        ui.fmt("{s}　{s}", .{ label, hint })
    else
        label;
    return shell_view.railTreeRow(ui, model, .{
        .disabled = !available or msg == null,
        .on_press = if (available) msg else null,
        .semantics = .{ .role = .treeitem, .label = label },
    }, 1, shown);
}

/// 命令 id → Msg。与 `core.zig` 的 `commandMsg` 同一个落点：直接发它翻译出的
/// 那条臂（面板行与快捷键因此必然一致）。
fn paletteMsg(id: []const u8) ?Msg {
    if (std.mem.eql(u8, id, "document.save")) return .{ .document_save = {} };
    if (std.mem.eql(u8, id, "document.undo")) return .{ .document_undo = {} };
    if (std.mem.eql(u8, id, "theme.next")) return .{ .theme_next = {} };
    if (std.mem.eql(u8, id, "kara.toggle")) return .{ .kara_toggle = {} };
    if (std.mem.eql(u8, id, "app.quit")) return .{ .app_quit = {} };
    // search 的落点是文件去处（commandMsg：case "search" → workbench_key 2）。
    if (std.mem.eql(u8, id, "search")) return .{ .workbench_key = 2 };
    return null;
}

/// 这条命令现在可不可用。保存/撤销要一份打开着的稿子——没有就说清楚，
/// 而不是让作者按一次被具名拒绝。
fn paletteAvailable(model: *const Model, id: []const u8) bool {
    if (std.mem.eql(u8, id, "document.save") or std.mem.eql(u8, id, "document.undo")) {
        return model.document.path.slice().len > 0;
    }
    return true;
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
