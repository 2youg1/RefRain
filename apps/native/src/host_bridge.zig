const std = @import("std");
const native_sdk = @import("native_sdk");
const protocol = @import("generated/protocol.zig");

extern fn refrain_native_dispatch(request: protocol.RefrainNativeRequest) callconv(.c) protocol.RefrainNativeResponse;

var projection: protocol.RefrainNativeResponse = undefined;
var has_projection = false;

/// 投影文本的落脚处。
///
/// **接上哪个功能**：正稿渲染。`RefrainNativeResponse.text` 是裸指针，
/// 而它指向的线上字节住在调用栈上——出了 `request` 就悬空。
///
/// **在全局逻辑中负责什么**：把那段文本拷进模块生命周期的缓冲，让视图
/// 在后续帧里仍能读到。协议已把正稿限在 `projection_bytes` 以内，
/// 所以这块缓冲永远够用，不需要分配器。
var projection_text: [protocol.projection_bytes]u8 = undefined;

/// 锚定区间的落脚处：与 `projection_text` 同一条纪律——线上字节活在
/// 调用栈上，区间（窗口坐标）搬进模块缓冲，容量即协议上界。
var projection_ranges: [protocol.anchor_range_capacity]protocol.AnchorRangeWire = undefined;
var projection_range_count: usize = 0;

/// 行首偏移的落脚处：同一条纪律。视图按它们断行（SDK 只认 space/tab，
/// 断不了中文），行数不超投影字节数（理论极值，每字节一个换行）。
var projection_line_starts: [protocol.projection_bytes]u32 = undefined;
var projection_line_start_count: usize = 0;

/// 收下一个从线上字节解出的投影，并把它的文本搬进 `projection_text`。
/// `wire` 只在本次调用内有效，函数返回后 `projection.text` 指向本模块的缓冲。
fn adoptProjection(decoded: protocol.RefrainNativeResponse, wire: []const u8) void {
    projection = decoded;
    const text_len = @min(@as(usize, decoded.text_len), protocol.projection_bytes);
    if (text_len > 0 and wire.len >= protocol.response_header_bytes + text_len) {
        @memcpy(projection_text[0..text_len], wire[protocol.response_header_bytes..][0..text_len]);
        projection.text = projection_text[0..].ptr;
    } else {
        projection.text_len = 0;
    }
    // 行首与区间两段挂在文本之后；旧录制（v3）两段都没有，回放出空表
    // 而不是错位。
    adoptSections(wire, text_len, projection.line_start_count);
    has_projection = true;
}

/// 从线上字节解出行首偏移与锚定区间。逐字段 readInt——两段都不对齐
/// （文本长度任意），按 extern 结构借指针会在未对齐的地址上炸掉。
fn adoptSections(wire: []const u8, text_len: usize, line_count: u32) void {
    projection_line_start_count = 0;
    projection_range_count = 0;
    var section = protocol.response_header_bytes + text_len;
    if (line_count > 0) {
        const wanted: usize = @min(line_count, protocol.projection_bytes);
        if (wire.len < section + wanted * 4) return;
        var index: usize = 0;
        while (index < wanted) : (index += 1) {
            projection_line_starts[index] = std.mem.readInt(u32, wire[section + index * 4 ..][0..4], .little);
        }
        projection_line_start_count = wanted;
        section += wanted * 4;
    }
    if (wire.len < section + 4) return;
    const count = std.mem.readInt(u32, wire[section..][0..4], .little);
    const available = (wire.len - section - 4) / protocol.anchor_range_wire_bytes;
    const bounded = @min(@min(count, available), protocol.anchor_range_capacity);
    var index: usize = 0;
    while (index < bounded) : (index += 1) {
        const at = section + 4 + index * protocol.anchor_range_wire_bytes;
        var id: [36]u8 = undefined;
        @memcpy(&id, wire[at + 12 ..][0..36]);
        projection_ranges[index] = .{
            .start = std.mem.readInt(u32, wire[at..][0..4], .little),
            .end = std.mem.readInt(u32, wire[at + 4 ..][0..4], .little),
            .kind = std.mem.readInt(u32, wire[at + 8 ..][0..4], .little),
            .id = id,
        };
    }
    projection_range_count = bounded;
}

pub const DocumentView = struct {
    text: []const u8,
    window_start: u64,
    window_end: u64,
    first_block: u64,
    block_count: u32,
    /// The selection in manuscript coordinates, for reporting how much of the
    /// whole document is selected. Rendering uses `selection` instead.
    document_selection_start: u64,
    document_selection_end: u64,
    selection: ?native_sdk.canvas.TextSelection,
    composition: ?native_sdk.canvas.TextRange,
    /// How many lines the projection occupies once CLREQ 禁则 are applied.
    /// Rust computed the break offsets; counting them is all the view needs to
    /// size the column, and it replaces the old per-character estimate that
    /// assumed every glyph was one column wide.
    line_count: usize,
    /// 这份稿子写的是哪一门语言，来自 Rust 的 `DocumentFormat`。
    /// 翻成 SDK 语法的那张表在 `document_language.zig`；这里只搬数字。
    format: u32,
    /// 这一窗里的锚定区间（窗口字节坐标）：批注（1=高亮 2=评论）与未裁决
    /// 提案（3）。Rust 按当前稿子解析，锚不上的不在表里——视图按 kind
    /// 分层画印点，缺席就是它「锚不上」的全部表示。
    ranges: []const protocol.AnchorRangeWire,
    /// CLREQ 禁则断出的行首偏移（窗口字节坐标）：视图按它断行——SDK 的
    /// 换行搜索只认 space/tab，断不了中文。第一行恒从 0 开始。
    line_starts: []const u32,
};

/// Bind the one generated dispatch codec to Native SDK's typed effect channel.
pub fn bind(effects: anytype) void {
    const Effects = @TypeOf(effects.*);
    effects.bindHostCalls(.{
        .context = effects,
        .send_fn = Callbacks(Effects).send,
        .request_fn = Callbacks(Effects).request,
    });
}

/// Return the latest Rust projection.
///
/// Rust already spliced any preedit into `text` and expressed both offsets
/// against it, so this only bounds the borrowed slice for the current frame.
pub fn documentView() DocumentView {
    if (!has_projection) return emptyDocumentView();
    const text_len = @min(@as(usize, projection.text_len), protocol.projection_bytes);
    const source = projection.text[0..text_len];
    const composition: ?native_sdk.canvas.TextRange = if (projection.composition_len == 0)
        null
    else
        native_sdk.canvas.TextRange.init(
            @min(@as(usize, @intCast(projection.composition_start)), text_len),
            @min(@as(usize, @intCast(projection.composition_end)), text_len),
        );
    return .{
        .text = source,
        .window_start = projection.window_start,
        .window_end = projection.window_start +| @as(u64, @intCast(text_len)),
        .first_block = projection.first_block,
        .block_count = projection.block_count,
        .document_selection_start = projection.document_selection_start,
        .document_selection_end = projection.document_selection_end,
        .line_count = @max(1, @as(usize, projection.line_start_count)),
        .selection = .{
            .anchor = @min(@as(usize, @intCast(projection.selection_anchor)), text_len),
            .focus = @min(@as(usize, @intCast(projection.selection_focus)), text_len),
        },
        .composition = composition,
        .format = projection.document_format,
        .ranges = projection_ranges[0..projection_range_count],
        .line_starts = projection_line_starts[0..projection_line_start_count],
    };
}

fn emptyDocumentView() DocumentView {
    return .{
        .text = &.{},
        .window_start = 0,
        .window_end = 0,
        .first_block = 0,
        .block_count = 0,
        .document_selection_start = 0,
        .document_selection_end = 0,
        .selection = null,
        .composition = null,
        .line_count = 1,
        // 还没有稿子时按散文算：空表面不该显示成一份代码文件。
        .format = 0,
        .ranges = &.{},
        .line_starts = &.{},
    };
}

const max_safe_integer: f64 = 9007199254740991.0;

/// Decode one SDK host record. The request's text is borrowed from `bytes`
/// rather than copied, so the decoded value must not outlive this payload.
fn decodeBridgeRequest(bytes: []const u8) ?protocol.RefrainNativeRequest {
    if (bytes.len < protocol.offset_text + protocol.trailing_bytes) return null;
    const text_len: usize = @intCast(std.mem.readInt(u32, bytes[protocol.offset_text_len..protocol.offset_text], .little));
    if (text_len > protocol.event_text_bytes) return null;
    const tail = protocol.offset_text + text_len;
    if (bytes.len != tail + protocol.trailing_bytes) return null;
    const scroll_offset_y = readF64(bytes, protocol.offset_scroll_offset_y);
    if (!std.math.isFinite(scroll_offset_y) or scroll_offset_y < 0) return null;
    const request_value: protocol.RefrainNativeRequest = .{
        .protocol_version = wholeU16(readF64(bytes, protocol.offset_protocol_version)) orelse return null,
        .action = wholeU16(readF64(bytes, protocol.offset_action)) orelse return null,
        .input = wholeU16(readF64(bytes, protocol.offset_input)) orelse return null,
        .flags = wholeU16(readF64(bytes, protocol.offset_flags)) orelse return null,
        .session = wholeU64(readF64(bytes, protocol.offset_session)) orelse return null,
        .revision = wholeU64(readF64(bytes, protocol.offset_revision)) orelse return null,
        .window_start = wholeU64(readF64(bytes, tail + protocol.trailing_offset_window_start)) orelse return null,
        .anchor = wholeU64(readF64(bytes, protocol.offset_anchor)) orelse return null,
        .focus = wholeU64(readF64(bytes, protocol.offset_focus)) orelse return null,
        .cursor = wholeU64(readF64(bytes, protocol.offset_cursor)) orelse return null,
        .viewport_first_block = wholeU64(readF64(bytes, tail + protocol.trailing_offset_viewport_first_block)) orelse return null,
        .viewport_block_count = wholeU32(readF64(bytes, tail + protocol.trailing_offset_viewport_block_count)) orelse return null,
        .scroll_offset_y = scroll_offset_y,
        // 字身 per line, measured by the platform. Rust returns 禁则-correct
        // break offsets for it; a non-finite or negative value means "no
        // breaking" rather than a refusal, because a viewport can legitimately
        // have no width yet on the first frame.
        .columns_em = blk: {
            const value = readF64(bytes, protocol.offset_columns_em);
            break :blk if (std.math.isFinite(value) and value > 0) value else 0;
        },
        .text_len = @intCast(text_len),
        .text = bytes[protocol.offset_text..tail].ptr,
    };
    return request_value;
}

fn readF64(bytes: []const u8, offset: usize) f64 {
    return @bitCast(std.mem.readInt(u64, bytes[offset..][0..8], .little));
}

fn wholeU16(value: f64) ?u16 {
    if (!std.math.isFinite(value) or value < 0 or value > @as(f64, @floatFromInt(std.math.maxInt(u16))) or @trunc(value) != value) return null;
    return @intFromFloat(value);
}

fn wholeU32(value: f64) ?u32 {
    if (!std.math.isFinite(value) or value < 0 or value > @as(f64, @floatFromInt(std.math.maxInt(u32))) or @trunc(value) != value) return null;
    return @intFromFloat(value);
}

fn wholeU64(value: f64) ?u64 {
    if (!std.math.isFinite(value) or value < 0 or value > max_safe_integer or @trunc(value) != value) return null;
    return @intFromFloat(value);
}

/// Validate one decoded request against its action's shape.
///
/// TypeScript speaks the Rust action and input vocabulary directly, and the
/// scroll offset rides through to Rust, so nothing is translated here.
fn validateRequest(request_value: *const protocol.RefrainNativeRequest) bool {
    const action = std.enums.fromInt(protocol.Action, request_value.action) orelse return false;
    switch (action) {
        // health 不带文本；open_manuscript 的文本段正是要打开的引用
        // （rootId + 换行 + path，core 的 document_open 分支构造）。把
        // open 与 health 一起要求 text_len == 0，真实打开文档永远被拒——
        // journal 回放绕过这条校验所以没暴露（e2e 仿真抓出）。
        .health => {
            if (request_value.input != 0 or request_value.text_len != 0 or request_value.flags != 0) return false;
        },
        .open_manuscript => {
            if (request_value.input != 0 or request_value.flags != 0) return false;
            if (request_value.text_len > protocol.event_text_bytes) return false;
        },
        // 两个取投影的动作形状相同，差别只在锚点来源（Rust 侧）：
        // `obtain_projection` 按块，`scroll_projection` 按像素偏移。把滑轮
        // 分出一个动作码，是因为「滚到最顶」与「保持当前块」在数值上同为 0。
        .obtain_projection, .scroll_projection => {
            if (request_value.input != 0 or request_value.text_len != 0 or request_value.flags != 0) return false;
        },
        .project => {
            if (request_value.input != 0 or request_value.flags != 0) return false;
        },
        .apply_input => {
            const input = std.enums.fromInt(protocol.Input, request_value.input) orelse return false;
            // 只有三种输入带文本：插入、预编辑、回档（动作 id）。其余带文本是
            // 形状错误。
            if (input != .insert_text and input != .set_composition and input != .revert_to and request_value.text_len != 0) {
                return false;
            }
            if (input == .move_caret) {
                const direction = request_value.flags & protocol.caret_direction_mask;
                if (std.enums.fromInt(protocol.CaretDirection, direction) == null) return false;
                if (request_value.flags & ~(protocol.caret_direction_mask | protocol.caret_extend_flag) != 0) {
                    return false;
                }
            } else if (request_value.flags != 0) {
                return false;
            }
        },
    }
    return true;
}

fn Callbacks(comptime Effects: type) type {
    return struct {
        fn send(context: *anyopaque, name: []const u8, payload: []const u8) void {
            _ = context;
            _ = name;
            _ = payload;
        }

        fn request(context: *anyopaque, name: []const u8, key: u64, payload: []const u8) void {
            const effects: *Effects = @ptrCast(@alignCast(context));
            if (!std.mem.eql(u8, name, protocol.host_service)) {
                feed(effects, key, false, &protocol.encodeProtocolError(.invalid_request, 0));
                return;
            }
            const decoded = decodeBridgeRequest(payload) orelse {
                const action = if (payload.len >= 8) wholeU16(readF64(payload, protocol.offset_action)) orelse 0 else 0;
                feed(effects, key, false, &protocol.encodeProtocolError(.invalid_request, action));
                return;
            };
            const request_value = decoded;
            const action = request_value.action;
            if (!validateRequest(&request_value)) {
                feed(effects, key, false, &protocol.encodeProtocolError(.invalid_request, action));
                return;
            }
            var result = refrain_native_dispatch(request_value);
            // 线上只带两种文本：`project` 的不透明载荷，和三个投影动作的正稿。
            // 其余动作（health）没有文本可带。正稿此前被这里清零——那让 journal
            // 里没有它，录制会话回放时界面因此是空的。
            if (!carriesWireText(action)) result.text_len = 0;
            const encoded = protocol.encodeDispatchResponse(result);
            const wire = encoded[0..protocol.encodedResponseLen(result)];
            // 投影从**线上字节**重建，不从 FFI 返回值取。回放时主机不被调用，
            // 只有这些字节会被重放；两条路读同一份数据，界面因此在录制与
            // 回放中一致（可访问性树的哈希正是回放的判据）。
            if (result.status == 0 and updatesDocumentProjection(action)) {
                if (protocol.decodeDispatchResponse(wire)) |projected| {
                    adoptProjection(projected, wire);
                }
            }
            feed(effects, key, result.status == 0, wire);
        }

        fn feed(effects: *Effects, key: u64, ok: bool, bytes: []const u8) void {
            effects.feedHostResult(key, ok, bytes) catch unreachable;
        }
    };
}

/// Every action except the opaque project group replaces the document
/// projection the view renders from.
fn updatesDocumentProjection(action: u16) bool {
    const resolved = std.enums.fromInt(protocol.Action, action) orelse return false;
    return switch (resolved) {
        .open_manuscript, .apply_input, .obtain_projection, .scroll_projection => true,
        .health, .project => false,
    };
}

/// 哪些动作的响应带文本上线。
///
/// 两类：`project` 带 Rust 的不透明载荷（界面不解读它），三个投影动作带正稿
/// （视图要画它，回放要重建它）。`health` 没有文本。
///
/// 这条判断决定 journal 里有没有正稿——漏掉投影动作，回放的界面就是空的，
/// 而录制与回放两侧单看都自洽。
fn carriesWireText(action: u16) bool {
    const resolved = std.enums.fromInt(protocol.Action, action) orelse return false;
    return switch (resolved) {
        .project, .open_manuscript, .apply_input, .obtain_projection, .scroll_projection => true,
        .health => false,
    };
}

const StubEffects = struct {
    binding: ?native_sdk.HostCallBinding = null,
    response: [protocol.response_bytes]u8 = @splat(0),
    response_len: usize = 0,
    response_ok: bool = false,

    fn bindHostCalls(self: *StubEffects, binding: native_sdk.HostCallBinding) void {
        self.binding = binding;
    }

    fn feedHostResult(self: *StubEffects, _: u64, ok: bool, bytes: []const u8) error{EffectNotFound}!void {
        @memcpy(self.response[0..bytes.len], bytes);
        self.response_len = bytes.len;
        self.response_ok = ok;
    }
};

fn call(effects: *StubEffects, key: u64, payload: []const u8) void {
    effects.binding.?.request_fn(
        effects.binding.?.context,
        protocol.host_service,
        key,
        payload,
    );
}

const empty_host_record_bytes: usize = protocol.offset_text + protocol.trailing_bytes;

fn request(action: protocol.Action) [empty_host_record_bytes]u8 {
    var out: [empty_host_record_bytes]u8 = @splat(0);
    writeF64(&out, protocol.offset_action, @floatFromInt(@intFromEnum(action)));
    writeF64(&out, protocol.offset_protocol_version, @floatFromInt(protocol.protocol_version));
    writeF64(
        &out,
        protocol.offset_text + protocol.trailing_offset_viewport_block_count,
        @floatFromInt(protocol.default_viewport_blocks),
    );
    return out;
}

fn applyRequest(input: protocol.Input) [empty_host_record_bytes]u8 {
    var out = request(.apply_input);
    writeF64(&out, protocol.offset_input, @floatFromInt(@intFromEnum(input)));
    return out;
}

fn writeF64(bytes: []u8, offset: usize, value: f64) void {
    std.mem.writeInt(u64, bytes[offset..][0..8], @bitCast(value), .little);
}

test "one dispatch health request crosses the Rust ABI" {
    var effects: StubEffects = .{};
    bind(&effects);
    const payload = request(.health);
    call(&effects, 7, &payload);

    try std.testing.expect(effects.response_ok);
    const response = effects.response[0..effects.response_len];
    try std.testing.expectEqual(protocol.response_header_bytes, response.len);
    try std.testing.expectEqual(@as(u32, 0), std.mem.readInt(u32, response[8..12], .little));
    try std.testing.expectEqual(protocol.api_version, std.mem.readInt(u16, response[12..14], .little));
    try std.testing.expectEqual(protocol.capability_mask, std.mem.readInt(u32, response[16..20], .little));
}

test "one project-group request preserves its opaque Rust payload without replacing document authority" {
    var effects: StubEffects = .{};
    bind(&effects);
    projection = protocol.emptyResponse(@intFromEnum(protocol.Action.obtain_projection));
    projection.revision = 77;
    has_projection = true;

    const input = "{\"kind\":\"notAProjectInput\"}";
    var payload: [protocol.offset_text + input.len + protocol.trailing_bytes]u8 = @splat(0);
    writeF64(&payload, protocol.offset_action, @floatFromInt(@intFromEnum(protocol.Action.project)));
    writeF64(&payload, protocol.offset_protocol_version, @floatFromInt(protocol.protocol_version));
    std.mem.writeInt(u32, payload[protocol.offset_text_len..protocol.offset_text], @intCast(input.len), .little);
    @memcpy(payload[protocol.offset_text..][0..input.len], input);
    writeF64(
        &payload,
        protocol.offset_text + input.len + protocol.trailing_offset_viewport_block_count,
        @floatFromInt(protocol.default_viewport_blocks),
    );
    call(&effects, 71, &payload);

    try std.testing.expect(!effects.response_ok);
    const response = effects.response[0..effects.response_len];
    try std.testing.expect(response.len > protocol.response_header_bytes);
    try std.testing.expectEqual(@intFromEnum(protocol.Action.project), std.mem.readInt(u16, response[6..8], .little));
    const text_len = std.mem.readInt(u32, response[48..52], .little);
    try std.testing.expectEqual(response.len, protocol.response_header_bytes + @as(usize, text_len));
    try std.testing.expect(std.mem.startsWith(u8, response[protocol.response_header_bytes..], "decode the project input"));
    try std.testing.expectEqual(@as(u64, 77), projection.revision);
}

test "open keeps the 11.4 MiB source in Rust and returns the requested block viewport" {
    var effects: StubEffects = .{};
    bind(&effects);
    const payload = request(.open_manuscript);
    call(&effects, 8, &payload);

    try std.testing.expect(effects.response_ok);
    const view = documentView();
    try std.testing.expect(view.text.len < protocol.projection_bytes);
    try std.testing.expectEqualStrings("中文", view.text[9..15]);
    try std.testing.expectEqual(@as(u64, 0), view.window_start);
    try std.testing.expectEqual(@as(u64, 0), view.first_block);
    try std.testing.expectEqual(protocol.default_viewport_blocks, view.block_count);
    try std.testing.expectEqualDeep(native_sdk.canvas.TextSelection.collapsed(0), view.selection.?);
    try std.testing.expect(view.composition == null);
}

test "the wheel action selects the bounded Rust block projection, offset zero included" {
    var effects: StubEffects = .{};
    bind(&effects);
    var payload = request(.open_manuscript);
    call(&effects, 8, &payload);
    try std.testing.expect(effects.response_ok);

    payload = request(.scroll_projection);
    writeF64(&payload, protocol.offset_revision, @floatFromInt(projection.revision));
    writeF64(&payload, protocol.offset_scroll_offset_y, 1_800_000);
    writeF64(&payload, protocol.offset_session, @floatFromInt(projection.session));
    call(&effects, 9, &payload);
    try std.testing.expect(effects.response_ok);
    try std.testing.expectEqual(@as(u64, 50_000), projection.first_block);
    try std.testing.expect(projection.window_start > 0);

    writeF64(&payload, protocol.offset_scroll_offset_y, 3_600_000);
    call(&effects, 10, &payload);
    try std.testing.expect(effects.response_ok);
    try std.testing.expectEqual(@as(u64, 99_904), projection.first_block);
    try std.testing.expectEqual(@as(u32, 96), projection.block_count);

    // M13：SDK 把向头部的大滚轮钳成 offset 0。滚轮动作下 0 就是最顶——
    // 从尾窗一次回到块 0，正是这条车道从前回不来的那一步。
    writeF64(
        &payload,
        protocol.offset_text + protocol.trailing_offset_viewport_first_block,
        99_904,
    );
    writeF64(&payload, protocol.offset_scroll_offset_y, 0);
    call(&effects, 11, &payload);
    try std.testing.expect(effects.response_ok);
    try std.testing.expectEqual(@as(u64, 0), projection.first_block);
    try std.testing.expectEqual(@as(u64, 0), projection.window_start);
}

test "document view borrows the Rust projection without copying or reinterpreting it" {
    // Rust already spliced any preedit and expressed both offsets against the
    // projected text, so the bridge only bounds the borrowed slice.
    const source = "abc中文ghi";
    projection = protocol.emptyResponse(@intFromEnum(protocol.Action.apply_input));
    projection.window_start = 100;
    projection.text_len = source.len;
    projection.text = source.ptr;
    projection.selection_anchor = 3;
    projection.selection_focus = 9;
    projection.composition_start = 3;
    projection.composition_end = 9;
    projection.composition_len = 6;
    has_projection = true;

    const view = documentView();
    try std.testing.expectEqualStrings(source, view.text);
    try std.testing.expectEqual(source.ptr, view.text.ptr);
    try std.testing.expectEqual(@as(u64, 100), view.window_start);
    try std.testing.expectEqual(@as(u64, 100 + source.len), view.window_end);
    try std.testing.expectEqualDeep(
        native_sdk.canvas.TextSelection{ .anchor = 3, .focus = 9 },
        view.selection.?,
    );
    try std.testing.expectEqualDeep(native_sdk.canvas.TextRange.init(3, 9), view.composition.?);

    // Offsets past the projected text are clamped rather than read out of range.
    projection.selection_focus = 9_999;
    projection.composition_end = 9_999;
    const clamped = documentView();
    try std.testing.expectEqual(source.len, clamped.selection.?.focus);
    try std.testing.expectEqual(source.len, clamped.composition.?.end);

    // No composition means the view reports none.
    projection.composition_len = 0;
    try std.testing.expect(documentView().composition == null);
}

test "anchor ranges cross the wire and land in the document view in window coordinates" {
    const source = "alpha one\n\nbeta two gamma";
    const backing = [_]protocol.AnchorRangeWire{
        .{ .start = 5, .end = 8, .kind = 1, .id = @splat('p') },
        .{ .start = 15, .end = 20, .kind = 3, .id = @splat('q') },
    };
    const lines = [_]u32{ 0, 10 };
    var response = protocol.emptyResponse(@intFromEnum(protocol.Action.obtain_projection));
    response.text_len = source.len;
    response.text = source.ptr;
    response.anchor_ranges = &backing;
    response.anchor_range_count = backing.len;
    response.line_starts = &lines;
    response.line_start_count = lines.len;

    const encoded = protocol.encodeDispatchResponse(response);
    const wire = encoded[0..protocol.encodedResponseLen(response)];
    const decoded = protocol.decodeDispatchResponse(wire) orelse return error.DecodeFailed;
    adoptProjection(decoded, wire);
    defer {
        has_projection = false;
        projection_range_count = 0;
        projection_line_start_count = 0;
    }

    const view = documentView();
    try std.testing.expectEqualStrings(source, view.text);
    try std.testing.expectEqual(@as(usize, 2), view.ranges.len);
    try std.testing.expectEqualDeep(
        protocol.AnchorRangeWire{ .start = 5, .end = 8, .kind = 1, .id = @splat('p') },
        view.ranges[0],
    );
    try std.testing.expectEqualDeep(
        protocol.AnchorRangeWire{ .start = 15, .end = 20, .kind = 3, .id = @splat('q') },
        view.ranges[1],
    );
    // 行首随同一窗字节过界：视图按它断行（禁则），不按 SDK 的空格搜索。
    try std.testing.expectEqualSlices(u32, &lines, view.line_starts);

    // 旧录制（v3，文本之后没有区间段）回放出空表而不是错位。
    const legacy = protocol.emptyResponse(@intFromEnum(protocol.Action.obtain_projection));
    const legacy_encoded = protocol.encodeDispatchResponse(legacy);
    const legacy_wire = legacy_encoded[0 .. protocol.response_header_bytes + legacy.text_len];
    const legacy_decoded = protocol.decodeDispatchResponse(legacy_wire) orelse return error.DecodeFailed;
    adoptProjection(legacy_decoded, legacy_wire);
    try std.testing.expectEqual(@as(usize, 0), documentView().ranges.len);
    try std.testing.expectEqual(@as(usize, 0), documentView().line_starts.len);
}

test "the bridge rejects malformed shapes for each action without a second numbering" {
    // A text payload on an action that carries no text is refused.
    var undo = std.mem.zeroes(protocol.RefrainNativeRequest);
    undo.action = @intFromEnum(protocol.Action.apply_input);
    undo.input = @intFromEnum(protocol.Input.undo);
    undo.text_len = 1;
    try std.testing.expect(!validateRequest(&undo));
    undo.text_len = 0;
    try std.testing.expect(validateRequest(&undo));
    try std.testing.expect(updatesDocumentProjection(undo.action));

    // Caret flags outside the generated direction set and extend bit are refused.
    var caret = std.mem.zeroes(protocol.RefrainNativeRequest);
    caret.action = @intFromEnum(protocol.Action.apply_input);
    caret.input = @intFromEnum(protocol.Input.move_caret);
    caret.flags = protocol.caret_direction_mask;
    try std.testing.expect(!validateRequest(&caret));
    caret.flags = @intFromEnum(protocol.CaretDirection.next_word) | protocol.caret_extend_flag;
    try std.testing.expect(validateRequest(&caret));

    // An unknown input code is refused rather than silently applied.
    var unknown = std.mem.zeroes(protocol.RefrainNativeRequest);
    unknown.action = @intFromEnum(protocol.Action.apply_input);
    unknown.input = 250;
    try std.testing.expect(!validateRequest(&unknown));

    // 回档带动作 id 文本，与插入同属带文本的输入。
    var revert = std.mem.zeroes(protocol.RefrainNativeRequest);
    revert.action = @intFromEnum(protocol.Action.apply_input);
    revert.input = @intFromEnum(protocol.Input.revert_to);
    revert.text_len = 1;
    try std.testing.expect(validateRequest(&revert));

    // The opaque project group carries text and never replaces the projection.
    const project_bytes = "{}";
    var project_input = std.mem.zeroes(protocol.RefrainNativeRequest);
    project_input.action = @intFromEnum(protocol.Action.project);
    project_input.text_len = project_bytes.len;
    project_input.text = project_bytes.ptr;
    try std.testing.expect(validateRequest(&project_input));
    try std.testing.expect(!updatesDocumentProjection(project_input.action));
}

test "host record offsets stay derived from the generated field order" {
    // The SDK packs leading scalars in field-name order as f64 values, so each
    // generated offset must be a distinct multiple of eight below the length
    // prefix. A hand-edited offset would break one of these relations.
    const leading = [_]usize{
        protocol.offset_action,     protocol.offset_anchor,
        protocol.offset_columns_em, protocol.offset_cursor,
        protocol.offset_flags,      protocol.offset_focus,
        protocol.offset_input,      protocol.offset_protocol_version,
        protocol.offset_revision,   protocol.offset_scroll_offset_y,
        protocol.offset_session,
    };
    for (leading, 0..) |offset, index| {
        try std.testing.expectEqual(index * 8, offset);
        try std.testing.expect(offset < protocol.offset_text_len);
    }
    try std.testing.expectEqual(leading.len * 8, protocol.offset_text_len);
    try std.testing.expectEqual(protocol.offset_text_len + 4, protocol.offset_text);
    try std.testing.expectEqual(@as(usize, 24), protocol.trailing_bytes);

    // A decoded record round-trips the field a caller wrote at each offset.
    var payload = request(.obtain_projection);
    writeF64(&payload, protocol.offset_session, 9);
    writeF64(&payload, protocol.offset_revision, 5);
    writeF64(&payload, protocol.offset_anchor, 3);
    const decoded = decodeBridgeRequest(&payload).?;
    try std.testing.expectEqual(@as(u64, 9), decoded.session);
    try std.testing.expectEqual(@as(u64, 5), decoded.revision);
    try std.testing.expectEqual(@as(u64, 3), decoded.anchor);
    try std.testing.expectEqual(@intFromEnum(protocol.Action.obtain_projection), decoded.action);
}

test "the Zig core's encoder and this decoder read one generated offset table" {
    // The seam that a Zig core sends through (`replay_seam.encode`) and the
    // decoder the bridge answers with are two ends of one wire. Both read the
    // offsets from `generated/protocol.zig`, so this test is what makes
    // "one authority" a fact instead of a claim: encode here, decode there,
    // every field agrees. A hand-edited offset on either side fails it.
    const replay_seam = @import("replay_seam.zig");
    var buffer: [replay_seam.max_record_bytes]u8 = undefined;
    const bytes = try replay_seam.encode(&buffer, .{
        .action = .apply_input,
        .input = @intFromEnum(protocol.Input.insert_text),
        .session = 7,
        .revision = 42,
        .cursor = 13,
        .columns_em = 65,
        .viewport_first_block = 3,
        .window_start = 99904,
        .text = "\u{4e2d}\u{6587}",
    });
    const decoded = decodeBridgeRequest(bytes) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(@intFromEnum(protocol.Action.apply_input), decoded.action);
    try std.testing.expectEqual(@intFromEnum(protocol.Input.insert_text), decoded.input);
    try std.testing.expectEqual(@as(u16, protocol.protocol_version), decoded.protocol_version);
    try std.testing.expectEqual(@as(u64, 7), decoded.session);
    try std.testing.expectEqual(@as(u64, 42), decoded.revision);
    try std.testing.expectEqual(@as(u64, 13), decoded.cursor);
    try std.testing.expectEqual(@as(u64, 3), decoded.viewport_first_block);
    try std.testing.expectEqual(@as(u64, 99904), decoded.window_start);
    try std.testing.expectEqual(@as(u32, protocol.default_viewport_blocks), decoded.viewport_block_count);
    try std.testing.expectEqualStrings("\u{4e2d}\u{6587}", decoded.text[0..decoded.text_len]);
}

test "protocol mismatch, malformed, and unknown service requests remain typed failures" {
    var effects: StubEffects = .{};
    bind(&effects);
    var payload = request(.health);
    writeF64(&payload, protocol.offset_protocol_version, @floatFromInt(protocol.protocol_version + 1));
    call(&effects, 9, &payload);
    try std.testing.expect(!effects.response_ok);
    try std.testing.expectEqual(
        @intFromEnum(protocol.ProtocolError.protocol_mismatch),
        std.mem.readInt(u32, effects.response[8..12], .little),
    );

    call(&effects, 10, payload[0..7]);
    try std.testing.expectEqual(
        @intFromEnum(protocol.ProtocolError.invalid_request),
        std.mem.readInt(u32, effects.response[8..12], .little),
    );

    effects.binding.?.request_fn(effects.binding.?.context, "wrong.host", 11, &payload);
    try std.testing.expectEqual(
        @intFromEnum(protocol.ProtocolError.invalid_request),
        std.mem.readInt(u32, effects.response[8..12], .little),
    );
}
