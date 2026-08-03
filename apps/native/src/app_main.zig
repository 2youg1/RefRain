const std = @import("std");
const builtin = @import("builtin");
const runner = @import("runner");
const native_sdk = @import("native_sdk");
const manifest = @import("app_manifest_zon");
const protocol = @import("generated/protocol.zig");
pub const core = @import("refrain_core");
const host_bridge = @import("host_bridge.zig");

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
}

test "generated C ABI layouts match the Rust repr C contract" {
    try std.testing.expectEqual(@as(usize, 12_072), @sizeOf(protocol.RefrainNativeRequest));
    try std.testing.expectEqual(@as(usize, 53_080), @sizeOf(protocol.RefrainNativeResponse));
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
        .selection = null,
        .composition = null,
    }, 100);
    try std.testing.expectEqual(@as(f32, 0), top.leading);
    try std.testing.expectApproxEqAbs(@as(f32, 3600), top.leading + top.projection + top.trailing, 0.001);

    const tail = documentLayout(.{
        .text = text,
        .window_start = 1000 - text.len,
        .window_end = 1000,
        .first_block = 98,
        .block_count = 2,
        .selection = null,
        .composition = null,
    }, 100);
    try std.testing.expectApproxEqAbs(@as(f32, 3600), tail.leading + tail.projection + tail.trailing, 0.001);
    try std.testing.expectEqual(@as(f32, 0), tail.trailing);
    try std.testing.expectEqual(@as(usize, 2), projectionVisualRows("中文\n日本"));
}

fn manuscriptTokens(_: *const Model) native_sdk.canvas.DesignTokens {
    return native_sdk.canvas.DesignTokens.themeWithOverrides(
        .{ .pack = runner.manifestThemePack() },
        .{ .typography = .{ .mono_font_id = manuscript_font_id } },
    );
}

pub fn main(init: std.process.Init) !void {
    const app_state = try Adapter.create(std.heap.page_allocator, .{}, .{
        .name = manifest.name,
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .view = documentView,
        .tokens_fn = manuscriptTokens,
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
const document_wrap_columns: usize = 120;

const DocumentLayout = struct {
    leading: f32,
    projection: f32,
    trailing: f32,
};

fn documentLayout(document: host_bridge.DocumentView, total_blocks: u64) DocumentLayout {
    const track = @max(document_viewport_height, @as(f32, @floatFromInt(total_blocks)) * document_block_height);
    const projection_height = @max(document_viewport_height, @as(f32, @floatFromInt(projectionVisualRows(document.text))) * document_line_height);
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

fn projectionVisualRows(text: []const u8) usize {
    var rows: usize = 1;
    var columns: usize = 0;
    for (text) |byte| {
        if (byte == '\n') {
            rows += 1;
            columns = 0;
        } else if (byte & 0xc0 != 0x80) {
            columns += 1;
            if (columns > document_wrap_columns) {
                rows += 1;
                columns = 1;
            }
        }
    }
    return rows;
}

fn documentView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const Input = @FieldType(Msg, "document_input");
    const Scroll = @FieldType(Msg, "document_scroll");
    const document = host_bridge.documentView();
    const total_blocks: u64 = @intCast(@max(model.documentBlocks, 0));
    const layout = documentLayout(document, total_blocks);
    var editor = ui.code(.{
        .language = .plain,
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
        .semantics = .{ .label = "RefRain manuscript track" },
    }, .{
        ui.column(.{}, .{
            ui.el(.stack, .{ .height = layout.leading }, .{}),
            editor,
            ui.el(.stack, .{ .height = layout.trailing }, .{}),
        }),
    });
    return ui.column(.{ .gap = 12, .padding = 16 }, .{
        CompiledView.build(ui, model),
        track,
        ui.text(.{}, ui.fmt(
            "visible blocks {d}–{d} of {d} · bytes {d}–{d} · one Rust manuscript",
            .{
                document.first_block,
                document.first_block + document.block_count,
                model.documentBlocks,
                document.window_start,
                document.window_end,
            },
        )),
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
