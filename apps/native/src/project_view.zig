//! 项目界面：文件树、名录行，和它们上面的动作。
//!
//! **接上哪个功能**：`ProjectInput` 的十六个产品入口。规则、测试与跨界通道
//! 早就在 Rust 里，缺的一直是这一层——把答复画成行，把点击编成请求。
//!
//! **在全局逻辑中负责什么**：只画与只送。读法归 `snapshot.zig`，写法归
//! `project_request.zig`，游标不变量归 `roster.ts`，去处规则归 `workbench.ts`。
//! 这里一条规则也不复制——复制的那一刻就会出现「界面允许点、Rust 又拒绝」。
//!
//! **能复用什么**：文件树与四个名录共用同一套行画法，因为它们的形状相同
//! （一列可选的行 + 选中项上的动作）。中文字面量住在这里，与去处表同一条
//! 纪律（core 子集不允许非 ASCII 进 rodata，NS9001）。

const std = @import("std");
const snapshot = @import("snapshot.zig");
const project_request = @import("project_request.zig");

/// 一行在界面上说的话。
///
/// 行文字由答复给出，但「没有标题时显示什么」是界面的判断，所以它在这里。
pub const Row = struct {
    /// 主文字：文件树是路径，名录是 Run 或提案的名字。
    label: []const u8,
    /// 次文字：角色、状态、条数这类补充。空表示不显示。
    detail: []const u8,
};

/// 文件树的一行。
///
/// 路径是行的身份（Root 内的相对路径，`/` 连接），也是打开它要送回的东西。
/// 没有路径的行不画——一个点不开的文件行只会让作者以为界面坏了。
pub fn documentRow(row: snapshot.Value) ?Row {
    const path = snapshot.stringField(row, "path") orelse return null;
    if (path.len == 0) return null;
    return .{ .label = path, .detail = roleLabel(snapshot.stringField(row, "role")) };
}

/// 文档角色的中文名。未知角色照实说「未知」，不猜一个。
///
/// 猜一个的代价是：一份资料被显示成正文，作者据此把它派给 Agent 当稿子改。
fn roleLabel(role: ?[]const u8) []const u8 {
    const name = role orelse return "未知";
    if (std.mem.eql(u8, name, "chapter")) return "正文";
    if (std.mem.eql(u8, name, "document")) return "文档";
    if (std.mem.eql(u8, name, "material")) return "资料";
    return "未知";
}

/// 一个 Run 在名录上说的话。
pub fn runRow(row: snapshot.Value) ?Row {
    const id = snapshot.stringField(row, "id") orelse return null;
    return .{ .label = id, .detail = progressLabel(snapshot.field(row, "progress")) };
}

/// Run 的状态的中文名。
///
/// `RunProgress` 是 Rust 的枚举（终态在类型里），serde 把它写成一个单键对象
/// 或一个字符串。两种形状都认，认不出就说「未知」——把未知状态显示成某个
/// 已知状态，作者会对一个还在跑的 Run 按下取消并以为它已经结束。
pub fn progressLabel(progress: ?snapshot.Value) []const u8 {
    const raw = progress orelse return "未知";
    const name = progressName(raw);
    if (std.mem.eql(u8, name, "authorized")) return "已授权";
    if (std.mem.eql(u8, name, "queued")) return "排队中";
    if (std.mem.eql(u8, name, "launching")) return "启动中";
    if (std.mem.eql(u8, name, "dispatched")) return "已送出";
    if (std.mem.eql(u8, name, "completed")) return "已完成";
    if (std.mem.eql(u8, name, "failed")) return "失败";
    if (std.mem.eql(u8, name, "cancelled")) return "已取消";
    return "未知";
}

/// 枚举变体的名字：`"queued"` 或 `{"authorized":{…}}` 都取到 `authorized`。
fn progressName(raw: snapshot.Value) []const u8 {
    if (raw.len >= 2 and raw[0] == '"') return raw[1 .. raw.len - 1];
    if (raw.len >= 2 and raw[0] == '{') {
        var index: usize = 1;
        while (index < raw.len and std.ascii.isWhitespace(raw[index])) index += 1;
        if (index >= raw.len or raw[index] != '"') return "";
        index += 1;
        const start = index;
        while (index < raw.len and raw[index] != '"') index += 1;
        return raw[start..index];
    }
    return "";
}

/// 选中的这一行上，现在允许哪些动作。
///
/// **这是本模块最要紧的一段。** 旧栈让界面从「是不是终态」推断按钮，于是
/// 重启后的 Dispatched Run 上会显示一个后端必然拒绝的「取消」。这里改成
/// 由状态直接说出允许什么——按钮不再猜，而 Rust 的拒绝也不再是常态。
pub const RunActions = struct {
    cancellable: bool,
    retryable: bool,
    /// 需要恢复：重启后没有活句柄的 Run。取消会被拒绝，重试也不接受它。
    needs_recovery: bool,
};

pub fn runActions(progress: ?snapshot.Value, needs_recovery: bool) RunActions {
    const name = progressName(progress orelse return .{
        .cancellable = false,
        .retryable = false,
        .needs_recovery = needs_recovery,
    });
    if (needs_recovery) {
        return .{ .cancellable = false, .retryable = false, .needs_recovery = true };
    }
    const failed = std.mem.eql(u8, name, "failed");
    const cancelled = std.mem.eql(u8, name, "cancelled");
    const running = std.mem.eql(u8, name, "launching") or std.mem.eql(u8, name, "dispatched");
    return .{
        .cancellable = running,
        .retryable = failed or cancelled,
        .needs_recovery = false,
    };
}

/// 这个 Run 在待恢复名单里吗。
pub fn needsRecovery(host: snapshot.Value, run_id: []const u8) bool {
    const list = snapshot.array(host, "runsRequiringRecovery");
    var index: usize = 0;
    while (list.at(index)) |entry| : (index += 1) {
        if (entry.len >= 2 and entry[0] == '"' and std.mem.eql(u8, entry[1 .. entry.len - 1], run_id)) {
            return true;
        }
    }
    return false;
}

/// 一次答复带来的事实，落进 Model 的那五个字段。
///
/// 不同答复带的事实不同（打开项目带文件树，读编排带名录），这里一次答完，
/// 免得每个调用点自己分辨是哪一种。
pub const Facts = struct {
    root_id: []const u8,
    document_cursor: []const u8,
    document_count: u32,
    document_total: u32,
    roster_count: u32,
};

/// 读一段答复里的事实。读不懂就交出全空——上层据此保留当前状态。
pub fn facts(reply: snapshot.Value) Facts {
    const kind = snapshot.kind(reply);
    const value = snapshot.value(reply);
    if (std.mem.eql(u8, kind, "opened")) {
        const rows = snapshot.array(value, "documents");
        return .{
            .root_id = snapshot.stringField(value, "rootId") orelse "",
            .document_cursor = snapshot.stringField(value, "documentCursor") orelse "",
            .document_count = @intCast(rows.count()),
            // 真实条数由答复自己带：界面数 `documents.len()` 得到的是
            // 「装得下的那些」，而作者读成的是「一共这么多」。
            .document_total = @intCast(snapshot.unsignedField(value, "documentTotal") orelse 0),
            .roster_count = 0,
        };
    }
    if (std.mem.eql(u8, kind, "page")) {
        const rows = snapshot.array(value, "documents");
        return .{
            .root_id = "",
            .document_cursor = snapshot.stringField(value, "next") orelse "",
            .document_count = @intCast(rows.count()),
            .document_total = @intCast(snapshot.unsignedField(value, "total") orelse 0),
            .roster_count = 0,
        };
    }
    if (std.mem.eql(u8, kind, "host")) {
        return .{
            .root_id = "",
            .document_cursor = "",
            .document_count = 0,
            .document_total = 0,
            // 名录数的是 Run。`runTotal` 是真实条数（含为装进 ABI 而丢掉的），
            // 画出来的却只能是手上这些——两者都要，差额是可见事实。
            .roster_count = @intCast(snapshot.array(value, "runs").count()),
        };
    }
    if (std.mem.eql(u8, kind, "documents") or std.mem.eql(u8, kind, "blocks")) {
        const field = if (std.mem.eql(u8, kind, "documents")) "documents" else "blocks";
        const rows = snapshot.array(value, field);
        return .{
            .root_id = "",
            .document_cursor = "",
            .document_count = @intCast(rows.count()),
            .document_total = @intCast(rows.count()),
            .roster_count = 0,
        };
    }
    return .{
        .root_id = "",
        .document_cursor = "",
        .document_count = 0,
        .document_total = 0,
        .roster_count = 0,
    };
}

/// 一条提案在裁决台上的样子。
///
/// 前后文都带：作者判的是「这一改值不值得」，只看新文本判不了。
pub const Proposal = struct {
    id: []const u8,
    scope: []const u8,
    before_text: []const u8,
    /// Agent 提议的新文本。只留评论的提案没有它。
    after_text: []const u8,
    /// 这条已经判过并暂存进批次了吗。
    staged: bool,
};

/// 读一条提案。缺 id 的行不画——判不了的行只会让作者以为界面坏了。
pub fn proposalAt(listing: snapshot.Value, index: usize) ?Proposal {
    const rows = snapshot.array(listing, "proposals");
    const row = rows.at(index) orelse return null;
    const id = snapshot.stringField(row, "id") orelse return null;
    return .{
        .id = id,
        .scope = snapshot.stringField(row, "scope") orelse "",
        .before_text = snapshot.stringField(row, "beforeText") orelse "",
        // 没有 afterText 是「只留评论」，不是读失败——两者在界面上是
        // 不同的行：前者不该显示一个空的「改成」。
        .after_text = snapshot.stringField(row, "afterText") orelse "",
        .staged = isStaged(listing, id),
    };
}

/// 这条提案已经判过了吗。
///
/// `staged` 里是**提案** id（Rust 侧已按账本配对过），所以这里能逐行回答。
/// 直接送账本行 id 的话，界面只能退成「批次空不空」的整体状态，作者看不出
/// 自己判到第几条。
pub fn isStaged(listing: snapshot.Value, proposal_id: []const u8) bool {
    const staged = snapshot.array(listing, "staged");
    var index: usize = 0;
    while (staged.at(index)) |entry| : (index += 1) {
        if (entry.len >= 2 and entry[0] == '"' and
            std.mem.eql(u8, entry[1 .. entry.len - 1], proposal_id))
        {
            return true;
        }
    }
    return false;
}

/// 这份文档上有几条提案。
pub fn proposalCount(listing: snapshot.Value) usize {
    return snapshot.array(listing, "proposals").count();
}

/// 一次裁决落盘的结局，讲成作者读得懂的一句话。
///
/// **三态各说各的**：正文落盘但派生状态待修，与磁盘被别人改过，是两件不同
/// 的事。把它们讲成同一句「保存失败」，作者会对第二种按重试，而那正是会
/// 覆盖别人改动的动作。
pub fn decisionMessage(reply: snapshot.Value) []const u8 {
    const state = snapshot.stringField(snapshot.value(reply), "state") orelse return "";
    if (std.mem.eql(u8, state, "durable")) return "已接受并落盘";
    if (std.mem.eql(u8, state, "bodyDurable")) return "正文已落盘，历史待修复";
    if (std.mem.eql(u8, state, "conflict")) return "磁盘上的正文已被别处改过，未覆盖";
    return "";
}

/// 一次收取的结局，讲成一句话。
pub fn collectMessage(reply: snapshot.Value) []const u8 {
    const value = snapshot.value(reply);
    const state = snapshot.stringField(value, "state") orelse return "";
    if (std.mem.eql(u8, state, "waiting")) return "结果还没出现";
    if (std.mem.eql(u8, state, "completed")) return "已收取";
    if (std.mem.eql(u8, state, "failed")) return "这一次派发失败";
    return "";
}

/// 打开一份文档要送的引用：`rootId\n相对路径`。
///
/// 绝对路径由 Rust 的 `ProjectStore::document_file` 解析，永远不过河——
/// 跨界的是一个 Root id 加一段相对路径，所以界面无法指定任意文件。
pub fn documentReference(
    buffer: []u8,
    root_id: []const u8,
    path: []const u8,
) ?[]const u8 {
    if (root_id.len == 0 or path.len == 0) return null;
    const total = root_id.len + 1 + path.len;
    if (total > buffer.len) return null;
    @memcpy(buffer[0..root_id.len], root_id);
    buffer[root_id.len] = '\n';
    @memcpy(buffer[root_id.len + 1 ..][0..path.len], path);
    return buffer[0..total];
}

test "a document row shows its path and says what kind of document it is" {
    const row =
        \\{"path":"第一章.md","role":"chapter"}
    ;
    const rendered = documentRow(row).?;
    try std.testing.expectEqualStrings("第一章.md", rendered.label);
    try std.testing.expectEqualStrings("正文", rendered.detail);

    // 未知角色照实说，不猜一个：把资料显示成正文，作者会把它派给 Agent 改写。
    const strange =
        \\{"path":"x.md","role":"somethingNew"}
    ;
    try std.testing.expectEqualStrings("未知", documentRow(strange).?.detail);
    // 没有路径的行不画——点不开的行只会让作者以为界面坏了。
    try std.testing.expect(documentRow("{\"role\":\"chapter\"}") == null);
}

test "run progress reads both the unit and the payload-carrying enum shapes" {
    // serde 把无字段变体写成字符串，带字段的写成单键对象。两种都要认——
    // 只认一种的表现是半数 Run 显示「未知」。
    try std.testing.expectEqualStrings("已取消", progressLabel("\"cancelled\""));
    try std.testing.expectEqualStrings(
        "已授权",
        progressLabel("{\"authorized\":{\"requestDigest\":\"d\"}}"),
    );
    // 认不出的状态说「未知」，不落到某个已知状态上。
    try std.testing.expectEqualStrings("未知", progressLabel("{\"brandNew\":{}}"));
    try std.testing.expectEqualStrings("未知", progressLabel(null));
}

test "the allowed actions come from the state, not from a guess about terminality" {
    // 旧栈按「是不是终态」推断按钮，于是重启后的 Dispatched Run 上有一个
    // 后端必然拒绝的取消键。这条守着按钮不再猜。
    const dispatched = runActions("{\"dispatched\":{\"receipt\":\"r\"}}", false);
    try std.testing.expect(dispatched.cancellable);
    try std.testing.expect(!dispatched.retryable);

    const failed = runActions("{\"failed\":{\"failure\":\"boom\"}}", false);
    try std.testing.expect(!failed.cancellable);
    try std.testing.expect(failed.retryable);

    // 待恢复的 Run 两个都不给：取消会被拒绝，重试也不接受这个状态。
    const stranded = runActions("{\"dispatched\":{\"receipt\":\"r\"}}", true);
    try std.testing.expect(!stranded.cancellable);
    try std.testing.expect(!stranded.retryable);
    try std.testing.expect(stranded.needs_recovery);

    // 已完成的 Run 不给取消也不给重试——它已经结束了。
    const done = runActions("{\"completed\":{\"artifactDigest\":\"d\"}}", false);
    try std.testing.expect(!done.cancellable);
    try std.testing.expect(!done.retryable);
}

test "recovery membership is read from the snapshot, not inferred from the state" {
    const host =
        \\{"runs":[],"runsRequiringRecovery":["run-a","run-b"],"runsAwaitingLaunch":[]}
    ;
    try std.testing.expect(needsRecovery(host, "run-a"));
    try std.testing.expect(needsRecovery(host, "run-b"));
    try std.testing.expect(!needsRecovery(host, "run-c"));
}

test "each reply kind lands the facts it actually carries" {
    const opened =
        \\{"kind":"opened","value":{"rootId":"r1","documentTotal":40,"documentCursor":"十.md","documents":[{"path":"一.md"},{"path":"二.md"}]}}
    ;
    const from_open = facts(opened);
    try std.testing.expectEqualStrings("r1", from_open.root_id);
    try std.testing.expectEqualStrings("十.md", from_open.document_cursor);
    try std.testing.expectEqual(@as(u32, 2), from_open.document_count);
    // 真实条数与画出来的条数不同，这个差额必须活着到界面上。
    try std.testing.expectEqual(@as(u32, 40), from_open.document_total);

    const host =
        \\{"kind":"host","value":{"runs":[{"id":"a"},{"id":"b"},{"id":"c"}],"runTotal":3}}
    ;
    const from_host = facts(host);
    try std.testing.expectEqual(@as(u32, 3), from_host.roster_count);
    // 编排答复不带 Root：上层据此保留作者已经打开的那一个。
    try std.testing.expectEqualStrings("", from_host.root_id);

    // 读不懂的答复交出全空，让上层保留当前状态而不是清空界面。
    const empty = facts("{\"kind\":\"cancelled\"}");
    try std.testing.expectEqual(@as(u32, 0), empty.document_count);
    try std.testing.expectEqualStrings("", empty.root_id);
}

test "a proposal row carries both sides so the author can judge the change" {
    // 只看新文本判不了「这一改值不值得」：作者判的是差异，不是结果。
    const listing =
        \\{"kind":"proposals","value":{"proposals":[{"id":"p1","scope":"ch01:b3","beforeText":"原文。","afterText":"改后。"},{"id":"p2","scope":"ch01:b9","beforeText":"另一段。","afterText":null}],"staged":["p1"]}}
    ;
    const value = snapshot.value(listing);
    try std.testing.expectEqual(@as(usize, 2), proposalCount(value));

    const first = proposalAt(value, 0).?;
    try std.testing.expectEqualStrings("p1", first.id);
    try std.testing.expectEqualStrings("原文。", first.before_text);
    try std.testing.expectEqualStrings("改后。", first.after_text);
    // 判过的行要标出来，否则作者看不出自己判到第几条。
    try std.testing.expect(first.staged);

    // 只留评论的提案没有 afterText。空串而不是读失败——它不该显示一个
    // 空的「改成」。
    const second = proposalAt(value, 1).?;
    try std.testing.expectEqualStrings("", second.after_text);
    try std.testing.expect(!second.staged);

    // 越界交出 null，不是最后一行。
    try std.testing.expect(proposalAt(value, 2) == null);
}

test "the decision outcome says which of the three states happened" {
    // 三态各说各的：把「正文落盘但历史待修」与「磁盘被别处改过」讲成同一句
    // 「保存失败」，作者会对第二种按重试——而那正是会覆盖别人改动的动作。
    try std.testing.expectEqualStrings(
        "已接受并落盘",
        decisionMessage("{\"kind\":\"decided\",\"value\":{\"state\":\"durable\"}}"),
    );
    try std.testing.expectEqualStrings(
        "正文已落盘，历史待修复",
        decisionMessage("{\"kind\":\"decided\",\"value\":{\"state\":\"bodyDurable\",\"detail\":\"x\"}}"),
    );
    try std.testing.expectEqualStrings(
        "磁盘上的正文已被别处改过，未覆盖",
        decisionMessage("{\"kind\":\"decided\",\"value\":{\"state\":\"conflict\"}}"),
    );
    // 读不懂就不说话，不猜一个状态。
    try std.testing.expectEqualStrings("", decisionMessage("{\"kind\":\"decided\",\"value\":{}}"));
}

test "collecting reports waiting as a state, not as a failure" {
    // 「结果还没出现」是正常的一态：把它讲成失败，作者会去重试一次
    // 其实还在跑的派发。
    try std.testing.expectEqualStrings(
        "结果还没出现",
        collectMessage("{\"kind\":\"collected\",\"value\":{\"state\":\"waiting\"}}"),
    );
    try std.testing.expectEqualStrings(
        "已收取",
        collectMessage("{\"kind\":\"collected\",\"value\":{\"state\":\"completed\",\"proposals\":2,\"memos\":0,\"drafts\":0}}"),
    );
    try std.testing.expectEqualStrings(
        "这一次派发失败",
        collectMessage("{\"kind\":\"collected\",\"value\":{\"state\":\"failed\",\"code\":\"x\",\"detail\":\"y\"}}"),
    );
}

test "a document reference carries a Root id and a relative path, never a filesystem path" {
    var buffer: [256]u8 = undefined;
    try std.testing.expectEqualStrings(
        "r1\n第一章.md",
        documentReference(&buffer, "r1", "第一章.md").?,
    );
    // 没有 Root 就没有引用：拼一个空 Root 的引用会被 Rust 当成有名拒绝，
    // 而作者看到的是一次没有解释的失败。
    try std.testing.expect(documentReference(&buffer, "", "第一章.md") == null);
    try std.testing.expect(documentReference(&buffer, "r1", "") == null);
    // 装不下就拒绝，不截断——截断出来的路径会指向另一份文档。
    var tiny: [4]u8 = undefined;
    try std.testing.expect(documentReference(&tiny, "r1", "第一章.md") == null);
}

test "the request writer and the reply reader agree on one Root id" {
    // 两个模块的耦合面就是这个 id：读出来的必须能原样送回去。
    const opened =
        \\{"kind":"opened","value":{"rootId":"root-7","documents":[]}}
    ;
    const root = facts(opened).root_id;
    var writer = project_request.Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"readHost\",\"value\":{\"rootId\":\"root-7\"}}",
        project_request.readHost(&writer, root).?.bytes,
    );
}

/// 一个 Harness 在这台机器上的样子。
///
/// 状态与等级都翻成中文：作者看的是「装好了 · 能取消」，不是
/// `ready` / `launch`。跨界那两个词是 kebab-case，读法在这里定死一次。
pub const Harness = struct {
    id: []const u8,
    program: []const u8,
    /// 「装好了」「没装」「装了但读不出来」。
    state: []const u8,
    /// 版本，探不到时是空。
    version: []const u8,
    /// 「写文件」「能取消」「能报用量」。
    tier: []const u8,
    /// 这个 Harness 现在能不能派活。
    ready: bool,
};

/// 读一行 Harness。
///
/// 缺 id 的行不画：一个没有身份的连接点不下去，只会让作者以为界面坏了。
pub fn harnessAt(listing: snapshot.Value, index: usize) ?Harness {
    var rows = snapshot.arrayOf(listing);
    const row = rows.at(index) orelse return null;
    const id = snapshot.stringField(row, "id") orelse return null;
    const state = snapshot.stringField(row, "state") orelse "";
    return .{
        .id = id,
        .program = snapshot.stringField(row, "program") orelse "",
        .state = harnessStateLabel(state),
        .version = snapshot.stringField(row, "version") orelse "",
        .tier = harnessTierLabel(snapshot.stringField(row, "tier") orelse ""),
        .ready = std.mem.eql(u8, state, "ready"),
    };
}

/// 「没装」与「装了但读不出来」要分开说。
///
/// 合成一句「不可用」，作者会去装一个他已经装了的程序——而真正坏的是
/// PATH 上那个同名的东西，或者那个可执行文件本身。
fn harnessStateLabel(state: []const u8) []const u8 {
    if (std.mem.eql(u8, state, "ready")) return "装好了";
    if (std.mem.eql(u8, state, "not-installed")) return "没装";
    if (std.mem.eql(u8, state, "unreadable")) return "装了，但读不出版本";
    return "状况不明";
}

/// 等级决定这个 Harness 能做什么，作者在派发之前就该看见。
fn harnessTierLabel(tier: []const u8) []const u8 {
    if (std.mem.eql(u8, tier, "usage")) return "能报用量";
    if (std.mem.eql(u8, tier, "launch")) return "能取消";
    if (std.mem.eql(u8, tier, "file")) return "只能写文件";
    return "";
}

test "a harness row keeps installed and unreadable apart" {
    // 两者要作者做的事完全不同：一个去装，一个去查 PATH。合并它们，
    // 作者会去装一个他已经装了的程序。
    const listing =
        "[{\"id\":\"kimi-print\",\"program\":\"kimi\",\"state\":\"not-installed\",\"version\":\"\",\"tier\":\"file\"}," ++
        "{\"id\":\"claude-print\",\"program\":\"claude\",\"state\":\"unreadable\",\"version\":\"\",\"tier\":\"file\"}]";
    const first = harnessAt(listing, 0).?;
    const second = harnessAt(listing, 1).?;
    try std.testing.expectEqualStrings("没装", first.state);
    try std.testing.expectEqualStrings("装了，但读不出版本", second.state);
    try std.testing.expect(!first.ready and !second.ready);
}

test "a ready harness carries its version and what it can do" {
    const listing =
        "[{\"id\":\"claude-print\",\"program\":\"claude\",\"state\":\"ready\",\"version\":\"1.2.3\",\"tier\":\"usage\"}]";
    const row = harnessAt(listing, 0).?;
    try std.testing.expect(row.ready);
    try std.testing.expectEqualStrings("1.2.3", row.version);
    // 等级要说出来：作者按这个决定派给谁。「能报用量」与「能取消」是
    // 两件事，而两者都只是一个绿点的话，界面上分辨不出来。
    try std.testing.expectEqualStrings("能报用量", row.tier);
}

test "a row without an id is skipped instead of drawn blank" {
    const listing = "[{\"program\":\"kimi\",\"state\":\"ready\"}]";
    try std.testing.expect(harnessAt(listing, 0) == null);
    // 越界同样返回 null，而不是读过表尾。
    try std.testing.expect(harnessAt("[]", 0) == null);
}

/// 一条改动记录在历史面板上的样子。
pub const Change = struct {
    /// 第几次改动。作者据此说「回到第 12 步」。
    ordinal: u64,
    /// 因何发生：作者自己打的字，还是一次裁决落盘。
    cause: []const u8,
    /// 这一条已经被撤销了吗。
    ///
    /// 已撤销的行仍然显示：它们是作者做过的事，从列表里消失会让他以为
    /// 自己记错了。
    undone: bool,
};

/// 读一行改动记录。
pub fn changeAt(listing: snapshot.Value, index: usize) ?Change {
    var rows = snapshot.arrayOf(listing);
    const row = rows.at(index) orelse return null;
    const ordinal = snapshot.unsignedField(row, "ordinal") orelse return null;
    return .{
        .ordinal = ordinal,
        .cause = snapshot.stringField(row, "cause") orelse "",
        // 缺 `undone` 按「还在」算：一条读不出状态的记录被画成已撤销，
        // 作者会以为自己撤销过一个他没撤销的改动。
        .undone = snapshot.boolField(row, "undone") orelse false,
    };
}

test "an undone change stays in the list marked rather than vanishing" {
    // 已撤销的行是作者做过的事。从列表里消失，他会以为自己记错了——
    // 而撤销本身是可以再撤销回来的。
    const listing =
        "[{\"id\":\"a\",\"ordinal\":3,\"cause\":\"native text input\",\"at\":1,\"undone\":true}," ++
        "{\"id\":\"b\",\"ordinal\":2,\"cause\":\"verdict\",\"at\":1,\"undone\":false}]";
    const first = changeAt(listing, 0).?;
    const second = changeAt(listing, 1).?;
    try std.testing.expect(first.undone);
    try std.testing.expect(!second.undone);
    // 序号保留：撤销不改变它在链上的位置。
    try std.testing.expectEqual(@as(u64, 3), first.ordinal);
}

test "a change whose undone flag cannot be read counts as still standing" {
    // 这一行的 `undone` 读不出来（字段缺失，或者写成了字符串）。按「已撤销」
    // 算，作者会以为自己撤销过一个他没撤销的改动，于是去把它「恢复」——
    // 而那次恢复动的是一条本来就在的记录。
    //
    // 这条测试是注入验红时补的：原来的夹具每行都带 `undone`，那条回落
    // 分支从未被执行，往里注入缺陷全绿。洞是真的，补测试不是为了好看。
    const missing = "[{\"id\":\"a\",\"ordinal\":1,\"cause\":\"x\"}]";
    try std.testing.expect(!changeAt(missing, 0).?.undone);
    const not_a_bool = "[{\"id\":\"a\",\"ordinal\":1,\"cause\":\"x\",\"undone\":\"yes\"}]";
    try std.testing.expect(!changeAt(not_a_bool, 0).?.undone);
}

test "a change without an ordinal is skipped instead of drawn at zero" {
    // 第 0 步不存在。画出来，作者会以为链的起点在那里。
    try std.testing.expect(changeAt("[{\"cause\":\"x\"}]", 0) == null);
    try std.testing.expect(changeAt("[]", 0) == null);
}
