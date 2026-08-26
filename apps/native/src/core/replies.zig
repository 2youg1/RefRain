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
///
/// v0.3.4 之前文件树、提案、信箱、连接、历史、搜索六种名录共挤 `.project`
/// 一个槽：点一次「重新探测」，文件树就被探测答复冲成空白——作者读到的是
/// 「打不开任何文档」。现在每张常驻名录各有自己的槽，互不冲掉。
pub const Slot = enum {
    /// 文件树：打开项目（`.opened`）与翻页（`.page`）的文档名录。
    documents,
    /// 搜索命中：找正文（`.blocks`）与找文档（`.documents`）。两种 kind 都
    /// 只由搜索产出（`project_wire.rs` 各只有一个产地），所以它们不会把
    /// 树冲掉，只会互相接替——那正是搜索框的语义。
    search,
    /// 本机 Harness 探测名录。
    harnesses,
    /// 信箱名录（含回收站页签的投影）。
    mailbox,
    /// 改动记录名录。
    history,
    /// 提案名录。裁决台与正文印点都读它。
    proposals,
    /// 批注名录（裁决台的另一半）。
    annotations,
    /// 其余答复的落脚处：各类回执（判词、送出、收取、删除……）。
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
///
/// **为什么十四个槽一样大，而不是各按各的最大行数定容**（审计项 O-03，量过之后
/// 撤回）：一个槽的最大值不是它的行数，是它的行数**加上那些行指向的文本**，而
/// 每一种答复的文本都是变长的——目录的路径、失败原因、Agent 名录、预览的清单，
/// 没有一处有比 ABI 上界更小的具名上界。把某个槽收窄到那个上界以下，代价是一条
/// 合法答复被 `store` 按坏答复丢掉，而作者看到的是那一屏空白。
///
/// 省下的那 500 KB 也不是省在工作集上：这块存储是 `undefined`，落 .bss，按页
/// 惰性提交，没收到过大答复的槽从来不触碰它的页。
///
/// 真要缩，缩的不是每个槽的尺寸，是「十四个槽各留一份满额缓冲」这个形状——
/// 一块共享存储加每槽一个世代。那是另一个设计，不是给这一个改尺寸。下面那条
/// 测试把这段判断钉住：任何一个槽被收窄，它就红。
var storage: [slot_count][protocol.projection_bytes]u8 align(4) = undefined;
var lengths: [slot_count]usize = @splat(0);

/// 一条答复按它自称的种类落槽。
///
/// 种类是生成的枚举（`wire.Kind`），不再是一个字符串——认错种类因此不再可能，
/// 而新增一种答复只改 `protocol/host.json` 一处。
pub fn slotForKind(kind: wire.Kind) Slot {
    return switch (kind) {
        .opened, .page => .documents,
        // kind `.blocks` 是搜索的正文命中；槽 `.blocks` 装的是派发台的块清单
        // （kind `.document_blocks`）。同名不同物，路由在这一处分开。
        .blocks, .documents => .search,
        .harnesses => .harnesses,
        .mailbox => .mailbox,
        .history => .history,
        .proposals => .proposals,
        .annotations => .annotations,
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
    return borrow(.proposals).head(.proposals);
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

test "提案住自己的槽，别的答复冲不掉它" {
    clearAll();
    const listing = encoded(.proposals, .{ .staged_count = 3 });
    _ = store(slotForKind(.proposals), listing[0 .. @sizeOf(wire.Header) + @sizeOf(wire.ProposalsHead)]);
    try testing.expectEqual(@as(u32, 3), proposals().?.staged_count);

    // 搜索答复落搜索槽，提案名录原封不动——旧形下这一下会把裁决台清空。
    const documents = encoded(.documents, .{});
    _ = store(slotForKind(.documents), documents[0 .. @sizeOf(wire.Header) + @sizeOf(wire.DocumentsHead)]);
    try testing.expectEqual(@as(u32, 3), proposals().?.staged_count);
    try testing.expectEqual(wire.Kind.documents, borrow(.search).kind());
}

test "六张常驻名录各有自己的槽，探测冲不掉文件树" {
    clearAll();
    const opened = encoded(.opened, .{});
    _ = store(slotForKind(.opened), opened[0 .. @sizeOf(wire.Header) + @sizeOf(wire.OpenedHead)]);
    const probed = encoded(.harnesses, .{});
    _ = store(slotForKind(.harnesses), probed[0 .. @sizeOf(wire.Header) + @sizeOf(wire.HarnessesHead)]);
    // 探测之后树还在——这正是 v0.3.4 作者报的「打不开任何文档」的根因。
    try testing.expectEqual(wire.Kind.opened, borrow(.documents).kind());
    try testing.expectEqual(wire.Kind.harnesses, borrow(.harnesses).kind());
    // 翻页答复接替打开答复：同一张树的两种形状同一个槽。
    const paged = encoded(.page, .{});
    _ = store(slotForKind(.page), paged[0 .. @sizeOf(wire.Header) + @sizeOf(wire.PageHead)]);
    try testing.expectEqual(wire.Kind.page, borrow(.documents).kind());
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

test "十四个槽各自装得下一条满额答复" {
    // O-03 的裁断以可执行的形式留在这里：每一个槽都必须能收下 ABI 上界那么大
    // 的一条答复，因为每一种答复的文本都只受那一个上界约束。谁把某个槽收窄，
    // 这条测试就红，而不是等某位作者在某一屏上看见空白。
    defer clearAll();
    const full = protocol.projection_bytes;
    var payload: [full]u8 = @splat(0);
    // 一段能被 `Reply` 认出来的头，其余填满：断言比的是容量，不是解析。
    const header = wire.Header{ .magic = wire.magic, .kind = @intFromEnum(wire.Kind.opened), .bytes = full };
    @memcpy(payload[0..@sizeOf(wire.Header)], std.mem.asBytes(&header));

    inline for (@typeInfo(Slot).@"enum".fields) |field| {
        const slot: Slot = @enumFromInt(field.value);
        const stored = store(slot, payload[0..full]);
        try std.testing.expectEqual(@as(usize, full), stored.bytes.len);
    }

    // 而超过上界的一条按坏答复处理：不留半条记录，也不越界写。
    var oversize: [full + 1]u8 = @splat(0);
    const refused = store(.project, oversize[0..]);
    try std.testing.expectEqual(@as(usize, 0), refused.bytes.len);
}
