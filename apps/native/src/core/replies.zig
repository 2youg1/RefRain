//! 项目答复的落脚处：一段线上字节活过它到达的那一次调用。
//!
//! **为什么必须有这一层**：`EffectHostResult.bytes` 只在 `update` 的那一次调用里
//! 有效——SDK 借的是自己的收包缓冲。而界面下一帧还要画那份名录，`verdict_accept`
//! 下一次按键还要问「游标那一行是哪条提案」。所以答复必须被搬进模块生命周期的
//! 缓冲，与 `host_bridge.zig` 把正稿投影搬进 `projection_text` 是同一条纪律、
//! 同一个理由。
//!
//! **它不是为了被删而存在的**（Handoff §7 的疑问在这里作答）。单元 11 换掉的是
//! **格式**——JSON 变成 typed rows，`snapshot.zig` 的解析随之消失；但「线上字节
//! 要活过这次调用」这件事不因格式而改变，届时改的是本模块存的是什么，不是它存
//! 不存在。因此现在建它不是造一个将死之物。
//!
//! **为什么分七个槽**：台上同时要看块清单、Run 名录与预览清单，而它们共用同一条
//! 通道。一个槽会让「读一次设置」把块清单冲掉——作者看到的是一个自己会清空的
//! 面板。槽由答复自己的 `kind` 认，不由发请求的那一方记账：记账要求请求与答复
//! 一一对应，而链式重读（判后重读名录、送出后重读快照）打破了那个对应。
//!
//! **唯一权威**：`Model` 不持这些切片。持了就有两份「最近一条答复是什么」，而
//! 它们只在同一次 `update` 里同步——一次漏改就是画面停在上一条答复上。
//!
//! 规格：`RefRain-work/main+SPEC.md` §7 的后续批次（12e）。

const std = @import("std");
const protocol = @import("../generated/protocol.zig");
const snapshot = @import("../snapshot.zig");

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

/// 每槽一份，容量即协议对一次答复文本的上界。答复超上界时 Rust 已经具名拒绝，
/// 所以这里装不下等同于收到一段坏答复——按空槽处理，不截半段 JSON 出来。
var storage: [slot_count][protocol.projection_bytes]u8 = undefined;
var lengths: [slot_count]usize = @splat(0);

/// 一条答复按它自称的种类落槽。
///
/// 名字是 Rust `ProjectOutput` 的 serde 标签，与 `core.ts` 的那张常量表同源；
/// `verify:native-snapshot-fields` 守着两侧不漂开。
pub fn slotForKind(kind: []const u8) Slot {
    if (std.mem.eql(u8, kind, "config")) return .config;
    if (std.mem.eql(u8, kind, "host")) return .host;
    if (std.mem.eql(u8, kind, "dispatchPreview")) return .preview;
    if (std.mem.eql(u8, kind, "documentBlocks")) return .blocks;
    if (std.mem.eql(u8, kind, "materials")) return .materials;
    if (std.mem.eql(u8, kind, "materialDrafts")) return .material_drafts;
    return .project;
}

/// 收下一条答复。返回落进模块缓冲之后的那一段——调用方此后借它，不借线上字节。
pub fn store(slot: Slot, bytes: []const u8) []const u8 {
    const index = @intFromEnum(slot);
    if (bytes.len > protocol.projection_bytes) {
        lengths[index] = 0;
        return "";
    }
    @memcpy(storage[index][0..bytes.len], bytes);
    lengths[index] = bytes.len;
    return storage[index][0..bytes.len];
}

/// 借这一槽最近一条答复。没有过就是空——空名录与「还没问过」在界面上同形，
/// 都是「这里现在没有行」。
pub fn borrow(slot: Slot) []const u8 {
    const index = @intFromEnum(slot);
    return storage[index][0..lengths[index]];
}

pub fn clear(slot: Slot) void {
    lengths[@intFromEnum(slot)] = 0;
}

/// 全部清空。换项目与测试用；生产路径上只有换稿会清个别槽。
pub fn clearAll() void {
    lengths = @splat(0);
}

/// 这一槽的答复是不是提案名录。裁决台的每一次「游标那一行是谁」都先问它。
///
/// 行本身怎么读归 `project_view.zig`（`proposalAt`／`proposalCount`）——那是
/// 「一行提案长什么样」的唯一权威，本模块只回答「最近一条答复是不是那种」。
pub fn isProposals() bool {
    return std.mem.eql(u8, snapshot.kind(borrow(.project)), "proposals");
}

/// 提案名录的载荷。`project_view` 的读行函数吃的是它，不是整条答复。
pub fn proposalListing() snapshot.Value {
    if (!isProposals()) return "";
    return snapshot.value(borrow(.project));
}

// ------------------------------------------------------------------ 测试

const testing = std.testing;

test "一条答复按自己的种类落槽，互不冲掉" {
    clearAll();
    _ = store(slotForKind("config"), "{\"kind\":\"config\",\"value\":{}}");
    _ = store(slotForKind("documentBlocks"), "{\"kind\":\"documentBlocks\",\"value\":{}}");
    // 读一次设置不该把块清单冲掉——这正是分槽的理由。
    try testing.expectEqualStrings("config", snapshot.kind(borrow(.config)));
    try testing.expectEqualStrings("documentBlocks", snapshot.kind(borrow(.blocks)));
    // 没落过的槽是空，而不是上一槽的内容。
    try testing.expectEqualStrings("", borrow(.materials));
}

test "落槽之后借的是模块缓冲，不是原来的那段字节" {
    clearAll();
    var wire: [64]u8 = @splat('x');
    const source = "{\"kind\":\"host\",\"value\":{}}";
    @memcpy(wire[0..source.len], source);
    const kept = store(.host, wire[0..source.len]);
    // 线上字节被覆盖之后，借到的仍然是落槽时的内容。
    @memset(&wire, 0);
    try testing.expectEqualStrings(source, kept);
    try testing.expectEqualStrings(source, borrow(.host));
}

test "提案名录的载荷交给读行的那一方，换了名录就交出空" {
    clearAll();
    _ = store(.project,
        \\{"kind":"proposals","value":{"proposals":[{"id":"p-1","afterText":"甲"},{"id":"p-2"}],"staged":[]}}
    );
    try testing.expect(isProposals());
    const project_view = @import("../project_view.zig");
    try testing.expectEqualStrings("p-1", project_view.proposalAt(proposalListing(), 0).?.id);
    // 越界不是「最后一行」：把没有那么多行读成最后一行会让裁决落在别人身上。
    try testing.expect(project_view.proposalAt(proposalListing(), 2) == null);

    // 换成别的名录之后，裁决台的问题一律交出空，而不是在错的表里数行。
    _ = store(.project, "{\"kind\":\"documents\",\"value\":{}}");
    try testing.expect(!isProposals());
    try testing.expectEqualStrings("", proposalListing());
    try testing.expect(project_view.proposalAt(proposalListing(), 0) == null);
}

test "超上界的答复按空槽处理，不留半段 JSON" {
    clearAll();
    const long = [_]u8{'x'} ** (protocol.projection_bytes + 1);
    _ = store(.project, &long);
    try testing.expectEqualStrings("", borrow(.project));
}
