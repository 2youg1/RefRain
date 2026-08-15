//! Zig 核心问 Rust 的唯一出口——P2 的回放缝。
//!
//! **接上哪个功能**：`Effects.hostRequest`，SDK 里那条「具名 host 调用」。
//! 转译核心的 `request` 线记录今天就骑在它背后（SDK `effects.zig` 的头注释：
//! "the generic named host call behind a transpiled core's `request` wire
//! records"），所以 Zig 的 `update_fx` 调它不是新缝，是同一条缝的另一个调用方。
//!
//! **在迁移中负责什么**：三件事，缺一个 Zig 核心就发不出请求——
//! 通道键的命名空间、host record 的编码、答复的路由。TS 车道把这三件事分给了
//! 转译器（键）、`@native-sdk/core` 的 `hostRecordBytes`（编码）与 `Cmd.request`
//! 的 ok/err 标签（路由）；Zig 车道没有转译器，因此它们在这里合成一个模块。
//!
//! **为什么它能被回放**：SDK 按种类记录每条效果结果，`.host` 是其中之一。
//! `session_replay.zig::effectRegeneratesUnderReplay` 对 `.host` 的裁定是
//! `record.exit_reason == .rejected`——只有确定性的准入拒绝会在回放侧重算，
//! host 的**答复一律喂入**。因此不需要 trait、不需要双实现、不需要
//! `if (replaying)` 分支：录制与回放对 `update_fx` 是同一条路径。
//!
//! 规格：`RefRain-work/replay_seam+SPEC.md`。

const std = @import("std");
const native_sdk = @import("native_sdk");
const protocol = @import("generated/protocol.zig");

/// 服务名。与 `host_bridge.zig` 注册的那一个同源——两侧都取生成的常量，
/// 因此不存在「表面拼错了服务名」这一类静默。
pub const service_name = protocol.host_service;

/// 一条请求骑哪个通道。
///
/// 键是**常量**而不是运行期分配的槽位下标：TS 车道的 key 是
/// `request_key_base + 槽位`（`ts_core_host.zig::allocRequestEntry`），槽位在
/// 发出顺序里分配、终态投递后回收——那是转译器的记账需要，不是通道的身份。
/// Zig 核心只有两个 host 通道，把身份写成常量让「保存在飞时打字不顶掉保存」
/// 成为类型上可读的事实（W12 save channel），而不是一次运行期分配的巧合。
///
/// 幻数取 `host.json` 已有的 `magic: "RFRN"`（0x5246_524E）加序号。它与 SDK
/// 的六个 `*_key_base` 都不相撞——SDK 的 base 全部形如 `0x5453_xxxx`（"TS"）。
/// 万一将来撞上，表现是**一条具名的 err Msg**（键与别的效果种类相撞即拒绝，
/// 见 `effects.zig::startHostRequest`），不是静默。
pub const Channel = enum(u64) {
    /// 投影通道：握手、开文档、打字、滚动、以及一切项目请求。
    dispatch = 0x5246_524E_0000_0001,
    /// 保存通道。与打字分键的理由是证据：共键时在飞的保存会被下一次输入
    /// 顶掉（SDK 的 keyed 语义是替换），「已保存」就成了没有证据的说辞。
    save = 0x5246_524E_0000_0002,

    pub fn key(self: Channel) u64 {
        return @intFromEnum(self);
    }

    /// 答复回来时认出它骑的是哪个通道。`on_result` 是无捕获的纯函数指针，
    /// 路由信息只能由 `result.key` 携带——这是键必须是常量的第二个理由。
    pub fn fromKey(value: u64) ?Channel {
        inline for (@typeInfo(Channel).@"enum".fields) |field| {
            if (field.value == value) return @enumFromInt(field.value);
        }
        return null;
    }
};

/// 一条 host record 的字段。名字与 `host.json` 的 `hostRecord` 表同源，
/// 顺序也同——线上布局由 `protocol.zig` 的 offset 常量决定，不由这里的声明序。
///
/// 缺省值是「这次请求不关心这一槽」的诚实写法：`action` 无缺省（每条请求都
/// 必须说自己是什么），其余按协议的中性值。
pub const Record = struct {
    action: protocol.Action,
    input: u16 = 0,
    flags: u16 = 0,
    session: u64 = 0,
    revision: u64 = 0,
    anchor: u64 = 0,
    focus: u64 = 0,
    cursor: u64 = 0,
    columns_em: f64 = 0,
    scroll_offset_y: f64 = 0,
    viewport_first_block: u64 = 0,
    viewport_block_count: u32 = protocol.default_viewport_blocks,
    window_start: u64 = 0,
    /// 随请求过界的文本（项目请求的 JSON、插入的字符）。上限
    /// `protocol.event_text_bytes`，超了是 `error.TextTooLong` 而不是截断——
    /// 截断会把一次合法的长输入变成一次语义不同的短输入。
    text: []const u8 = "",
};

/// 一条 host record 的最大字节数。调用方按它开缓冲。
pub const max_record_bytes: usize =
    protocol.offset_text + protocol.event_text_bytes + protocol.trailing_bytes;

pub const EncodeError = error{
    /// `text` 超过 `protocol.event_text_bytes`。
    TextTooLong,
    /// 调用方给的缓冲装不下这条记录。
    BufferTooSmall,
};

/// 把一条记录写成 SDK host record 的线上字节。
///
/// 布局全部来自 `generated/protocol.zig` 的 offset 常量——它与 Rust 侧的
/// 解码（`host_bridge.zig::decodeBridgeRequest`）读同一张生成表，因此两端
/// 不可能各持一份偏移。标量槽是 f64（解码侧 `readF64`），`text_len` 是
/// 小端 u32，尾随三个标量跟在文本之后。
pub fn encode(buffer: []u8, record: Record) EncodeError![]const u8 {
    if (record.text.len > protocol.event_text_bytes) return error.TextTooLong;
    const total = protocol.offset_text + record.text.len + protocol.trailing_bytes;
    if (buffer.len < total) return error.BufferTooSmall;
    const out = buffer[0..total];
    @memset(out, 0);

    writeScalar(out, protocol.offset_action, @floatFromInt(@intFromEnum(record.action)));
    writeScalar(out, protocol.offset_anchor, @floatFromInt(record.anchor));
    writeScalar(out, protocol.offset_columns_em, record.columns_em);
    writeScalar(out, protocol.offset_cursor, @floatFromInt(record.cursor));
    writeScalar(out, protocol.offset_flags, @floatFromInt(record.flags));
    writeScalar(out, protocol.offset_focus, @floatFromInt(record.focus));
    writeScalar(out, protocol.offset_input, @floatFromInt(record.input));
    writeScalar(out, protocol.offset_protocol_version, @floatFromInt(protocol.protocol_version));
    writeScalar(out, protocol.offset_revision, @floatFromInt(record.revision));
    writeScalar(out, protocol.offset_scroll_offset_y, record.scroll_offset_y);
    writeScalar(out, protocol.offset_session, @floatFromInt(record.session));

    std.mem.writeInt(u32, out[protocol.offset_text_len..][0..4], @intCast(record.text.len), .little);
    @memcpy(out[protocol.offset_text..][0..record.text.len], record.text);

    const tail = protocol.offset_text + record.text.len;
    writeScalar(out, tail + protocol.trailing_offset_viewport_block_count, @floatFromInt(record.viewport_block_count));
    writeScalar(out, tail + protocol.trailing_offset_viewport_first_block, @floatFromInt(record.viewport_first_block));
    writeScalar(out, tail + protocol.trailing_offset_window_start, @floatFromInt(record.window_start));
    return out;
}

fn writeScalar(buffer: []u8, offset: usize, value: f64) void {
    std.mem.writeInt(u64, buffer[offset..][0..8], @bitCast(value), .little);
}

/// 发一条请求。
///
/// `fx` 是 `UiApp(Model, Msg).Effects`，`on_result` 是它的
/// `Effects.hostMsg(.arm)`——两者都由调用方实例化，所以这里取 `anytype`：
/// 本模块不认识调用方的 Msg，也不该认识。
///
/// 同键重发即**替换**（SDK 的 keyed 语义）：连续打字只有最后一枪回话，被顶掉
/// 的旧枪静默丢弃。这正是投影通道要的语义，也正是保存必须分键的理由。
pub fn request(fx: anytype, channel: Channel, payload: []const u8, on_result: anytype) void {
    fx.hostRequest(.{
        .key = channel.key(),
        .name = service_name,
        .payload = payload,
        .on_result = on_result,
    });
}

// ---------------------------------------------------------------- 缝的测试

const testing = std.testing;
const geometry = native_sdk.geometry;

test "超长文本是具名错误，不是截断" {
    var buffer: [max_record_bytes]u8 = undefined;
    const long = [_]u8{'x'} ** (protocol.event_text_bytes + 1);
    try testing.expectError(error.TextTooLong, encode(&buffer, .{ .action = .project, .text = &long }));
}

test "两个通道键互不相同，且都认得回自己" {
    try testing.expect(Channel.dispatch.key() != Channel.save.key());
    try testing.expectEqual(Channel.dispatch, Channel.fromKey(Channel.dispatch.key()).?);
    try testing.expectEqual(Channel.save, Channel.fromKey(Channel.save.key()).?);
    try testing.expectEqual(@as(?Channel, null), Channel.fromKey(0));
    // SDK 的六个 key base 全部形如 0x5453_xxxx（"TS"）；本模块的是 0x5246（"RF"）。
    // 这条断言把 §14 的硬编码声明钉成可执行的事实。
    try testing.expect(Channel.dispatch.key() >> 48 != 0x5453);
    try testing.expect(Channel.save.key() >> 48 != 0x5453);
}

// ------------------------------------------ 真 UiApp 上的一次往返（10a/10b）

const SeamModel = struct {
    ok_count: u32 = 0,
    err_count: u32 = 0,
    last_channel: ?Channel = null,
    last_len: usize = 0,
};

const SeamMsg = union(enum) {
    open,
    save,
    host_result: native_sdk.EffectHostResult,
};

const SeamApp = native_sdk.UiApp(SeamModel, SeamMsg);

fn seamUpdate(model: *SeamModel, msg: SeamMsg, fx: *SeamApp.Effects) void {
    switch (msg) {
        .open => {
            var buffer: [max_record_bytes]u8 = undefined;
            const bytes = encode(&buffer, .{
                .action = .project,
                .text = "{\"kind\":\"readConfig\"}",
            }) catch return;
            request(fx, .dispatch, bytes, SeamApp.Effects.hostMsg(.host_result));
        },
        .save => {
            var buffer: [max_record_bytes]u8 = undefined;
            const bytes = encode(&buffer, .{
                .action = .apply_input,
                .input = @intFromEnum(protocol.Input.save),
            }) catch return;
            request(fx, .save, bytes, SeamApp.Effects.hostMsg(.host_result));
        },
        .host_result => |result| {
            if (result.ok) model.ok_count += 1 else model.err_count += 1;
            model.last_channel = Channel.fromKey(result.key);
            model.last_len = result.bytes.len;
        },
    }
}

fn seamView(ui: *SeamApp.Ui, model: *const SeamModel) SeamApp.Ui.Node {
    return ui.column(.{ .gap = 4, .padding = 8 }, .{
        ui.text(.{}, ui.fmt("{d} ok", .{model.ok_count})),
    });
}

const seam_canvas_label = "seam-canvas";

const app_manifest = native_sdk.app_manifest;

const seam_views = [_]app_manifest.ShellView{
    .{ .label = seam_canvas_label, .kind = .gpu_surface, .fill = true, .gpu_backend = .metal },
};
const seam_windows = [_]app_manifest.ShellWindow{.{
    .label = "main",
    .title = "seam",
    .width = 400,
    .height = 300,
    .views = &seam_views,
}};
const seam_scene: app_manifest.ShellConfig = .{ .windows = &seam_windows };

const SeamHarness = struct {
    harness: *native_sdk.TestHarness(),
    app_state: *SeamApp,
    app: native_sdk.App,

    fn create() !SeamHarness {
        const harness = try native_sdk.TestHarness().create(testing.allocator, .{
            .size = geometry.SizeF.init(400, 300),
        });
        errdefer harness.destroy(testing.allocator);
        harness.null_platform.gpu_surfaces = true;
        const app_state = try testing.allocator.create(SeamApp);
        errdefer testing.allocator.destroy(app_state);
        app_state.* = SeamApp.init(std.heap.page_allocator, .{}, .{
            .name = "replay-seam",
            .scene = seam_scene,
            .canvas_label = seam_canvas_label,
            .update_fx = seamUpdate,
            .view = seamView,
        });
        const app = app_state.app();
        try harness.start(app);
        try harness.runtime.dispatchPlatformEvent(app, .{ .gpu_surface_frame = .{
            .label = seam_canvas_label,
            .size = geometry.SizeF.init(400, 300),
            .scale_factor = 1,
            .frame_index = 1,
            .timestamp_ns = 1_000_000,
        } });
        return .{ .harness = harness, .app_state = app_state, .app = app };
    }

    fn destroy(self: *SeamHarness) void {
        self.app_state.deinit();
        testing.allocator.destroy(self.app_state);
        self.harness.destroy(testing.allocator);
    }

    fn wake(self: *SeamHarness) !void {
        try self.harness.runtime.dispatchPlatformEvent(self.app, .wake);
    }
};

test "缝存在：Zig update_fx 发出的请求被停住，喂进答复后恰好一条 Msg 落地" {
    var h = try SeamHarness.create();
    defer h.destroy();
    const fx = &h.app_state.effects;
    fx.executor = .fake;

    try h.app_state.dispatch(&h.harness.runtime, 1, .open);
    try testing.expectEqual(@as(usize, 1), fx.pendingHostCount());
    const parked = fx.pendingHostAt(0).?;
    // 停住的那条请求带着本模块的通道键与生成的服务名——这是「同一条缝」的物证。
    try testing.expectEqual(Channel.dispatch.key(), parked.key);
    try testing.expectEqualStrings(service_name, parked.name);
    try testing.expectEqual(@as(u16, protocol.protocol_version), readScalarU16(parked.payload, protocol.offset_protocol_version));

    try fx.feedHostResult(Channel.dispatch.key(), true, "answer");
    try h.wake();
    try testing.expectEqual(@as(u32, 1), h.app_state.model.ok_count);
    try testing.expectEqual(Channel.dispatch, h.app_state.model.last_channel.?);
    try testing.expectEqual(@as(usize, 6), h.app_state.model.last_len);
    try testing.expectEqual(@as(usize, 0), fx.pendingHostCount());
}

test "两个通道各自在飞：保存不被打字顶掉" {
    var h = try SeamHarness.create();
    defer h.destroy();
    const fx = &h.app_state.effects;
    fx.executor = .fake;

    try h.app_state.dispatch(&h.harness.runtime, 1, .save);
    try h.app_state.dispatch(&h.harness.runtime, 1, .open);
    // 两条同时在飞：键不同，投影没有替换掉保存。共键的代价正是这一条会变成 1。
    try testing.expectEqual(@as(usize, 2), fx.pendingHostCount());

    try fx.feedHostResult(Channel.save.key(), true, "saved");
    try h.wake();
    try testing.expectEqual(Channel.save, h.app_state.model.last_channel.?);
    try testing.expectEqual(@as(u32, 1), h.app_state.model.ok_count);
}

test "err 路由也恰好投一条 Msg，不静默" {
    var h = try SeamHarness.create();
    defer h.destroy();
    const fx = &h.app_state.effects;
    fx.executor = .fake;

    try h.app_state.dispatch(&h.harness.runtime, 1, .open);
    try fx.feedHostResult(Channel.dispatch.key(), false, "refused");
    try h.wake();
    try testing.expectEqual(@as(u32, 1), h.app_state.model.err_count);
    try testing.expectEqual(@as(u32, 0), h.app_state.model.ok_count);
    // 键已终态：再喂一次是具名错误，不是第二条 Msg。
    try testing.expectError(error.EffectNotFound, fx.feedHostResult(Channel.dispatch.key(), true, ""));
}

fn readScalarU16(bytes: []const u8, offset: usize) u16 {
    if (bytes.len < offset + 8) return 0;
    const raw = std.mem.readInt(u64, bytes[offset..][0..8], .little);
    const value: f64 = @bitCast(raw);
    if (!(value >= 0) or value > std.math.maxInt(u16)) return 0;
    return @intFromFloat(value);
}
