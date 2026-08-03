const std = @import("std");
const native_sdk = @import("native_sdk");
const protocol = @import("generated/protocol.zig");

extern fn refrain_native_dispatch(request: protocol.RefrainNativeRequest) callconv(.c) protocol.RefrainNativeResponse;

const rust_action_health: u16 = 1;
const rust_action_open_manuscript: u16 = 2;
const rust_action_apply_input: u16 = 3;
const rust_action_obtain_projection: u16 = 4;
const rust_action_project: u16 = 5;

const bridge_action_health: u16 = 101;
const bridge_action_open_manuscript: u16 = 102;
const bridge_action_text_event: u16 = 103;
const bridge_action_viewport: u16 = 104;
const bridge_action_undo: u16 = 105;
const bridge_action_project: u16 = 106;

const rust_input_set_selection: u16 = 1;
const rust_input_insert_text: u16 = 2;
const rust_input_delete_backward: u16 = 3;
const rust_input_delete_forward: u16 = 4;
const rust_input_delete_word_backward: u16 = 5;
const rust_input_delete_word_forward: u16 = 6;
const rust_input_clear: u16 = 7;
const rust_input_move_caret: u16 = 8;
const rust_input_set_composition: u16 = 9;
const rust_input_commit_composition: u16 = 10;
const rust_input_cancel_composition: u16 = 11;
const rust_input_undo: u16 = 12;

const event_insert_text: u16 = 1;
const event_delete_backward: u16 = 2;
const event_delete_forward: u16 = 3;
const event_delete_word_backward: u16 = 4;
const event_delete_word_forward: u16 = 5;
const event_clear: u16 = 6;
const event_move_caret: u16 = 7;
const event_set_selection: u16 = 8;
const event_set_composition: u16 = 9;
const event_commit_composition: u16 = 10;
const event_cancel_composition: u16 = 11;

var projection: protocol.RefrainNativeResponse = undefined;
var has_projection = false;
var composed_projection_text: [protocol.projection_bytes + protocol.event_text_bytes]u8 = undefined;

pub const DocumentView = struct {
    text: []const u8,
    window_start: u64,
    window_end: u64,
    first_block: u64,
    block_count: u32,
    selection: ?native_sdk.canvas.TextSelection,
    composition: ?native_sdk.canvas.TextRange,
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

/// Return the latest immutable Rust projection. Preedit bytes are materialized
/// only for this render; commit is the only input that changes manuscript bytes.
pub fn documentView() DocumentView {
    if (!has_projection) return emptyDocumentView();
    const source_len = @min(@as(usize, projection.text_len), projection.text.len);
    const source = projection.text[0..source_len];
    const window_start = projection.window_start;
    const window_end = window_start +| @as(u64, @intCast(source.len));
    const selection: native_sdk.canvas.TextSelection = .{
        .anchor = localOffset(projection.selection_anchor, window_start, source.len),
        .focus = localOffset(projection.selection_focus, window_start, source.len),
    };
    const base: DocumentView = .{
        .text = source,
        .window_start = window_start,
        .window_end = window_end,
        .first_block = projection.first_block,
        .block_count = projection.block_count,
        .selection = selection,
        .composition = null,
    };

    const composition_len = @min(@as(usize, projection.composition_len), projection.composition.len);
    if (composition_len == 0 or
        projection.composition_start < window_start or
        projection.composition_end < projection.composition_start or
        projection.composition_end > window_end or
        projection.composition_cursor > composition_len)
    {
        return base;
    }

    const range_start = localOffset(projection.composition_start, window_start, source.len);
    const range_end = localOffset(projection.composition_end, window_start, source.len);
    const composition = projection.composition[0..composition_len];
    if (!std.unicode.utf8ValidateSlice(composition) or
        !isUtf8Boundary(source, range_start) or
        !isUtf8Boundary(source, range_end) or
        !isUtf8Boundary(composition, @intCast(projection.composition_cursor)))
    {
        return base;
    }

    var cursor: usize = 0;
    @memcpy(composed_projection_text[cursor .. cursor + range_start], source[0..range_start]);
    cursor += range_start;
    @memcpy(composed_projection_text[cursor .. cursor + composition.len], composition);
    cursor += composition.len;
    @memcpy(composed_projection_text[cursor .. cursor + source.len - range_end], source[range_end..]);
    cursor += source.len - range_end;
    const composition_start = range_start;
    const composition_end = composition_start + composition.len;
    return .{
        .text = composed_projection_text[0..cursor],
        .window_start = window_start,
        .window_end = window_end,
        .first_block = projection.first_block,
        .block_count = projection.block_count,
        .selection = native_sdk.canvas.TextSelection.collapsed(
            composition_start + @as(usize, @intCast(projection.composition_cursor)),
        ),
        .composition = native_sdk.canvas.TextRange.init(composition_start, composition_end),
    };
}

fn emptyDocumentView() DocumentView {
    return .{
        .text = &.{},
        .window_start = 0,
        .window_end = 0,
        .first_block = 0,
        .block_count = 0,
        .selection = null,
        .composition = null,
    };
}

fn localOffset(absolute: u64, window_start: u64, text_len: usize) usize {
    if (absolute <= window_start) return 0;
    const delta = std.math.cast(usize, absolute - window_start) orelse return text_len;
    return @min(delta, text_len);
}

fn isUtf8Boundary(text: []const u8, offset: usize) bool {
    return offset <= text.len and (offset == text.len or text[offset] & 0xc0 != 0x80);
}

const host_record_text_length_offset: usize = 80;
const host_record_text_offset: usize = 84;
const host_record_tail_bytes: usize = 24;
const max_safe_integer: f64 = 9007199254740991.0;

const DecodedBridgeRequest = struct {
    request: protocol.RefrainNativeRequest,
    scroll_offset_y: f64,
};

fn decodeBridgeRequest(bytes: []const u8) ?DecodedBridgeRequest {
    if (bytes.len < host_record_text_offset + host_record_tail_bytes) return null;
    const text_len: usize = @intCast(std.mem.readInt(u32, bytes[host_record_text_length_offset..host_record_text_offset], .little));
    if (text_len > protocol.event_text_bytes) return null;
    const tail = host_record_text_offset + text_len;
    if (bytes.len != tail + host_record_tail_bytes) return null;
    var request_value: protocol.RefrainNativeRequest = .{
        .protocol_version = wholeU16(readF64(bytes, 48)) orelse return null,
        .action = wholeU16(readF64(bytes, 0)) orelse return null,
        .input = wholeU16(readF64(bytes, 40)) orelse return null,
        .flags = wholeU16(readF64(bytes, 24)) orelse return null,
        .session = wholeU64(readF64(bytes, 72)) orelse return null,
        .revision = wholeU64(readF64(bytes, 56)) orelse return null,
        .window_start = wholeU64(readF64(bytes, tail + 16)) orelse return null,
        .anchor = wholeU64(readF64(bytes, 8)) orelse return null,
        .focus = wholeU64(readF64(bytes, 32)) orelse return null,
        .cursor = wholeU64(readF64(bytes, 16)) orelse return null,
        .viewport_first_block = wholeU64(readF64(bytes, tail + 8)) orelse return null,
        .viewport_block_count = wholeU32(readF64(bytes, tail)) orelse return null,
        .text_len = @intCast(text_len),
        .text = @splat(0),
    };
    @memcpy(request_value.text[0..text_len], bytes[host_record_text_offset..tail]);
    const scroll_offset_y = readF64(bytes, 64);
    if (!std.math.isFinite(scroll_offset_y)) return null;
    return .{ .request = request_value, .scroll_offset_y = scroll_offset_y };
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

fn viewportFirstBlock(scroll_offset_y: f64, block_count: u32) ?u64 {
    if (scroll_offset_y < 0 or !has_projection) return 0;
    if (projection.total_blocks > std.math.maxInt(u32)) return null;
    const visible = @min(@as(u64, block_count), projection.total_blocks);
    const max_first = projection.total_blocks - visible;
    const projected = @floor(scroll_offset_y / protocol.virtual_block_height);
    if (projected <= 0) return 0;
    if (projected >= @as(f64, @floatFromInt(max_first))) return max_first;
    return @intFromFloat(projected);
}

fn translateRequest(request_value: *protocol.RefrainNativeRequest, scroll_offset_y: f64) bool {
    switch (request_value.action) {
        bridge_action_health => {
            if (request_value.input != 0 or request_value.text_len != 0) return false;
            request_value.action = rust_action_health;
        },
        bridge_action_open_manuscript => {
            if (request_value.input != 0 or request_value.text_len != 0) return false;
            request_value.action = rust_action_open_manuscript;
        },
        bridge_action_viewport => {
            if (request_value.input != 0 or request_value.text_len != 0) return false;
            request_value.viewport_first_block = viewportFirstBlock(
                scroll_offset_y,
                request_value.viewport_block_count,
            ) orelse return false;
            request_value.action = rust_action_obtain_projection;
        },
        bridge_action_undo => {
            if (request_value.input != 0 or request_value.text_len != 0) return false;
            request_value.action = rust_action_apply_input;
            request_value.input = rust_input_undo;
        },
        bridge_action_text_event => {
            request_value.action = rust_action_apply_input;
            request_value.input = switch (request_value.input) {
                event_insert_text => rust_input_insert_text,
                event_delete_backward => rust_input_delete_backward,
                event_delete_forward => rust_input_delete_forward,
                event_delete_word_backward => rust_input_delete_word_backward,
                event_delete_word_forward => rust_input_delete_word_forward,
                event_clear => rust_input_clear,
                event_move_caret => rust_input_move_caret,
                event_set_selection => rust_input_set_selection,
                event_set_composition => rust_input_set_composition,
                event_commit_composition => rust_input_commit_composition,
                event_cancel_composition => rust_input_cancel_composition,
                else => return false,
            };
            if (request_value.input != rust_input_insert_text and
                request_value.input != rust_input_set_composition and
                request_value.text_len != 0)
            {
                return false;
            }
            if (request_value.input == rust_input_move_caret) {
                const direction = request_value.flags & 0xff;
                if (direction < 1 or direction > 6 or request_value.flags & ~@as(u16, 0x1ff) != 0) {
                    return false;
                }
            } else if (request_value.flags != 0) {
                return false;
            }
        },
        bridge_action_project => {
            if (request_value.input != 0 or request_value.flags != 0) return false;
            request_value.action = rust_action_project;
        },
        else => return false,
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
                const action = if (payload.len >= 8) wholeU16(readF64(payload, 0)) orelse 0 else 0;
                feed(effects, key, false, &protocol.encodeProtocolError(.invalid_request, action));
                return;
            };
            var request_value = decoded.request;
            const bridge_action = request_value.action;
            if (!translateRequest(&request_value, decoded.scroll_offset_y)) {
                feed(effects, key, false, &protocol.encodeProtocolError(.invalid_request, bridge_action));
                return;
            }
            var result = refrain_native_dispatch(request_value);
            if (result.status == 0 and updatesDocumentProjection(bridge_action)) {
                projection = result;
                has_projection = true;
            }
            result.action = bridge_action;
            if (bridge_action != bridge_action_project) result.text_len = 0;
            const encoded = protocol.encodeDispatchResponse(result);
            feed(
                effects,
                key,
                result.status == 0,
                encoded[0..protocol.encodedResponseLen(result)],
            );
        }

        fn feed(effects: *Effects, key: u64, ok: bool, bytes: []const u8) void {
            effects.feedHostResult(key, ok, bytes) catch unreachable;
        }
    };
}

fn updatesDocumentProjection(action: u16) bool {
    return action == bridge_action_open_manuscript or
        action == bridge_action_text_event or
        action == bridge_action_viewport or
        action == bridge_action_undo;
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

const empty_host_record_bytes: usize = host_record_text_offset + host_record_tail_bytes;

fn request(action: u16) [empty_host_record_bytes]u8 {
    var out: [empty_host_record_bytes]u8 = @splat(0);
    writeF64(&out, 0, @floatFromInt(action));
    writeF64(&out, 48, @floatFromInt(protocol.protocol_version));
    writeF64(&out, host_record_text_offset, @floatFromInt(protocol.default_viewport_blocks));
    return out;
}

fn writeF64(bytes: []u8, offset: usize, value: f64) void {
    std.mem.writeInt(u64, bytes[offset..][0..8], @bitCast(value), .little);
}

test "one dispatch health request crosses the Rust ABI" {
    var effects: StubEffects = .{};
    bind(&effects);
    const payload = request(bridge_action_health);
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
    projection = protocol.emptyResponse(rust_action_obtain_projection);
    projection.revision = 77;
    has_projection = true;

    const input = "{\"kind\":\"notAProjectInput\"}";
    var payload: [host_record_text_offset + input.len + host_record_tail_bytes]u8 = @splat(0);
    writeF64(&payload, 0, @floatFromInt(bridge_action_project));
    writeF64(&payload, 48, @floatFromInt(protocol.protocol_version));
    std.mem.writeInt(u32, payload[host_record_text_length_offset..host_record_text_offset], @intCast(input.len), .little);
    @memcpy(payload[host_record_text_offset..][0..input.len], input);
    writeF64(
        &payload,
        host_record_text_offset + input.len,
        @floatFromInt(protocol.default_viewport_blocks),
    );
    call(&effects, 71, &payload);

    try std.testing.expect(!effects.response_ok);
    const response = effects.response[0..effects.response_len];
    try std.testing.expect(response.len > protocol.response_header_bytes);
    try std.testing.expectEqual(bridge_action_project, std.mem.readInt(u16, response[6..8], .little));
    const text_len = std.mem.readInt(u32, response[48..52], .little);
    try std.testing.expectEqual(response.len, protocol.response_header_bytes + @as(usize, text_len));
    try std.testing.expect(std.mem.startsWith(u8, response[protocol.response_header_bytes..], "decode the project input"));
    try std.testing.expectEqual(@as(u64, 77), projection.revision);
}

test "open keeps the 11.4 MiB source in Rust and returns the requested block viewport" {
    var effects: StubEffects = .{};
    bind(&effects);
    const payload = request(bridge_action_open_manuscript);
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

test "scroll offset selects the bounded Rust block projection" {
    var effects: StubEffects = .{};
    bind(&effects);
    var payload = request(bridge_action_open_manuscript);
    call(&effects, 8, &payload);
    try std.testing.expect(effects.response_ok);

    payload = request(bridge_action_viewport);
    writeF64(&payload, 56, @floatFromInt(projection.revision));
    writeF64(&payload, 64, 1_800_000);
    writeF64(&payload, 72, @floatFromInt(projection.session));
    call(&effects, 9, &payload);
    try std.testing.expect(effects.response_ok);
    try std.testing.expectEqual(@as(u64, 50_000), projection.first_block);
    try std.testing.expect(projection.window_start > 0);

    writeF64(&payload, 64, 3_600_000);
    call(&effects, 10, &payload);
    try std.testing.expect(effects.response_ok);
    try std.testing.expectEqual(@as(u64, 99_904), projection.first_block);
    try std.testing.expectEqual(@as(u32, 96), projection.block_count);
}

test "document view maps a reversed cross-block selection into projection offsets" {
    projection = protocol.emptyResponse(rust_action_obtain_projection);
    projection.window_start = 100;
    projection.first_block = 10;
    projection.block_count = 2;
    const source = "aa\n\nbb";
    projection.text_len = source.len;
    @memcpy(projection.text[0..source.len], source);
    projection.selection_anchor = 106;
    projection.selection_focus = 101;
    has_projection = true;

    const view = documentView();
    try std.testing.expectEqualStrings(source, view.text);
    try std.testing.expectEqual(@as(u64, 10), view.first_block);
    try std.testing.expectEqualDeep(
        native_sdk.canvas.TextSelection{ .anchor = 6, .focus = 1 },
        view.selection.?,
    );
    try std.testing.expect(view.composition == null);
}

test "document view synthesizes bounded preedit bytes from the Rust composition" {
    projection = protocol.emptyResponse(rust_action_apply_input);
    projection.window_start = 100;
    const source = "abcDEFghi";
    projection.text_len = source.len;
    @memcpy(projection.text[0..source.len], source);
    const preedit = "中文";
    projection.composition_len = preedit.len;
    @memcpy(projection.composition[0..preedit.len], preedit);
    projection.composition_start = 103;
    projection.composition_end = 106;
    projection.composition_cursor = 3;
    has_projection = true;

    const view = documentView();
    try std.testing.expectEqualStrings("abc中文ghi", view.text);
    try std.testing.expectEqualDeep(native_sdk.canvas.TextSelection.collapsed(6), view.selection.?);
    try std.testing.expectEqualDeep(native_sdk.canvas.TextRange.init(3, 9), view.composition.?);
    try std.testing.expectEqual(@as(u64, 109), view.window_end);
}

test "bridge translates SDK event tags into the distinct Rust input vocabulary" {
    var input = std.mem.zeroes(protocol.RefrainNativeRequest);
    input.action = bridge_action_text_event;
    input.input = event_set_selection;
    try std.testing.expect(translateRequest(&input, 0.0));
    try std.testing.expectEqual(rust_action_apply_input, input.action);
    try std.testing.expectEqual(rust_input_set_selection, input.input);
    try std.testing.expect(event_set_selection != rust_input_set_selection);

    var undo = std.mem.zeroes(protocol.RefrainNativeRequest);
    undo.action = bridge_action_undo;
    try std.testing.expect(translateRequest(&undo, 0.0));
    try std.testing.expectEqual(rust_action_apply_input, undo.action);
    try std.testing.expectEqual(rust_input_undo, undo.input);

    var project_input = std.mem.zeroes(protocol.RefrainNativeRequest);
    project_input.action = bridge_action_project;
    project_input.text_len = 2;
    project_input.text[0] = '{';
    project_input.text[1] = '}';
    try std.testing.expect(translateRequest(&project_input, 0.0));
    try std.testing.expectEqual(rust_action_project, project_input.action);
    try std.testing.expect(!updatesDocumentProjection(bridge_action_project));
}

test "protocol mismatch, malformed, and unknown service requests remain typed failures" {
    var effects: StubEffects = .{};
    bind(&effects);
    var payload = request(bridge_action_health);
    writeF64(&payload, 48, @floatFromInt(protocol.protocol_version + 1));
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
