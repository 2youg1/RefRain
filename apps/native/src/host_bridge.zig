const std = @import("std");
const native_sdk = @import("native_sdk");
const protocol = @import("generated/protocol.zig");

extern fn refrain_native_health(requested_protocol: u16) callconv(.c) protocol.RefrainNativeHealthResult;

/// Bind the one generated host protocol to Native SDK's typed effect channel.
pub fn bind(effects: anytype) void {
    const Effects = @TypeOf(effects.*);
    effects.bindHostCalls(.{
        .context = effects,
        .send_fn = Callbacks(Effects).send,
        .request_fn = Callbacks(Effects).request,
    });
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
            // The synchronous callback runs while the SDK still owns this active key.
            if (!std.mem.eql(u8, name, protocol.health_service)) {
                const response = protocol.encodeHealthError(.unknown_request);
                effects.feedHostResult(key, false, &response) catch unreachable;
                return;
            }
            if (!protocol.isHealthRequest(payload)) {
                const response = protocol.encodeHealthError(.invalid_request);
                effects.feedHostResult(key, false, &response) catch unreachable;
                return;
            }
            const result = refrain_native_health(protocol.healthRequestProtocolVersion(payload));
            const response = protocol.encodeHealthResult(result);
            effects.feedHostResult(key, result.status == 0, &response) catch unreachable;
        }
    };
}

const StubEffects = struct {
    binding: ?native_sdk.HostCallBinding = null,
    response: [64]u8 = @splat(0),
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

test "generated health request crosses refrain-app and the Rust ABI" {
    var effects: StubEffects = .{};
    bind(&effects);
    const request = protocol.healthRequest();
    effects.binding.?.request_fn(
        effects.binding.?.context,
        protocol.health_service,
        7,
        &request,
    );

    try std.testing.expect(effects.response_ok);
    const response = effects.response[0..effects.response_len];
    try std.testing.expect(protocol.isHealthResponse(response));
    try std.testing.expectEqual(protocol.protocol_version, protocol.healthProtocolVersion(response));
    try std.testing.expectEqual(protocol.health_api_version, protocol.healthApiVersion(response));
    try std.testing.expectEqual(protocol.capability_typed_requests, protocol.healthCapabilities(response));
}

test "refrain-app protocol mismatch returns the generated typed error" {
    var effects: StubEffects = .{};
    bind(&effects);
    var request = protocol.healthRequest();
    request[4] +%= 1;
    effects.binding.?.request_fn(
        effects.binding.?.context,
        protocol.health_service,
        8,
        &request,
    );

    try std.testing.expect(!effects.response_ok);
    const response = effects.response[0..effects.response_len];
    try std.testing.expectEqual(protocol.HealthError.protocol_mismatch, protocol.healthError(response).?);
}

test "host contract rejects malformed and unknown requests with distinct errors" {
    var effects: StubEffects = .{};
    bind(&effects);
    const request = protocol.healthRequest();
    effects.binding.?.request_fn(effects.binding.?.context, protocol.health_service, 9, request[0..7]);
    try std.testing.expectEqual(
        protocol.HealthError.invalid_request,
        protocol.healthError(effects.response[0..effects.response_len]).?,
    );

    effects.binding.?.request_fn(effects.binding.?.context, "wrong.host", 10, &request);
    try std.testing.expectEqual(
        protocol.HealthError.unknown_request,
        protocol.healthError(effects.response[0..effects.response_len]).?,
    );
}
