//! 项目答复的落脚处：一段线上字节活过它到达的那一次调用。
//!
//! **为什么必须有这一层**：`EffectHostResult.bytes` 只在 `update` 的那一次调用里
//! 有效——SDK 借的是自己的收包缓冲。而界面下一帧还要画那份名录，`verdict_accept`
//! 下一次按键还要问「游标那一行是哪条提案」。所以答复必须被搬进模块生命周期的
//! 缓冲，与 `host_bridge.zig` 把正稿投影搬进 `projection_text` 是同一条纪律、
//! 同一个理由。
//!
//! **单元 11 之后它存的是什么变了，它本身没变**：以前是一段 JSON，现在是
//! `generated/wire.zig` 的定长头 + 定长行 + 尾部字节。缓冲因此声明成 `align(4)`
//! ——行是 `extern struct`，对不齐就取不出切片。
//!
//! **为什么分七个槽**：台上同时要看块清单、Run 名录与预览清单，而它们共用同一条
//! 通道。一个槽会让「读一次设置」把块清单冲掉——作者看到的是一个自己会清空的
//! 面板。槽由答复自己的种类认，不由发请求的那一方记账：记账要求请求与答复
//! 一一对应，而链式重读（判后重读名录、送出后重读快照）打破了那个对应。
//!
//! **唯一权威**：`Model` 不持这些切片。持了就有两份「最近一条答复是什么」，而
//! 它们只在同一次 `update` 里同步——一次漏改就是画面停在上一条答复上。

const std = @import("std");
const protocol = @import("../generated/protocol.zig");
const wire = @import("../generated/wire.zig");

/// 一条答复该落哪个槽。
pub const Slot = enum {
    /// 多数屏共用的最近一条答复：文件树、提案名录、信箱、连接、搜索命中。
    project,
    /// 设置答复。排版三值与面板材质只在它里面出现。
    config,
    /// 编排快照（Run 名录与等待队列）。
    host,
    /// 派发预览。送出成功后清槽——这次预览已被消费，再送必须重新预览。
    preview,
    /// 派发台的块清单（当前一页）。
    blocks,
    /// 材料名录。
    materials,
    /// 材料草稿名录。
    material_drafts,
};

const slot_count = @typeInfo(Slot).@"enum".fields.len;

/// 每槽一份，容量即协议对一次答复的上界。答复超上界时 Rust 已经具名拒绝，
/// 所以这里装不下等同于收到一段坏答复——按空槽处理，不留半条记录。
///
/// `align(4)`：行是 `extern struct`，`Reply.rows` 按对齐取切片。
var storage: [slot_count][protocol.projection_bytes]u8 align(4) = undefined;
var lengths: [slot_count]usize = @splat(0);

/// 一条答复按它自称的种类落槽。
///
/// 种类是生成的枚举（`wire.Kind`），不再是一个字符串——认错种类因此不再可能，
/// 而新增一种答复只改 `protocol/host.json` 一处。
pub fn slotForKind(kind: wire.Kind) Slot {
    return switch (kind) {
        .config => .config,
        .host => .host,
        .dispatch_preview => .preview,
        .document_blocks => .blocks,
        .materials => .materials,
        .material_drafts => .material_drafts,
        else => .project,
    };
}

/// 收下一条答复。返回落进模块缓冲之后的那一份——调用方此后借它，不借线上字节。
pub fn store(slot: Slot, bytes: []const u8) wire.Reply {
    const index = @intFromEnum(slot);
    if (bytes.len > protocol.projection_bytes) {
        lengths[index] = 0;
        return wire.Reply.empty;
    }
    @memcpy(storage[index][0..bytes.len], bytes);
    lengths[index] = bytes.len;
    return borrow(slot);
}

/// 借这一槽最近一条答复。没有过就是空——空名录与「还没问过」在界面上同形，
/// 都是「这里现在没有行」。
pub fn borrow(slot: Slot) wire.Reply {
    const index = @intFromEnum(slot);
    return .{ .bytes = storage[index][0..lengths[index]] };
}

pub fn clear(slot: Slot) void {
    lengths[@intFromEnum(slot)] = 0;
}

/// 全部清空。换项目与测试用；生产路径上只有换稿会清个别槽。
pub fn clearAll() void {
    lengths = @splat(0);
}

/// 提案名录的头。裁决台的每一次「游标那一行是谁」都先问它。
///
/// 不是提案名录就交出 null：换了名录之后裁决台的问题一律交出空，而不是在错的
/// 表里数行——在错的表里数出来的那一行，作者按下去会判到别人身上。
pub fn proposals() ?*const wire.ProposalsHead {
    return borrow(.project).head(.proposals);
}

// ------------------------------------------------------------------ 测试

const testing = std.testing;

/// 一条只有头的答复，测试用。
fn encoded(comptime kind: wire.Kind, head: wire.headType(kind)) [128]u8 {
    var bytes: [128]u8 = @splat(0);
    const header = wire.Header{
        .magic = wire.magic,
        .kind = @intFromEnum(kind),
        .bytes = @sizeOf(wire.Header) + @sizeOf(@TypeOf(head)),
    };
    @memcpy(bytes[0..@sizeOf(wire.Header)], std.mem.asBytes(&header));
    @memcpy(bytes[@sizeOf(wire.Header)..][0..@sizeOf(@TypeOf(head))], std.mem.asBytes(&head));
    return bytes;
}

test "一条答复按自己的种类落槽，互不冲掉" {
    clearAll();
    const config = encoded(.config, .{});
    const blocks = encoded(.document_blocks, .{});
    _ = store(slotForKind(.config), config[0 .. @sizeOf(wire.Header) + @sizeOf(wire.ConfigHead)]);
    _ = store(slotForKind(.document_blocks), blocks[0 .. @sizeOf(wire.Header) + @sizeOf(wire.DocumentBlocksHead)]);
    // 读一次设置不该把块清单冲掉——这正是分槽的理由。
    try testing.expectEqual(wire.Kind.config, borrow(.config).kind());
    try testing.expectEqual(wire.Kind.document_blocks, borrow(.blocks).kind());
    // 没落过的槽是空，而不是上一槽的内容。
    try testing.expectEqual(wire.Kind.none, borrow(.materials).kind());
}

test "落槽之后借的是模块缓冲，不是原来的那段字节" {
    clearAll();
    var source = encoded(.host, .{ .run_total = 7 });
    const len = @sizeOf(wire.Header) + @sizeOf(wire.HostHead);
    const kept = store(.host, source[0..len]);
    // 线上字节被覆盖之后，借到的仍然是落槽时的内容。
    @memset(&source, 0);
    try testing.expectEqual(wire.Kind.host, kept.kind());
    try testing.expectEqual(@as(u32, 7), borrow(.host).head(.host).?.run_total);
}

test "换了名录之后裁决台的问题交出空，而不是在错的表里数行" {
    clearAll();
    const listing = encoded(.proposals, .{ .staged_count = 3 });
    _ = store(.project, listing[0 .. @sizeOf(wire.Header) + @sizeOf(wire.ProposalsHead)]);
    try testing.expectEqual(@as(u32, 3), proposals().?.staged_count);

    const documents = encoded(.documents, .{});
    _ = store(.project, documents[0 .. @sizeOf(wire.Header) + @sizeOf(wire.DocumentsHead)]);
    try testing.expect(proposals() == null);
}

test "超上界的答复按空槽处理，不留半条记录" {
    clearAll();
    const long = [_]u8{'x'} ** (protocol.projection_bytes + 1);
    _ = store(.project, &long);
    try testing.expectEqual(wire.Kind.none, borrow(.project).kind());
}

test "写坏的字节读成空，而不是某一种答复的空形态" {
    clearAll();
    // 魔数对不上：这段不是一条答复，说出来比装成一份空名录安全。
    var bytes: [32]u8 = @splat(0);
    _ = store(.project, &bytes);
    try testing.expectEqual(wire.Kind.none, borrow(.project).kind());
    // 头自称的长度超过实际收到的字节：同样拒绝，否则每一个 `Str` 都可能越界。
    const header = wire.Header{ .magic = wire.magic, .kind = 2, .bytes = 4096 };
    @memcpy(bytes[0..@sizeOf(wire.Header)], std.mem.asBytes(&header));
    _ = store(.project, &bytes);
    try testing.expectEqual(wire.Kind.none, borrow(.project).kind());
}
