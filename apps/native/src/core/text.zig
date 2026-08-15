//! Model 里的一段文字：定容、不分配、不静默截断。
//!
//! **为什么 Model 不能持切片**：`Model` 跨帧存活并被整体拷贝（`UiApp` 每次
//! `update` 交出一个新值）。切片指向的字节若住在帧竞技场里，下一帧就悬空；若住在
//! 堆上，`update` 就得管分配与释放——而 TEA 的 `update` 是纯函数，管不了。定容缓冲
//! 把「这段文字多长」变成类型的一部分，Model 因此是可整体拷贝的值。
//!
//! **与 TS 车道的差别**：受限子集的字符串也是定长的，但长度由编译器按第一次赋值
//! 推断，作者读不到也改不了（`NS9001`：一个被重新赋值的变量会以第一个分支的长度
//! 定型）。这里容量写在类型上，每个字段的容量旁边写着它为什么是这个数。
//!
//! **截断策略**：`set`/`append` 装不下就是 `error.TooLong`，不截断。静默截断会把
//! 一次合法的长输入变成一次语义不同的短输入——正稿的字节由 Rust 管，这里只装界面
//! 的草稿与标识，装不下是调用方要处理的事实。唯一的例外是 `setTruncated`，它明说
//! 自己会截，并且只在码位边界上截。
//!
//! 规格：`RefRain-work/main+SPEC.md` §8。

const std = @import("std");
const native_sdk = @import("native_sdk");

pub const Error = error{TooLong};

/// 一段最多 `capacity` 字节的 UTF-8 文字。
pub fn Bounded(comptime capacity: usize) type {
    return struct {
        const Self = @This();

        /// 容量写在类型上，调用方可以据此判断装不装得下。
        pub const cap: usize = capacity;

        bytes: [capacity]u8 = @splat(0),
        len: usize = 0,

        pub const empty: Self = .{};

        /// 从一段字节起笔。装不下是具名错误,不是截断。
        pub fn from(source: []const u8) Error!Self {
            var self: Self = .{};
            try self.set(source);
            return self;
        }

        pub fn set(self: *Self, source: []const u8) Error!void {
            if (source.len > capacity) return error.TooLong;
            @memcpy(self.bytes[0..source.len], source);
            self.len = source.len;
        }

        pub fn append(self: *Self, source: []const u8) Error!void {
            const total = self.len + source.len;
            if (total > capacity) return error.TooLong;
            @memcpy(self.bytes[self.len..total], source);
            self.len = total;
        }

        /// 明说会截的那一个：只在码位边界上截，绝不切出半个字。
        ///
        /// 给「这段文字只用来显示一行」的场合（状态行、回来卡的前文）。返回是否
        /// 截过——调用方要能知道自己看到的是不是全部。
        pub fn setTruncated(self: *Self, source: []const u8) bool {
            if (source.len <= capacity) {
                // 直接拷而不是 `set(...) catch unreachable`：这一支已经自证装得下，
                // 而一个不可达分支仍然是一条 panic 路径。宁可不产生它。
                @memcpy(self.bytes[0..source.len], source);
                self.len = source.len;
                return false;
            }
            var end: usize = capacity;
            // 退到一个码位的起点：UTF-8 的续字节是 0b10xxxxxx。
            while (end > 0 and isContinuation(source[end])) : (end -= 1) {}
            @memcpy(self.bytes[0..end], source[0..end]);
            self.len = end;
            return true;
        }

        pub fn clear(self: *Self) void {
            self.len = 0;
        }

        pub fn slice(self: *const Self) []const u8 {
            return self.bytes[0..self.len];
        }

        pub fn isEmpty(self: *const Self) bool {
            return self.len == 0;
        }

        pub fn eql(self: *const Self, other: []const u8) bool {
            return std.mem.eql(u8, self.slice(), other);
        }

        /// 退掉最后一个码位（退格键）。
        ///
        /// 按码位而不是按字节：一个汉字三字节，按字节退会留下半个字，而那半个字
        /// 在下一次绘制时是一个替换符——作者按一次退格看见一个方块。
        /// 把一次文本编辑落到这段草稿上。
        ///
        /// **为什么草稿要自己算**：平台的文本通道送的是编辑事件（插入、退格、
        /// 清空），不是整串——「这次编辑之后框里是什么」必须有人算。正稿那一条路
        /// 由 Rust 算（`DocumentSurface` 是唯一的文本状态机）；界面的单行草稿进不了
        /// 那个机器，所以算在这里。
        ///
        /// **只认三种事件**：插入、退格、清空。移动光标、选区与组字属于正稿的
        /// 词汇，一段草稿没有光标模型可言——默默处理它们会造出一个只有一半行为
        /// 的编辑器。没认的事件原样不动。
        ///
        /// 返回是否真的改变了内容。装不下时不报错也不截：草稿到顶就不再长，
        /// 已经写下的一字不失——这是作者看得见的拒绝，不是静默的。
        pub fn applyEdit(self: *Self, event: native_sdk.canvas.TextInputEvent) bool {
            switch (event) {
                .insert_text => |chunk| {
                    self.append(chunk) catch return false;
                    return chunk.len > 0;
                },
                .delete_backward => {
                    if (self.len == 0) return false;
                    self.popCodepoint();
                    return true;
                },
                .clear => {
                    if (self.len == 0) return false;
                    self.clear();
                    return true;
                },
                else => return false,
            }
        }

        pub fn popCodepoint(self: *Self) void {
            if (self.len == 0) return;
            var end = self.len - 1;
            while (end > 0 and isContinuation(self.bytes[end])) : (end -= 1) {}
            self.len = end;
        }
    };
}

fn isContinuation(byte: u8) bool {
    return byte & 0b1100_0000 == 0b1000_0000;
}

// ------------------------------------------------------------------ 测试

const testing = std.testing;

test "起笔、追加与读回" {
    var line = try Bounded(16).from("hello");
    try testing.expectEqualStrings("hello", line.slice());
    try line.append(" there");
    try testing.expectEqualStrings("hello there", line.slice());
    try testing.expect(line.eql("hello there"));
    line.clear();
    try testing.expect(line.isEmpty());
}

test "装不下是具名错误，不是截断" {
    var line: Bounded(4) = .empty;
    try testing.expectError(error.TooLong, line.set("12345"));
    // 失败之后原值不动——一次被拒的输入不该把已有的内容抹掉。
    try testing.expect(line.isEmpty());
    try line.set("1234");
    try testing.expectError(error.TooLong, line.append("5"));
    try testing.expectEqualStrings("1234", line.slice());
}

test "明说会截的那一个只在码位边界上截" {
    // 「中文字」三个汉字九字节，容量 8 只装得下两个。
    var line: Bounded(8) = .empty;
    try testing.expect(line.setTruncated("中文字"));
    try testing.expectEqualStrings("中文", line.slice());
    // 装得下就不截，也不报截过。
    var wide: Bounded(16) = .empty;
    try testing.expect(!wide.setTruncated("中文字"));
    try testing.expectEqualStrings("中文字", wide.slice());
}

test "退格退掉一整个码位，不留半个字" {
    var line = try Bounded(32).from("写中文");
    line.popCodepoint();
    try testing.expectEqualStrings("写中", line.slice());
    line.popCodepoint();
    line.popCodepoint();
    try testing.expect(line.isEmpty());
    // 空了再退不动，也不越界。
    line.popCodepoint();
    try testing.expect(line.isEmpty());
}

test "编辑事件只认插入、退格与清空" {
    var draft: Bounded(32) = .empty;
    try testing.expect(draft.applyEdit(.{ .insert_text = "写" }));
    try testing.expect(draft.applyEdit(.{ .insert_text = "中文" }));
    try testing.expectEqualStrings("写中文", draft.slice());
    // 退格退一个码位，不是一个字节。
    try testing.expect(draft.applyEdit(.delete_backward));
    try testing.expectEqualStrings("写中", draft.slice());
    try testing.expect(draft.applyEdit(.clear));
    try testing.expect(draft.isEmpty());
    // 空了再退、再清都不算改变。
    try testing.expect(!draft.applyEdit(.delete_backward));
    try testing.expect(!draft.applyEdit(.clear));
    // 正稿的词汇原样不动：一段草稿没有光标模型可言。
    try testing.expect(!draft.applyEdit(.commit_composition));
    try testing.expect(!draft.applyEdit(.{ .move_caret = .{ .direction = .next } }));
    try testing.expect(draft.isEmpty());
}

test "草稿到顶就不再长，已写下的一字不失" {
    var draft = try Bounded(4).from("abcd");
    try testing.expect(!draft.applyEdit(.{ .insert_text = "e" }));
    try testing.expectEqualStrings("abcd", draft.slice());
}

test "边界：容量恰好、空输入" {
    var exact: Bounded(3) = .empty;
    try exact.set("abc");
    try testing.expectEqual(@as(usize, 3), exact.slice().len);
    try exact.set("");
    try testing.expect(exact.isEmpty());
    try testing.expectEqual(@as(usize, 3), @TypeOf(exact).cap);
}
