//! 在测试里把一个视图真的建出来，然后问它绑给了谁。
//!
//! **接上哪个功能**：`view/` 这一层的全部断言。这一层有 3,500 多行、含全部
//! 交互绑定，而它此前一条 `test` 都没有——两个已证实的缺陷（文件树行点击绑到
//! 错误文档、Run 进度标签串位）都在这里。
//!
//! **在全局逻辑中负责什么**：只做两件事，视图一件也不做——给一个建在 arena 上
//! 的 `Ui`，以及一条遍历建出来的节点树、按语义标签找行的路。视图函数签名不改，
//! 它们照旧收 `*Adapter.Ui` 与 `*const Model`；测试拿到的是真实的那棵树，
//! 不是一份重写的模拟。
//!
//! **能复用什么**：`Surface.init` 与 `Surface.find` / `Surface.rows`。任何
//! 「第 i 行绑到第 i 行」这一类断言都从这两个口进——`docs/AGENTS.md` 的
//! 「断言作者看到的东西」在这一层的具体形式，就是断言**行与它的动作是同一行**。
//!
//! **为什么 `Ui` 直接 `init` 而不是驱动一个 `UiApp`**：`UiApp` 要窗口、要帧、
//! 要平台事件，而这一层的问题与那些无关；`Ui.init(arena)` 是 SDK 自己给的口
//! （`ui.zig:1577`），建出来的节点树与生产帧里的完全同型。绑定 arena 这件事
//! 由调用方显式做，因为「载荷活多久」正是这一层要断言的东西。

const std = @import("std");
const core = @import("../core.zig");
const project_request = @import("../project_request.zig");

const Adapter = core.App;
const Model = core.Model;
const Msg = core.Msg;
pub const Node = Adapter.Ui.Node;

/// 一次视图构建：一个 arena、一个 `Ui`，以及它建出来的那棵树。
///
/// arena 同时是 SDK 的 build arena 与本次构建的 `project_request` 绑定目标，
/// 与生产帧同一形状：`documentView` 在帧入口绑一次，视图借它。
pub const Surface = struct {
    arena: std.heap.ArenaAllocator,
    ui: Adapter.Ui,

    pub fn init(allocator: std.mem.Allocator) Surface {
        return .{ .arena = std.heap.ArenaAllocator.init(allocator), .ui = undefined };
    }

    /// 开一道构建。`build` 收 `*Adapter.Ui` 与 `*const Model`，与生产同签名。
    pub fn build(
        self: *Surface,
        model: *const Model,
        comptime view: fn (*Adapter.Ui, *const Model) Node,
    ) Node {
        self.ui = Adapter.Ui.init(self.arena.allocator());
        project_request.bindBuildArena(self.arena.allocator());
        defer project_request.bindBuildArena(null);
        return view(&self.ui, model);
    }

    /// 下一道构建复用同一块 arena 而不复位它。
    ///
    /// 这是 SDK 为**开着的菜单**做的事的测试等价：菜单呈现时 SDK 钉住它建自的
    /// arena 世代，于是后续任意多次重建都不动那一份载荷（`ui_app.zig:6317`）。
    /// 复位 arena 会把那一份抹掉，正是被钉住的世代要防的事。
    pub fn rebuildPinned(
        self: *Surface,
        model: *const Model,
        comptime view: fn (*Adapter.Ui, *const Model) Node,
    ) Node {
        return self.build(model, view);
    }

    pub fn deinit(self: *Surface) void {
        self.arena.deinit();
    }
};

/// 树里第一个语义标签等于 `label` 的节点。
pub fn find(node: Node, label: []const u8) ?Node {
    if (std.mem.eql(u8, node.widget.semantics.label, label)) return node;
    for (node.nodes) |child| {
        if (find(child, label)) |found| return found;
    }
    return null;
}

/// 树里每一个带 `role` 的节点，按建树顺序写进 `out`，返回写了几个。
///
/// 顺序即行序：`ui.list` 按它收到的数组顺序建子节点，而那个数组正是视图按
/// 答复的行顺序填的。所以「第 i 个 treeitem」与「答复的第 i 行」是同一行，
/// 这条等式是本模块全部行断言的地基。
pub fn rows(node: Node, role: anytype, out: []Node) usize {
    var written: usize = 0;
    collect(node, role, out, &written);
    return written;
}

fn collect(node: Node, role: anytype, out: []Node, written: *usize) void {
    if (node.widget.semantics.role == role and written.* < out.len) {
        out[written.*] = node;
        written.* += 1;
    }
    for (node.nodes) |child| collect(child, role, out, written);
}

/// 一个 `Msg` 里的请求字节，没有就是空。
///
/// 视图绑上去的动作几乎都是 `project_request` 编出来的一段字节；「这一行绑到
/// 谁」这个问题的答案就在那段字节里。
pub fn requestBytes(msg: ?Msg) []const u8 {
    const found = msg orelse return "";
    return switch (found) {
        .project_request => |bytes| bytes,
        .document_open => |bytes| bytes,
        else => "",
    };
}

const wire = @import("../generated/wire.zig");
const replies = @import("../core/replies.zig");

/// 一份 `.opened` 答复的线上字节：一个 root 加一串文档路径。
///
/// 真实字节由 Rust 发；这里按同一张表（`protocol/host.json` 生成的 `wire.zig`）
/// 拼一份，好让「三十行的文件树」这类装置在测试里存在。装置必须够大：
/// F-01 的触发阈值是可见文档 ≥ 22 份，一份只有三行的装置认证不了任何东西。
pub fn storeOpened(buffer: []u8, root_id: []const u8, paths: []const []const u8) void {
    const head_bytes = @sizeOf(wire.Header) + @sizeOf(wire.OpenedHead);
    @memset(buffer[0..head_bytes], 0);
    var len: usize = head_bytes;

    const put = struct {
        fn text(buf: []u8, at: *usize, value: []const u8) wire.Str {
            if (value.len == 0) return .{};
            const off = at.*;
            @memcpy(buf[off..][0..value.len], value);
            at.* += value.len;
            return .{ .off = @intCast(off), .len = @intCast(value.len) };
        }
    };

    const root = put.text(buffer, &len, root_id);
    var rows_built: [128]wire.DocumentRow = undefined;
    const count = @min(paths.len, rows_built.len);
    for (paths[0..count], 0..) |path, index| {
        rows_built[index] = .{
            .path = put.text(buffer, &len, path),
            .title = put.text(buffer, &len, path),
            .role = .chapter,
        };
    }
    while (len % 4 != 0) : (len += 1) buffer[len] = 0;
    const rows_off = len;
    for (rows_built[0..count]) |row| {
        @memcpy(buffer[len..][0..@sizeOf(wire.DocumentRow)], std.mem.asBytes(&row));
        len += @sizeOf(wire.DocumentRow);
    }

    const header = wire.Header{
        .magic = wire.magic,
        .kind = @intFromEnum(wire.Kind.opened),
        .bytes = @intCast(len),
    };
    @memcpy(buffer[0..@sizeOf(wire.Header)], std.mem.asBytes(&header));
    const head = wire.OpenedHead{
        .root_id = root,
        .document_total = @intCast(count),
        .documents = .{ .off = @intCast(rows_off), .len = @intCast(count) },
    };
    @memcpy(buffer[@sizeOf(wire.Header)..][0..@sizeOf(wire.OpenedHead)], std.mem.asBytes(&head));
    _ = replies.store(.documents, buffer[0..len]);
}

/// 树里有没有一个文本节点画着 `text`。
///
/// 与 `find` 分工：`find` 问语义标签（无障碍树看得见的那一层），这一个问画出来
/// 的字。F-02 那一类缺陷正落在两者之间——语义标签对，画出来的字串了位。
pub fn findText(node: Node, text: []const u8) bool {
    if (std.mem.eql(u8, node.widget.text, text)) return true;
    for (node.nodes) |child| {
        if (findText(child, text)) return true;
    }
    return false;
}

/// 一份 `.host` 答复：一串同属一份文档、各带各的失败原因的 Run。
///
/// 装置要满一屏：派遣台一屏是 `shell_view.card_rows` = 24 行，而旧形的进度标签
/// 只有四个轮换的槽——不到五行就看不出串位。
pub fn storeFailedRuns(buffer: []u8, document: []const u8, reasons: []const []const u8) void {
    const head_bytes = @sizeOf(wire.Header) + @sizeOf(wire.HostHead);
    @memset(buffer[0..head_bytes], 0);
    var len: usize = head_bytes;

    const put = struct {
        fn text(buf: []u8, at: *usize, value: []const u8) wire.Str {
            if (value.len == 0) return .{};
            const off = at.*;
            @memcpy(buf[off..][0..value.len], value);
            at.* += value.len;
            return .{ .off = @intCast(off), .len = @intCast(value.len) };
        }
    };

    var built: [64]wire.RunRow = undefined;
    const count = @min(reasons.len, built.len);
    var id_text: [64][24]u8 = undefined;
    for (reasons[0..count], 0..) |reason, index| {
        const id = std.fmt.bufPrint(&id_text[index], "run-{d:0>4}", .{index}) catch unreachable;
        built[index] = .{
            .id = put.text(buffer, &len, id),
            .document = put.text(buffer, &len, document),
            .workspace = .{},
            .failure = put.text(buffer, &len, reason),
            .progress = .failed,
            .needs_recovery = false,
        };
    }
    while (len % 4 != 0) : (len += 1) buffer[len] = 0;
    const rows_off = len;
    for (built[0..count]) |row| {
        @memcpy(buffer[len..][0..@sizeOf(wire.RunRow)], std.mem.asBytes(&row));
        len += @sizeOf(wire.RunRow);
    }

    const header = wire.Header{
        .magic = wire.magic,
        .kind = @intFromEnum(wire.Kind.host),
        .bytes = @intCast(len),
    };
    @memcpy(buffer[0..@sizeOf(wire.Header)], std.mem.asBytes(&header));
    const head = wire.HostHead{
        .runs = .{ .off = @intCast(rows_off), .len = @intCast(count) },
        .run_total = @intCast(count),
    };
    @memcpy(buffer[@sizeOf(wire.Header)..][0..@sizeOf(wire.HostHead)], std.mem.asBytes(&head));
    _ = replies.store(.host, buffer[0..len]);
}

/// 树里有几个节点画着字。空屏与「这一屏还没有内容」在这一层同形，
/// 而两者都不该是零个字：作者读到空白会以为这一屏坏了。
pub fn textCount(node: Node) usize {
    var count: usize = if (node.widget.text.len > 0) 1 else 0;
    for (node.nodes) |child| count += textCount(child);
    return count;
}

/// 树里有没有任何一个绑上去的动作，其请求字节含 `needle`。
pub fn anyRequestContains(node: Node, needle: []const u8) bool {
    for ([_]?Msg{ node.on_press, node.on_submit, node.on_toggle, node.on_change }) |msg| {
        const bytes = requestBytes(msg);
        if (bytes.len > 0 and std.mem.indexOf(u8, bytes, needle) != null) return true;
    }
    for (node.context_menu) |item| {
        const bytes = requestBytes(item.msg);
        if (bytes.len > 0 and std.mem.indexOf(u8, bytes, needle) != null) return true;
    }
    for (node.nodes) |child| {
        if (anyRequestContains(child, needle)) return true;
    }
    return false;
}
