//! 工作台的去处与导航：作者此刻在哪，以及「这一下按键归谁」。
//!
//! **接上哪个功能**：导航（Cmd+1..8）、面板开合（Escape 退层、同键再按关闭）、
//! 命令面板与分栏。它们问的是同一个问题（「现在该显示什么」），所以共用这一个
//! 权威。
//!
//! **舞台规则**（`docs/ARCHITECTURE.md`《The stage rule》同文，此处只实现不重述）：
//! 正文是唯一的舞台，交互区只有两个——单侧功能区与右键编辑区。一切工具表面从
//! 同一侧以面板进出、按层深叠放；工具不开在正文之上。Escape 一次只关一层。
//!
//! **模型**：去处是唯一下标，但可沿两条轴走——四区键位（Cmd+1..4）与直达键位
//! （Cmd+5..8）。Agent 区记忆上次去处：按 Cmd+4 回到上次 Agent 去处，而不是某个
//! 默认值。面板栈退化成「上一个去处」：Escape 回上一个，同键再按关闭当前。
//!
//! **与 `workbench.ts` 的三处差别，都是受限子集的伤疤在这里愈合**：
//!
//! | `workbench.ts` | 为什么那样写 | 这里 |
//! |---|---|---|
//! | `NEEDS_DOCUMENT_MASK = 92` | 子集只折叠数字，一个数表达八条规则 | switch，穷尽性由编译器判 |
//! | `panelStack` 3 bit × 8 层塞进一个 number | 子集不折叠数组 | `[8]Destination` + `depth` |
//! | `popDestination` / `popRest` 拆成两个函数 | 子集不折叠无标注的对象字面量 | 一个 `pop` 返回记录 |
//!
//! 规格：`RefRain-work/main+SPEC.md`。
//! 本模块今天没有生产读者——车道切换在单元 13，届时 `panel_stack.zig` 的像素几何
//! 并进来，`workbench.ts` 同批删。

const std = @import("std");

/// 八个去处。
///
/// 枚举而不是裸下标：`workbench.ts` 里 `isDestination` 被调了七次，每个读取点都
/// 得先问一次「这个数字合法吗」。枚举让那个问题只在**外部数字进来的边界**上出现
/// 一次（键位序号、答复里的下标），内部读取点一次都不需要。
pub const Destination = enum(u3) {
    /// 稿子。永远够得着，也是一切拒绝的落点。
    manuscript = 0,
    /// 文件（侧栏）。四区的「文件」指的就是它。
    files = 1,
    /// 裁决台。Alt 裁决键的路由读它：那些键只在台上才动作。
    review = 2,
    /// 派发。Agent 区与 Cmd+4 的默认落点。
    dispatch = 3,
    mailbox = 4,
    connections = 5,
    history = 6,
    /// 设置。四区的「设置」指的就是它。
    settings = 7,

    /// 这个去处需要手上有一份打开的稿子吗。
    ///
    /// 读稿子的是裁决、派发、信箱、历史。`workbench.ts` 把这张表压成常量 92，
    /// 需要一段注释才能读；这里由编译器保证「新增去处忘了归类」编译不过。
    pub fn needsDocument(self: Destination) bool {
        return switch (self) {
            .review, .dispatch, .mailbox, .history => true,
            .manuscript, .files, .connections, .settings => false,
        };
    }

    /// 这个去处属于 Agent 层吗（Cmd+4 会记住它）。
    pub fn isAgent(self: Destination) bool {
        return switch (self) {
            .review, .dispatch, .mailbox, .connections, .history => true,
            .manuscript, .files, .settings => false,
        };
    }

    /// 这个去处有一份名录吗（上下移动有意义）。
    ///
    /// 名录键（Ctrl+J/K 与 Alt+J/K）按它接管：在没有名录的去处上移动一个看不见
    /// 的游标，等作者回到台上时位置已经漂了——那是「键没生效」与「键偷偷生效」
    /// 两种困惑的来源。历史不在其中：它的行是只读的回档名录，由自己的键走。
    pub fn hasRoster(self: Destination) bool {
        return switch (self) {
            .review, .dispatch, .mailbox, .connections => true,
            .manuscript, .files, .history, .settings => false,
        };
    }

    /// 独占舞台的去处：稿子与裁决。它们打开时盖住所有层（层留在栈里）。
    pub fn isWholeStage(self: Destination) bool {
        return self == .manuscript or self == .review;
    }
};

/// 去处的套数。与 Zig 侧 `workbench_destinations` 的长度同源。
pub const destination_count: usize = @typeInfo(Destination).@"enum".fields.len;

/// 一个外部来的数字指向哪个去处，指不到就是 `null`。
///
/// 「外部」指平台的键位序号与 Rust 答复里的下标——本模块内部永远传枚举。
pub fn destinationFrom(index: i64) ?Destination {
    if (index < 0 or index >= destination_count) return null;
    return std.enums.fromInt(Destination, @as(u3, @intCast(index)));
}

/// 下标钳到一个真实去处。越界回落到稿子——一次坏的选择不该让界面无处可去。
pub fn destinationAt(index: i64) Destination {
    return destinationFrom(index) orelse .manuscript;
}

/// 四区键位：Cmd+1..4，与旧版 quarters 同序（设置/文件/编辑/Agent）。
///
/// 收的是键位序号（Cmd+1 是 1）。不是四区也不是直达键时返回 `null`——调用方据此
/// 决定这一下不该被接管（去不了的那一下不 preventDefault，让平台默认行为走）。
pub fn destinationForOrdinal(ordinal: i64, agent_destination: ?Destination) ?Destination {
    return switch (ordinal) {
        1 => .settings,
        2 => .files,
        3 => .manuscript,
        // Agent 区回落到记住的去处，而不是某个固定面板；记忆坏了才回派发。
        4 => agent_destination orelse .dispatch,
        else => destinationFrom(ordinal - 1),
    };
}

/// 一次导航的结果。
///
/// 四个具名值而不是「新去处或 null」：拒绝有理由，调用方需要那个理由才能告诉
/// 作者为什么没动。
pub const Navigation = enum {
    moved,
    /// 已经在那里。不是失败，但也不该重放动画或重发请求。
    unchanged,
    /// 那个去处需要一份打开的稿子。
    needs_document,
    /// 同键再按：旧版面板栈「已在顶上→关」。回稿子。
    close,
};

/// 算一次导航。不改任何状态——调用方拿结果自己落地。
///
/// 同键再按是「关闭」而非「不动」：作者在批注里按 Cmd+4 再按一次，想回的是正文，
/// 不是同一个面板再看一遍。
pub fn navigate(current: Destination, target: Destination, has_document: bool) Navigation {
    if (target.needsDocument() and !has_document) return .needs_document;
    if (target == current) {
        // 稿子本身没有再按一次的关闭语义：回到稿子就是留在稿子。
        return if (target == .manuscript) .unchanged else .close;
    }
    return .moved;
}

/// 换一份稿子（或关掉稿子）之后，当前去处还站得住吗。
///
/// 换项目等于换了一份稿子的世界：站在裁决台上而稿子已经不在，那个台子上的每一条
/// 都指向不存在的东西。此时退回稿子，而不是留在原地显示空列表。
pub fn settleAfterDocument(current: Destination, has_document: bool) Destination {
    return if (current.needsDocument() and !has_document) .manuscript else current;
}

/// 侧栏默认宽：248px / 1280px ≈ 0.19。与旧版 `--rail-width` 同源。
pub const rail_fraction_default: f64 = 0.19;

/// 面板宽：400px / 1280px。
const panel_fraction: f64 = 0.32;

/// 分栏的第一 pane 占比（0..1）。
///
/// 渲染把「去处」投影成分栏宽度，这一张表就是那个投影的唯一权威——渲染不各猜一次。
/// 一切从单侧（左）出现，正文恒在最右。
pub fn layoutFraction(index: Destination, rail_fraction: f64) f64 {
    return switch (index) {
        // 稿子与裁决独占舞台，正文全宽。
        .manuscript, .review => 1.0,
        // 文件区用作者拖出来的宽度。
        .files => rail_fraction,
        else => panel_fraction,
    };
}

/// 侧栏宽的可调区间（拖柄钳制）。非有限数回落默认——一次坏的读数不该把栏拖没。
pub fn clampRailFraction(fraction: f64) f64 {
    if (!std.math.isFinite(fraction)) return rail_fraction_default;
    return @min(0.4, @max(0.1, fraction));
}

/// 可见面板层数上限（含当前层）。更旧的层留在栈里，只是不画。
///
/// 三层在 1250px 窗口上按默认比例只给正文剩 4%（ARCHITECTURE《The layout of the
/// layers》）——所以是三层，不是更多。
pub const max_visible_layers: u8 = 3;

/// 面板栈能记多少层作者的来路。
pub const max_depth: usize = 8;

/// 面板栈：去处切换的退层记忆。
///
/// 有界数组而不是位压缩（PLAN §3 P4 明令）。位压缩是受限子集的产物——子集不折叠
/// 数组，所以八层 × 3 bit 挤进一个 number，而代价是真的：深度只能靠「右移到零」
/// 数出来，于是「栈底压了一个稿子(0)」与「空栈」在数值上不可区分。深度成为字段
/// 之后那个歧义消失，`push` 对稿子的特判留下来——那不是编码的产物，是规则本身
/// （稿子是根，不进栈）。
pub const PanelStack = struct {
    layers: [max_depth]Destination = @splat(.manuscript),
    depth: u8 = 0,

    pub const empty: PanelStack = .{};

    /// 栈顶去处；空栈返回稿子（根）。
    pub fn peek(self: *const PanelStack) Destination {
        if (self.depth == 0) return .manuscript;
        return self.at(self.depth - 1);
    }

    /// 栈里第 index 层的去处（0 = 栈底）。越界返回稿子（根）。
    pub fn at(self: *const PanelStack, index: u8) Destination {
        if (index >= self.depth or index >= max_depth) return .manuscript;
        return self.layers[index];
    }

    /// 前进到某处：压栈。去处是稿子时不动——根不进栈。
    /// 栈满时不再压：丢最新的，不丢最旧的——最旧的是作者的来路。
    pub fn push(self: PanelStack, destination: Destination) PanelStack {
        if (destination == .manuscript) return self;
        if (self.depth >= max_depth) return self;
        var next = self;
        next.layers[self.depth] = destination;
        next.depth = self.depth + 1;
        return next;
    }

    /// 弹栈：栈顶去处与弹掉之后剩下的栈。
    ///
    /// 一个函数返回记录，而不是 `workbench.ts` 的两个数字函数——那是「子集不折叠
    /// 无接口标注的对象字面量」留下的伤疤，不该抄进来。
    pub fn pop(self: PanelStack) struct { destination: Destination, rest: PanelStack } {
        if (self.depth == 0) return .{ .destination = .manuscript, .rest = self };
        var rest = self;
        rest.depth = self.depth - 1;
        return .{ .destination = self.at(self.depth - 1), .rest = rest };
    }

    /// 可见层数。当前层是独占去处时为 0（它盖住一切）；否则是栈里的面板层与当前
    /// 面板层的总数，夹到上限。
    pub fn visibleDepth(self: *const PanelStack, current: Destination) u8 {
        if (current.isWholeStage()) return 0;
        return @min(self.panelCount() + 1, max_visible_layers);
    }

    /// 栈里有几个面板层（独占层不算面板）。
    fn panelCount(self: *const PanelStack) u8 {
        var panels: u8 = 0;
        var index: u8 = 0;
        while (index < self.depth) : (index += 1) {
            if (!self.at(index).isWholeStage()) panels += 1;
        }
        return panels;
    }

    /// 可见的第 at_index 层（0 = 最左）是哪个去处。
    ///
    /// 栈里的面板层按从底到顶排，当前层恒在最右；超出上限时最旧的层先藏起来。
    pub fn visibleLayerAt(self: *const PanelStack, current: Destination, at_index: u8) Destination {
        const visible = self.visibleDepth(current);
        if (at_index + 1 >= visible) return current;
        // 当前层占掉最后一席，剩下的窗口只露最新的几层。
        const window = visible - 1;
        const panels = self.panelCount();
        const skip = if (panels > window) panels - window else 0;
        var seen: u8 = 0;
        var index: u8 = 0;
        while (index < self.depth) : (index += 1) {
            const layer = self.at(index);
            if (layer.isWholeStage()) continue;
            if (seen >= skip and seen == skip + at_index) return layer;
            seen += 1;
        }
        return current;
    }
};

// ------------------------------------------------------------------ 测试
// 向量逐条搬自 `workbench.test.ts`，断言的是同一个事实。

const testing = std.testing;

test "需要稿子的去处正是那些读稿子的" {
    // `workbench.ts` 的掩码是手算常量，所以那条测试把每一位摊开写死。这里改由
    // switch 穷尽，但仍逐个钉住——算错一位在别处只表现为「某个面板偶尔能空开」。
    const expected = [_]bool{ false, false, true, true, true, false, true, false };
    try testing.expectEqual(expected.len, destination_count);
    for (expected, 0..) |needs, index| {
        try testing.expectEqual(needs, destinationAt(@intCast(index)).needsDocument());
    }
}

test "四区握着自己的键，其余按位置直达" {
    try testing.expectEqual(Destination.settings, destinationForOrdinal(1, .dispatch).?);
    try testing.expectEqual(Destination.files, destinationForOrdinal(2, .dispatch).?);
    try testing.expectEqual(Destination.manuscript, destinationForOrdinal(3, .dispatch).?);
    // Agent 区回落到记住的去处，而不是某个固定面板。
    try testing.expectEqual(Destination.history, destinationForOrdinal(4, .history).?);
    try testing.expectEqual(Destination.mailbox, destinationForOrdinal(4, .mailbox).?);
    // 没有记忆时回落派发。TS 侧是「记忆值越界」，Zig 侧越界根本构造不出来——
    // 非法状态不可表示，剩下的唯一情形是「还没记过」。
    try testing.expectEqual(Destination.dispatch, destinationForOrdinal(4, null).?);
    // 直达键位：Cmd+5..8。
    try testing.expectEqual(Destination.mailbox, destinationForOrdinal(5, .dispatch).?);
    try testing.expectEqual(Destination.settings, destinationForOrdinal(8, .dispatch).?);
}

test "去处表以外的键或下标是拒绝，不是落在某处" {
    try testing.expectEqual(@as(?Destination, null), destinationForOrdinal(0, .dispatch));
    try testing.expectEqual(@as(?Destination, null), destinationForOrdinal(9, .dispatch));
    try testing.expectEqual(Destination.manuscript, destinationAt(-1));
    try testing.expectEqual(Destination.manuscript, destinationAt(@intCast(destination_count)));
    // 越界的下标不该被当成「需要稿子」——那会让一次坏输入伪装成一次合理拒绝。
    try testing.expect(!destinationAt(@intCast(destination_count)).needsDocument());
    try testing.expect(!destinationAt(-1).needsDocument());
}

test "读稿子的去处没有稿子就打不开" {
    for (0..destination_count) |index| {
        const target = destinationAt(@intCast(index));
        if (!target.needsDocument()) continue;
        try testing.expectEqual(Navigation.needs_document, navigate(.manuscript, target, false));
        try testing.expectEqual(Navigation.moved, navigate(.manuscript, target, true));
    }
}

test "同键再按关闭当前去处" {
    // 近失手：把「同键再按」当成一次 move，会重发一次请求并重放动画。
    try testing.expectEqual(Navigation.close, navigate(.review, .review, true));
    try testing.expectEqual(Navigation.close, navigate(.settings, .settings, false));
    // 稿子没有可关的：回到稿子就是留在稿子。
    try testing.expectEqual(Navigation.unchanged, navigate(.manuscript, .manuscript, true));
    // 文件区是侧栏不是面板：同键再按同样关闭（回正文全宽）。
    try testing.expectEqual(Navigation.close, navigate(.files, .files, false));
}

test "关掉稿子会把正在读它的去处赶回稿子" {
    try testing.expectEqual(Destination.manuscript, settleAfterDocument(.review, false));
    try testing.expectEqual(Destination.manuscript, settleAfterDocument(.history, false));
    // 不读稿子的去处留在原地：换项目不该把作者从设置里赶出来。
    try testing.expectEqual(Destination.settings, settleAfterDocument(.settings, false));
    try testing.expectEqual(Destination.review, settleAfterDocument(.review, true));
}

test "Agent 层正是 Cmd+4 会记住的那几个去处" {
    try testing.expect(Destination.review.isAgent());
    try testing.expect(Destination.dispatch.isAgent());
    try testing.expect(Destination.mailbox.isAgent());
    try testing.expect(Destination.connections.isAgent());
    try testing.expect(Destination.history.isAgent());
    try testing.expect(!Destination.manuscript.isAgent());
    try testing.expect(!Destination.files.isAgent());
    try testing.expect(!Destination.settings.isAgent());
}

test "有名录的正是那四个有一列可走的去处" {
    try testing.expect(Destination.review.hasRoster());
    try testing.expect(Destination.dispatch.hasRoster());
    try testing.expect(Destination.mailbox.hasRoster());
    try testing.expect(Destination.connections.hasRoster());
    try testing.expect(!Destination.manuscript.hasRoster());
    try testing.expect(!Destination.files.hasRoster());
    // 历史没有名录：它的行是只读的回档名录，由自己的键走。
    try testing.expect(!Destination.history.hasRoster());
    try testing.expect(!Destination.settings.hasRoster());
}

test "可见栈按从底到顶排面板层，当前层恒在最右" {
    // 栈记的是离开的去处（当前层不在栈里）：栈底是文件，当前层是派发台。
    const stack = PanelStack.empty.push(.files);
    try testing.expectEqual(@as(u8, 2), stack.visibleDepth(.dispatch));
    try testing.expectEqual(Destination.files, stack.visibleLayerAt(.dispatch, 0));
    try testing.expectEqual(Destination.dispatch, stack.visibleLayerAt(.dispatch, 1));
    // 独占去处（裁决）当前时：没有侧层。
    try testing.expectEqual(@as(u8, 0), stack.visibleDepth(.review));

    // 超过上限时最旧的层先藏：栈 [文件,派发,信箱] + 当前连接 → 只露三层。
    const deep = PanelStack.empty.push(.files).push(.dispatch).push(.mailbox);
    try testing.expectEqual(@as(u8, 3), deep.depth);
    try testing.expectEqual(max_visible_layers, deep.visibleDepth(.connections));
    try testing.expectEqual(Destination.dispatch, deep.visibleLayerAt(.connections, 0)); // 文件被藏起
    try testing.expectEqual(Destination.mailbox, deep.visibleLayerAt(.connections, 1));
    try testing.expectEqual(Destination.connections, deep.visibleLayerAt(.connections, 2));

    // 栈里的独占层不算面板层：栈 [文件,裁决] + 当前派发 → 文件与派发。
    const mixed = PanelStack.empty.push(.files).push(.review);
    try testing.expectEqual(@as(u8, 2), mixed.visibleDepth(.dispatch));
    try testing.expectEqual(Destination.files, mixed.visibleLayerAt(.dispatch, 0));
    try testing.expectEqual(Destination.dispatch, mixed.visibleLayerAt(.dispatch, 1));
}

test "栈：根不进栈，空栈弹栈交出稿子，满栈丢最新的" {
    // 稿子是根：压它不动栈。位压缩车道靠数值分不开「栈底是稿子」与「空栈」，
    // 深度成为字段之后这条歧义不再存在。
    try testing.expectEqual(@as(u8, 0), PanelStack.empty.push(.manuscript).depth);
    try testing.expectEqual(Destination.manuscript, PanelStack.empty.peek());

    const popped = PanelStack.empty.pop();
    try testing.expectEqual(Destination.manuscript, popped.destination);
    try testing.expectEqual(@as(u8, 0), popped.rest.depth);

    const one = PanelStack.empty.push(.settings);
    try testing.expectEqual(Destination.settings, one.peek());
    const back = one.pop();
    try testing.expectEqual(Destination.settings, back.destination);
    try testing.expectEqual(@as(u8, 0), back.rest.depth);

    // 满栈：丢最新的，不丢最旧的——最旧的是作者的来路。
    var full = PanelStack.empty;
    for (0..max_depth) |_| full = full.push(.settings);
    try testing.expectEqual(@as(u8, max_depth), full.depth);
    const overflowed = full.push(.mailbox);
    try testing.expectEqual(@as(u8, max_depth), overflowed.depth);
    try testing.expectEqual(Destination.settings, overflowed.peek());
}

test "分栏是去处的纯投影" {
    // 稿子与裁决（独占舞台）全宽。
    try testing.expectEqual(@as(f64, 1.0), layoutFraction(.manuscript, rail_fraction_default));
    try testing.expectEqual(@as(f64, 1.0), layoutFraction(.review, rail_fraction_default));
    // 文件区：侧栏在左，用作者拖出来的宽度。
    try testing.expectEqual(rail_fraction_default, layoutFraction(.files, rail_fraction_default));
    try testing.expectEqual(@as(f64, 0.3), layoutFraction(.files, 0.3));
    // 其余去处：面板 32%（≈400px/1280px）在左，正文让到右。
    try testing.expectEqual(panel_fraction, layoutFraction(.dispatch, rail_fraction_default));
    try testing.expectEqual(panel_fraction, layoutFraction(.settings, rail_fraction_default));
}

test "侧栏比例钳在可用区间内" {
    try testing.expectEqual(@as(f64, 0.1), clampRailFraction(0.05));
    try testing.expectEqual(@as(f64, 0.4), clampRailFraction(0.9));
    try testing.expectEqual(rail_fraction_default, clampRailFraction(rail_fraction_default));
    try testing.expectEqual(rail_fraction_default, clampRailFraction(std.math.nan(f64)));
}
