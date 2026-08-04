//! 项目答复的读法：一段不透明 JSON 变成界面能画的行。
//!
//! **接上哪个功能**：`ProjectInput` 的每一条产品入口。跨界那条通道是不透明的
//! ——Rust 送来一段 JSON，`core.ts` 把它原样存进 `projectResult`，因为 core
//! 子集没有 JSON 解析器。缺的正是这一半：把那段字节读成文件树、名录、设置。
//!
//! **在全局逻辑中负责什么**：只读，不判断。「这一行能不能点」归 `roster.ts`
//! 的不变量，「这个去处够不够得着」归 `workbench.ts`——两处都在 core 子集里，
//! 可在 Null platform 上单测。这里只回答「这段字节里有什么」，答不出就交出
//! 空视图而不是猜一个：一份读错的名录比一份空名录危险得多。
//!
//! **能复用什么**：读法与「行里装的是什么」无关，所以文件树、提案、Run、
//! 信箱共用同一个游标器。Rust 的字段名（camelCase，由 serde 决定）是这里唯一
//! 的耦合面，`verify:native-snapshot-fields` 守着它不漂开。
//!
//! 为什么不用 SDK 的 `json` 原语：它按字段名取值，没有数组游标，而名录恰恰
//! 是一列对象。这里补的正是那一件事，其余仍走 SDK 的取值。

const std = @import("std");

/// 一段 JSON 值。
pub const Value = []const u8;

/// 取一个对象字段的原始值（含引号、括号），没有就是 null。
///
/// 与 SDK `json.fieldValue` 同规，重写在这里是因为 app 模块拿不到那个模块，
/// 且这里还需要它的游标形态来走数组。
pub fn field(object: Value, name: []const u8) ?Value {
    var index: usize = 0;
    skipSpace(object, &index);
    if (index >= object.len or object[index] != '{') return null;
    index += 1;
    while (index < object.len) {
        skipSpace(object, &index);
        if (index < object.len and object[index] == '}') return null;
        const key = stringSpan(object, &index) orelse return null;
        skipSpace(object, &index);
        if (index >= object.len or object[index] != ':') return null;
        index += 1;
        skipSpace(object, &index);
        const start = index;
        skipValue(object, &index) orelse return null;
        if (std.mem.eql(u8, key, name)) return object[start..index];
        skipSpace(object, &index);
        if (index < object.len and object[index] == ',') {
            index += 1;
            continue;
        }
        return null;
    }
    return null;
}

/// 一个字符串字段的内容，去掉外层引号。
///
/// 不做反转义：名录里的路径与标题是作者自己起的名字，反转义要一块暂存缓冲，
/// 而这一层只借用字节。含转义序列的少数名字会原样显示反斜杠，这比为它引入
/// 一份可能溢出的缓冲划算。
pub fn stringField(object: Value, name: []const u8) ?[]const u8 {
    const raw = field(object, name) orelse return null;
    if (raw.len < 2 or raw[0] != '"' or raw[raw.len - 1] != '"') return null;
    return raw[1 .. raw.len - 1];
}

/// 一个非负整数字段。越界或不是数字都交出 null。
pub fn unsignedField(object: Value, name: []const u8) ?u64 {
    const raw = field(object, name) orelse return null;
    if (raw.len == 0) return null;
    for (raw) |ch| {
        if (!std.ascii.isDigit(ch)) return null;
    }
    return std.fmt.parseUnsigned(u64, raw, 10) catch null;
}

/// 一个布尔字段。缺字段与不是布尔都交出 null，由调用方决定按哪一边算。
///
/// 不在这里回落成 `false`：`false` 与「读不出来」在界面上是不同的行。
/// 一条读不出撤销状态的记录被画成「还在」还是「已撤销」，要由知道那一行
/// 是什么的地方决定，而不是这个不认识它的读取器。
pub fn boolField(object: Value, name: []const u8) ?bool {
    const raw = field(object, name) orelse return null;
    if (std.mem.eql(u8, raw, "true")) return true;
    if (std.mem.eql(u8, raw, "false")) return false;
    return null;
}

/// 一列 JSON 值上的游标。
///
/// **这是本模块存在的理由。** 名录是一列对象，而按字段名取值答不了「第三行是
/// 哪一个」。游标一次走一个元素，所以读一列 1,000 行不会先建一份 1,000 行的
/// 中间表——视图只画看得见的那些。
pub const Array = struct {
    bytes: Value,
    index: usize,

    /// 下一个元素，走完交出 null。
    pub fn next(self: *Array) ?Value {
        skipSpace(self.bytes, &self.index);
        if (self.index >= self.bytes.len) return null;
        if (self.bytes[self.index] == ']') return null;
        if (self.bytes[self.index] == ',') {
            self.index += 1;
            skipSpace(self.bytes, &self.index);
        }
        if (self.index >= self.bytes.len or self.bytes[self.index] == ']') return null;
        const start = self.index;
        skipValue(self.bytes, &self.index) orelse return null;
        return self.bytes[start..self.index];
    }

    /// 第 `wanted` 个元素（从 0 数）。没有那么多行就交出 null。
    ///
    /// 从头数起，不受此前调用影响：界面画一屏时对同一列反复取行，若下标
    /// 相对游标当前位置解释，第二次取到的就是另一行——一个读起来自洽、
    /// 却整屏错位的界面。
    pub fn at(self: *const Array, wanted: usize) ?Value {
        var cursor = Array{ .bytes = self.bytes, .index = 0 };
        var seen: usize = 0;
        while (cursor.next()) |row| : (seen += 1) {
            if (seen == wanted) return row;
        }
        return null;
    }

    /// 一共有几个元素。名录的行数读它。
    pub fn count(self: *const Array) usize {
        var cursor = Array{ .bytes = self.bytes, .index = 0 };
        var total: usize = 0;
        while (cursor.next() != null) total += 1;
        return total;
    }
};

/// 一个数组字段上的游标。字段不存在或不是数组时交出空游标——空名录与读不到
/// 在这里合并是安全的，因为「读不到」由更上层的 `kind` 判断先答掉了。
pub fn array(object: Value, name: []const u8) Array {
    return arrayOf(field(object, name) orelse return .{ .bytes = "", .index = 0 });
}

/// 一段本身就是数组的值上的游标。
///
/// 与 `array` 的差别是它不先取字段：有些答复的载荷直接是一列行
/// （`{"kind":"harnesses","value":[…]}`），没有一个包着它的字段名。
/// 让调用方先造一个假字段名去骗 `array` 是行不通的——那个函数按名字
/// 找子串，而载荷里根本没有那个名字。
pub fn arrayOf(raw: Value) Array {
    if (raw.len < 2 or raw[0] != '[') return .{ .bytes = "", .index = 0 };
    return .{ .bytes = raw[1 .. raw.len - 1], .index = 0 };
}

/// 这段答复是哪一种。`ProjectOutput` 的 serde 标签，界面据它决定画什么。
///
/// 拿不到标签就是 `.unknown`——一段读不懂的答复必须说出来，而不是被当成
/// 某一种的空形态。
pub fn kind(reply: Value) []const u8 {
    return stringField(reply, "kind") orelse "";
}

/// 答复的载荷。`ProjectOutput` 用 `{"kind":…,"value":…}` 过河。
pub fn value(reply: Value) Value {
    return field(reply, "value") orelse "";
}

fn skipSpace(bytes: Value, index: *usize) void {
    while (index.* < bytes.len and std.ascii.isWhitespace(bytes[index.*])) : (index.* += 1) {}
}

fn stringSpan(bytes: Value, index: *usize) ?[]const u8 {
    if (index.* >= bytes.len or bytes[index.*] != '"') return null;
    index.* += 1;
    const start = index.*;
    while (index.* < bytes.len) : (index.* += 1) {
        const ch = bytes[index.*];
        if (ch == '"') {
            const span = bytes[start..index.*];
            index.* += 1;
            return span;
        }
        if (ch == '\\') {
            index.* += 1;
            if (index.* >= bytes.len) return null;
        }
    }
    return null;
}

fn skipValue(bytes: Value, index: *usize) ?void {
    if (index.* >= bytes.len) return null;
    return switch (bytes[index.*]) {
        '"' => if (stringSpan(bytes, index) != null) {} else null,
        '{' => skipContainer(bytes, index, '{', '}'),
        '[' => skipContainer(bytes, index, '[', ']'),
        else => skipAtom(bytes, index),
    };
}

fn skipContainer(bytes: Value, index: *usize, open: u8, close: u8) ?void {
    if (index.* >= bytes.len or bytes[index.*] != open) return null;
    var depth: usize = 0;
    while (index.* < bytes.len) {
        const ch = bytes[index.*];
        if (ch == '"') {
            // 字符串里的括号不计数：作者可以把 `]` 写进文件名，按字节数括号
            // 会在那里收尾，于是那之后的每一行都错位一格。
            _ = stringSpan(bytes, index) orelse return null;
            continue;
        }
        if (ch == open) depth += 1;
        if (ch == close) {
            depth -= 1;
            if (depth == 0) {
                index.* += 1;
                return;
            }
        }
        index.* += 1;
    }
    return null;
}

fn skipAtom(bytes: Value, index: *usize) ?void {
    const start = index.*;
    while (index.* < bytes.len) : (index.* += 1) {
        switch (bytes[index.*]) {
            ',', '}', ']', ' ', '\n', '\r', '\t' => break,
            else => {},
        }
    }
    if (index.* == start) return null;
    return;
}

test "a reply names its kind and lends its value" {
    const reply =
        \\{"kind":"opened","value":{"rootId":"r1","documentTotal":3}}
    ;
    try std.testing.expectEqualStrings("opened", kind(reply));
    try std.testing.expectEqual(@as(u64, 3), unsignedField(value(reply), "documentTotal").?);
    try std.testing.expectEqualStrings("r1", stringField(value(reply), "rootId").?);
}

test "an array cursor walks rows without building an intermediate table" {
    const reply =
        \\{"kind":"opened","value":{"documents":[{"path":"一.md"},{"path":"二.md"},{"path":"三.md"}]}}
    ;
    const rows = array(value(reply), "documents");
    try std.testing.expectEqual(@as(usize, 3), rows.count());

    // 按下标取行，且下标从头数起：界面画一屏时对同一列反复取行，若下标相对
    // 游标当前位置解释，第二次取到的就是另一行——整屏错位而每一行看着都对。
    try std.testing.expectEqualStrings("一.md", stringField(rows.at(0).?, "path").?);
    try std.testing.expectEqualStrings("二.md", stringField(rows.at(1).?, "path").?);
    try std.testing.expectEqualStrings("三.md", stringField(rows.at(2).?, "path").?);
    // 取过之后再数一遍，答案不变。
    try std.testing.expectEqual(@as(usize, 3), rows.count());
    // 越界交出 null 而不是最后一行——把「没有那么多行」读成「最后一行」会让
    // 空名录上的动作落在一个真实的对象上。
    try std.testing.expect(rows.at(3) == null);
}

test "nested objects and arrays do not end the row that contains them" {
    // 一行里带对象或数组时，浅扫描会在内层的 `}` 处收尾，于是后面的行全部错位。
    const reply =
        \\{"value":{"runs":[{"id":"a","progress":{"authorized":{"requestDigest":"d"}}},{"id":"b"}]}}
    ;
    const rows = array(value(reply), "runs");
    try std.testing.expectEqual(@as(usize, 2), rows.count());
    try std.testing.expectEqualStrings("b", stringField(rows.at(1).?, "id").?);
}

test "a string holding a bracket does not end its row" {
    // 作者可以把 `]` 或 `}` 写进文件名。按字节数括号的读法会在那里断行。
    const reply =
        \\{"value":{"documents":[{"path":"第一章]的稿子.md"},{"path":"二.md"}]}}
    ;
    const rows = array(value(reply), "documents");
    try std.testing.expectEqual(@as(usize, 2), rows.count());
    try std.testing.expectEqualStrings("第一章]的稿子.md", stringField(rows.at(0).?, "path").?);
    try std.testing.expectEqualStrings("二.md", stringField(rows.at(1).?, "path").?);
}

test "an unreadable reply answers empty instead of guessing a shape" {
    // 读不懂必须说出来。把坏答复当成某一种的空形态，作者看到的是一份
    // 「这个项目没有文档」的假事实。
    try std.testing.expectEqualStrings("", kind("not json"));
    try std.testing.expect(unsignedField("{}", "documentTotal") == null);
    try std.testing.expect(stringField("{}", "rootId") == null);
    var empty = array("{}", "documents");
    try std.testing.expectEqual(@as(usize, 0), empty.count());
    try std.testing.expect(empty.at(0) == null);
}

test "a numeric field refuses a non-numeric value rather than reading zero" {
    // 0 与「读不到」在名录上是两回事：前者是空列表，后者是坏答复。
    try std.testing.expect(unsignedField("{\"total\":\"3\"}", "total") == null);
    try std.testing.expect(unsignedField("{\"total\":-1}", "total") == null);
    try std.testing.expectEqual(@as(u64, 0), unsignedField("{\"total\":0}", "total").?);
}
