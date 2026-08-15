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
const snapshot = @import("snapshot.zig");
const project_request = @import("project_request.zig");
const project_view = @import("project_view.zig");
const document_language = @import("document_language.zig");
// P2 的回放缝：Zig 核心问 Rust 的出口。今天只有它自己的测试是读者——
// 车道切换在 P5，届时 update_fx 成为第二个读者、TS 车道成为零个。
const replay_seam = @import("replay_seam.zig");
// 单元 12 的规则层：去处/导航/面板栈与名录游标。
const core_workbench = @import("core/workbench.zig");
const core_roster = @import("core/roster.zig");
const core_text = @import("core/text.zig");
const core_msg = @import("core/msg.zig");
const core_model = @import("core/model.zig");

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
    std.testing.refAllDecls(snapshot);
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
    const japanese = try native_sdk.canvas.font_ttf.Face.parse(japanese_font_bytes);
    for ([_]u21{ 'A', 0x3042, 0x30a2, 0x65e5, 0x672c }) |codepoint| {
        try std.testing.expect(japanese.glyphIndex(codepoint) != 0);
    }
}

test "the document track inverts the projection's scroll anchor" {
    const text = "a\n\nb";
    // 视口高与行高由调用方按 Model 换算后传入；这里沿用旧的 650/18 直接给值，
    // 几何断言不变——换签名不换语义。
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
        .ranges = &.{},
        .line_starts = &.{},
    }, 100_000, 650, 18);
    try std.testing.expectEqual(@as(f32, 0), top.leading);

    const tail = documentLayout(.{
        .text = text,
        .window_start = 1000 - text.len,
        .window_end = 1000,
        .first_block = 50_000,
        .block_count = 2,
        .document_selection_start = 0,
        .document_selection_end = 0,
        .selection = null,
        .composition = null,
        .line_count = 3,
        .format = 0,
        .ranges = &.{},
        .line_starts = &.{},
    }, 100_000, 650, 18);
    // 互逆：把前导空白当成一次滚轮的偏移交回 Rust 的映射，得回同一块。
    // 注入证明：把 `leading` 改回按比例摊，这一条立刻报出别的块号。
    try std.testing.expectEqual(
        @as(u64, 50_000),
        @as(u64, @intFromFloat(@floor(tail.leading / document_block_height))),
    );
    // 末窗之后没有可滚的余量：拖尾归零，轨底恰是最后一屏的底。
    const at_last_window = documentLayout(.{
        .text = text,
        .window_start = 0,
        .window_end = text.len,
        .first_block = 99_904,
        .block_count = 96,
        .document_selection_start = 0,
        .document_selection_end = 0,
        .selection = null,
        .composition = null,
        .line_count = 3,
        .format = 0,
        .ranges = &.{},
        .line_starts = &.{},
    }, 100_000, 650, 18);
    try std.testing.expectEqual(@as(f32, 0), at_last_window.trailing);
    try std.testing.expectEqual(@as(f32, 99_904 * 36), at_last_window.leading);

    // 一屏装得下整份稿子：没有行程，轨高就是投影实高。
    const short = documentLayout(.{
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
        .ranges = &.{},
        .line_starts = &.{},
    }, 2, 650, 18);
    try std.testing.expectEqual(@as(f32, 0), short.leading);
    try std.testing.expectEqual(@as(f32, 0), short.trailing);
    try std.testing.expectEqual(@as(f32, 650), short.projection);
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
    const theme = &themes.themes[currentThemeIndex(model)];
    // 面板材质的 token 一侧（2.10 方案 a）：右键菜单、下拉这类 SDK 自绘的
    // 面只读 token、不吃 app 侧部件字段——把表面/描边两色按材质配方换掉，
    // 菜单与功能区的面一起换肤（模糊是部件级接线，menu_surface 的模糊要
    // SDK 补丁，另立项）。纸色与正文底色不动：正文区恒实心（红线）。
    const kind = panelMaterialKind(model);
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

/// chrome 动画的唯一登记口：veil（KARA 的纱）、panel-in（换层进场）与
/// 呼吸墨线（保存在飞）共用 `Options.animations` 这一条通道，按段拼接。
fn chromeAnimations(
    model: *const Model,
    tree: *const TsUiTree,
    start_ns: u64,
    out: []native_sdk.canvas.CanvasRenderAnimation,
) usize {
    const used = veil.animations(model, tree, start_ns, out);
    const paneled = used + panel_stack.enterAnimation(model, start_ns, out[used..]);
    return paneled + inkAnimation(model, start_ns, out[paneled..]);
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

const document_block_height: f32 = @floatCast(protocol.virtual_block_height);

/// 帧前的滚动布局缺省：帧还没到（`frameMsg` 未落地）时视口高先用它，
/// 首帧一到即被真实窗口换算值替换。旧的 650 硬编码的错误不在数值，
/// 在于帧到了还用——这里只担保第一帧之前。
const pre_frame_viewport_height: f32 = 650;

const DocumentLayout = struct {
    leading: f32,
    projection: f32,
    trailing: f32,
};

/// 行高（px）：与编辑区部件的绘制同一式——字号 × 行高百分比。
/// 排版三值经 core 从设置答复落地进 Model；缺省与 Rust
/// `TypographyConfig::default`（config.rs）同源（17px / 190%）。
fn documentLineHeightPx(model: *const Model) f32 {
    const size: f32 = @floatCast(model.typography.text_size);
    const percent: f32 = @floatFromInt(model.typography.line_height_percent);
    if (size <= 0 or percent <= 0) return 0;
    return size * percent / 100;
}

/// 视口高（px）：帧到了用 core 按真实窗高换算的值（`viewportHeightPx`），
/// 没到用帧前缺省。滚动布局每帧都要一个值，不等第一帧。
fn documentViewportHeightPx(model: *const Model) f32 {
    if (model.viewport.height_px > 0) return @floatFromInt(model.viewport.height_px);
    return pre_frame_viewport_height;
}

/// 正文列宽（px）：生效行长（core 的 `projectionColumnsEm`：作者行长与
/// 视口实测取小）× 字号——字身宽即字号（CJK 全角 advance 恒为 1em）。
/// 0 表示帧还没到，编辑区自动宽。
fn documentColumnWidthPx(model: *const Model) f32 {
    if (model.viewport.columns_em <= 0 or model.typography.text_size <= 0) return 0;
    return @floatCast(model.viewport.columns_em * model.typography.text_size);
}

/// 滚动轨道的几何：投影窗口的真实内容高、窗口前后的空白。行高与视口高
/// 由调用方按 Model 换算——本函数是纯几何，不认识排版配置（同一式只有
/// `documentLineHeightPx` 一处，这里与测试都不抄第二遍）。
///
/// **刻度与锚定互逆**：Rust 的滚动锚点算 `首块 = floor(偏移 / 虚拟块高)`
/// （`DocumentAnchor::Scroll`），这里的前导空白就得是 `首块 × 虚拟块高`——
/// 一次滚轮落在哪一块，那一块的顶边就落在同一个偏移上。旧式按
/// `travel × 首块 / 末窗` 摊，摊的是「轨高减投影实高」，而投影实高只有绘制
/// 侧知道：两边各算一套映射，滚动条与窗口因此对不上（M13 的后半）。
///
/// 末窗 = 总块数 − 一屏块数，与 Rust 的 `anchor_block` 同式；一屏块数取
/// 协议常量，因为核心每条请求都发它。轨高随之是「末窗的滚动行程 + 投影
/// 实高」，可滚区间恰好覆盖 Rust 认得的 `[0, 末窗 × 虚拟块高]`，越界的
/// 钳制仍只有 Rust 一份。
fn documentLayout(document: host_bridge.DocumentView, total_blocks: u64, viewport_height: f32, line_height: f32) DocumentLayout {
    const projection_height = @max(viewport_height, @as(f32, @floatFromInt(document.line_count)) * line_height);
    const last_window = total_blocks -| @as(u64, protocol.default_viewport_blocks);
    const first_block = @min(document.first_block, last_window);
    const leading = @as(f32, @floatFromInt(first_block)) * document_block_height;
    const trailing = @as(f32, @floatFromInt(last_window - first_block)) * document_block_height;
    return .{
        .leading = leading,
        .projection = projection_height,
        .trailing = trailing,
    };
}

/// 信箱：Agent 提了什么、作者怎么安排，以及送出去的 Run 走到哪了。
///
/// **接上哪个功能**：`ReadMailbox`／`MailboxPin`／`MailboxDiscard`／`Countermand`，
/// 与编排的 `readHost`／`hostCommand`／`collect`。答复共用 `projectResult` 一个
/// 槽——最后一封答复是什么形状，这一屏就画哪一段；两个刷新按钮各取一份，
/// 信箱动作（置顶、弃置、冲销）的答复本身就是刷新后的信箱，不必再发一条读。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。格与 Pin 归 `refrain_app::mailbox`，
/// Run 允许什么动作归 `project_view.runActions`——这里一条规则也不复制。
/// 空信箱说话而不是留白：什么都不画会被读成界面坏了。
fn mailboxView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.root_id.slice().len == 0) {
        return ui.column(.{ .gap = 8, .padding = 12 }, .{
            ui.text(.{}, "送出去的那些"),
            ui.text(.{}, "先打开一个项目"),
        });
    }
    const reply = snapshot.value(replies.borrow(.project));
    var children: [2 * mailbox_rows + 2]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    // 页签决定读哪份投影；未读数只在默认列表有意义，回收站里数它
    // 会数出「刚放弃的那批」——那不是未读。
    const discarded = model.mailbox_discarded;
    const unread = if (discarded) 0 else blk: {
        var seen: usize = 0;
        var walk: usize = 0;
        while (walk < mailbox_rows) : (walk += 1) {
            const entry = project_view.mailboxEntryAt(reply, walk) orelse break;
            if (std.mem.eql(u8, entry.box_name, "unread")) seen += 1;
        }
        break :blk seen;
    };
    children[count] = ui.row(.{ .gap = 8, .cross = .center }, .{
        ui.text(.{ .grow = 1 }, if (discarded) "回收站" else "信箱"),
        if (!discarded and unread > 0)
            ui.text(.{}, ui.fmt("{d} 未读", .{unread}))
        else
            ui.spacer(0),
        ui.button(.{
            .on_press = .{ .mailbox_tab = {} },
            .semantics = .{ .label = if (discarded) "回默认信箱" else "看回收站" },
        }, if (discarded) "默认" else "回收站"),
        ui.button(.{
            .on_press = readMailboxMsg(model),
            .semantics = .{ .label = "重新读信箱" },
        }, "刷新"),
        ui.button(.{
            .on_press = readHostMsg(model),
            .semantics = .{ .label = "重新读派发的状况" },
        }, "刷新派发"),
    });
    count += 1;
    var drawn: usize = 0;
    while (drawn < mailbox_rows) : (drawn += 1) {
        const entry = project_view.mailboxEntryAt(reply, drawn) orelse break;
        const prev = if (drawn > 0) project_view.mailboxEntryAt(reply, drawn - 1) else null;
        const next = project_view.mailboxEntryAt(reply, drawn + 1);
        children[count] = mailboxCard(ui, model, entry, drawn, prev, next, discarded);
        count += 1;
    }
    var found = drawn;
    // Run 段：同一屏的另一半。`runs` 只在 host 形状的答复里有，信箱形状
    // 的答复里它是空数组——两段不会同时满，也不会因为另一段而错位。
    const runs = snapshot.array(reply, "runs");
    var run_index: usize = 0;
    while (run_index < mailbox_rows) : (run_index += 1) {
        const row = runs.at(run_index) orelse break;
        children[count] = runCard(ui, model, reply, row, run_index);
        count += 1;
    }
    found += run_index;
    if (found == 0) {
        children[count] = ui.text(.{}, if (discarded) "回收站是空的" else "信箱是空的");
        count += 1;
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, @as([]const Adapter.Ui.Node, children[0..count]));
}

/// 信箱一屏最多画多少单。定长而不是分配：视图每帧重建，一次分配一列
/// 几百行的节点数组会把这一帧的预算花在作者看不见的行上。
const mailbox_rows = 24;

/// 一单提案的卡片：它落在哪份文档、要改哪里、到哪一步了，和它的安排动作。
///
/// 冲销只给「已处理」的单——它退回的是账本里已有的裁决行，对一封还没判过
/// 的提案按冲销，Rust 只会具名拒绝。回收站页签（`discarded`）里同一张卡片
/// 换两个动作：取回（软删除可逆）与重新弃置的确认交给 Rust 的幂等语义。
/// 位次交换只在双方都有位次时可用——`prev`／`next` 带上邻居的 id 与位次，
/// 交换是两条 `mailboxRank`（自己落邻居的位次、邻居落自己的），Rust 侧
/// 每次只落一个数字。
fn mailboxCard(
    ui: *Adapter.Ui,
    model: *const Model,
    entry: project_view.MailboxEntry,
    index: usize,
    prev: ?project_view.MailboxEntry,
    next: ?project_view.MailboxEntry,
    discarded: bool,
) Adapter.Ui.Node {
    const done = std.mem.eql(u8, entry.box_name, "done");
    const can_move = !discarded and entry.rank != null;
    return ui.el(.card, .{ .key = .{ .index = index }, .padding = 8 }, .{
        ui.column(.{ .gap = 2 }, .{
            ui.text(.{}, ui.fmt("{s} · {s}{s}", .{
                entry.document,
                entry.scope,
                if (entry.pinned) " · 已置顶" else "",
            })),
            ui.text(.{}, ui.fmt("{s} · {s}", .{ entry.box_label, entry.before_text })),
            if (discarded)
                ui.row(.{ .gap = 8, .cross = .center }, .{
                    ui.button(.{
                        .on_press = mailboxRestoreMsg(model, entry),
                        .semantics = .{ .label = "取回这一单" },
                    }, "取回"),
                    ui.button(.{
                        .on_press = mailboxDiscardMsg(model, entry),
                        .semantics = .{ .label = "从回收站再弃置（空操作）" },
                    }, "弃置"),
                })
            else
                ui.row(.{ .gap = 8, .cross = .center }, .{
                    ui.button(.{
                        .disabled = !(can_move and prev != null and prev.?.rank != null),
                        .on_press = if (can_move and prev != null and prev.?.rank != null)
                            mailboxSwapMsg(model, entry, prev.?)
                        else
                            null,
                        .semantics = .{ .label = "这一单上移一位" },
                    }, "上移"),
                    ui.button(.{
                        .disabled = !(can_move and next != null and next.?.rank != null),
                        .on_press = if (can_move and next != null and next.?.rank != null)
                            mailboxSwapMsg(model, entry, next.?)
                        else
                            null,
                        .semantics = .{ .label = "这一单下移一位" },
                    }, "下移"),
                    ui.button(.{
                        .on_press = mailboxPinMsg(model, entry),
                        .semantics = .{ .label = if (entry.pinned) "取消置顶这一单" else "置顶这一单" },
                    }, if (entry.pinned) "取消置顶" else "置顶"),
                    ui.button(.{
                        .on_press = mailboxDiscardMsg(model, entry),
                        .semantics = .{ .label = "弃置这一单" },
                    }, "弃置"),
                    ui.button(.{
                        .disabled = !done,
                        .on_press = countermandMsg(model, entry),
                        .semantics = .{ .label = "冲销这一单的裁决" },
                    }, "冲销"),
                }),
        }),
    });
}

/// 一个 Run 的卡片：状态、允许的动作，和「需要恢复」这句作者必须读到的话。
///
/// **这是 F-08 的修法。** 旧栈为所有非终态 Run 显示「取消」，于是重启后的
/// Dispatched Run 上有一个后端必然拒绝的按钮。允许什么由状态本身说。
fn runCard(
    ui: *Adapter.Ui,
    model: *const Model,
    host: snapshot.Value,
    row: snapshot.Value,
    index: usize,
) Adapter.Ui.Node {
    const run_id = snapshot.stringField(row, "id") orelse
        return ui.listItem(.{ .key = .{ .index = index }, .disabled = true }, "这一行读不出来");
    const rendered = project_view.runRow(row) orelse
        return ui.listItem(.{ .key = .{ .index = index }, .disabled = true }, "这一行读不出来");
    const actions = project_view.runActions(
        snapshot.field(row, "progress"),
        project_view.needsRecovery(host, run_id),
    );
    return ui.el(.card, .{ .key = .{ .index = index }, .padding = 8 }, .{
        ui.column(.{ .gap = 2 }, .{
            ui.text(.{}, ui.fmt("{s} · {s}", .{ rendered.label, rendered.detail })),
            ui.row(.{ .gap = 8, .cross = .center }, .{
                ui.button(.{
                    // 开始仅已授权可按（2.11）：与派发台同一条发令枪，
                    // 两处不说两种话。
                    .disabled = !actions.launchable,
                    .on_press = launchRunMsg(model, run_id),
                    .semantics = .{ .label = "发射这一次派发" },
                }, "开始"),
                ui.button(.{
                    .disabled = !actions.cancellable,
                    .on_press = runCommandMsg("cancelRun", model, run_id),
                    .semantics = .{ .label = "取消这一次派发" },
                }, "取消"),
                ui.button(.{
                    .disabled = !actions.retryable,
                    .on_press = runCommandMsg("retryRun", model, run_id),
                    .semantics = .{ .label = "重试这一次派发" },
                }, "重试"),
                ui.button(.{
                    // 收取随时可按：结果还没出现是 `waiting` 那一态，不是错误。
                    .on_press = collectRunMsg(model, run_id),
                    .semantics = .{ .label = "收取这一次派发的结果" },
                }, "收取"),
            }),
            // 待恢复不是一个诊断字段，是作者必须能读到的产品状态。
            if (actions.needs_recovery)
                ui.text(.{}, "这一条需要恢复：重启后它没有活着的进程")
            else
                ui.spacer(1),
        }),
    });
}

/// 读信箱。没有 Root 就没有信箱——按钮因此返回 null。
fn readMailboxMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readMailbox(&writer, model.root_id.slice(), model.mailbox_discarded) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 取回一弃置的单。页签上下文就是它的出处——行本身不带弃置标记。
fn mailboxRestoreMsg(model: *const Model, entry: project_view.MailboxEntry) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.mailboxRestore(&writer, model.root_id.slice(), entry.id) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 与相邻一单交换位次。交换是 Rust 侧的一次事务（`mailboxSwap`）——
/// 两条 `mailboxRank` 拼不出原子交换，界面只发一条。
fn mailboxSwapMsg(
    model: *const Model,
    entry: project_view.MailboxEntry,
    neighbor: project_view.MailboxEntry,
) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    _ = entry.rank orelse return null;
    _ = neighbor.rank orelse return null;
    var writer = project_request.Writer{};
    const request = project_request.mailboxSwap(&writer, model.root_id.slice(), entry.id, neighbor.id) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 读编排名录：Run 那一半的数据从这条来。
fn readHostMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readHost(&writer, model.root_id.slice()) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 置顶或取消置顶一单。格名取自行本身——它是安排表点名的依据，不是显示文本。
fn mailboxPinMsg(model: *const Model, entry: project_view.MailboxEntry) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.mailboxPin(
        &writer,
        model.root_id.slice(),
        entry.id,
        entry.box_name,
        !entry.pinned,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 弃置一单：软删除，它从默认列表消失，提案行与账本原封不动（INV-4）。
fn mailboxDiscardMsg(model: *const Model, entry: project_view.MailboxEntry) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.mailboxDiscard(
        &writer,
        model.root_id.slice(),
        entry.id,
        entry.box_name,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 冲销一单已裁决的提案。`document` 是 Root 相对路径——`Countermand` 按
/// 文档取回稿子，跨界的是路径而不是绝对地址。
fn countermandMsg(model: *const Model, entry: project_view.MailboxEntry) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.countermand(
        &writer,
        model.root_id.slice(),
        entry.document,
        entry.id,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 界面一次最多画多少行。超出的部分由作者用名录上下键走到。
///
/// 定长而不是分配：视图每帧重建，一次分配一列几百行的节点数组会把这一帧的
/// 预算花在作者看不见的行上。
const max_visible_rows = 64;
/// 块清单一页的行数上限：Rust 把 count 夹在 100 以内，这里留一页的余量。
const desk_block_rows = 128;

/// 一条只带 Run id 的编排命令，编成 `project_request` 消息。
///
/// 编码缓冲每次现取：请求出不了这一帧——它随 Msg 提交时被复制进 Model 的
/// 堆，这正是它的寿命。
fn runCommandMsg(
    comptime command: []const u8,
    model: *const Model,
    run_id: []const u8,
) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.hostRunCommand(
        &writer,
        model.root_id.slice(),
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
    if (model.root_id.slice().len == 0) {
        // 还没有项目：这一屏是作者第一次打开软件看到的东西，所以它必须
        // 自己给出入口，而不是显示一句「没有项目」。
        return ui.column(.{ .gap = 12, .padding = 16 }, .{
            // 「前往」节与命令面板同一份（paletteGoSection，单一来源）：
            // 空项目时也画全八个去处——够不着的由 core 的 navigate 具名拒绝，
            // 作者由此学会键位，而不是发现不了功能存在（v0.3.0 走查问题 1）。
            paletteGoSection(ui, model, ""),
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
    const opened = snapshot.value(replies.borrow(.project));
    const documents = snapshot.array(opened, "documents");
    // 行数当场数——答复里那个数组就是权威。Model 里曾经另存一个
    // `documentCount`，它去找一个 Rust 从未发过的字段名，恒为 0，于是
    // 这一屏恒画零行——作者打开项目以后什么都看不见。
    const window = @min(documents.count(), max_visible_rows);
    var rows: [max_visible_rows]Adapter.Ui.Node = undefined;
    var index: usize = 0;
    while (index < window) : (index += 1) {
        const row = documents.at(index);
        const rendered = if (row) |entry| project_view.documentRow(entry) else null;
        rows[index] = if (rendered) |shown|
            railTreeRow(ui, .{
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
            railTreeRow(ui, .{ .key = .{ .index = index }, .disabled = true }, 1, "这一行读不出来");
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        // 「前往」节置顶：八个去处的鼠标入口与键位提示（paletteGoSection，
        // 与命令面板同一份，单一来源）。树状排列与键位印行上，服务慢鼠标
        // 画像——不大幅移鼠标也够得着全部功能（v0.3.0 走查问题 1）。
        paletteGoSection(ui, model, ""),
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "文档"),
            // 画出来的与一共有多少分开说：作者据此知道还有没读到的。
            ui.text(.{}, ui.fmt("{d} / {d}", .{ window, model.document.total })),
        }),
        // 搜索与文件树在同一屏：作者找一份稿子时不必先想「该去哪个去处」。
        searchView(ui, model),
        ui.list(
            .{ .gap = rail_row_gap_px, .semantics = .{ .role = .tree, .label = "项目里的文档" } },
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
const DOCUMENT_REFERENCE_SLOTS: usize = 64;
var document_reference_pool: [DOCUMENT_REFERENCE_SLOTS][1024]u8 = undefined;
var document_reference_slot: usize = 0;

fn openDocumentMsg(model: *const Model, path: []const u8) ?Msg {
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

/// 设置：读当前值，改一项，立刻落盘。
///
/// **接上哪个功能**：`ReadConfig` 与 `ChangeConfig`。旧栈的设置只住在 Tauri 的
/// `lib.rs` 里，原生表面够不着同一份；现在两边读的是 `ConfigStore` 那一份。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。值的合法性归 `ConfigChange`
/// 的变体集合，落盘归 `ConfigStore`——界面不校验，也不缓存第二份。
fn settingsView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    // 设置读 configReply 槽而不是 projectResult：后者是「最后一次答复」的
    // 公共槽，一次搜索就把它换成搜索结果——设置页随作者上一把操作漂移，
    // 「还没读到」其实是读错了槽。configReply 只收 config 答复（core 按
    // kind 落槽），换主题、改排版、切身份的答复都会刷新它。
    const config = snapshot.value(replies.borrow(.config));
    const appearance = snapshot.field(config, "appearance");
    const theme = if (appearance) |shown|
        snapshot.stringField(shown, "theme") orelse ""
    else
        "";
    const theme_grid = themeButtons(ui, model);
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
                // 键位印在按钮上：标签与键位都读命令表（唯一权威），
                // 与右键菜单同款，作者按几次就记住了 Ctrl+Shift+T。
            }, ui.fmt("{s} ({s})", .{ commands.labelOf("theme.next"), commands.hintOf("theme.next") })),
        }),
        // 直选网格：七套各一颗按钮。直选是鼠标的路，「换主题」轮换是键盘
        // 的路——两个入口同一条落盘链，不会出现「点了但快捷键以为没换」。
        ui.row(.{ .gap = 4, .cross = .center }, @as([]const Adapter.Ui.Node, theme_grid[0..])),
        // 材质三选：实心 / 亚克力 / 液态玻璃是三种「密度」（透光度递增），
        // 不是一种皮肤的三个颜色——透光多少是材质自己的事，七套主题都成立
        // （material.zig 配方表的唯一权威）。按下即换肤，落盘随答复。
        ui.row(.{ .gap = 4, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "面板材质"),
            materialButton(ui, model, 0, "实心"),
            materialButton(ui, model, 1, "亚克力"),
            materialButton(ui, model, 2, "液态玻璃"),
        }),
        // KARA：写作状态机的手动开关。Ctrl+Enter（app.zon 的 kara.toggle）
        // 也走同一条消息——两个入口一条路径，不会出现「按钮开了但快捷键
        // 以为还关着」。
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "专注写作（KARA）"),
            ui.button(.{
                .on_press = karaToggleMsg(),
                .semantics = .{ .label = "进入或退出专注写作" },
            }, ui.fmt("切换 ({s})", .{commands.hintOf("kara.toggle")})),
        }),
        // 排版三项：字号、行高、行长。只列这三项是因为它们决定一行有
        // 多少字、字有多大、行与行隔多远——作者真正会反复调的就是这些。
        // 其余（首行缩进、基线网格、页边距）定下来就不动。
        typographyRow(ui, model, "字号", "textSize"),
        typographyRow(ui, model, "行高", "lineHeight"),
        typographyRow(ui, model, "行长", "measure"),
        fontsSection(ui, config),
        connectionsConfigSection(ui, config),
        agentsSection(ui, model, config),
        ui.button(.{
            .on_press = readConfigMsg(),
            .semantics = .{ .label = "重新读取设置" },
        }, "读取设置"),
    });
}

/// 主题直选网格：七套各一颗按钮，当前套高亮。
///
/// **接上哪个功能**：`theme_select` 臂（core 记下标 + 落盘 SetTheme）。
/// 高亮读 Model 的下标而不是设置答复的名字——下标是按下那一刻就生效的
/// （颜色立刻换），答复晚一拍到；跟着答复走高亮会慢半拍，作者以为没点上。
///
/// **交互设计**：高亮复用 SDK 的 `.selected` 底色（与名录游标同一画法，
/// 零新几何）；按钮文字就是主题名，鼠标停在文本区附近就能点到。
fn themeButtons(ui: *Adapter.Ui, model: *const Model) [themes.themes.len]Adapter.Ui.Node {
    var buttons: [themes.themes.len]Adapter.Ui.Node = undefined;
    const current = currentThemeIndex(model);
    inline for (themes.themes, 0..) |theme, index| {
        buttons[index] = ui.button(.{
            .on_press = .{ .theme_select = @intCast(index) },
            .selected = index == current,
            .semantics = .{ .label = "选用主题 " ++ theme.name },
        }, theme.name);
    }
    return buttons;
}

/// Model 的主题下标钳进色表范围（越界回落默认——与 core `theme_select`
/// 臂的越界处理同一句话，界面与内核不各判一次）。
fn currentThemeIndex(model: *const Model) usize {
    return if (model.theme_index >= 0 and model.theme_index < themes.themes.len)
        @intCast(model.theme_index)
    else
        themes.default_index;
}

/// Model 的材质下标 → material.zig 的 Kind。越界回落实心——与 core 的
/// `material_select` 臂、material.zig 的 `kindFromKebab` 同一句（实心什么
/// 都不依赖，永远画得出来）。
fn panelMaterialKind(model: *const Model) material_recipe.Kind {
    return switch (model.panel_material) {
        1 => .acrylic,
        2 => .liquid,
        else => .solid,
    };
}

/// 材质三选的一颗按钮：按下记 `material_select` 下标，当前材质高亮
/// （复用 `.selected` 底色，与主题网格同一画法，零新几何）。
fn materialButton(
    ui: *Adapter.Ui,
    model: *const Model,
    comptime index: i64,
    comptime label: []const u8,
) Adapter.Ui.Node {
    return ui.button(.{
        .on_press = .{ .material_select = index },
        .selected = model.panel_material == index,
        .semantics = .{ .label = "把面板换成" ++ label },
    }, label);
}

/// Agent 名录：名字、身份模式，和二态开关。
///
/// **接上哪个功能**：`ConfigChange::ToggleAgentPersona`——干活 ↔ 扮演，
/// 身份原文由 Rust 带过去，界面只按 id 点名。答复是刷新后的整份 Config，
/// 所以切换之后不必再发一条读。
fn agentsSection(ui: *Adapter.Ui, model: *const Model, config: snapshot.Value) Adapter.Ui.Node {
    const agents = snapshot.field(config, "agents") orelse "";
    var rows: [mailbox_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const agent = project_view.agentAt(agents, count) orelse break;
        const editing = model.editing_agent.id.slice().len > 0 and
            std.mem.eql(u8, model.editing_agent.id.slice(), agent.id);
        rows[count] = ui.el(.card, .{ .key = .{ .index = count }, .padding = 8 }, .{
            ui.column(.{ .gap = 4 }, .{
                ui.row(.{ .gap = 8, .cross = .center }, .{
                    ui.text(.{ .grow = 1 }, ui.fmt("{s} · {s}", .{ agent.name, agent.mode_label })),
                    ui.button(.{
                        .disabled = !agent.has_persona,
                        .on_press = toggleAgentPersonaMsg(agent),
                        .semantics = .{ .label = "切换这个 Agent 的身份模式" },
                    }, "切换"),
                    if (editing)
                        ui.button(.{
                            .on_press = @as(?Msg, .agent_edit_cancel),
                            .semantics = .{ .label = "放弃这次参数编辑" },
                        }, "取消")
                    else
                        ui.button(.{
                            .on_press = beginAgentEditMsg(agent.id),
                            .semantics = .{ .label = "编辑这个 Agent 的专属参数" },
                        }, "编辑参数"),
                }),
                // 身份说明回显：作者写给这个 Agent 的那段字。没有身份的
                // 不画一行空——「空说明」与「没有说明」是同一件事。
                if (agent.persona_body.len > 0)
                    ui.text(.{}, agent.persona_body)
                else
                    ui.spacer(0),
                ui.text(.{}, ui.fmt("专属参数 {d} 项", .{agent.argv_count})),
                if (editing) agentArgvEditor(ui, model, agent) else ui.spacer(0),
            }),
        });
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.text(.{}, "Agent 名录"),
        if (count == 0)
            ui.text(.{}, "还没有读到 Agent——按「读取设置」取一份")
        else
            ui.column(
                .{ .gap = 2, .semantics = .{ .role = .list, .label = "Agent 名录" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// 当前字体：西文、中文、日文三个槽各装哪张脸。
///
/// **接上哪个功能**：`Config.appearance.fonts`（设置面板读的同一份 Config）。
/// 只读——「改字体」需要枚举机器字库的选择器（`list_fonts` 通道尚未接），
/// 这里先让作者看见现在用的是什么；字号行高在排版三行那里调。
fn fontsSection(ui: *Adapter.Ui, config: snapshot.Value) Adapter.Ui.Node {
    const appearance = snapshot.field(config, "appearance");
    // fonts 住在 appearance.typography.fonts（Config 的层级），不是
    // appearance.fonts——读错层级会把「有字体」读成「还没读到」。
    const fonts = if (appearance) |shown|
        snapshot.field(snapshot.field(shown, "typography") orelse "", "fonts")
    else
        null;
    const latin = if (fonts) |shown| snapshot.stringField(shown, "latin") orelse "" else "";
    const chinese = if (fonts) |shown| snapshot.stringField(shown, "chinese") orelse "" else "";
    const japanese = if (fonts) |shown| snapshot.stringField(shown, "japanese") orelse "" else "";
    return ui.column(.{ .gap = 4 }, .{
        ui.text(.{}, "字体"),
        if (latin.len + chinese.len + japanese.len == 0)
            ui.text(.{}, "还没读到字体——按「读取设置」取一份")
        else
            ui.column(.{ .gap = 2 }, .{
                ui.text(.{}, ui.fmt("西文 {s}", .{latin})),
                ui.text(.{}, ui.fmt("中文 {s}", .{chinese})),
                ui.text(.{}, ui.fmt("日文 {s}", .{japanese})),
            }),
    });
}

/// 已存连接参数：每个适配器一行，显示程序与参数项数。
///
/// **接上哪个功能**：`Config.harness_connections`（设置面板读的同一份
/// Config）。只读——编辑走伙伴编辑（agent 级 argv）或直接改 `config.toml`；
/// 连接级 argv 的图形编辑入口尚未接，这里先让作者看见「有没有参数」。
fn connectionsConfigSection(ui: *Adapter.Ui, config: snapshot.Value) Adapter.Ui.Node {
    const connections = snapshot.field(config, "harnessConnections") orelse "";
    var rows: [8]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const connection = project_view.connectionAt(connections, count) orelse break;
        rows[count] = ui.listItem(.{
            .key = .{ .index = count },
            .semantics = .{ .role = .listitem },
        }, ui.fmt("{s} · {s} · 参数 {d} 项", .{
            connection.adapter,
            connection.executable,
            connection.argv_count,
        }));
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.text(.{}, "连接参数"),
        if (count == 0)
            ui.text(.{}, "还没有存过连接——派发时选「文件通道」之外的方式会存")
        else
            ui.column(
                .{ .gap = 2, .semantics = .{ .role = .list, .label = "连接参数" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// 编辑这个 Agent 的参数： 是 ，带字段的变体先构造
/// 再赋值——直接在  里写匿名结构会在 ReleaseFast 下类型推断失败。
fn beginAgentEditMsg(agent_id: []const u8) Msg {
    // core 子集把单字段变体压平为裸值（`agent_edit_begin: []const u8`），
    // 所以这里直接传 id，不套结构。
    return @unionInit(Msg, "agent_edit_begin", agent_id);
}

/// 一个 Agent 的专属参数编辑区：一段以空格分隔的文本 + 保存。
///
/// **接上哪个功能**：伙伴编辑（`UpsertAgent`）。保存按空格分词后整份
/// upsert——名字与身份从 Rust 快照回填，只改参数。编辑态与草稿住在
/// Model（`editingAgent`／`agentArgvDraft`），与改写区同一条纪律。
fn agentArgvEditor(ui: *Adapter.Ui, model: *const Model, agent: project_view.Agent) Adapter.Ui.Node {
    return ui.column(.{ .gap = 4 }, .{
        ui.textField(.{
            .text = model.editing_agent.body.slice(),
            .placeholder = "--model max --temperature 0.2",
            .on_input = Adapter.Ui.inputMsg(.agent_argv_typed),
            .semantics = .{ .label = "这个 Agent 的专属参数" },
        }),
        ui.button(.{
            .variant = .primary,
            .on_press = upsertAgentMsg(model, agent),
            .semantics = .{ .label = "按这份参数保存这个 Agent" },
        }, "保存参数"),
    });
}

/// 整份保存一个 Agent：名字与身份从快照回填，参数用编辑草稿；连接 id
/// 原样回填（快照读到的）——不编辑它不等于可以抹掉它（审计项）。
fn upsertAgentMsg(model: *const Model, agent: project_view.Agent) ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.upsertAgent(
        &writer,
        agent.id,
        agent.name,
        agent.connection_id,
        agentPersonaMode(agent),
        agent.persona_body,
        model.editing_agent.body.slice(),
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 这个 Agent 的身份模式：work／cosplay／空（无身份）。从快照的变体键
/// 读来——「干活」的标签在 Zig，跨界那个词是 Rust 的枚举名。
fn agentPersonaMode(agent: project_view.Agent) []const u8 {
    if (!agent.has_persona) return "";
    return if (std.mem.eql(u8, agent.mode_label, "干活")) "work" else "cosplay";
}

/// 切换一个 Agent 的二态。无身份的切无可切，按钮因此返回 null。
fn toggleAgentPersonaMsg(agent: project_view.Agent) ?Msg {
    if (!agent.has_persona) return null;
    var writer = project_request.Writer{};
    const request = project_request.toggleAgentPersona(&writer, agent.id) orelse return null;
    return .{ .project_request = request.bytes };
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
/// 步长与量程归 `project_view.typographySliderSpec`（与 Rust `TypographyField::bounds`
/// 同一张表）：行长的单位是十分之一 em，与字号的十分之一像素不同量纲，
/// 共用一个步长会让其中一项每次只动一丝。
///
/// **交互设计**：滑杆与 ± 按钮共存——滑杆走大范围，按钮走两端微调。拇指
/// 位置与数值实时读 Model（答复落回来即刷新）；滑杆贴步距，没跨步不发
/// 请求（`noop`）：SDK 的 slider 按帧合并报值、没有「落定」事件，一次
/// 拖动的落盘次数因此被步数限住而不是被帧率限住。这是与 v0.2.4「一次
/// 拖动=一次修改」的刻意差异——等价的限流靠步距量化达成，且拖动中
/// 实时预览。玻璃垫 + 慢鼠标的画像：滑轨 `grow = 1` 尽量拉宽，一步的
/// 鼠标行程就越大，微调越不需要精准。
fn typographyRow(
    ui: *Adapter.Ui,
    model: *const Model,
    comptime label: []const u8,
    comptime field: []const u8,
) Adapter.Ui.Node {
    const spec = comptime project_view.typographySliderSpec(field);
    const slider = TypographySliderMsg(field);
    // 当前值既是拇指位置的来源，也是闭包基准的真值来源（渲染时重写基准，
    // 答复落回来的值因此自愈拖动中的任何漂移）。
    const current = currentTypographyUnits(model, field);
    slider.setBase(current);
    // 数值跟着标签走：作者拖动时看到的是「字号 17.5 px」在动，不是一根
    // 没有刻度的轨——滑杆没有刻度是 SDK 部件的形状，数值由我们补上。
    const value_text = if (comptime std.mem.eql(u8, field, "textSize"))
        ui.fmt("{d:.1} px", .{model.typography.text_size})
    else if (comptime std.mem.eql(u8, field, "lineHeight"))
        ui.fmt("{d}%", .{model.typography.line_height_percent})
    else
        ui.fmt("{d:.1} em", .{model.typography.measure_em});
    return ui.row(.{ .gap = 8, .cross = .center }, .{
        ui.text(.{}, ui.fmt("{s} {s}", .{ label, value_text })),
        ui.button(.{
            .on_press = adjustTypographyMsg(field, -spec.step_units),
            .semantics = .{ .label = label ++ "小一点" },
        }, "−"),
        ui.el(.slider, .{
            .grow = 1,
            .value = project_view.sliderFraction(spec, current),
            .on_value = slider.msg,
            .semantics = .{ .label = label },
        }, .{}),
        ui.button(.{
            .on_press = adjustTypographyMsg(field, spec.step_units),
            .semantics = .{ .label = label ++ "大一点" },
        }, "+"),
    });
}

/// Model 里的排版值换算成 `adjustTypography` 的 delta 单位。
/// 三字段量纲不同（十分之一像素 / 百分点 / 十分之一 em），按字段词汇分派；
/// 词汇表以 Rust 为准，这里多一个词就是第二份权威。
fn currentTypographyUnits(model: *const Model, comptime field: []const u8) i32 {
    if (comptime std.mem.eql(u8, field, "textSize")) {
        return @intFromFloat(model.typography.text_size * 10);
    }
    if (comptime std.mem.eql(u8, field, "lineHeight")) {
        return @intCast(model.typography.line_height_percent);
    }
    return @intFromFloat(model.typography.measure_em * 10);
}

/// 排版滑杆的消息闭包：一个字段一个实例，实例里装着上一次落定的值。
///
/// **为什么要有 base**：SDK 的 `ValueMsgFn` 是裸函数指针（`*const fn (f32) Msg`），
/// 带不了上下文；而 `adjustTypography` 要增量，增量 = 新值 − 基准。渲染时
/// 基准从 Model 写入（答复落回来的真值）；事件时基准立刻更新成新值——
/// 拖动中答复还在路上、Model 是旧值，基准必须跟着事件走，增量链才不多算
/// （17→18→19 拖两步，基准不动会送出 +10 +20 而不是 +5 +5）。
/// comptime 实例各自持有自己的 base：三个滑杆互不串台。
fn TypographySliderMsg(comptime field: []const u8) type {
    const spec = comptime project_view.typographySliderSpec(field);
    return struct {
        var base_units: i32 = 0;

        fn setBase(units: i32) void {
            base_units = units;
        }

        fn msg(fraction: f32) Msg {
            const next = project_view.sliderSnap(spec, fraction);
            const delta = next - base_units;
            base_units = next;
            // 没跨步：不编请求。拖动在轨上停留的每一帧都会报值，其中只有
            // 跨步的那些值得一次落盘；noop 让 core 原样返回，零重建。
            if (delta == 0) return .noop;
            var writer = project_request.Writer{};
            const request = project_request.adjustTypography(&writer, field, delta) orelse return .noop;
            return .{ .project_request = request.bytes };
        }
    };
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
/// 即打即搜在 core（每次按键重挂 120ms 钟，停笔开火；空查询撤钟）。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。查询词住在 Model（`searchQuery`），
/// 不住在部件状态里：放在部件里一次重绘就会被冲掉，作者读成的是输入框自己
/// 清空了。空查询不画旧结果——答复还躺在槽里，但作者还没问。
///
/// **交互设计**：块命中画以命中为中心的 60 字摘录（`excerptAround`），不画
/// 全块——作者找的是「那段话」，不是整段的复读。命中行是 list_item：↑↓
/// 走焦点、Enter 跳过去（on_submit）、Space 选择激活，都是 SDK 的 list
/// 键图原生行为。
fn searchView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const results = snapshot.value(replies.borrow(.project));
    const kind = snapshot.kind(replies.borrow(.project));
    const is_blocks = std.mem.eql(u8, kind, "blocks");
    const rows = snapshot.array(results, if (is_blocks) "blocks" else "documents");
    // 空查询不画旧结果：按 searchQuery 判空，不按答复判空。
    const searching = model.search.query.slice().len > 0;
    const count = if (searching) @min(rows.count(), max_visible_rows) else 0;
    var nodes: [max_visible_rows]Adapter.Ui.Node = undefined;
    var index: usize = 0;
    while (index < count) : (index += 1) {
        const row = rows.at(index).?;
        // 块命中：路径 + 以命中为中心的摘录。高亮用「」标出命中段——
        // list_item 只渲染纯文本标签（children 不进它的绘制），而三截上色
        // 的 row 又丢掉 list_item 的键图（Enter 提交只认这个 kind）。SDK 的
        // per-text 颜色通道（style_tokens.foreground）与键盘导航不可兼得，
        // 取键图、「」标出（任务许的退路）。
        const label = if (is_blocks) blk: {
            const path = snapshot.stringField(row, "path") orelse "";
            const text = snapshot.stringField(row, "text") orelse "";
            const excerpt_buf = ui.arena.alloc(u8, 4 * 60 + 12) catch break :blk path;
            break :blk ui.fmt("{s} · {s}", .{
                path,
                project_view.excerptAround(excerpt_buf, text, model.search.query.slice(), 60),
            });
        } else snapshot.stringField(row, "path") orelse "这一行读不出来";
        const jump = searchHitMsg(model, row, is_blocks);
        nodes[index] = ui.listItem(.{
            .key = .{ .index = index },
            .on_press = jump,
            // Enter 是行主键（桌面名录惯例）：与点击同一条 searchHitMsg。
            .on_submit = jump,
            .semantics = .{ .role = .listitem },
        }, label);
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.text(.{}, "搜索"),
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.textField(.{
                .grow = 1,
                .text = model.search.query.slice(),
                .placeholder = "搜索文档或正文",
                .on_input = Adapter.Ui.inputMsg(.search_typed),
                .semantics = .{ .label = "搜索词" },
            }),
            ui.button(.{
                .on_press = .{ .search_precision = {} },
                .semantics = .{ .label = "切换精确与宽松" },
            }, if (model.search.exact) "精确" else "宽松"),
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
        // 只印接好线的键位：list_item 的 ↑↓/Enter/Space 是 SDK 键图原生行为。
        ui.text(.{}, "↑↓ 移动 · Enter 跳过去"),
        ui.list(
            .{ .gap = 2, .semantics = .{ .role = .list, .label = "搜索结果" } },
            @as([]const Adapter.Ui.Node, nodes[0..count]),
        ),
    });
}

/// 一次搜索。空查询不发请求——空词在 Rust 那边是一次有名拒绝，
/// 而作者读成的是「搜索坏了」。
fn searchMsg(model: *const Model, comptime blocks: bool) ?Msg {
    if (model.root_id.slice().len == 0 or model.search.query.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = if (blocks)
        project_request.blockSearch(&writer, model.root_id.slice(), model.search.query.slice(), model.search.exact)
    else
        project_request.documentSearch(&writer, model.root_id.slice(), model.search.query.slice(), model.search.exact);
    return .{ .project_request = (request orelse return null).bytes };
}

/// 点一条命中：同一份稿子的块命中直接跳过去，其余先打开那份文档。
///
/// 跨文档的跳块要等打开后的新一轮投影才点得名——那是另一段接线；先打开
/// 文档是今天就有用的那半步。块序号 clamp 归 Rust（越界钳到尾窗），这里
/// 原样送回。
fn searchHitMsg(model: *const Model, row: snapshot.Value, blocks: bool) ?Msg {
    const path = snapshot.stringField(row, "path") orelse "";
    if (blocks and path.len > 0) {
        const ordinal = snapshot.unsignedField(row, "ordinal") orelse return null;
        if (model.document.session != 0 and std.mem.eql(u8, path, model.document.path.slice())) {
            return .{ .document_jump = @intCast(ordinal) };
        }
        // 跨文档命中：开文档与跳块是两次请求——挂起的块序号随引用一起送，
        // 打开答复落地后 core 补发跳块（v0.2.4 的 selectDocument→revealBlock
        // 串联缝）。引用与文件树行同一个轮换池、同一条借用纪律。
        if (model.root_id.slice().len == 0) return null;
        document_reference_slot = (document_reference_slot + 1) % DOCUMENT_REFERENCE_SLOTS;
        const buffer: []u8 = document_reference_pool[document_reference_slot][0..];
        const reference = project_view.documentReference(buffer, model.root_id.slice(), path) orelse return null;
        return .{ .document_open_jump = .{
            .reference = reference,
            .block = @intCast(ordinal),
        } };
    }
    return openDocumentMsg(model, path);
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
    // 这个函数里写，写完立刻被 SDK 读走。label_pool 是「标签　键位」
    // 拼接串的槽：与表同一条轮换纪律。
    const State = struct {
        var table: [16]Adapter.Ui.ContextMenuItem = undefined;
        var label_pool: [6][64]u8 = undefined;
    };
    const selected = selectedText(host_bridge.documentView());
    // 高亮要有选区才有意义。灰掉而不是移除：一个时有时无的菜单项会让
    // 作者以为自己记错了菜单的样子。
    State.table = .{
        .{ .label = "高亮这一段", .msg = annotateMsg(model, selected), .enabled = selected.len > 0 },
        .{ .label = "转全角", .msg = convertWidthMsg(model, selected, false, "to-full"), .enabled = selected.len > 0 },
        .{ .label = "转半角", .msg = convertWidthMsg(model, selected, false, "to-half"), .enabled = selected.len > 0 },
        // 攒进发送：把选区原文存进派发台的攒段（NUL 分隔），送出时逐段
        // 成 scope。与「高亮这一段」同一条选区纪律——空选区灰掉。
        .{ .label = "攒进发送", .msg = @as(?Msg, .{ .dispatch_stash = selected }), .enabled = selected.len > 0 },
        .{ .separator = true },
        // 全文级：不用选区，作者在任意处都能叫出整篇转换。
        .{ .label = "整篇转全角", .msg = convertWidthMsg(model, "", true, "to-full"), .enabled = true },
        .{ .label = "整篇转半角", .msg = convertWidthMsg(model, "", true, "to-half"), .enabled = true },
        .{ .separator = true },
        // 键位印在菜单项上（「保存　Ctrl+S」，浏览器右键同款）——让人
        // 用着用着就学会了。键位从命令表拼。
        .{ .label = commands.withHint(&State.label_pool[0], "document.save"), .msg = .{ .document_save = {} } },
        .{ .label = commands.withHint(&State.label_pool[1], "document.undo"), .msg = .{ .document_undo = {} } },
        .{ .separator = true },
        // 三个最常用的去处直达。八个全列会让菜单变成一张目录，
        // 而目录已经是命令面板（⌘K）的活。只有文件有固定键位（Ctrl+2 =
        // go.2 → FILES）；裁决/派发走 workbench_go 直达到处下标——
        // workbench_key 的 ordinal  remap 后 3 是稿子、4 是动态的 Agent
        // 去处，印它们的键位会教作者一个按到别处的组合。
        .{ .label = commands.withHint(&State.label_pool[2], "go.2"), .msg = .{ .workbench_key = 2 } },
        .{ .label = "裁决", .msg = .{ .workbench_go = .review } },
        .{ .label = "派发", .msg = .{ .workbench_go = .dispatch } },
        .{ .separator = true },
        .{ .label = commands.withHint(&State.label_pool[5], "palette"), .msg = .{ .palette_toggle = {} } },
    };
    return &State.table;
}

/// 在选中的一段正文上留一条高亮。
///
/// 只做高亮不做评论：评论要作者写一段字，而右键菜单按下即执行。
/// 评论走批注面板（尚未接）。
fn annotateMsg(model: *const Model, selected: []const u8) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    if (selected.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.annotate(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
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
///
/// **交互设计（v0.2.4 回迁，2.1b）**：这一台是为「坐着不动、连判十二条」
/// 设计的——作者厌大范围鼠标移动，所以每个动作都有键位，键位就印在
/// 按钮上（浏览器右键同款，让肌肉自己学会）：
///
/// - Alt+J/K 上下移动游标（高亮行）；就是名录键 roster_step，四个去处
///   共用一份越界钳制（roster.ts）。判完一条 120ms 后游标自动 +1——
///   延迟挂在答复落地时（core 的 reviewAdvanceArmed → Cmd.delay），
///   判失败不动：作者的注意力不该被一次失败推着走。只 +1 不跳过已判，
///   与 v0.2.4 一致：已判行留着标「已判」，作者看得见自己判到哪。
/// - Alt+A 接受 / Alt+B 退回 / Alt+E 改后接受：直接判游标行。退回键
///   与就地饭盒统一用 Alt+B（v0.2.4 桌面曾是 Alt+X——一词一义，一个
///   动作不教两种键）。「只评论」没有键：它是少见动作，按钮够得着。
/// - Alt+R 理由：单行框开在游标行，Enter 记（空也记）、Escape 当作没
///   问过；记下的理由随下一次裁决发出，判后即清——它不赖着影响下
///   一条。理由框内 Escape 被 SDK 文本部件吃掉，所以「取消」按钮是
///   兜底出口（v0.2.4 纪律：快捷键不能是唯一入口）。
/// - Alt+P 翻竞争稿：同 scope（同一段）的另一条提案是竞争者，翻 B 面
///   把它的改法画出来对照；再翻回 A 面。v0.2.4 只翻角标不换内容
///   （未完成特性），这里把内容真的画出来。跟着行走不跟着台子走。
/// - Alt+Enter 落定：改写中 = 把改写落成裁决；否则 = 提交暂存的批次
///   （空批次不发，按钮先灰）。合并落盘后名录自动重读——已判提案被
///   领域层收走，不重读台面就停着一排鬼影。
/// - Escape 逐层关（core 的 panel_back）：饭盒 > 理由框 > 改写框 >
///   过期面板 > 退栈，一次只关一层。
///
/// **两条请求路径**：行内按钮的字节在本文件渲染时由 project_request.zig
/// 编好（`desk_verdict` 臂）；键盘路径等不到带数据的 Zig 事件，字节由
/// core 的 wire_json 拼出——两侧逐字节同形，wire-shapes 门禁钉着。
/// 与 v0.2.4 的刻意差异：无 Alt+S 入批开关（native 的 stage 即写账本
/// +入批，没有单独的入批态）；进度显示 `{staged}/{total} 已判` 同理，
/// native 里「已判」与「待合并」恒等，不硬凑两个数。
fn reviewView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) {
        return ui.column(.{ .gap = 8, .padding = 12 }, .{
            ui.text(.{}, "待裁决的提案"),
            ui.text(.{}, "先打开一份稿子"),
        });
    }
    const listing = snapshot.value(replies.borrow(.project));
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
            // 批次进度跟着台账走（stagedCount 由 core 从答复提取），
            // 界面不自己数「我判了几条」——那会与账本漂开。
            ui.text(.{}, ui.fmt("{d}/{d} 已判", .{ model.review.staged_count, total })),
            ui.button(.{
                .on_press = readProposalsMsg(model),
                .semantics = .{ .label = "重新读取待裁决的提案" },
            }, "读取"),
            ui.button(.{
                .variant = .primary,
                // 空批次不发提交：按钮先灰掉，作者按下去之前就知道，
                // 而不是收到一次拒绝。
                .disabled = model.review.staged_count == 0,
                .on_press = commitVerdictsMsg(model),
                .semantics = .{ .label = "把判过的这些落盘" },
            }, ui.fmt("{s} {d} 条 ({s})", .{
                commands.labelOf("verdict.settle"),
                model.review.staged_count,
                commands.hintOf("verdict.settle"),
            })),
        }),
        // 键位即提示：从命令表拼，与 core.ts 的 keyMsg 同名同键。
        ui.text(.{}, ui.fmt("{s}/{s} 移动 · {s} 接受 · {s} 退回 · {s} 改后接受 · {s} 理由 · {s} 竞争稿 · {s} 合并", .{
            commands.hintOf("roster.step.next"),
            commands.hintOf("roster.step.previous"),
            commands.hintOf("verdict.accept"),
            commands.hintOf("verdict.reject"),
            commands.hintOf("verdict.revise"),
            commands.hintOf("review.reason"),
            commands.hintOf("review.peer"),
            commands.hintOf("verdict.settle"),
        })),
        // 过期面板压在名录之上：它是上一次派发失败的说辞，先交代清楚再判。
        if (model.review.stale_recovery.slice().len > 0)
            stalePanel(ui, model)
        else
            ui.el(.stack, .{ .height = 0 }, .{}),
        if (total == 0)
            ui.text(.{}, "没有等待裁决的提案")
        else
            ui.list(
                .{ .gap = 6, .semantics = .{ .role = .list, .label = "待裁决的提案" } },
                @as([]const Adapter.Ui.Node, rows[0..window]),
            ),
        // 落盘的结局要说出来：三态各说各的，`decisionMessage` 判。
        ui.text(.{}, project_view.decisionMessage(replies.borrow(.project))),
        annotationsSection(ui, model),
    });
}

/// 过期面板：这一段在派发之后被改过了，提案没有套用（SPEC 7.4：不静默
/// 套用，也不静默丢弃）。
///
/// **接上哪个功能**：`staleFrozen`（Agent 当时读到的字）与 `staleRecovery`
/// （恢复步骤码，\n 连接）。两者由 core 在答复落空时写下，「知道了」派
/// `.stale_dismiss` 清掉。
///
/// **交互设计**：它出现在「提交批次被领域层拒绝（stale-proposal）」之后，
/// 压在名录之上——先交代清楚这次失败，作者才好继续判。面板只出示信息
/// 不替他选：冻结原文（作者自己改过那段，只有他能判断建议还成不成立）
/// 与两条具名恢复步骤（对照冻结原文 / 按现状重发），次序随领域层给的
/// 数组，界面不重排。出口有两个：「知道了」按钮与 Escape（panel_back
/// 分层里它在退栈之前）；任何一次项目用例成功也会把它清掉（core 在
/// ACTION_PROJECT 落地时清）——失败的说辞不赖着。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。步骤码的中文读法归
/// `project_view.staleStepLabel`（中文字面量纪律），不认识的码原样显示。
fn stalePanel(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    // 步骤码逐行画。码表是 core 写死的三条（留两条槽给将来的码），
    // 数组有界：标题 + 冻结段两行 + 步骤 + 按钮。
    var children: [12]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    children[count] = ui.text(.{}, "这一段在派发之后被改过了，提案没有套用。");
    count += 1;
    if (model.review.stale_frozen.slice().len > 0) {
        children[count] = ui.text(.{}, "Agent 当时读到的是：");
        count += 1;
        children[count] = ui.text(.{}, model.review.stale_frozen.slice());
        count += 1;
    }
    var rest = model.review.stale_recovery.slice();
    while (rest.len > 0 and count + 1 < children.len) {
        const at = std.mem.indexOfScalar(u8, rest, '\n') orelse rest.len;
        // 空段（连着的 \n 或收尾的 \n）不画——一行空步骤会被读成界面坏了。
        if (at > 0) {
            children[count] = ui.text(.{}, project_view.staleStepLabel(rest[0..at]));
            count += 1;
        }
        rest = if (at < rest.len) rest[at + 1 ..] else rest[0..0];
    }
    children[count] = ui.button(.{
        .on_press = @as(?Msg, .stale_dismiss),
        .semantics = .{ .label = "关掉过期提案的说明" },
    }, "知道了");
    count += 1;
    return ui.el(.card, .{ .padding = 8 }, .{
        ui.column(.{ .gap = 4 }, @as([]const Adapter.Ui.Node, children[0..count])),
    });
}

/// 批注与评论：这份稿子上标过的那些。
///
/// **接上哪个功能**：`ReadAnnotations` 读、`Annotate` 写。评论在这里写：
/// 作者先在正文框一段字，切到这一屏看见选区的预览，在输入框里写下要说
/// 的话，按「发评论」——高亮与评论是同一族，草稿为空发的就是高亮。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。草稿字节住在 Model
/// （`annotationDraft`），与派发框同一条路径；「这段字够不够清楚」不是
/// 这一屏能判的，范围对不上块由 Rust 在入口具名拒绝。
fn annotationsSection(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const listing = snapshot.value(replies.borrow(.project));
    var rows: [mailbox_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const annotation = project_view.annotationAt(listing, count) orelse break;
        rows[count] = ui.listItem(.{
            .key = .{ .index = count },
            .semantics = .{ .role = .listitem },
        }, if (annotation.comment)
            ui.fmt("「{s}」 · {s}", .{ annotation.quote, annotation.body })
        else
            ui.fmt("「{s}」", .{annotation.quote}));
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "批注与评论"),
            ui.button(.{
                .on_press = readAnnotationsMsg(model),
                .semantics = .{ .label = "重新读这份稿子的批注" },
            }, "读取"),
        }),
        // 写评论：选区的预览是批注的对象。没有选区时灰掉——一条没有
        // 对象的评论会让 Rust 具名拒绝，而作者读成的是「按钮坏了」。
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{
                .grow = 1,
            }, if (selectedText(host_bridge.documentView()).len > 0)
                ui.fmt("「{s}」", .{selectedText(host_bridge.documentView())})
            else
                "先在正文框一段字"),
        }),
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.textField(.{
                .grow = 1,
                .text = model.annotation_draft.slice(),
                .placeholder = "写评论（留空就是高亮）",
                .on_input = Adapter.Ui.inputMsg(.annotation_draft_typed),
                .semantics = .{ .label = "评论草稿" },
            }),
            ui.button(.{
                .disabled = selectedText(host_bridge.documentView()).len == 0,
                .on_press = commentMsg(model),
                .semantics = .{ .label = "在选中的这一段上发这条评论" },
            }, "发评论"),
        }),
        if (count == 0)
            ui.text(.{}, "这份稿子上还没有批注")
        else
            ui.column(
                .{ .gap = 2, .semantics = .{ .role = .list, .label = "批注与评论" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// 把一段正文在全角与半角之间转换。
///
/// **接上哪个功能**：正文右键菜单——选区级（`whole_document = false`）
/// 与全文级（`whole_document = true`）两档。转换在 Rust（`text_width` 是
/// 唯一权威）：这里只送选区原文、作用域与方向，块身份由 Rust 按
/// `locate_scope` 查——送块 id 等于要求界面先知道块怎么切。
///
/// **在全局逻辑中负责什么**：只拼请求。全文级时 `selected` 留空（Rust
/// 侧不看它）；「没有可转的字符」由 Rust 具名拒绝（定义域外的文字转换
/// 不动一个字节），这里不猜。
fn convertWidthMsg(
    model: *const Model,
    selected: []const u8,
    whole_document: bool,
    direction: []const u8,
) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    if (!whole_document and selected.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.convertWidth(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        selected,
        whole_document,
        direction,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 在选中的一段正文上发一条评论：正文是选区原文，评论是草稿字节。
/// 草稿为空就是高亮——与正文右键菜单同一族，只是这里能写字。
fn commentMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    const selected = selectedText(host_bridge.documentView());
    if (selected.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.annotate(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        selected,
        model.annotation_draft.slice(),
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 读这份文档的批注。没打开稿子就没有可读的——按钮因此返回 null。
fn readAnnotationsMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readAnnotations(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 一条提案：范围、原文、改后，以及四个裁决动作与理由框。
///
/// 游标行（`rosterCursor` 指着的那条）多三样：选中底色、竞争稿徽标与
/// B 面、理由框。翻页与开框都跟着行走——换一行，它们跟着换，不赖在
/// 原来的行上。
/// 一条提案行：原文、改后、动作按钮，以及游标行的三件额外物（竞争稿、
/// 理由框、已记理由的提示）。
///
/// **交互设计**：行有两种状态——普通行与游标行（`rosterCursor` 指着，
/// 高亮复用 SDK card 的 selected 底色，不新写几何）。键盘动作（Alt+A/B/E）
/// 永远作用在游标行；按钮则每行都有（v0.2.4 纪律：快捷键不能是唯一
/// 入口），文案自带键位提示，让作者从按钮学会键位。理由框只开在游标
/// 行：理由随下一次裁决发出，与行绑定才不会让作者以为它是整批的。
/// 竞争稿（Alt+P 的 B 面）也只跟着游标行翻——一台只对照一处。
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
    const revising = model.revising.id.slice().len > 0 and
        std.mem.eql(u8, model.revising.id.slice(), proposal.id);
    // 游标是 `?u32`：null 就是没有行。旧形用 −1 占这个位，每个读取点都得记得。
    const on_cursor = if (model.roster_cursor) |row| index == @as(usize, row) else false;
    // 竞争稿只在游标行找：翻 B 面跟着行走，不跟着台子走。
    const competitor = if (on_cursor) project_view.competitorOf(listing, index) else null;
    return ui.el(.card, .{
        .key = .{ .index = index },
        .padding = 8,
        // 游标高亮复用 SDK card 面自带的 selected 底色（与命令面板的
        // listItem 同一条通道），不新写几何。
        .selected = on_cursor,
    }, .{
        ui.column(.{ .gap = 4 }, .{
            ui.row(.{ .gap = 8, .cross = .center }, .{
                ui.text(.{ .grow = 1 }, proposal.scope),
                // 游标行有竞争者时，翻到哪面就亮哪面的徽标。
                ui.text(.{}, if (competitor != null)
                    (if (model.review.peer) "竞争 B" else "竞争 A")
                else
                    ""),
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
            // B 面：竞争稿的正文画在原文与改后之下。找不到就说没有——
            // 画一段空气会被读成「竞争稿是空的」。
            if (on_cursor and model.review.peer)
                (if (competitor) |peer|
                    (if (peer.after_text.len > 0)
                        ui.text(.{}, ui.fmt("竞争稿：{s}", .{peer.after_text}))
                    else
                        ui.text(.{}, "（只留评论，不改正文）"))
                else
                    ui.text(.{}, "这一条没有竞争稿"))
            else
                ui.el(.stack, .{ .height = 0 }, .{}),
            ui.row(.{ .gap = 8 }, .{
                ui.button(.{
                    .disabled = proposal.staged,
                    .on_press = verdictMsg(model, proposal.id, "accept"),
                    .semantics = .{ .label = "接受这一条" },
                    // 键位从命令表拼（一处改键，处处跟着）。
                }, ui.fmt("{s} ({s})", .{ commands.labelOf("verdict.accept"), commands.hintOf("verdict.accept") })),
                ui.button(.{
                    .disabled = proposal.staged,
                    .on_press = verdictMsg(model, proposal.id, "reject"),
                    .semantics = .{ .label = "退回这一条" },
                }, ui.fmt("{s} ({s})", .{ commands.labelOf("verdict.reject"), commands.hintOf("verdict.reject") })),
                ui.button(.{
                    // 只留评论的提案没有可改的正文：改写它等于凭空写一段，
                    // 那是「退回后自己写」，不是改写。
                    .disabled = proposal.staged or proposal.after_text.len == 0,
                    .on_press = beginRevisionMsg(listing, index),
                    .semantics = .{ .label = "改写这一条再接受" },
                }, ui.fmt("{s} ({s})", .{ commands.labelOf("verdict.revise"), commands.hintOf("verdict.revise") })),
                ui.button(.{
                    .disabled = proposal.staged,
                    .on_press = verdictMsg(model, proposal.id, "comment-only"),
                    .semantics = .{ .label = "只留评论，不改正文" },
                }, "只评论"),
                ui.button(.{
                    .on_press = @as(?Msg, .review_reason_open),
                    .semantics = .{ .label = "给下一次裁决记下一条理由" },
                }, ui.fmt("{s} ({s})", .{ commands.labelOf("review.reason"), commands.hintOf("review.reason") })),
            }),
            // 理由框只开在游标行：理由随下一次裁决发出，与行绑定才不会
            // 让作者以为它是整批的。
            if (on_cursor and model.review.reason_open)
                ui.row(.{ .gap = 8, .cross = .center }, .{
                    ui.textField(.{
                        .grow = 1,
                        .text = model.review.reason_draft.slice(),
                        .placeholder = "理由（可留空）",
                        .on_input = Adapter.Ui.inputMsg(.review_reason_typed),
                        .on_submit = @as(?Msg, .review_reason_commit),
                        // 边沿触发：开框那一帧 false→true 拉一次焦点，
                        // 之后保持 true 也不会再抢作者的焦点。
                        .autofocus = true,
                        .semantics = .{ .label = "这一条裁决的理由" },
                    }),
                    ui.button(.{
                        .on_press = @as(?Msg, .review_reason_commit),
                        .semantics = .{ .label = "记下这条理由" },
                    }, "记下"),
                    // Escape 在框内被部件吃掉，取消按钮是兜底出口（SDK
                    // 键优先级：焦点在 text-entry 上时按键被静默消费，
                    // 到不了 core 的 panel_back）。
                    ui.button(.{
                        .on_press = @as(?Msg, .review_reason_cancel),
                        .semantics = .{ .label = "当作没问过" },
                    }, "取消"),
                })
            else
                ui.el(.stack, .{ .height = 0 }, .{}),
            // 已记下的理由亮出来：它随下一次裁决发出，作者要知道它还在。
            if (on_cursor and model.review.reason_recorded)
                ui.text(.{}, ui.fmt("理由：{s} · 随下一次裁决发出", .{
                    if (model.review.reason.slice().len > 0) model.review.reason.slice() else "（空）",
                }))
            else
                ui.el(.stack, .{ .height = 0 }, .{}),
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
            .on_input = Adapter.Ui.inputMsg(.revision_typed),
            .semantics = .{ .label = "改写后的正文" },
        }, model.revising.body.slice()),
        ui.row(.{ .gap = 8 }, .{
            ui.button(.{
                .variant = .primary,
                .disabled = model.revising.body.slice().len == 0,
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
///
/// 已记下的理由随这一次裁决发出（没记下就是空切片，写器出 `null`，与
/// core 键盘路径逐字节同形）。返回 `desk_verdict` 而不是通用
/// `project_request`：core 发它时连带清掉理由、挂起判后前进的旗。
fn verdictMsg(model: *const Model, proposal_id: []const u8, kind: []const u8) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.stageVerdict(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        proposal_id,
        kind,
        "",
        if (model.review.reason_recorded) model.review.reason.slice() else "",
    ) orelse return null;
    return .{ .desk_verdict = request.bytes };
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
        .id = proposal.id,
        .seed = proposal.after_text,
    } };
}

/// 提交改写：作者写的那一段成为最终正文。
///
/// 与其余三种裁决共用 `stageVerdict`，只是多带 `final_text`。Rust 侧在入口
/// 就拒绝「改写型但没有最终正文」，所以这里不必自己判——但空文字仍然拦下，
/// 让作者在按钮上就知道还没写，而不是按下去收到一次拒绝。
///
/// 理由与返回通道同 `verdictMsg`：记下的理由随这次裁决发出，桌面裁决走
/// `desk_verdict`（core 连带清理由、挂判后前进）。
fn commitRevisionMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    if (model.revising.id.slice().len == 0 or model.revising.body.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.stageVerdict(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        model.revising.id.slice(),
        "accept-modified",
        model.revising.body.slice(),
        if (model.review.reason_recorded) model.review.reason.slice() else "",
    ) orelse return null;
    return .{ .desk_verdict = request.bytes };
}

/// 提交暂存的裁决批次。裁决即落盘（D1／F-01）。
fn commitVerdictsMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.commitVerdicts(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 读这份文档上待裁决的提案。
fn readProposalsMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readProposals(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 读这份稿子的块清单（派发台的行）。`after` 是翻页游标：null 读第一页。
fn readBlocksMsg(model: *const Model, after: ?u64) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readBlocks(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        after,
        100,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 读这个项目的资料名录（派发台的资料分区）。
fn readMaterialsMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readMaterials(&writer, model.root_id.slice()) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 收取选中那一条 Run 的结果。
fn collectRunMsg(model: *const Model, run_id: []const u8) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.collectRun(&writer, model.root_id.slice(), run_id) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 发射一条已授权的 Run（2.11）：工作区由 Rust 组成，界面只点名 run。
/// 手动往返的作者在按下它之后拿到一份可以亲手送给 Agent 的请求
/// （工作区里的 request），发令枪与下游自动发射同一条命令。
fn launchRunMsg(model: *const Model, run_id: []const u8) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.launchRun(&writer, model.root_id.slice(), run_id) orelse return null;
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
    const listing = snapshot.value(replies.borrow(.project));
    var rows: [24]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const change = project_view.changeAt(listing, count) orelse break;
        rows[count] = ui.listItem(
            .{
                .key = .{ .index = count },
                .on_press = revertToMsg(change),
                .disabled = change.undone,
                .semantics = .{ .role = .listitem },
            },
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

/// 回到这一行刚落下的状态。行 id 就是动作 id，原样送回 Rust 点名——
/// 序号是给作者读的。已撤销的行在视图上 disabled，到不了这里。
fn revertToMsg(change: project_view.Change) ?Msg {
    if (change.undone) return null;
    return .{ .document_revert = change.id };
}

/// 读这份文档的改动记录。没打开稿子就没有可读的——按钮因此返回 null。
fn readHistoryMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readHistory(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
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
fn connectionsView(ui: *Adapter.Ui) Adapter.Ui.Node {
    const listing = snapshot.value(replies.borrow(.project));
    var rows: [8]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const harness = project_view.harnessAt(listing, count) orelse break;
        // 一行装不下三件事（程序名、状况、能做什么），所以用卡片——
        // 与裁决台的提案行同族，不新起一套画法。
        const installed = std.mem.eql(u8, harness.skill, "current");
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
                // 协议徽章 + 安装/更新：只有装好了的 harness 才有协议可装；
                // 装协议是 Root 之外唯一的写路径，按钮是它的唯一入口。
                if (harness.ready)
                    ui.row(.{ .gap = 8, .cross = .center }, .{
                        ui.text(.{ .grow = 1 }, project_view.skillLabel(harness.skill)),
                        ui.button(.{
                            .on_press = installSkillMsg(harness.id),
                            .semantics = .{ .label = "把当前协议装进这个 harness 的 skill 目录" },
                        }, if (installed) "更新协议" else "安装协议"),
                    })
                else
                    ui.spacer(0),
            }),
        });
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "本机 Harness"),
            ui.button(.{
                // 手动按钮走 force：探测要起 2 秒级子进程，自动读有 15 秒
                // 缓存，而「重新探测」的意思就是「别信缓存」。
                .on_press = readHarnessesMsg(true),
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

/// 把当前协议装进一个 harness 的 skill 目录。作者显式点击才到达——
/// 这是 Root 之外唯一的写路径。
fn installSkillMsg(harness_id: []const u8) ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.installSkill(&writer, harness_id) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 探测本机装了哪些 Harness。不带 Root——它问的是这台机器。
fn readHarnessesMsg(force: bool) ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.readHarnesses(&writer, force) orelse return null;
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

/// 派发台：框出要改的段落，写下要求，委托给一个伙伴，送出去。
///
/// **接上哪个功能**：`refrain_app::dispatch`（2.2 派发深度回迁）。范围有
/// 三个来源：块清单的勾选（`ReadBlocks` 读来的块）、正文右键攒下的段
/// （`dispatchStash`）、正文当前的选区。三者同走 `dispatchDesk` 一个写器
/// （选区只在位图与攒段都空时作数），委托/带稿/资料三个闸同价（审计 #7）。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。勾选位图、攒段、带稿档位与
/// 委托对象都住在 Model（core.ts）；「这段原文还在不在稿子里」由 Rust 在
/// 派发入口判（对不回块就具名拒绝），这里不复制那条规则。
///
/// **交互设计**：这一台为「段落 → 要求 → 委托 → 范围 → 送出」的票据流
/// 设计。票头四格让作者一眼看到还缺什么（送出钮的灰态是第五格）；鼠标
/// 路径全是近距点击，键位印在按钮上。本轮只接了 Ctrl+Enter（焦点在要求
/// 框里时送出）；Space 勾选与台内移动键 2.8 才接，hint 行因此不印它们
/// ——印在界面上的键位必须是接好线的。
///
/// Run 名录是「送出去之后看它们跑到哪」的地方：收取只在在途时可点，
/// 轮询只在有 Run 在飞时自己走（2500ms 链式，core 管），接力/校验的
/// 下游在上游收取后自动发射（领域层管）——这一节只读快照，一条编排
/// 规则也不复制。材料草稿的「改」在行内完成：作者不离台。
fn dispatchView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const document = host_bridge.documentView();
    const selected = selectedText(document);
    const span = coverageSpan(model);
    // 就绪 = 有范围 ∧ 要求非空 ∧ 委托可送。委托恒可送（没有具名伙伴时
    // 「手动往返」兜底行总在），所以它不进这个式子。
    const ready = (span != null or model.dispatch.stash.slice().len > 0 or selected.len > 0) and
        model.dispatch.prompt.slice().len > 0;
    // 请求先编一次：攒段/选区太长装不下 12KB 槽时编不出——按钮灰掉并
    // 说原因。不灰不按、按了没反应，都是谎话（审计 #13）。
    const preview_msg = previewDispatchMsg(model, selected);
    const dispatch_msg = dispatchMsg(model, selected);
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        deskTicket(ui, model, selected, span),
        deskBlockList(ui, model),
        deskMaterials(ui, model),
        deskStash(ui, model),
        // 先让作者看见他要派发的是哪一段。派发出去之后请求就冻结了，
        // 而这一刻是他唯一能核对范围的地方。
        if (selected.len > 0)
            ui.text(.{}, selected)
        else
            ui.text(.{}, "先在正文里选一段要改的文字"),
        ui.text(.{}, "要求："),
        // 要求框直接画 textarea：editable 的 ui.code 内部就是这个部件，而
        // CodeOptions 收不了 on_submit。多行部件上 Ctrl+Enter 触发
        // on_submit（SDK 的 isSubmitKeyboard：Enter 留给换行），绑到送出。
        ui.el(.textarea, .{
            .wrap = true,
            .text = model.dispatch.prompt.slice(),
            .on_input = Adapter.Ui.inputMsg(.dispatch_typed),
            .on_submit = dispatchMsg(model, selected),
            .semantics = .{ .label = "写给 agent 的要求" },
        }, .{}),
        deskAgentRow(ui, model),
        deskCarryRow(ui, model),
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "agent"),
            ui.button(.{
                .on_press = .{ .dispatch_agents = -1 },
                .semantics = .{ .label = "少派一个" },
            }, "−"),
            ui.text(.{}, ui.fmt("{d}", .{model.dispatch.agents})),
            ui.button(.{
                .on_press = .{ .dispatch_agents = 1 },
                .semantics = .{ .label = "多派一个" },
            }, "+"),
        }),
        // 排法只在多于一个 agent 时有意义。一个 agent 时仍然画出来但灰掉，
        // 而不是整行消失——一行凭空出现的控件会让作者以为界面刚才坏了。
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, orchestrationAt(model.dispatch.orchestration).hint),
            ui.button(.{
                .disabled = model.dispatch.agents < 2,
                .on_press = @as(?Msg, .dispatch_orchestration),
                .semantics = .{ .label = "换一种排法" },
            }, orchestrationAt(model.dispatch.orchestration).label),
        }),
        ui.row(.{ .gap = 8 }, .{
            ui.button(.{
                .disabled = !ready or preview_msg == null,
                .on_press = preview_msg,
                .semantics = .{ .label = "先编译请求包给作者核对" },
            }, "预览"),
            ui.button(.{
                .variant = .primary,
                .disabled = !ready or dispatch_msg == null,
                .on_press = dispatch_msg,
                .semantics = .{ .label = "把这些段落和要求送出去" },
            }, "送出去"),
        }),
        if (ready and dispatch_msg == null)
            ui.text(.{}, "攒下的段落一次送不出去了——分两次送，或先丢掉几段")
        else
            ui.spacer(0),
        // 只印接好线的键位：Space 勾选与台内移动 2.8 才接。
        ui.text(.{}, "Ctrl+Enter 送出（在要求框里）"),
        dispatchPreviewSection(ui),
        deskRunRoster(ui, model),
        materialDraftsSection(ui, model),
    });
}

/// 勾选覆盖的连续块段：from 是起始 ordinal，count 是块数。
const DeskSpan = struct { from: u64, count: u64 };

/// 勾选位图的第 i 位。越界当 0。
///
/// 旧形是一个按需长长的字节数组，每个读取点自己做 `>>3` 与 `&7`；现在是
/// `StaticBitSet(1024)`，那两次移位连同「越界当 0」的约定一起归它。
fn deskBit(model: *const Model, ordinal: usize) bool {
    if (ordinal >= model.dispatch.checked.capacity()) return false;
    return model.dispatch.checked.isSet(ordinal);
}

/// 勾了几块。
fn deskCheckedCount(model: *const Model) usize {
    return model.dispatch.checked.count();
}

/// 勾选的最小覆盖：首末置位之间的连续块段。一块也没勾时是 null。
fn coverageSpan(model: *const Model) ?DeskSpan {
    var first: ?usize = null;
    var last: usize = 0;
    var ordinal: usize = 0;
    while (ordinal < model.dispatch.checked.capacity()) : (ordinal += 1) {
        if (deskBit(model, ordinal)) {
            if (first == null) first = ordinal;
            last = ordinal;
        }
    }
    const start = first orelse return null;
    return .{ .from = @intCast(start), .count = @intCast(last - start + 1) };
}

/// 攒了几段：NUL 数 + 1。空串是零段。
fn stashCount(model: *const Model) usize {
    if (model.dispatch.stash.slice().len == 0) return 0;
    var count: usize = 1;
    for (model.dispatch.stash.slice()) |ch| {
        if (ch == 0) count += 1;
    }
    return count;
}

/// 字符数（不是字节数）：按 UTF-8 序列长度走，坏字节当一个字符。
fn charCount(text: []const u8) usize {
    var count: usize = 0;
    var index: usize = 0;
    while (index < text.len) {
        index += std.unicode.utf8ByteSequenceLength(text[index]) catch 1;
        count += 1;
    }
    return count;
}

/// 前 n 个字符，char 边界安全——攒段预览不截半个字。
fn firstChars(text: []const u8, n: usize) []const u8 {
    var count: usize = 0;
    var index: usize = 0;
    while (index < text.len and count < n) {
        index += std.unicode.utf8ByteSequenceLength(text[index]) catch 1;
        count += 1;
    }
    return text[0..index];
}

/// config 答复里的 agents 数组原文。没有答复时是空数组。
fn configAgents() snapshot.Value {
    return snapshot.field(snapshot.value(replies.borrow(.config)), "agents") orelse "[]";
}

/// 手动往返的哨兵词（agent id 是 uuid，这个词不会撞）：空 dispatchAgent
/// 是「还没选」（默认预选第一个具名伙伴），哨兵才是作者亲手选的手动往返——
/// 没有这个区分，配上伙伴的项目里手动往返永远选不中（审计 #6）。
const manual_agent_sentinel = "manual";

/// 当前生效的委托对象：哨兵是手动往返（空 id）；`dispatchAgent` 非空是它；
/// 空时视同第一个具名伙伴（显示上亮第一个）；一个伙伴也没有时是手动往返。
fn effectiveDispatchAgent(model: *const Model) []const u8 {
    if (std.mem.eql(u8, model.dispatch.agent.slice(), manual_agent_sentinel)) return "";
    if (model.dispatch.agent.slice().len > 0) return model.dispatch.agent.slice();
    const first = project_view.agentAt(configAgents(), 0) orelse return "";
    return first.id;
}

/// 票头「委托」格的名字：具名伙伴亮名字，手动往返照实说。
fn deskAgentLabel(model: *const Model) []const u8 {
    const effective = effectiveDispatchAgent(model);
    if (effective.len == 0) return "手动往返";
    var index: usize = 0;
    while (project_view.agentAt(configAgents(), index)) |agent| : (index += 1) {
        if (std.mem.eql(u8, agent.id, effective)) return agent.name;
    }
    return "—";
}

/// 票头四格：段落、要求、委托、范围——还缺什么一眼看见。
fn deskTicket(ui: *Adapter.Ui, model: *const Model, selected: []const u8, span: ?DeskSpan) Adapter.Ui.Node {
    // 段落数 = 勾选位数 + 攒段数 + 当前选区一段（若有）。注意它与送出的
    // scope 数不恒等：选区只在位图与攒段都空时才作为 scope 送出
    // （见 dispatchDeskMsg 的选区路径）。这一格数的是「手上有的段落」。
    const segments = deskCheckedCount(model) + stashCount(model) + @as(usize, @intFromBool(selected.len > 0));
    return ui.row(.{ .gap = 12 }, .{
        ui.text(.{}, ui.fmt("段落 {d} 块", .{segments})),
        ui.text(.{}, if (model.dispatch.prompt.slice().len > 0)
            ui.fmt("要求 {d} 字", .{charCount(model.dispatch.prompt.slice())})
        else
            "要求 —"),
        ui.text(.{}, ui.fmt("委托 {s}", .{deskAgentLabel(model)})),
        // b 的序号与块清单行的显示同一个口径（ordinal + 1）。
        ui.text(.{}, if (span) |s|
            ui.fmt("范围 覆盖 b{d}–b{d}", .{ s.from + 1, s.from + s.count })
        else
            "范围 —"),
    });
}

/// 块清单：`ReadBlocks` 读来的行，勾选合成范围。
///
/// core 的 `deskBlocks` 槽是替换语义（每页答复换掉整槽），位图跨页
/// 存活——翻页不丢勾选，显示的是当前这页。
fn deskBlockList(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const listing = snapshot.value(replies.borrow(.blocks));
    var rows: [desk_block_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const block = project_view.deskBlockAt(listing, count) orelse break;
        const checked = deskBit(model, block.ordinal);
        rows[count] = ui.button(.{
            .key = .{ .index = count },
            // 勾选态用前缀字符而不是 SDK 的 checkbox 部件：它不画标签，
            // 用了行会变成「框一个命中、字一个命中」两个目标。
            // 字取 ■/□ 而不是 ☑/☐：后者不在界面字面里，画出来是方块，
            // 而方块恰好长得像个空框——`verify:font-coverage` 抓到的第二处。
            .on_press = .{ .dispatch_block_toggle = @intCast(block.ordinal) },
            .semantics = .{ .label = "勾选或取消这一块" },
        }, ui.fmt("{s}b{d} · {s} · {d} 字", .{
            if (checked) "■ " else "□ ",
            block.ordinal + 1,
            block.peek,
            block.chars,
        }));
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "段落"),
            // 已装 / 总数：槽里这页的行数 对 这份稿子的总块数。
            ui.text(.{}, ui.fmt("{d}/{d}", .{ count, model.document.blocks })),
            ui.button(.{
                .on_press = @as(?Msg, .dispatch_blocks_all),
                .semantics = .{ .label = "勾上整章" },
            }, "整章"),
            ui.button(.{
                .disabled = deskCheckedCount(model) == 0,
                .on_press = @as(?Msg, .dispatch_blocks_clear),
                .semantics = .{ .label = "清掉全部勾选" },
            }, "清空"),
        }),
        if (count == 0)
            ui.button(.{
                .on_press = readBlocksMsg(model, null),
                .semantics = .{ .label = "读入这份稿子的块清单" },
            }, "读入块清单")
        else
            ui.list(
                .{ .gap = 2, .semantics = .{ .role = .list, .label = "段落清单" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
        if (count > 0)
            ui.button(.{
                // null = 没有下页（旧形用 −1 当哨兵）。
                .disabled = model.dispatch.blocks_next == null,
                .on_press = readBlocksMsg(model, if (model.dispatch.blocks_next) |next| @as(u64, next) else null),
                .semantics = .{ .label = "读入下一页块" },
            }, "再读一页")
        else
            ui.el(.stack, .{ .height = 0 }, .{}),
    });
}

/// 资料分区：这轮给 agent 读什么的勾选。
///
/// **接上哪个功能**：`ReadMaterials`（deskMaterials 槽）与
/// `DispatchRequest.materials`——勾选的路径随送出/预览过河。
///
/// **交互设计**：资料是票据流里「读什么」的那一格。只有路径过河，档位的
/// 权威在名录（`SetDisclosure` 写它）——界面照名录画、只把勾选的路径送
/// 回去。勾选态住在 Model（`dispatchMaterials`，\n 分隔），这一节一条
/// 规则也不复制。
fn deskMaterials(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (replies.borrow(.materials).len == 0) {
        return ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "资料"),
            ui.button(.{
                .on_press = readMaterialsMsg(model),
                .semantics = .{ .label = "读入这个项目的资料名录" },
            }, "读取资料"),
        });
    }
    const listing = snapshot.value(replies.borrow(.materials));
    var rows: [mailbox_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const material = project_view.materialAt(listing, count) orelse break;
        const checked = materialChecked(model, material.path);
        rows[count] = ui.button(.{
            .key = .{ .index = count },
            // 与块清单同一款行：前缀字符而不是 SDK checkbox（它不画标签，
            // 会把行劈成两个命中目标）。
            .on_press = .{ .dispatch_material_toggle = material.path },
            .semantics = .{ .label = "勾选或取消这份资料" },
        }, ui.fmt("{s}{s} · {s}", .{
            if (checked) "■ " else "□ ",
            material.path,
            material.disclosure_label,
        }));
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "资料"),
            ui.button(.{
                .on_press = readMaterialsMsg(model),
                .semantics = .{ .label = "重新读资料名录" },
            }, "刷新"),
        }),
        ui.column(
            .{ .gap = 2, .semantics = .{ .role = .list, .label = "资料名录" } },
            @as([]const Adapter.Ui.Node, rows[0..count]),
        ),
    });
}

/// 这份资料勾了吗：`dispatchMaterials` 是 \n 分隔的路径表，逐段比对。
fn materialChecked(model: *const Model, path: []const u8) bool {
    var rest = model.dispatch.materials.slice();
    while (rest.len > 0) {
        const at = std.mem.indexOfScalar(u8, rest, '\n') orelse rest.len;
        if (std.mem.eql(u8, rest[0..at], path)) return true;
        rest = if (at < rest.len) rest[at + 1 ..] else rest[0..0];
    }
    return false;
}

/// 勾选的资料路径切进 `out`，返回条数。空段（连着的 \n）跳过。
fn checkedMaterials(model: *const Model, out: [][]const u8) usize {
    var count: usize = 0;
    var rest = model.dispatch.materials.slice();
    while (rest.len > 0 and count < out.len) {
        const at = std.mem.indexOfScalar(u8, rest, '\n') orelse rest.len;
        const segment = rest[0..at];
        rest = if (at < rest.len) rest[at + 1 ..] else rest[0..0];
        if (segment.len == 0) continue;
        out[count] = segment;
        count += 1;
    }
    return count;
}

/// 攒段区：正文右键「攒进发送」存下的段。每段在送出时成为一个文本
/// scope（顺在块段后面）。空时不画这一节。
fn deskStash(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.dispatch.stash.slice().len == 0) return ui.el(.stack, .{ .height = 0 }, .{});
    // 与信箱同一条窗口纪律：画前 mailbox_rows 段，更多的照送但不全画。
    var rows: [mailbox_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    var rest = model.dispatch.stash.slice();
    while (rest.len > 0 and count < rows.len) {
        const at = std.mem.indexOfScalar(u8, rest, 0) orelse rest.len;
        const segment = rest[0..at];
        rest = if (at < rest.len) rest[at + 1 ..] else rest[0..0];
        if (segment.len == 0) continue;
        rows[count] = ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, firstChars(segment, 40)),
            ui.button(.{
                .on_press = .{ .dispatch_stash_drop = @intCast(count) },
                .semantics = .{ .label = "把这一段从攒段里丢掉" },
            }, "丢"),
        });
        count += 1;
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, ui.fmt("已攒 {d} 段", .{stashCount(model)})),
            ui.button(.{
                .on_press = @as(?Msg, .dispatch_stash_clear),
                .semantics = .{ .label = "清空攒下的全部段" },
            }, "清空"),
        }),
        ui.column(.{ .gap = 2 }, @as([]const Adapter.Ui.Node, rows[0..count])),
    });
}

/// 委托行：config 名录里的具名伙伴各一个按钮（选中态高亮），末尾
/// 「手动往返」。一个伙伴也没有时只剩手动往返那行。
fn deskAgentRow(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const agents = configAgents();
    const effective = effectiveDispatchAgent(model);
    var rows: [mailbox_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const agent = project_view.agentAt(agents, count) orelse break;
        rows[count] = ui.button(.{
            .selected = std.mem.eql(u8, agent.id, effective),
            .on_press = .{ .dispatch_agent = agent.id },
            .semantics = .{ .label = ui.fmt("委托给 {s}", .{agent.name}) },
        }, agent.name);
        count += 1;
    }
    // 手动往返是兜底行：没有自动通道，身份随请求走（L0）。选中态读生效值：
    // 选了哨兵、或一个伙伴也没有时，生效的就是手动往返。
    const manual = ui.button(.{
        .selected = effective.len == 0,
        .on_press = .{ .dispatch_agent = manual_agent_sentinel },
        .semantics = .{ .label = "不具名，手动往返" },
    }, "手动往返");
    return ui.row(.{ .gap = 8, .cross = .center }, .{
        ui.text(.{}, "委托"),
        ui.row(.{ .gap = 4, .grow = 1 }, @as([]const Adapter.Ui.Node, rows[0..count])),
        manual,
    });
}

/// 带稿模式三档：增量／全文／不带。当前档高亮。默认增量是界面替作者
/// 选的——线协议的默认是不带（旧载荷旧行为），所以「不带」送出时不写
/// carry 这个词。
fn deskCarryRow(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const modes = [_][]const u8{ "增量", "全文", "不带" };
    var buttons: [3]Adapter.Ui.Node = undefined;
    for (modes, 0..) |label, index| {
        buttons[index] = ui.button(.{
            .selected = model.dispatch.carry == @as(i64, @intCast(index)),
            .on_press = .{ .dispatch_carry = @intCast(index) },
            .semantics = .{ .label = label },
        }, label);
    }
    return ui.row(.{ .gap = 8, .cross = .center }, .{
        ui.text(.{}, "带稿"),
        buttons[0],
        buttons[1],
        buttons[2],
    });
}

/// Run 名录节：这份稿子送出去的 Run 跑到哪了。
///
/// **接上哪个功能**：`ReadHost`（deskHost 槽）与 `CollectRun`／`cancelRun`／
/// `retryRun`。行只列当前文档的 Run——`project_view.runsForDocument` 按
/// tasks∩runs 的交集筛，别份稿子的 Run 不进这一节。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。允许什么动作归
/// `project_view.runActions`（收取仅在途、取消仅非终态、重试仅失败/取消）；
/// 轮询链与下游自动发射都不在这里——core 与领域层各管各的，这一节只读
/// 快照。
fn deskRunRoster(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (replies.borrow(.host).len == 0) {
        return ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "Run 名录"),
            ui.button(.{
                .on_press = readHostMsg(model),
                .semantics = .{ .label = "读入派发的状况" },
            }, "读取 Run 名录"),
        });
    }
    const host = snapshot.value(replies.borrow(.host));
    var rows: [mailbox_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const row = project_view.runsForDocument(host, model.document.path.slice(), count) orelse break;
        rows[count] = deskRunRow(ui, model, host, row, count);
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "Run 名录"),
            ui.button(.{
                .on_press = readHostMsg(model),
                .semantics = .{ .label = "重新读派发的状况" },
            }, "刷新"),
        }),
        if (count == 0)
            ui.text(.{}, "这份稿子还没有送出去的 Run")
        else
            ui.column(
                .{ .gap = 4, .semantics = .{ .role = .list, .label = "Run 名录" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// Run 名录的一行：状态措辞 + workspace（有就画）+ 允许的动作。
fn deskRunRow(
    ui: *Adapter.Ui,
    model: *const Model,
    host: snapshot.Value,
    row: snapshot.Value,
    index: usize,
) Adapter.Ui.Node {
    const run_id = snapshot.stringField(row, "id") orelse
        return ui.listItem(.{ .key = .{ .index = index }, .disabled = true }, "这一行读不出来");
    const progress = snapshot.field(row, "progress");
    const actions = project_view.runActions(progress, project_view.needsRecovery(host, run_id));
    const workspace = snapshot.stringField(row, "workspace") orelse "";
    return ui.el(.card, .{ .key = .{ .index = index }, .padding = 8 }, .{
        ui.column(.{ .gap = 2 }, .{
            // 状态措辞的唯一权威是 progressLabel（七态表），这里不另写。
            ui.text(.{}, project_view.progressLabel(progress)),
            if (workspace.len > 0)
                ui.text(.{}, workspace)
            else
                ui.el(.stack, .{ .height = 0 }, .{}),
            ui.row(.{ .gap = 8 }, .{
                ui.button(.{
                    // 开始仅已授权可按：发令枪只在 Run 铸成之后、送出之前
                    // 有意义（2.11 的 LaunchRun 通路；手动往返的第一棒）。
                    .disabled = !actions.launchable,
                    .on_press = launchRunMsg(model, run_id),
                    .semantics = .{ .label = "发射这一次派发" },
                }, "开始"),
                ui.button(.{
                    // 收取仅在途可按：还没送出时按钮先灰掉，作者不必按一次
                    // 才知道结果是 waiting。
                    .disabled = !actions.collectable,
                    .on_press = collectRunMsg(model, run_id),
                    .semantics = .{ .label = "收取这一次派发的结果" },
                }, "收取"),
                ui.button(.{
                    .disabled = !actions.cancellable,
                    .on_press = runCommandMsg("cancelRun", model, run_id),
                    .semantics = .{ .label = "取消这一次派发" },
                }, "取消"),
                ui.button(.{
                    .disabled = !actions.retryable,
                    .on_press = runCommandMsg("retryRun", model, run_id),
                    .semantics = .{ .label = "重试这一次派发" },
                }, "重试"),
            }),
        }),
    });
}

/// 派发预览清单：各节名字/来源/字节/token 三态 + digest 前 12 位 +
/// 稳定前缀字节——「送前核对」的读法（SPEC 8.2 的授权落点）。预览住专槽
/// `deskPreview`（审计 #8）：刷新名录/读取资料不再把它冲掉，清单活到被
/// 消费（送出成功清槽）或被下一次预览替换。
fn dispatchPreviewSection(ui: *Adapter.Ui) Adapter.Ui.Node {
    if (!std.mem.eql(u8, snapshot.kind(replies.borrow(.preview)), "dispatchPreview")) {
        return ui.el(.stack, .{ .height = 0 }, .{});
    }
    const package = snapshot.value(replies.borrow(.preview));
    const digest = snapshot.stringField(package, "digest") orelse "";
    const prefix_bytes = snapshot.unsignedField(package, "prefixBytes") orelse 0;
    var rows: [mailbox_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const entry = project_view.manifestEntryAt(package, count) orelse break;
        rows[count] = ui.text(.{}, ui.fmt("{s} · {s} · {d} B · token {s}", .{
            entry.section,
            entry.source,
            entry.bytes,
            entry.tokens_label,
        }));
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.text(.{}, ui.fmt("核对 {s} · 稳定前缀 {d} B", .{
            digest[0..@min(12, digest.len)],
            prefix_bytes,
        })),
        ui.column(.{ .gap = 2 }, @as([]const Adapter.Ui.Node, rows[0..count])),
    });
}

/// 材料草稿行：Agent 交来的草稿在这里等成稿或退回。
///
/// **接上哪个功能**：`ReadMaterialDrafts`／`CommitMaterialDraft`——答复与
/// 回执共用同一份名录（动作之后界面不再发一次读），所以这一节只在名录
/// 是最新答复时画行，否则给一个「读草稿」入口。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。成稿的角色（资料区还是正文）
/// 由按钮说清，规则（草稿存没存在、落哪）归 Rust。
///
/// **交互设计**：「改」在行内完成——作者不离台。编辑态住在 Model
/// （`materialDraftId`／`materialDraftText`），与改写框同一条
/// `draftAfterEdit` 路径；编辑中的行把「收进资料区／收成正文」换成带
/// 编辑后正文的版本（`edited_body` 通道，M3 备好的那条）。
fn materialDraftsSection(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const is_drafts = std.mem.eql(u8, snapshot.kind(replies.borrow(.project)), "materialDrafts");
    const listing = snapshot.value(replies.borrow(.project));
    var rows: [mailbox_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    if (is_drafts) {
        while (count < rows.len) : (count += 1) {
            const draft = project_view.materialDraftAt(listing, count) orelse break;
            // 正在改的是不是这一条：同时只编辑一条（与裁决台的改写区同
            // 一条纪律——一次提交只带一条的正文）。
            const editing = model.material_draft.id.slice().len > 0 and
                std.mem.eql(u8, model.material_draft.id.slice(), draft.id);
            rows[count] = ui.el(.card, .{ .key = .{ .index = count }, .padding = 8 }, .{
                ui.column(.{ .gap = 4 }, .{
                    ui.text(.{}, ui.fmt("{s} · {s}", .{ draft.title, draft.kind })),
                    if (editing)
                        ui.column(.{ .gap = 4 }, .{
                            // 与裁决台改写区同款编辑器（ui.code editable 内部
                            // 是 textarea）。高度随内容撑开：SDK 没有「按行数」
                            // 的声明通道，硬编像素值违反几何纪律。
                            ui.code(.{
                                .language = .markdown,
                                .editable = true,
                                .wrap = true,
                                .on_input = Adapter.Ui.inputMsg(.material_draft_typed),
                                .semantics = .{ .label = "改这条草稿的正文" },
                            }, model.material_draft.body.slice()),
                            ui.row(.{ .gap = 8 }, .{
                                ui.button(.{
                                    .on_press = commitMaterialDraftMsg(model, draft.id, model.material_draft.body.slice(), false, false),
                                    .semantics = .{ .label = "按改后的正文收进资料区" },
                                }, "收进资料区"),
                                ui.button(.{
                                    .on_press = commitMaterialDraftMsg(model, draft.id, model.material_draft.body.slice(), false, true),
                                    .semantics = .{ .label = "按改后的正文提拔成正文" },
                                }, "收成正文"),
                                ui.button(.{
                                    .on_press = @as(?Msg, .material_draft_cancel),
                                    .semantics = .{ .label = "放弃这次修改" },
                                }, "取消"),
                            }),
                        })
                    else
                        ui.row(.{ .gap = 8 }, .{
                            ui.button(.{
                                .on_press = commitMaterialDraftMsg(model, draft.id, null, false, false),
                                .semantics = .{ .label = "收进资料区" },
                            }, "收进资料区"),
                            ui.button(.{
                                .on_press = commitMaterialDraftMsg(model, draft.id, null, false, true),
                                .semantics = .{ .label = "直接提拔成正文" },
                            }, "收成正文"),
                            ui.button(.{
                                .on_press = commitMaterialDraftMsg(model, draft.id, null, true, false),
                                .semantics = .{ .label = "退回这条草稿" },
                            }, "退回"),
                            ui.button(.{
                                // 起笔是草稿当前的正文（body 随名录行走）。
                                .on_press = @as(?Msg, .{ .material_draft_begin = .{
                                    .id = draft.id,
                                    .seed = draft.body,
                                } }),
                                .semantics = .{ .label = "在行内改这条草稿" },
                            }, "改"),
                        }),
                }),
            });
        }
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "材料草稿"),
            ui.button(.{
                .on_press = readMaterialDraftsMsg(model),
                .semantics = .{ .label = "读取材料草稿名录" },
            }, "刷新"),
        }),
        if (is_drafts and count == 0)
            ui.text(.{}, "没有等待成稿的草稿")
        else if (!is_drafts)
            ui.text(.{}, "草稿在这里等成稿——点刷新读取")
        else
            ui.column(.{ .gap = 4 }, @as([]const Adapter.Ui.Node, rows[0..count])),
    });
}

/// 读材料草稿名录。没有项目时不发——Rust 会具名拒绝，而按钮根本不该送到。
fn readMaterialDraftsMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readMaterialDrafts(&writer, model.root_id.slice()) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 成稿或退回一条草稿。`edited_body` 是行内编辑后的正文（2.2 接上）；
/// 没编辑过就是 null——空切片与「没编辑」是两件事，serde 写 null。
fn commitMaterialDraftMsg(
    model: *const Model,
    draft_id: []const u8,
    edited_body: ?[]const u8,
    dismiss: bool,
    as_chapter: bool,
) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.commitMaterialDraft(
        &writer,
        model.root_id.slice(),
        draft_id,
        edited_body,
        dismiss,
        as_chapter,
    ) orelse return null;
    return .{ .project_request = request.bytes };
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

/// 最新预览答复里的 digest。预览住专槽 `deskPreview`（审计 #8）：无关答复
/// 不再把它冲掉；槽空（没预览过、或上次送出已消费）时交出空切片——
/// 「送出去」因此带不上核对，Rust 按无核对处理。
fn previewedDigest() []const u8 {
    if (!std.mem.eql(u8, snapshot.kind(replies.borrow(.preview)), "dispatchPreview")) return "";
    return snapshot.stringField(snapshot.value(replies.borrow(.preview)), "digest") orelse "";
}

/// 送出去。
///
/// 范围的三个来源按规则合成：位图覆盖的块段、攒段的文本段、选区的一段
/// （选区只在前两者都空时才作数）——同走 `dispatchDesk` 一个写器，三个闸
/// （委托/带稿/资料）对三种来源同价。三个都空交出 null——按钮因此灰掉，
/// 作者按下去之前就知道。
fn dispatchMsg(model: *const Model, selected: []const u8) ?Msg {
    return dispatchDeskMsg(model, selected, "dispatch");
}

/// 预览：与送出同一份合成规则，只是不铸 Run、不带送前核对的 digest。
fn previewDispatchMsg(model: *const Model, selected: []const u8) ?Msg {
    return dispatchDeskMsg(model, selected, "previewDispatch");
}

fn dispatchDeskMsg(model: *const Model, selected: []const u8, comptime kind: []const u8) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    if (model.dispatch.prompt.slice().len == 0) return null;
    const agents: u64 = @intCast(@max(1, model.dispatch.agents));
    // 一个 agent 时排法无意义，送并列：让 Rust 那边少一个「作者选了
    // 接力却只派了一个」的边角情况。
    const orchestration = if (model.dispatch.agents < 2) "alternates" else orchestrationAt(model.dispatch.orchestration).wire;
    const span = coverageSpan(model);
    // 选区路径并入 desk 写器（审计 #7）：位图与攒段都空时，选区当成一段
    // 文本 scope 走 stash 槽位送出——委托/带稿/资料三个闸从此在选区派发
    // 也生效（旧路径把它们写死丢了：persona 恒 null、channel 恒 harness、
    // carry/materials/agent 全不送）。2.2 的纪律不变：选区只在位图与攒段
    // 都空时才作为 scope。
    const has_blocks = span != null or model.dispatch.stash.slice().len > 0;
    if (!has_blocks and selected.len == 0) return null;
    const agent = effectiveDispatchAgent(model);
    // 手动往返（空 id）走 L0：channel 是 manual，agent 字段不写。
    const channel: []const u8 = if (agent.len > 0) "harness" else "manual";
    // 带稿档位：0 增量 / 1 全文 / 2 不带。「不带」不写这个词——与 serde
    // 的 skip 同形，旧载荷旧行为。
    const carry: []const u8 = switch (model.dispatch.carry) {
        1 => "full",
        2 => "",
        else => "diff",
    };
    // 送前核对只在送出时带；预览不带（与旧的一对同一条分工）。
    const digest = previewedDigest();
    const expected: ?[]const u8 = if (comptime std.mem.eql(u8, kind, "dispatch"))
        (if (digest.len > 0) digest else null)
    else
        null;
    // 勾选的资料随块段/攒段路径走：只有路径过河，档位权威在名录。
    // 定长数组而不是分配：Msg 在帧内消费，路径切片借的是 Model 的字节。
    var material_paths: [200][]const u8 = undefined;
    const material_count = checkedMaterials(model, &material_paths);
    var writer = project_request.Writer{};
    const request = project_request.dispatchDesk(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        model.dispatch.prompt.slice(),
        if (span) |s| .{ .from = s.from, .count = s.count } else null,
        if (has_blocks) model.dispatch.stash.slice() else selected,
        agents,
        orchestration,
        carry,
        material_paths[0..material_count],
        agent,
        channel,
        expected,
        kind,
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

/// 印点几何：块右缘内侧的 9px 方点，垂直居中于命中的那一行。
/// 一窗至多画 max_anchor_dots 颗——窗口里通常只有几颗，超了宁可少画
/// 也不让叠放数组越界。
const anchor_dot_size: f32 = 9;
const max_anchor_dots: usize = 32;

/// 行首表是升序的（第一项恒 0）：命中的行是最后一个 ≤ at 的下标。
fn lineIndexOf(line_starts: []const u32, at: u32) usize {
    var lo: usize = 0;
    var hi: usize = line_starts.len;
    while (lo + 1 < hi) {
        const mid = lo + (hi - lo) / 2;
        if (line_starts[mid] <= at) lo = mid else hi = mid;
    }
    return lo;
}

/// 一颗提案印点：点开就地饭盒。位置由禁则行首推（y）与版心右缘（x）——
/// 与正文同一坐标系，所以滚动时它跟着段落走。
fn anchorDot(
    ui: *Adapter.Ui,
    model: *const Model,
    range: protocol.AnchorRangeWire,
    column_width: f32,
    line_height: f32,
    line_starts: []const u32,
) Adapter.Ui.Node {
    const line = lineIndexOf(line_starts, range.start);
    return ui.button(.{
        .frame = native_sdk.geometry.RectF.init(
            @max(0, column_width - anchor_dot_size - 3),
            @as(f32, @floatFromInt(line)) * line_height + @max(0, (line_height - anchor_dot_size) / 2),
            anchor_dot_size,
            anchor_dot_size,
        ),
        .on_press = verdictBeginMsg(model, range),
        .semantics = .{ .label = "这里有提案，点开裁决（Alt+A 接受 / Alt+B 退回）" },
    }, "");
}

/// 就地裁决饭盒：一次一个，开在命中行的下缘。接受/退回的请求在
/// `verdict_begin` 里预编好（提案 id 是变量，core 子集不拼 JSON）——
/// 按钮与 Alt 键送出的是同一条。
///
/// **交互设计（2.1a）**：在正文里判，不切台——作者写着写着看到印点，
/// 点一下（或记住键位后 Alt 系）就地判完继续写。与裁决台的差别在
/// 落盘时机：饭盒判了即落盘（judgeVerdict = 记账+提交一步，v0.2.4
/// 信箱侧「接受类立即合并、退回只记录」的语义），判完饭盒消失、作者
/// 回到写作；裁决台是批量台，判完进批次等合并。键位：Alt+A 接受 /
/// Alt+B 退回 / Alt+E 改后接受（起笔是 agent 的建议）/ Alt+Enter
/// 落定改写 / Escape 关盒（panel_back 分层里它在最内层）。键位印在
/// 按钮上：作者多数时候鼠标停在文本区，第一次用眼睛学，之后用手。
/// 一次只开一个盒：两处同时判会让「我判的是哪一条」失去答案。
fn verdictBento(
    ui: *Adapter.Ui,
    model: *const Model,
    document: host_bridge.DocumentView,
    column_width: f32,
    line_height: f32,
) ?Adapter.Ui.Node {
    if (model.review.proposal.slice().len == 0) return null;
    for (document.ranges) |range| {
        if (range.kind != 3) continue;
        if (!std.mem.eql(u8, &range.id, model.review.proposal.slice())) continue;
        const line = lineIndexOf(document.line_starts, range.start);
        const width = @min(@as(f32, 340), @max(@as(f32, 240), column_width));
        const revising = std.mem.eql(u8, model.revising.id.slice(), model.review.proposal.slice());
        var bento = ui.el(.panel, .{
            .frame = native_sdk.geometry.RectF.init(
                @max(0, column_width - width),
                (@as(f32, @floatFromInt(line)) + 1) * line_height + 8,
                width,
                0,
            ),
            .padding = 8,
        }, .{
            ui.column(.{ .gap = 6 }, .{
                ui.row(.{ .gap = 8 }, .{
                    ui.button(.{
                        .on_press = @as(?Msg, .verdict_accept),
                        .semantics = .{ .label = "接受这条提案（Alt+A）" },
                    }, "接受 (Alt+A)"),
                    ui.button(.{
                        .on_press = @as(?Msg, .verdict_revise),
                        .semantics = .{ .label = "改写这条提案（Alt+E）" },
                    }, "改后接受 (Alt+E)"),
                    ui.button(.{
                        .on_press = @as(?Msg, .verdict_reject),
                        .semantics = .{ .label = "退回这条提案（Alt+B）" },
                    }, "退回 (Alt+B)"),
                    ui.button(.{
                        .on_press = @as(?Msg, .verdict_close),
                        .semantics = .{ .label = "关上饭盒（Escape）" },
                    }, "关 (Esc)"),
                }),
                if (revising)
                    ui.column(.{ .gap = 6 }, .{
                        ui.code(.{
                            .language = document_language.syntaxOf(document.format),
                            .editable = true,
                            .wrap = true,
                            .on_input = Adapter.Ui.inputMsg(.revision_typed),
                            .semantics = .{ .label = "改写后的正文" },
                        }, model.revising.body.slice()),
                        ui.button(.{
                            .variant = .primary,
                            .disabled = model.revising.body.slice().len == 0,
                            .on_press = judgeRevisionMsg(model),
                            .semantics = .{ .label = "按我改的这版接受并落盘" },
                        }, "落定 (Alt+Enter)"),
                    })
                else
                    ui.el(.stack, .{ .height = 0 }, .{}),
            }),
        });
        // 饭盒也吃材质（2.10）：它是编辑区词汇不是浮窗，但与功能区面板
        // 同一份配方——透光度/模糊一张表，不存在「饭盒另是一层皮」。
        material_paint.apply(
            &bento.widget,
            panelMaterialKind(model),
            &themes.themes[currentThemeIndex(model)],
        );
        return bento;
    }
    return null;
}

/// 点开印点：带提案 id 与起笔（名录没在读就空起笔）。
///
/// 单元 13 之前这里还预编两条 `judgeVerdict` 请求随 `Msg` 搭过去，因为受限子集
/// 拼不出 JSON，只能让 Zig 在渲染时先编好。Zig 核心自己调得动编码器，那一族摆渡
/// 字段因此不存在（`core/msg.zig` 里有一条测试钉着它不要回来）。
fn verdictBeginMsg(model: *const Model, range: protocol.AnchorRangeWire) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    const id: []const u8 = &range.id;
    return .{ .verdict_begin = .{ .id = id, .seed = proposalSeedById(id) } };
}

/// 从裁决名录里按 id 读起笔（agent 的建议）。名录没在读就空起笔。
fn proposalSeedById(id: []const u8) []const u8 {
    if (!std.mem.eql(u8, snapshot.kind(replies.borrow(.project)), "proposals")) return "";
    const listing = snapshot.value(replies.borrow(.project));
    var index: usize = 0;
    while (index < mailbox_rows) : (index += 1) {
        const proposal = project_view.proposalAt(listing, index) orelse break;
        if (std.mem.eql(u8, proposal.id, id)) return proposal.after_text;
    }
    return "";
}

/// 改后接受并落盘：作者写的那段成为最终正文，一次完成（judgeVerdict
/// 把记账与提交合成一步——饭盒不停留，作者回到写作）。
fn judgeRevisionMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    if (model.revising.id.slice().len == 0 or model.revising.body.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.judgeVerdict(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        model.revising.id.slice(),
        "accept-modified",
        model.revising.body.slice(),
        "",
    ) orelse return null;
    return .{ .project_request = request.bytes };
}

fn documentView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const Scroll = @FieldType(Msg, "document_scroll");
    const document = host_bridge.documentView();
    const total_blocks: u64 = @intCast(@max(model.document.blocks, 0));
    // 行高/视口高/列宽都从 Model 换算（同一式各只有一处），滚动布局与
    // 部件绘制因此必然一致——旧的 650/18 硬编码的错误正是两处各写一份。
    const line_height = documentLineHeightPx(model);
    const layout = documentLayout(document, total_blocks, documentViewportHeightPx(model), line_height);
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
        .width = documentColumnWidthPx(model),
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
    const column_width = documentColumnWidthPx(model);
    var overlay: [max_anchor_dots + 2]Adapter.Ui.Node = undefined;
    overlay[0] = editor;
    var overlay_count: usize = 1;
    for (document.ranges) |range| {
        if (range.kind != 3) continue; // 2.1a 只画提案印点；批注的呈现随后
        if (overlay_count > max_anchor_dots) break;
        overlay[overlay_count] = anchorDot(ui, model, range, column_width, line_height, document.line_starts);
        overlay_count += 1;
    }
    if (verdictBento(ui, model, document, column_width, line_height)) |bento| {
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
        .context_menu = manuscriptMenu(model),
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
    const track_with_card = ui.el(.stack, .{}, .{ track, karaReturnCard(ui, model, column_width, line_height) });
    // 一处常驻的 split 承载全部去处（V0.2.4 的浮层+让位模型，SDK 的
    // split 是其原生等价）：去处切换 = fraction 变化 + 300ms 先快后慢
    // tween（旧版 panel-in 动效），正文不重建、不重排全文。
    //
    // **单侧极简（旧版 UI 哲学）**：一切从左侧出现——文件树（Rail）最左，
    // 面板贴着它展开，正文恒在最右；右键菜单与 notice 是仅有的两个浮在
    // 正文上的东西。裁决是 stage 例外：独占整屏（旧版 takesWholeStage）。
    // 多层面板栈（2.9）：侧层 + 当前层并排，正文轨按 v0.2.4 的公式右滑。
    // 面板打开时是功能区的模式替换，不进栈；独占去处当前时没有侧层。
    // 层深先问语义（栈里有几层），再问几何（这扇窗画得下几层）。三个
    // 消费点（这里、`railEdgeX`、`layeredBody`）拿同一个数，地、分栏线与
    // 版式因此不可能对不齐。
    const depth = panel_stack.fittingDepth(
        @floatCast(@max(model.window.width, 0)),
        @floatCast(model.layout_fraction),
        model.panel_stack.visibleDepth(model.destination),
    );
    const layered = depth >= 2 and !model.palette.open;
    // 左 pane 的内容：命令面板住在功能区（打开时整个换成它——模式替换，
    // 舞台规则不许浮层，关掉回原来的去处），否则是当前去处。
    const leading_content = if (model.palette.open)
        palettePanel(ui, model)
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
        rail.dress(ui, &themes.themes[currentThemeIndex(model)], leading_hosted)
    else
        leading_hosted;
    // 栏占掉的那一段宽：通知条与状态行都是正文那一栏的事（状态行报的是
    // 稿子的保存点与选区），所以它们从栏的右缘开始，而不是铺到窗左缘
    // 去压在栏上。
    const rail_lead = if (railEdgeX(model, depth, layered)) |edge|
        @max(0, edge - shell_padding_px)
    else
        0;
    const body: Adapter.Ui.Node = if (layered)
        layeredBody(ui, model, track_with_card, depth)
    else
        ui.split(.{
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
    const root = ui.column(.{ .gap = 12, .padding = shell_padding_px }, .{
        // 通知条横跨整窗，不让位给功能栏：它报的是具名的拒绝（「那个去处要
        // 先打开一份稿子」），而拒绝往往正发生在栏占满窗宽的时候——让位会
        // 把它振成一个读不出的碎片（真窗探针拍到过：三层时只剩一个
        // 「Dism」）。它自带地（`.alert` 的 chrome），所以跨在栏上也读得出。
        noticeBar(ui, model),
        body,
        karaInterruptLine(ui, model),
        karaSummaryStrip(ui, model),
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
            ui.text(.{ .grow = 1 }, statuslineText(ui, model, document)),
        }),
    });
    // 壳上的两件叠加物：分栏线与悬停探头条。两件都要窗口的上下缘，
    // 而只有壳知道那两条缘在哪里。
    var shell_layers: [4]Adapter.Ui.Node = undefined;
    var shell_count: usize = 0;
    const railband = if (railEdgeX(model, depth, layered)) |edge| rail.band(
        ui,
        &themes.themes[currentThemeIndex(model)],
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
/// **出处**：根栏左 padding + 可见层数 × 层宽，层宽走
/// `panel_stack.layerWidth`——与 `veil.rect` 量正文轨宽时同一式，不新造
/// 第二份版式算术。
///
/// **什么时候没有**：没有栏时；栏独占整屏时（`layoutFraction == 1`，稿子
/// 与裁决）——没有第二栏就没有分界，也无从让位；窗尺寸未到时（不猜）。
fn railEdgeX(model: *const Model, depth: usize, layered: bool) ?f32 {
    if (!railOpen(model)) return null;
    const fraction: f32 = @floatCast(model.layout_fraction);
    if (fraction >= 0.999) return null;
    const window_width: f32 = @floatCast(@max(model.window.width, 0));
    if (window_width <= 0 or model.window.height <= 0) return null;
    const columns: f32 = if (layered) @floatFromInt(depth) else 1;
    return shell_padding_px + panel_stack.layerWidth(window_width, fraction) * columns;
}

/// 状态行（2.6）：保存点、选中统计、活动句。
///
/// **接上哪个功能**：core 的 `savePending/savedRevision`（保存证据链，
/// native-save 通道）与投影的 `document_selection_*`（全文字节偏移）。
/// 措辞的唯一权威是这里——状态行只有一行，每一句都要值得那一行。
///
/// **交互设计**：句序 = 作者此刻最想知道的：活动在飞（正在保存…）>
/// 有未保存改动 > 已保存 · 相对时刻。选中段只在有选区时出现，越出
/// 视窗的部分如实标「+」不假装数得出。保存是原子动作、没有可量的
/// 进度，所以等待只说「正在保存…」，不画假装进度的百分比。没有稿子
/// 时说「还没有打开稿子」，不画一串零。
fn statuslineText(ui: *Adapter.Ui, model: *const Model, document: host_bridge.DocumentView) []const u8 {
    if (model.document.session == 0) return "还没有打开稿子";
    const save_seg = saveSegment(ui, model);
    const stats = project_view.selectionStats(
        document.text,
        document.window_start,
        document.document_selection_start,
        document.document_selection_end,
    ) orelse return save_seg;
    if (stats.chars == 0 and stats.clipped) return ui.fmt("{s} · 选中（越出视窗）", .{save_seg});
    return ui.fmt("{s} · 选中 {d} 字 · {d} 段{s}", .{
        save_seg,
        stats.chars,
        stats.blocks,
        if (stats.clipped) "+" else "",
    });
}

/// 保存段的墙钟打戳：渲染时观测 `savedRevision` 的变化沿，变化的那帧
/// 打上本地毫秒戳。这是 UI 的观测不是协议——与真实落盘最多差一帧；
/// core 子集没有墙钟，钟只能长在视图侧（注释即约定，读数别当协议用）。
var statusline_stamped_revision: u64 = 0;
var statusline_save_ms: i64 = 0;

fn saveSegment(ui: *Adapter.Ui, model: *const Model) []const u8 {
    if (model.document.save_pending) return "正在保存…";
    if (model.document.revision != model.document.saved_revision) return "有未保存改动";
    if (model.document.saved_revision != statusline_stamped_revision) {
        statusline_stamped_revision = model.document.saved_revision;
        // 墙钟走 SDK 的 runtime.nowMs（三平台一致，Windows 用 NT 精确系统
        // 时间）：Zig 0.16 的 std.time 已不再暴露墙钟。
        statusline_save_ms = native_sdk.runtime.nowMs();
    }
    var buf: [32]u8 = undefined;
    const rel = project_view.relativeSaveText(&buf, native_sdk.runtime.nowMs() - statusline_save_ms);
    return ui.fmt("已保存 · {s}", .{rel});
}

/// 回来卡：「你停在这里」。
///
/// **接上哪个功能**：KARA 离开又回来后的状态恢复卡（2.3a）。600ms 自消
/// 在 core（卡计时器），这里只在 `karaCard` 立着时画。
///
/// **交互设计**：舞台规则豁免的浮层（Agent 状态恢复卡，唯一合法浮层
/// 之一）——叠放在正文轨顶，frame 定位，不进流、不随滚动。宽度沿用
/// 饭盒的那条公式（`verdictBento`），不新写几何。
fn karaReturnCard(ui: *Adapter.Ui, model: *const Model, column_width: f32, line_height: f32) Adapter.Ui.Node {
    if (!model.kara.card) return ui.el(.stack, .{ .height = 0 }, .{});
    const width = @min(@as(f32, 340), @max(@as(f32, 240), column_width));
    var card = ui.el(.panel, .{
        // 轨顶内缩 12（根栏间距的既有数）；高是一行加 padding 16。
        .frame = native_sdk.geometry.RectF.init(16, 12, width, line_height + 16),
        .padding = 8,
    }, .{
        ui.text(.{}, ui.fmt("你停在这里：{s}", .{model.kara.return_tail.slice()})),
    });
    // 回来卡同吃材质（2.10）：它是豁免浮层，但观感上与面板同一份配方。
    material_paint.apply(
        &card.widget,
        panelMaterialKind(model),
        &themes.themes[currentThemeIndex(model)],
    );
    return card;
}

/// 打断行：KARA 计时被事实打断时的一句实话（保存失败、磁盘写不进……）。
/// `.alert` 部件画它——语义即「需要作者看一眼」。打断码的翻译表归
/// veil.zig（中文字面量纪律），不认识的码原样显示。
fn karaInterruptLine(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.kara.interrupt.slice().len == 0 or model.kara.state == 0) {
        return ui.el(.stack, .{ .height = 0 }, .{});
    }
    return ui.el(.alert, .{
        .semantics = .{ .label = "打断" },
    }, .{
        ui.text(.{}, veil.interruptLabel(model.kara.interrupt.slice())),
    });
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
    const notice = model.notice orelse return ui.el(.stack, .{ .height = 0 }, .{});
    return ui.el(.alert, .{
        .variant = .secondary,
        .semantics = .{ .label = "提示" },
    }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, notice.slice()),
            ui.el(.button, .{
                .variant = .secondary,
                .icon = "x",
                .semantics = .{ .label = "知道了" },
                .on_press = .notice_dismiss,
            }, .{}),
        }),
    });
}

/// 小结带：离场时把这一段发生的事讲一遍（`.status_bar` 部件——栏脚语义）。
/// queued 掩码逐位出文案，位序即显示序；什么都没有就说「这一段很安静。」。
fn karaSummaryStrip(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.kara.state != 5) return ui.el(.stack, .{ .height = 0 }, .{});
    return ui.el(.status_bar, .{
        .semantics = .{ .label = "离场小结" },
    }, .{
        ui.text(.{}, karaSummaryText(ui, model)),
    });
}

/// 小结文案：已保存 / Agent 完成了 / 提案到了 / 索引刷新了，按位序连接。
fn karaSummaryText(ui: *Adapter.Ui, model: *const Model) []const u8 {
    const queued = model.kara.queued;
    if (queued <= 0) return "这一段很安静。";
    var parts: [4][]const u8 = undefined;
    var count: usize = 0;
    if (queued & 1 != 0) {
        parts[count] = "已保存";
        count += 1;
    }
    if (queued & 2 != 0) {
        parts[count] = "Agent 完成了";
        count += 1;
    }
    if (queued & 4 != 0) {
        parts[count] = "提案到了";
        count += 1;
    }
    if (queued & 8 != 0) {
        parts[count] = "索引刷新了";
        count += 1;
    }
    return std.mem.join(ui.arena, " · ", parts[0..count]) catch "这一段很安静。";
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
        .files => filesView(ui, model),
        // 裁决台画提案，不画 Run 名录：作者在这里判的是「这一改值不值得」。
        .review => reviewView(ui, model),
        // 派发台画的是「送什么出去」，不是「送出去了什么」——后者在信箱。
        .dispatch => dispatchView(ui, model),
        .mailbox => mailboxView(ui, model),
        // 连接问的是这台机器有什么，不是这个项目有什么。
        .connections => connectionsView(ui),
        // 历史读的是落盘的记录，不是内存里那条撤销链。
        .history => historyView(ui, model),
        .settings => settingsView(ui, model),
    };
}

/// 多层并排的版式：侧层在左、当前层最右、正文轨在它们右边。
///
/// **接上哪个功能**：`panelStack` 的可见层（`panel_stack.zig` 投影层深与
/// 几何）。每层内容是各去处的既有视图（`destinationView`），复用不重写。
///
/// **交互设计**：一行里排完，与单层时的 split 同形——层各占一层宽，
/// 舊台拿剩下的全部。每层包 `.panel`：圆角/材质/分隔全走 token 与
/// corners，零新几何。当前层带 `global_key = "panel-current"`，panel-in
/// 动画按它寻址（变换不入流，邻居不跟着动）。
///
/// **为什么不再是 z 叠 + 右滑**：上一版把轨铺满整个 body、再按
/// v0.2.4 的 CSS 公式平移「多出的层宽的一半」，而面板盖在它上面。
/// 那个公式来自一个轨居中于整窗的版式；在这里它意味着二层起
/// 正文就落在面板上——实测：打开派发后「# 第一章」与面板的「段落 0
/// 块」炖在同一行。排成一行之后，正文永远在自己的 pane 里，与单层
/// 时同一条不变式。
fn layeredBody(
    ui: *Adapter.Ui,
    model: *const Model,
    track: Adapter.Ui.Node,
    depth: usize,
) Adapter.Ui.Node {
    const width = panel_stack.layerWidth(
        @floatCast(@max(model.window.width, 0)),
        @floatCast(model.layout_fraction),
    );
    var layers: [panel_stack.MAX_VISIBLE_LAYERS + 1]Adapter.Ui.Node = undefined;
    var at: usize = 0;
    while (at < depth) : (at += 1) {
        const current = at == depth - 1;
        const panel = ui.el(.panel, .{
            .key = .{ .index = at },
            .global_key = if (current) .{ .str = "panel-current" } else null,
            .width = width,
        }, .{
            destinationView(ui, model, track, model.panel_stack.visibleLayerAt(
                model.destination,
                @intCast(at),
            )),
        });
        // 功能栏穿上自己的地与墨（`rail.dress`）：材质配方、去弧边、去外框
        // 与递归着墨四件事在那一处定。侧层与当前层同质，与单层时的左 pane
        // 也同质——三处消费点共用这一行。
        layers[at] = rail.dress(ui, &themes.themes[currentThemeIndex(model)], panel);
    }
    // 层在前、舊台在后，一行排完：舊台 `grow` 拿剩下的全部，所以“正文落
    // 在面板上”在几何上不可能，而不是靠一个平移量刚好错开。
    layers[depth] = ui.el(.stack, .{ .grow = 1 }, .{track});
    return ui.row(.{ .grow = 1 }, @as([]const Adapter.Ui.Node, layers[0 .. depth + 1]));
}

/// 命令面板：住在功能区（rail）里，不是浮层。
///
/// **接上哪个功能**：`palette_toggle` 开合（开时清空查询，core 管）、
/// `palette_query` 过滤词、`workbench_go` 与各命令臂是行的落点。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。「这个去处现在够不够得着」
/// 由 `core.ts` 的 `navigate` 判，这里不复制那条规则。
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
            paletteGoSection(ui, model, query),
            paletteCommandSection(ui, model, query, "文档", &.{ "document.save", "document.undo", "search" }),
            paletteCommandSection(ui, model, query, "视图", &.{ "theme.next", "kara.toggle" }),
            paletteCommandSection(ui, model, query, "系统", &.{"app.quit"}),
        }),
    });
}

/// 根栏的内边距（px）。版心列宽、层宽（`panel_stack.layerWidth`）与纱的
/// 几何（`veil.rect`）都从它减起，所以它只能有一处。
const shell_padding_px: f32 = 16;

/// 导轨树里一行向右缩进一格的宽度。
///
/// 14px 是一个 CJK 字的大致半宽：窄到不把行推出版心，宽到一眼能看出
/// 这一行属于上一行。SDK 的 `tree_level` 只是语义层级（它自己的测试写明
/// “logical hierarchy metadata, not renderer-owned spacing”），几何归我们。
const rail_indent_px: f32 = 14;

/// 完全透明。用在「这里不画东西」而不是「这里画白色」的地方——
/// 白色在深色主题上是一道亮边，透明在七套主题上都是一样的无。
const transparent = native_sdk.canvas.Color.rgba(0, 0, 0, 0);

/// 导轨树一行的高度（px）。
///
/// 行高 30 + 行间 6 = 36px 的步长。v0.3.0 是 24px（行高随字号 + gap 2），
/// 在真窗上读作「挤」——一叠贴在一起的行不像一棵树，像一块文本。
/// 36 是正文行高的量级：导轨与正文因此同一个呼吸，眼睛从稿子移到名录
/// 不用重新对焦。
const rail_row_height_px: f32 = 30;
const rail_row_gap_px: f32 = 6;

/// 导轨树里的一行。
///
/// **它拥有的规则**：树里的一行不是盒子。行本体去角（`corners.squared`），
/// 层级靠左侧的空格说，选中靠行底色说——三件事在这一处定，不在每个
/// 调用点各写一遍。调用点只说「这一行在第几层」。
///
/// 保留 `list_item` 而不自绘：命中、键盘主键、右键菜单、无障碍角色都在
/// 它身上，为了一个形状把这些重建一遍是把一条规则换成四条。
fn railTreeRow(ui: *Adapter.Ui, options: Adapter.Ui.ElementOptions, depth: u16, label: []const u8) Adapter.Ui.Node {
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
fn paletteGoSection(ui: *Adapter.Ui, model: *const Model, query: []const u8) Adapter.Ui.Node {
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
    return railTreeRow(ui, .{
        .disabled = !available or msg == null,
        .on_press = if (available) msg else null,
        .semantics = .{ .role = .treeitem, .label = label },
    }, 1, shown);
}

/// 命令 id → Msg。与 core.ts `commandMsg` 同一个落点：直接发它翻译出的
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
