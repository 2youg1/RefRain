const std = @import("std");
const builtin = @import("builtin");
const runner = @import("runner");
const native_sdk = @import("native_sdk");
const manifest = @import("app_manifest_zon");
pub const core = @import("refrain_core");
const host_bridge = @import("host_bridge.zig");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);
pub const Model = core.Model;
pub const Msg = core.Msg;

const Adapter = native_sdk.TsUiApp(core);
const shell_scene = native_sdk.app_manifest.shellConfigFrom(manifest);
const canvas_label = native_sdk.app_manifest.firstGpuSurfaceLabel(shell_scene);
const app_permissions = manifestStringList(manifest, "permissions");
pub const app_markup = @embedFile("app.native");
const CompiledView = native_sdk.canvas.CompiledMarkupView(Model, Msg, app_markup);

pub fn main(init: std.process.Init) !void {
    const app_state = try Adapter.create(std.heap.page_allocator, .{}, .{
        .name = manifest.name,
        .scene = shell_scene,
        .canvas_label = canvas_label,
        .view = CompiledView.build,
        .markup = if (builtin.mode == .Debug)
            .{ .source = app_markup, .watch_path = "src/app.native", .io = init.io }
        else
            null,
        .theme = comptime runner.manifestThemePack(),
        .theme_accent = comptime runner.manifestThemeAccent(),
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
