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
///
/// 措辞的唯一权威是这里（v0.2.4 的七态表）：排队／已授权／启动／在途／
/// 完成／失败／取消。失败带原因时说原因——作者据此决定重试还是放弃。
pub fn progressLabel(progress: ?snapshot.Value) []const u8 {
    const raw = progress orelse return "未知";
    const name = progressName(raw);
    if (std.mem.eql(u8, name, "authorized")) return "已授权";
    if (std.mem.eql(u8, name, "queued")) return "排队";
    if (std.mem.eql(u8, name, "launching")) return "启动";
    if (std.mem.eql(u8, name, "dispatched")) return "在途";
    if (std.mem.eql(u8, name, "completed")) return "完成";
    if (std.mem.eql(u8, name, "failed")) {
        const payload = snapshot.field(raw, "failed") orelse return "失败";
        const reason = snapshot.stringField(payload, "failure") orelse return "失败";
        return failedLabel(reason);
    }
    if (std.mem.eql(u8, name, "cancelled")) return "取消";
    return "未知";
}

/// 「失败：{原因}」要拼一个字串，需要一块缓冲。轮换池与
/// `documentReference` 同一条借用纪律：单线程 UI 帧内消费，写完立刻被
/// SDK 读走。原因超长时截在 char 边界上——半个字不是预览，是坏字节。
var progress_label_pool: [4][288]u8 = undefined;
var progress_label_slot: usize = 0;

fn failedLabel(reason: []const u8) []const u8 {
    progress_label_slot = (progress_label_slot + 1) % progress_label_pool.len;
    const buffer: []u8 = progress_label_pool[progress_label_slot][0..];
    const prefix = "失败：";
    @memcpy(buffer[0..prefix.len], prefix);
    var len: usize = @min(reason.len, buffer.len - prefix.len);
    // 真的截了才退到 char 边界：continuation 字节（10xxxxxx）不是字符起点。
    while (len > 0 and len < reason.len and (reason[len] & 0xC0) == 0x80) len -= 1;
    @memcpy(buffer[prefix.len..][0..len], reason[0..len]);
    return buffer[0 .. prefix.len + len];
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
///
/// 显隐表（v0.2.4）：取消仅非终态，重试仅失败与取消，收取仅在途——
/// 结果只可能在送出之后出现，提前可按只会让作者按一次才知道还没好。
/// 2.11 补「开始」：仅已授权（authorized）——Run 铸成后等待作者的
/// 那一声发令枪（手动往返与下游接力的第一棒都经它）。
pub const RunActions = struct {
    /// 取消：仅非终态（排队／已授权／启动／在途）。
    cancellable: bool,
    /// 重试：仅失败与取消。
    retryable: bool,
    /// 收取：仅在途（dispatched）。
    collectable: bool,
    /// 开始：仅已授权（2.11 的 LaunchRun 通路）。
    launchable: bool,
    /// 需要恢复：重启后没有活句柄的 Run。取消会被拒绝，重试也不接受它。
    needs_recovery: bool,
};

pub fn runActions(progress: ?snapshot.Value, needs_recovery: bool) RunActions {
    const name = progressName(progress orelse return .{
        .cancellable = false,
        .retryable = false,
        .collectable = false,
        .launchable = false,
        .needs_recovery = needs_recovery,
    });
    if (needs_recovery) {
        return .{
            .cancellable = false,
            .retryable = false,
            .collectable = false,
            .launchable = false,
            .needs_recovery = true,
        };
    }
    const failed = std.mem.eql(u8, name, "failed");
    const cancelled = std.mem.eql(u8, name, "cancelled");
    const completed = std.mem.eql(u8, name, "completed");
    return .{
        .cancellable = !failed and !cancelled and !completed,
        .retryable = failed or cancelled,
        .collectable = std.mem.eql(u8, name, "dispatched"),
        .launchable = std.mem.eql(u8, name, "authorized"),
        .needs_recovery = false,
    };
}

/// 这份文档的第 index 个 Run：host 快照里 tasks 与 runs 的交集。
///
/// v0.2.4 的 runsOf 同款：task 带 `document`（哪份稿子），run 带 `taskId`
/// （哪一轮派发）——两步连起来才答得出「这份稿子送出去过哪些 Run」。
/// 直接按 run 上的字段猜会把别份稿子的 Run 算进来。
///
/// 返回的是 runs 数组里那一行的原文（调用方再取 id／progress／workspace）。
pub fn runsForDocument(host: snapshot.Value, path: []const u8, index: usize) ?snapshot.Value {
    const runs = snapshot.array(host, "runs");
    var seen: usize = 0;
    var run_index: usize = 0;
    while (runs.at(run_index)) |row| : (run_index += 1) {
        const task_id = snapshot.stringField(row, "taskId") orelse continue;
        if (!taskIsForDocument(host, task_id, path)) continue;
        if (seen == index) return row;
        seen += 1;
    }
    return null;
}

/// 这个 task id 是不是这份文档的一轮派发。
fn taskIsForDocument(host: snapshot.Value, task_id: []const u8, path: []const u8) bool {
    const tasks = snapshot.array(host, "tasks");
    var index: usize = 0;
    while (tasks.at(index)) |task| : (index += 1) {
        const id = snapshot.stringField(task, "id") orelse continue;
        if (!std.mem.eql(u8, id, task_id)) continue;
        const document = snapshot.stringField(task, "document") orelse return false;
        return std.mem.eql(u8, document, path);
    }
    return false;
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

/// 同一 scope 上的另一条提案：这一条的竞争稿。
///
/// 并列方案共享一个 scope（改的是同一段），靠 id 区分——裁决台翻 B 面
/// （Alt+P）时按它取稿。找不到交出 null：界面据此说「这一条没有竞争稿」，
/// 而不是画一段凭空的对照。
pub fn competitorOf(listing: snapshot.Value, index: usize) ?Proposal {
    const current = proposalAt(listing, index) orelse return null;
    var other: usize = 0;
    while (proposalAt(listing, other)) |candidate| : (other += 1) {
        if (!std.mem.eql(u8, candidate.id, current.id) and
            std.mem.eql(u8, candidate.scope, current.scope)) return candidate;
    }
    return null;
}

/// 过期提案恢复步骤码的中文读法。
///
/// 不认识的码原样显示——译一个没见过的码，作者照着做的可能是另一件事。
pub fn staleStepLabel(code: []const u8) []const u8 {
    if (std.mem.eql(u8, code, "compare-with-frozen-text")) return "看看 Agent 当时读到的是什么";
    if (std.mem.eql(u8, code, "send-again")) return "按现在的文字重新发一次";
    if (std.mem.eql(u8, code, "report-defect")) return "报告缺陷";
    return code;
}

/// 派发台块清单的一行。
///
/// 与搜索命中的 `BlockHit` 不是同一族：这行来自活 Manuscript 的
/// `documentBlocks` 答复，职责是让作者按块勾选派发范围。
pub const DeskBlock = struct {
    /// 块 id（36 字节 uuid）。
    id: []const u8,
    /// 第几块，从 0 起。勾选位图与块段 scope 都按它点名。
    ordinal: usize,
    /// 块种类线名（`paragraph`／`heading:N`／`fence`／`table`）。
    kind: []const u8,
    /// 前 60 字符的预览（Rust 已按 char 切好）。
    peek: []const u8,
    /// 正文的字符数。
    chars: usize,
};

/// 读块清单的第 index 行。清单是 `documentBlocks` 答复的 value（调用方
/// 先过 `snapshot.value`）。缺 id 或 ordinal 的行交 null——点不了名的行
/// 只会让作者以为界面坏了。
pub fn deskBlockAt(listing: snapshot.Value, index: usize) ?DeskBlock {
    const rows = snapshot.array(listing, "blocks");
    const row = rows.at(index) orelse return null;
    const id = snapshot.stringField(row, "id") orelse return null;
    const ordinal = snapshot.unsignedField(row, "ordinal") orelse return null;
    return .{
        .id = id,
        .ordinal = @intCast(ordinal),
        .kind = snapshot.stringField(row, "kind") orelse "",
        .peek = snapshot.stringField(row, "peek") orelse "",
        .chars = @intCast(snapshot.unsignedField(row, "chars") orelse 0),
    };
}

/// 资料名录的一行：派发台「这轮给 agent 读什么」的勾选行。
pub const DeskMaterial = struct {
    /// Root 相对路径——勾选过河只带它。
    path: []const u8,
    /// 披露档位的中文读法。
    disclosure_label: []const u8,
};

/// 读资料名录的第 index 行。名录是 `materials` 答复的 value（调用方先过
/// `snapshot.value`）。缺 path 的行交 null——勾不了的行是死行。
pub fn materialAt(listing: snapshot.Value, index: usize) ?DeskMaterial {
    const rows = snapshot.array(listing, "materials");
    const row = rows.at(index) orelse return null;
    const path = snapshot.stringField(row, "path") orelse return null;
    return .{
        .path = path,
        .disclosure_label = disclosureLabel(snapshot.stringField(row, "disclosure")),
    };
}

/// 披露档位的中文读法。缺席（null）按默认档——与 Rust 读名录时
/// `unwrap_or_default` 同一个答案（retrievable）。措辞与文件树右键菜单
/// 的披露三档同一套（app_main 的 disclosureMsg 那处），不造第二份。
pub fn disclosureLabel(disclosure: ?[]const u8) []const u8 {
    const name = disclosure orelse return "可检索";
    if (std.mem.eql(u8, name, "outline-only")) return "只给目录";
    if (std.mem.eql(u8, name, "retrievable")) return "可检索";
    if (std.mem.eql(u8, name, "full")) return "全文可读";
    return "未知";
}

/// 一个 UTF-8 序列的字节长（坏字节当 1）。
fn charStep(ch: u8) usize {
    return std.unicode.utf8ByteSequenceLength(ch) catch 1;
}

/// 前 n 个字符占的字节数（char 边界安全）。
fn byteOffsetOfChar(text: []const u8, n: usize) usize {
    var count: usize = 0;
    var index: usize = 0;
    while (index < text.len and count < n) {
        index += charStep(text[index]);
        count += 1;
    }
    return index;
}

/// 字符数（不是字节数）。
fn charCount(text: []const u8) usize {
    var count: usize = 0;
    var index: usize = 0;
    while (index < text.len) {
        index += charStep(text[index]);
        count += 1;
    }
    return count;
}

fn putInto(buf: []u8, at: usize, bytes: []const u8) usize {
    @memcpy(buf[at..][0..bytes.len], bytes);
    return at + bytes.len;
}

/// 命中摘录：以命中点为中心、至多 `max` 个字符的一段，命中段用「」标出。
///
/// 在新鲜块文本上 indexOf 查询词定位（不信索引偏移——索引记忆的是它建成
/// 时的字节）。宽松召回的近音/异形命中 indexOf 找不到：画块头 max 字，
/// 不硬猜一个位置。上下文前不足补后、后不足补前；省略号只在截断的那一端
/// 出现。
///
/// 摘录带「」与 …，不是原文的切片——写进 `buf`，返回它的前缀。`buf`
/// 至少要 `4 * max + 12` 字节（全四字节字符加一对「」与两个 …）。
pub fn excerptAround(buf: []u8, text: []const u8, query: []const u8, max: usize) []const u8 {
    const total_chars = charCount(text);
    const hit_byte: ?usize = if (query.len > 0) std.mem.indexOf(u8, text, query) else null;
    // 摘录的字符区间 [lo, hi)：无命中取头 max 字；有命中以它为中心对半。
    var lo: usize = 0;
    var hi: usize = @min(max, total_chars);
    var hit_char: usize = 0;
    var hit_end: usize = 0;
    if (hit_byte) |byte| {
        hit_char = charCount(text[0..byte]);
        hit_end = hit_char + charCount(query);
        if (hit_end - hit_char >= max) {
            // 命中段自己顶到上限：从命中起点切 max 字。
            lo = hit_char;
            hi = hit_char + max;
        } else {
            const budget = max - (hit_end - hit_char);
            const avail_before = hit_char;
            const avail_after = total_chars - hit_end;
            var before = @min(budget / 2, avail_before);
            const after = @min(budget - before, avail_after);
            before = @min(budget - after, avail_before);
            lo = hit_char - before;
            hi = hit_end + after;
        }
    }
    var out: usize = 0;
    if (lo > 0) out = putInto(buf, out, "…");
    if (hit_byte == null) {
        out = putInto(buf, out, text[byteOffsetOfChar(text, lo)..byteOffsetOfChar(text, hi)]);
    } else {
        const match_hi = @min(hit_end, hi);
        out = putInto(buf, out, text[byteOffsetOfChar(text, lo)..byteOffsetOfChar(text, hit_char)]);
        out = putInto(buf, out, "「");
        out = putInto(buf, out, text[byteOffsetOfChar(text, hit_char)..byteOffsetOfChar(text, match_hi)]);
        out = putInto(buf, out, "」");
        if (match_hi < hi) {
            out = putInto(buf, out, text[byteOffsetOfChar(text, match_hi)..byteOffsetOfChar(text, hi)]);
        }
    }
    if (hi < total_chars) out = putInto(buf, out, "…");
    return buf[0..out];
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
    try std.testing.expectEqualStrings("取消", progressLabel("\"cancelled\""));
    try std.testing.expectEqualStrings(
        "已授权",
        progressLabel("{\"authorized\":{\"requestDigest\":\"d\"}}"),
    );
    // 失败带原因时说原因：作者据此决定重试还是放弃。
    try std.testing.expectEqualStrings(
        "失败：磁盘被占",
        progressLabel("{\"failed\":{\"failure\":\"磁盘被占\"}}"),
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
    try std.testing.expect(dispatched.collectable);
    try std.testing.expect(!dispatched.retryable);

    // 非终态都能取消：已授权（还没发射）也是。收取只在在途——结果只可能
    // 在送出之后出现。
    const authorized = runActions("{\"authorized\":{\"requestDigest\":\"d\"}}", false);
    try std.testing.expect(authorized.cancellable);
    try std.testing.expect(!authorized.collectable);
    try std.testing.expect(!authorized.retryable);
    // 开始仅在已授权：发令枪只在 Run 铸成之后、发射之前有意义（2.11）。
    try std.testing.expect(authorized.launchable);
    try std.testing.expect(!dispatched.launchable);

    const failed = runActions("{\"failed\":{\"failure\":\"boom\"}}", false);
    try std.testing.expect(!failed.cancellable);
    try std.testing.expect(!failed.collectable);
    try std.testing.expect(failed.retryable);

    // 待恢复的 Run 什么都不给：取消会被拒绝，重试与收取也不接受这个状态。
    const stranded = runActions("{\"dispatched\":{\"receipt\":\"r\"}}", true);
    try std.testing.expect(!stranded.cancellable);
    try std.testing.expect(!stranded.collectable);
    try std.testing.expect(!stranded.retryable);
    try std.testing.expect(stranded.needs_recovery);

    // 已完成的 Run 不给取消也不给重试——它已经结束了。
    const done = runActions("{\"completed\":{\"artifactDigest\":\"d\"}}", false);
    try std.testing.expect(!done.cancellable);
    try std.testing.expect(!done.collectable);
    try std.testing.expect(!done.retryable);
}

test "runs for a document are the intersection of its tasks and the run list" {
    const host =
        \\{"tasks":[{"id":"t1","document":"章一.md"},{"id":"t2","document":"章二.md"}],"runs":[{"id":"r1","taskId":"t1"},{"id":"r2","taskId":"t2"},{"id":"r3","taskId":"t1"}]}
    ;
    // 章一.md 的 Run 是 r1 与 r3：t2 那份稿子的 r2 不在内。
    const first = runsForDocument(host, "章一.md", 0).?;
    try std.testing.expectEqualStrings("r1", snapshot.stringField(first, "id").?);
    const second = runsForDocument(host, "章一.md", 1).?;
    try std.testing.expectEqualStrings("r3", snapshot.stringField(second, "id").?);
    try std.testing.expect(runsForDocument(host, "章一.md", 2) == null);
    // 没派发过的稿子一个 Run 也没有。
    try std.testing.expect(runsForDocument(host, "章三.md", 0) == null);
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

test "a competing proposal shares the scope but never the id" {
    const listing =
        \\{"kind":"proposals","value":{"proposals":[{"id":"p1","scope":"ch01:b3","beforeText":"甲。","afterText":"甲子。"},{"id":"p2","scope":"ch01:b3","beforeText":"甲。","afterText":"甲乙。"},{"id":"p3","scope":"ch01:b9","beforeText":"乙。","afterText":"乙丙。"}],"staged":[]}}
    ;
    const value = snapshot.value(listing);
    // p1 的竞争稿是同 scope 的 p2：同一段落，另一份答案。
    const peer = competitorOf(value, 0).?;
    try std.testing.expectEqualStrings("p2", peer.id);
    try std.testing.expectEqualStrings("甲乙。", peer.after_text);
    // p3 独占一个 scope：没有竞争稿可翻。
    try std.testing.expect(competitorOf(value, 2) == null);
    // 越界的行连自己都读不出来，谈不上竞争者。
    try std.testing.expect(competitorOf(value, 3) == null);
}

test "a stale recovery step reads in Chinese and an unknown code stays verbatim" {
    try std.testing.expectEqualStrings("看看 Agent 当时读到的是什么", staleStepLabel("compare-with-frozen-text"));
    try std.testing.expectEqualStrings("按现在的文字重新发一次", staleStepLabel("send-again"));
    try std.testing.expectEqualStrings("报告缺陷", staleStepLabel("report-defect"));
    // 不认识的码原样显示，不猜一个意思安上去。
    try std.testing.expectEqualStrings("brand-new-code", staleStepLabel("brand-new-code"));
}

test "a desk block row names its block and says how long it is" {
    const listing =
        \\{"blocks":[{"id":"b1","ordinal":0,"kind":"paragraph","peek":"第一段。","chars":4},{"id":"b2","ordinal":1,"kind":"heading:1","peek":"# 章","chars":3}],"next":null}
    ;
    const first = deskBlockAt(listing, 0).?;
    try std.testing.expectEqualStrings("b1", first.id);
    try std.testing.expectEqual(@as(usize, 0), first.ordinal);
    try std.testing.expectEqualStrings("paragraph", first.kind);
    try std.testing.expectEqualStrings("第一段。", first.peek);
    try std.testing.expectEqual(@as(usize, 4), first.chars);
    const second = deskBlockAt(listing, 1).?;
    try std.testing.expectEqualStrings("heading:1", second.kind);
    // 缺 id 或 ordinal 的行与越界都交出 null，不画死行。
    try std.testing.expect(deskBlockAt("{\"blocks\":[{\"ordinal\":0}]}", 0) == null);
    try std.testing.expect(deskBlockAt("{\"blocks\":[{\"id\":\"b\"}]}", 0) == null);
    try std.testing.expect(deskBlockAt(listing, 2) == null);
}

test "the excerpt centers on the hit and marks it with corner brackets" {
    var buf: [4 * 60 + 12]u8 = undefined;
    // 命中在中段：前后尽量对半。全 ASCII 好数：102 字符、命中在 50。
    const source: []const u8 = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxqqxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    const excerpt = excerptAround(&buf, source, "qq", 60);
    // 命中 2 字，预算 58：前 29 后 29。「」标出命中段，两端都在截断。
    try std.testing.expectEqualStrings(
        "…" ++ "x" ** 29 ++ "「qq」" ++ "x" ** 29 ++ "…",
        excerpt,
    );
}

test "the excerpt back-fills the short side and never splits a character" {
    var buf: [4 * 60 + 12]u8 = undefined;
    // 命中靠头（前不足补后）：查询词在第二段开头。
    const source = "开头二字。" ++ "剑" ** 100;
    const excerpt = excerptAround(&buf, source, "剑剑", 60);
    // 前 5 字全留，后面补足 60：5 + 2（命中）+ 53。汉字一个也不截半。
    try std.testing.expectEqualStrings("开头二字。「剑剑」" ++ "剑" ** 53 ++ "…", excerpt);
    // 宽松召回的近音命中 indexOf 找不到：画块头，不硬猜。
    const miss = excerptAround(&buf, source, "sword", 60);
    try std.testing.expectEqualStrings("开头二字。" ++ "剑" ** 55 ++ "…", miss);
    // 短块整段装得下：两端都没有省略号。
    const whole = excerptAround(&buf, "他握着剑。", "剑", 60);
    try std.testing.expectEqualStrings("他握着「剑」。", whole);
    // 命中段比上限还长：从命中起点切，后面截断（省略号照出）。
    const long_query = "剑" ** 80;
    const clipped = excerptAround(&buf, long_query, long_query, 60);
    try std.testing.expectEqualStrings("「" ++ "剑" ** 60 ++ "」" ++ "…", clipped);
}

test "a material row reads its path and the disclosure in Chinese" {
    const listing =
        \\{"materials":[{"path":"资料/人物志.md","disclosure":"outline-only"},{"path":"资料/年表.md","disclosure":null}],"truncated":false}
    ;
    const first = materialAt(listing, 0).?;
    try std.testing.expectEqualStrings("资料/人物志.md", first.path);
    try std.testing.expectEqualStrings("只给目录", first.disclosure_label);
    // 没设过档位（null）按默认档读：与 Rust 的 unwrap_or_default 同一个答案。
    const second = materialAt(listing, 1).?;
    try std.testing.expectEqualStrings("可检索", second.disclosure_label);
    // 缺 path 的行与越界都交出 null，不画死行。
    try std.testing.expect(materialAt("{\"materials\":[{\"disclosure\":\"full\"}]}", 0) == null);
    try std.testing.expect(materialAt(listing, 2) == null);
    // 认不出的档说「未知」，不落到某个已知档上。
    try std.testing.expectEqualStrings("未知", disclosureLabel("brand-new"));
    try std.testing.expectEqualStrings("全文可读", disclosureLabel("full"));
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
    /// 协议装载状态：none／current／stale，原文过桥，中文名归 skillLabel。
    skill: []const u8,
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
/// 徽章的中文标签。认不出的状态说「未知」——猜一种状态会让作者以为
/// 协议是对的或坏的，而它只是这份界面还不认识。
pub fn skillLabel(skill: []const u8) []const u8 {
    if (std.mem.eql(u8, skill, "none")) return "未装";
    if (std.mem.eql(u8, skill, "current")) return "协议最新";
    if (std.mem.eql(u8, skill, "stale")) return "协议过期";
    return "未知";
}

pub fn harnessAt(listing: snapshot.Value, index: usize) ?Harness {
    var rows = snapshot.arrayOf(listing);
    const row = rows.at(index) orelse return null;
    const id = snapshot.stringField(row, "id") orelse return null;
    const state = snapshot.stringField(row, "state") orelse "";
    return .{
        .id = id,
        .skill = snapshot.stringField(row, "skill") orelse "none",
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
    /// 这条记录的动作 id。回档按它点名，不是按序号——序号是给人读的。
    id: []const u8,
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
        // 没有 id 的行点不了名，画出来也是死行——与缺序号同一条跳过规则。
        .id = snapshot.stringField(row, "id") orelse return null,
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
    // id 是回档点名的依据，必须与序号一起读出来。
    try std.testing.expectEqualStrings("a", first.id);
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

/// 信箱里的一单在界面上的样子。
///
/// 行就是提案（信箱服务的投影）：作者在这一屏安排「先看哪封、放弃哪封」，
/// 已处理的可以冲销。格翻成中文，格名原文留着——安排动作要把它原样送回。
pub const MailboxEntry = struct {
    id: []const u8,
    document: []const u8,
    scope: []const u8,
    before_text: []const u8,
    after_text: []const u8,
    /// 格名原文（`draft`／`unread`／`done`），pin 与 discard 的点名依据。
    box_name: []const u8,
    /// 格的中文名。认不出的格说「未知」，不落到某个已知格上。
    box_label: []const u8,
    pinned: bool,
    /// 作者排过的位次。缺席表示从没排过——相邻交换按钮只在双方都有
    /// 位次时可用，缺席的单在自然序里，没有可交换的邻居。
    rank: ?u32,
};

/// 读信箱里的一单。缺 id 的行不画——点不了名的行只会让作者以为界面坏了。
pub fn mailboxEntryAt(listing: snapshot.Value, index: usize) ?MailboxEntry {
    var rows = snapshot.arrayOf(listing);
    const row = rows.at(index) orelse return null;
    const id = snapshot.stringField(row, "id") orelse return null;
    const box_name = snapshot.stringField(row, "boxName") orelse "";
    return .{
        .id = id,
        .document = snapshot.stringField(row, "document") orelse "",
        .scope = snapshot.stringField(row, "scope") orelse "",
        .before_text = snapshot.stringField(row, "beforeText") orelse "",
        .after_text = snapshot.stringField(row, "afterText") orelse "",
        .box_name = box_name,
        .box_label = boxLabel(box_name),
        .pinned = snapshot.boolField(row, "pinned") orelse false,
        .rank = if (snapshot.unsignedField(row, "rank")) |rank| @intCast(rank) else null,
    };
}

/// 三格的中文名。信箱跨文档合并，作者按格读出「这封到哪一步了」。
fn boxLabel(box_name: []const u8) []const u8 {
    if (std.mem.eql(u8, box_name, "draft")) return "草稿";
    if (std.mem.eql(u8, box_name, "unread")) return "未读";
    if (std.mem.eql(u8, box_name, "done")) return "已处理";
    return "未知";
}

/// 一条材料草稿的界面读法。body 随行走：行内编辑（2.2 的「改」）从它
/// 起笔，不必再发一次读。
pub const MaterialDraftRow = struct {
    id: []const u8,
    title: []const u8,
    kind: []const u8,
    /// 草稿正文：行内编辑的种子。
    body: []const u8,
};

/// 从草稿名录答复里读第 index 条。名录答复与成稿/退回的回执共用同一份
/// （动作之后界面不再发一次读），所以这里只认 `value` 是草稿数组的形状。
pub fn materialDraftAt(listing: snapshot.Value, index: usize) ?MaterialDraftRow {
    var rows = snapshot.arrayOf(listing);
    const row = rows.at(index) orelse return null;
    const id = snapshot.stringField(row, "id") orelse return null;
    return .{
        .id = id,
        .title = snapshot.stringField(row, "title") orelse "",
        .kind = snapshot.stringField(row, "kind") orelse "",
        .body = snapshot.stringField(row, "body") orelse "",
    };
}

/// 预览清单里一节的界面读法。
pub const ManifestRow = struct {
    section: []const u8,
    source: []const u8,
    bytes: u64,
    /// token 三态的中文读法：实测 / 约（估计）/ 说不上。
    tokens_label: []const u8,
};

/// 读派发预览清单的第 index 节。`package` 是预览答复的 value
/// （`DispatchPackage`：requestMd/manifest/digest/prefixBytes）。
pub fn manifestEntryAt(package: snapshot.Value, index: usize) ?ManifestRow {
    var entries = snapshot.array(package, "manifest");
    const entry = entries.at(index) orelse return null;
    const tokens = snapshot.field(entry, "tokens") orelse "";
    return .{
        .section = snapshot.stringField(entry, "section") orelse "",
        .source = snapshot.stringField(entry, "source") orelse "",
        .bytes = snapshot.unsignedField(entry, "bytes") orelse 0,
        .tokens_label = tokensLabel(tokens),
    };
}

/// token 三态（`Tokens` 的外部标签：{"actual":N}/{"estimated":N}/"unknown"）。
fn tokensLabel(tokens: snapshot.Value) []const u8 {
    if (snapshot.unsignedField(tokens, "actual")) |count| {
        _ = count;
        return "实测";
    }
    if (snapshot.unsignedField(tokens, "estimated")) |_| return "约";
    return "说不上";
}

test "a manifest row reads section source bytes and the token tri-state" {
    const package =
        \\{"requestMd":"# Before…","manifest":[
        \\{"section":"before","source":"章一.md","digest":"d1","bytes":1024,"tokens":{"estimated":512}},
        \\{"section":"contract","source":"skill","digest":"d2","bytes":100,"tokens":"unknown"}],
        \\"digest":"abcdef0123456789","prefixBytes":800}
    ;
    const first = manifestEntryAt(package, 0).?;
    try std.testing.expectEqualStrings("before", first.section);
    try std.testing.expectEqualStrings("章一.md", first.source);
    try std.testing.expectEqual(@as(u64, 1024), first.bytes);
    try std.testing.expectEqualStrings("约", first.tokens_label);
    const second = manifestEntryAt(package, 1).?;
    try std.testing.expectEqualStrings("说不上", second.tokens_label);
    try std.testing.expect(manifestEntryAt(package, 2) == null);
}

test "a material draft row reads id title and kind" {
    const listing =
        \\[{"id":"d1","title":"全文摘要","kind":"chapter-synopsis","basis":"[]","body":"这一章写河湾起雾。"},
        \\{"id":"d2","title":"人物志","kind":"character-profile","basis":"[]","body":"陆沉舟。"}]
    ;
    const first = materialDraftAt(listing, 0).?;
    try std.testing.expectEqualStrings("d1", first.id);
    try std.testing.expectEqualStrings("全文摘要", first.title);
    try std.testing.expectEqualStrings("chapter-synopsis", first.kind);
    // body 随行走：行内编辑（「改」）从它起笔，不必再发一次读。
    try std.testing.expectEqualStrings("这一章写河湾起雾。", first.body);
    const second = materialDraftAt(listing, 1).?;
    try std.testing.expectEqualStrings("d2", second.id);
    try std.testing.expect(materialDraftAt(listing, 2) == null);
}

test "a mailbox entry carries its box both raw and translated" {
    // 两个都要：中文给作者读，原文给安排动作点名——译名送回去会被具名拒绝。
    const listing =
        \\[{"id":"p1","document":"章一.md","scope":"b3","beforeText":"原文。","afterText":"改后。","boxName":"done","rank":1,"pinned":true},
        \\{"id":"p2","document":"章二.md","scope":"b1","beforeText":"另一段。","afterText":null,"boxName":"unread","rank":null,"pinned":false}]
    ;
    const first = mailboxEntryAt(listing, 0).?;
    try std.testing.expectEqualStrings("p1", first.id);
    try std.testing.expectEqualStrings("done", first.box_name);
    try std.testing.expectEqualStrings("已处理", first.box_label);
    try std.testing.expect(first.pinned);
    const second = mailboxEntryAt(listing, 1).?;
    try std.testing.expectEqualStrings("章二.md", second.document);
    try std.testing.expectEqualStrings("", second.after_text);
    try std.testing.expect(!second.pinned);
    // 认不出的格说「未知」：显示成一个已知格，作者会对一封草稿按冲销。
    const strange = "[{\"id\":\"p9\",\"boxName\":\"brandNew\"}]";
    try std.testing.expectEqualStrings("未知", mailboxEntryAt(strange, 0).?.box_label);
    // 缺 id 的行与越界都交出 null，不画死行。
    try std.testing.expect(mailboxEntryAt("[{\"boxName\":\"unread\"}]", 0) == null);
    try std.testing.expect(mailboxEntryAt(listing, 2) == null);
}

/// 一个 Agent 在设置面板上的样子：名字、身份模式、能不能切。
///
/// 二态的规则住在 `refrain_core::persona`：干活时作者写下的就是全部，
/// 扮演时应用补一套演法。线上 persona 是 `{"work":{…}}`／`{"cosplay":{…}}`
/// 或 `null`——模式名取变体键，与 `progressName` 取进度变体同一条路子。
pub const Agent = struct {
    id: []const u8,
    name: []const u8,
    /// 「干活」／「扮演」／「无身份」。认不出的模式说「未知」。
    mode_label: []const u8,
    /// 身份说明：作者写给这个 Agent 的那段字（persona body），逐字节。
    /// 没有身份就是空——「空说明」与「没有说明」是一回事。
    persona_body: []const u8,
    /// 这个 Agent 绑的连接 id（空 = L0 文件通道）。整份 upsert 时原样
    /// 回填——界面不编辑它，但写 null 会把作者手绑的连接静默抹掉
    /// （整份替换的语义：不写清就是丢掉）。
    connection_id: []const u8,
    /// 这个 Agent 的专属 argv 有几项。显示与编辑不共用同一份文本：
    /// 快照是借用模式（不分配），join 需要一块缓冲，而编辑框的草稿
    /// 在 Model 里（core 可分配）——所以这里只数出有几项，让作者
    /// 看见「有没有参数」，编辑时从空草稿重写。
    argv_count: usize,
    /// 有没有身份可切。无身份的 Agent 在 Rust 侧切无可切——按钮灰掉，
    /// 而不是让作者按下去什么也没发生。
    has_persona: bool,
};

/// 读 Agent 名录里的一位。缺 id 的行不画：切换要点名，点不了名是死行。
///
/// 身份说明在 `persona.<mode>.body` 两层嵌套下：`progressName` 读出变体
/// 键，body 用同一个键再下一层。argv 是数组，这里并成一段以空格相连的
/// 文本——显示与编辑共用同一个样子，作者看到的编辑框内容就是存进去
/// 的那份。
pub fn agentAt(listing: snapshot.Value, index: usize) ?Agent {
    var rows = snapshot.arrayOf(listing);
    const row = rows.at(index) orelse return null;
    const id = snapshot.stringField(row, "id") orelse return null;
    const persona = snapshot.field(row, "persona");
    const mode = if (persona) |raw| progressName(raw) else "";
    const workable = std.mem.eql(u8, mode, "work") or std.mem.eql(u8, mode, "cosplay");
    const body = if (persona) |raw| blk: {
        const branch = snapshot.field(raw, mode) orelse break :blk "";
        break :blk snapshot.stringField(branch, "body") orelse "";
    } else "";
    return .{
        .id = id,
        .name = snapshot.stringField(row, "name") orelse "",
        .mode_label = if (workable)
            (if (mode[0] == 'w') @as([]const u8, "干活") else "扮演")
        else if (mode.len == 0)
            "无身份"
        else
            "未知",
        .persona_body = body,
        // `connection_id` 缺席或 null 都是 L0 文件通道（serde default）。
        .connection_id = snapshot.stringField(row, "connection_id") orelse "",
        .argv_count = snapshot.array(row, "argv").count(),
        .has_persona = workable,
    };
}

test "an agent row reads its persona mode from the variant key" {
    const listing =
        \\[{"id":"a1","name":"编辑","persona":{"work":{"body":"改稿"}},"connection_id":"c9","argv":[]},
        \\{"id":"a2","name":"剑士","persona":{"cosplay":{"body":"台词少"}},"argv":[]},
        \\{"id":"a3","name":"裸机","persona":null,"argv":[]}]
    ;
    const worker = agentAt(listing, 0).?;
    try std.testing.expectEqualStrings("干活", worker.mode_label);
    try std.testing.expect(worker.has_persona);
    // 绑了连接的行读出连接 id（整份 upsert 要原样回填）；缺席是 L0 文件通道。
    try std.testing.expectEqualStrings("c9", worker.connection_id);
    const player = agentAt(listing, 1).?;
    try std.testing.expectEqualStrings("扮演", player.mode_label);
    try std.testing.expectEqualStrings("", player.connection_id);
    const bare = agentAt(listing, 2).?;
    try std.testing.expectEqualStrings("无身份", bare.mode_label);
    try std.testing.expect(!bare.has_persona);
    // 缺 id 的行与越界都交出 null，不画死行。
    try std.testing.expect(agentAt("[{\"name\":\"x\"}]", 0) == null);
    try std.testing.expect(agentAt(listing, 3) == null);
}

/// 一条已存连接的样子：为哪个适配器、跑哪个程序、带什么参数。
///
/// argv 只数项数不拼文本——快照是借用模式（不分配），join 需要一块
/// 缓冲；「有没有参数」与「具体是什么」之间，这里选前者，具体内容由
/// 作者在设置面板的伙伴编辑里重写。
pub const Connection = struct {
    /// 适配器的 kebab-case 词（`kimi-code`／`claude-code`／`pi`），与
    /// harness 行的程序名（`kimi`／`claude`／`pi`）不是同一个词——连接
    /// 按适配器点名，不按程序名猜。
    adapter: []const u8,
    executable: []const u8,
    argv_count: usize,
};

/// 读 Config 快照里的一条连接。缺 adapter 的行不画：连在哪一类 harness
/// 上都说不出，画出来只会让作者去猜。
pub fn connectionAt(listing: snapshot.Value, index: usize) ?Connection {
    var rows = snapshot.arrayOf(listing);
    const row = rows.at(index) orelse return null;
    return .{
        .adapter = snapshot.stringField(row, "adapter") orelse return null,
        .executable = snapshot.stringField(row, "executable") orelse "",
        .argv_count = snapshot.array(row, "argv").count(),
    };
}

test "a connection row counts its argv without joining it" {
    const listing =
        \\[{"id":"c1","adapter":"kimi-code","executable":"C:\\kimi.exe","argv":["--model","max"]},
        \\{"id":"c2","adapter":"pi","executable":"pi","argv":[]}]
    ;
    const first = connectionAt(listing, 0).?;
    try std.testing.expectEqualStrings("kimi-code", first.adapter);
    try std.testing.expectEqual(@as(usize, 2), first.argv_count);
    const second = connectionAt(listing, 1).?;
    try std.testing.expectEqualStrings("pi", second.adapter);
    try std.testing.expectEqual(@as(usize, 0), second.argv_count);
    try std.testing.expect(connectionAt("[{\"executable\":\"x\"}]", 0) == null);
    try std.testing.expect(connectionAt(listing, 2) == null);
}

/// 一条批注在界面上的样子。
///
/// 高亮与评论是同一列里的两种行：高亮只有它标的那段原文，评论还有正文。
/// 两种都读不出 `quote` 就不画——一条说不出自己标了什么的批注是死行。
pub const Annotation = struct {
    quote: []const u8,
    /// true 是评论（带 `body`），false 是高亮。
    comment: bool,
    body: []const u8,
};

/// 读一条批注。`comment` 缺了按高亮算：一条读不出种类的高亮被画成评论，
/// 作者会去找一段并不存在的评论正文。
pub fn annotationAt(listing: snapshot.Value, index: usize) ?Annotation {
    var rows = snapshot.arrayOf(listing);
    const row = rows.at(index) orelse return null;
    return .{
        .quote = snapshot.stringField(row, "quote") orelse return null,
        .comment = snapshot.boolField(row, "comment") orelse false,
        .body = snapshot.stringField(row, "body") orelse "",
    };
}

test "an annotation row tells a highlight from a comment" {
    const listing =
        \\[{"id":"a1","blockId":"b3","quote":"剑","comment":false,"body":""},
        \\{"id":"a2","blockId":"b9","quote":"太满了","comment":true,"body":"这里收一下"}]
    ;
    const highlight = annotationAt(listing, 0).?;
    try std.testing.expectEqualStrings("剑", highlight.quote);
    try std.testing.expect(!highlight.comment);
    const comment = annotationAt(listing, 1).?;
    try std.testing.expect(comment.comment);
    try std.testing.expectEqualStrings("这里收一下", comment.body);
    // 说不出自己标了什么的行不画；越界同样交出 null。
    try std.testing.expect(annotationAt("[{\"comment\":true}]", 0) == null);
    try std.testing.expect(annotationAt(listing, 2) == null);
}

/// 排版滑杆的一栏规格：字段名、量程、步距。
///
/// 量程就是 Rust `TypographyField::bounds`（crates/refrain-store/src/config.rs）——
/// 上下界是那些字段自己的性质（可读性的边界），界面不另立一份；两份量程
/// 漂开的表现是滑杆推到头还能点 +、或者 + 按不动了滑杆却没到头。
/// 步距沿用 ± 按钮的步距（5/5/10）：一个字段一种走法，作者从按钮学到的
/// 步距在滑杆上不变。
pub const TypographySliderSpec = struct {
    /// `adjustTypography` 的 field 词汇。
    field: []const u8,
    /// 量程下界（含）。单位与 delta 相同：字号是十分之一像素、行高是
    /// 百分点、行长是十分之一 em。
    min_units: i32,
    max_units: i32,
    step_units: i32,
};

/// 按 field 词汇取规格。不在词汇表里的字段是编译错误——词汇表以 Rust 为准，
/// 这里多一个词就是第二份权威。
pub fn typographySliderSpec(comptime field: []const u8) TypographySliderSpec {
    if (comptime std.mem.eql(u8, field, "textSize")) {
        return .{ .field = field, .min_units = 100, .max_units = 400, .step_units = 5 };
    }
    if (comptime std.mem.eql(u8, field, "lineHeight")) {
        return .{ .field = field, .min_units = 120, .max_units = 300, .step_units = 5 };
    }
    if (comptime std.mem.eql(u8, field, "measure")) {
        return .{ .field = field, .min_units = 200, .max_units = 1200, .step_units = 10 };
    }
    @compileError("unknown typography field: " ++ field);
}

/// 滑杆比例 → 字段单位，贴到步距上。
///
/// SDK 的 slider 部件只报 0..1 的比例（指针在轨上的相对位置），量程与步距
/// 是应用自己的事。比例先钳再算——拖到轨外是指针手势的常态，撞界停界
/// 不绕回（与 Rust 钳位同一句话）。贴步距让一次拖动的落盘次数被步数
/// 而不是帧率限住：没跨步的比例变化换算出相同的值，界面据此不发请求。
pub fn sliderSnap(spec: TypographySliderSpec, fraction: f32) i32 {
    const clamped = std.math.clamp(fraction, @as(f32, 0), @as(f32, 1));
    const min: f32 = @floatFromInt(spec.min_units);
    const max: f32 = @floatFromInt(spec.max_units);
    const step: f32 = @floatFromInt(spec.step_units);
    const raw = min + clamped * (max - min);
    const snapped = @round(raw / step) * step;
    return @intFromFloat(std.math.clamp(snapped, min, max));
}

/// 字段单位 → 滑杆比例（画拇指位置用）。当前值落在量程外（旧配置、
/// 还没读到）时钳到端点——拇指永远停在轨上，不替作者猜一个位置。
pub fn sliderFraction(spec: TypographySliderSpec, current_units: i32) f32 {
    const span: f32 = @floatFromInt(spec.max_units - spec.min_units);
    const offset: f32 = @floatFromInt(current_units - spec.min_units);
    return std.math.clamp(offset / span, @as(f32, 0), @as(f32, 1));
}

test "typography slider specs mirror the Rust field bounds" {
    const text_size = typographySliderSpec("textSize");
    try std.testing.expectEqual(@as(i32, 100), text_size.min_units);
    try std.testing.expectEqual(@as(i32, 400), text_size.max_units);
    try std.testing.expectEqual(@as(i32, 5), text_size.step_units);
    const line_height = typographySliderSpec("lineHeight");
    try std.testing.expectEqual(@as(i32, 120), line_height.min_units);
    try std.testing.expectEqual(@as(i32, 300), line_height.max_units);
    const measure = typographySliderSpec("measure");
    try std.testing.expectEqual(@as(i32, 200), measure.min_units);
    try std.testing.expectEqual(@as(i32, 1200), measure.max_units);
}

test "slider snap lands on steps and stops at the bounds" {
    const spec = typographySliderSpec("textSize");
    try std.testing.expectEqual(@as(i32, 100), sliderSnap(spec, 0));
    try std.testing.expectEqual(@as(i32, 400), sliderSnap(spec, 1));
    // 0.5 × 300 + 100 = 250，恰在步距上。
    try std.testing.expectEqual(@as(i32, 250), sliderSnap(spec, 0.5));
    // 没跨步的比例变化贴回同一步：0.41 → 223 → 225，0.42 → 226 → 225。
    try std.testing.expectEqual(@as(i32, 225), sliderSnap(spec, 0.41));
    try std.testing.expectEqual(@as(i32, 225), sliderSnap(spec, 0.42));
    // 轨外钳到端点，不绕回。
    try std.testing.expectEqual(@as(i32, 100), sliderSnap(spec, -0.5));
    try std.testing.expectEqual(@as(i32, 400), sliderSnap(spec, 1.5));
    // 行高的步距是 5 个百分点：0.5 → 210。
    try std.testing.expectEqual(@as(i32, 210), sliderSnap(typographySliderSpec("lineHeight"), 0.5));
}

test "slider fraction is the exact inverse on steps and clamps outside" {
    const spec = typographySliderSpec("measure");
    try std.testing.expectEqual(@as(f32, 0), sliderFraction(spec, 200));
    try std.testing.expectEqual(@as(f32, 1), sliderFraction(spec, 1200));
    try std.testing.expectEqual(@as(f32, 0.5), sliderFraction(spec, 700));
    try std.testing.expectEqual(@as(i32, 650), sliderSnap(spec, sliderFraction(spec, 650)));
    try std.testing.expectEqual(@as(f32, 0), sliderFraction(spec, 0));
    try std.testing.expectEqual(@as(f32, 1), sliderFraction(spec, 9999));
}

/// 选区统计：字数与段数。
///
/// 选中多少是作者写稿时常问的一句（「这段删了多少字」）。选区起止是全文
/// 字节偏移（host_bridge.zig 的 document_selection_*），而手里只有投影
/// 窗口的文本——统计在窗口与选区的交集上做，越出窗口的部分用 clipped
/// 如实标出（界面显示「+」），不假装数得出。
pub const SelectionStats = struct {
    /// UTF-8 码点数（数非延续字节）：中文一字一码点。
    chars: usize,
    /// 段数：选区内 \n\n 分隔符数 + 1（块与块在投影文本里以 \n\n 相接）。
    blocks: usize,
    /// 选区越出投影窗口：统计是下界。
    clipped: bool,
};

/// 数一数选区。没有选区（起止相同）交出 null——「选中 0 字」与「没选中」
/// 是同一件事，不该在状态行各说一句话。
pub fn selectionStats(text: []const u8, window_start: u64, sel_start: u64, sel_end: u64) ?SelectionStats {
    if (sel_end <= sel_start) return null;
    const window_end = window_start + @as(u64, @intCast(text.len));
    const clipped = sel_start < window_start or sel_end > window_end;
    const lo = @max(sel_start, window_start);
    const hi = @min(sel_end, window_end);
    if (hi <= lo) return .{ .chars = 0, .blocks = 0, .clipped = true };
    const slice = text[@intCast(lo - window_start)..@intCast(hi - window_start)];
    var chars: usize = 0;
    var separators: usize = 0;
    var index: usize = 0;
    while (index < slice.len) : (index += 1) {
        // 换行是结构不是字：数进字数会把段分隔也算成「写了两个字」。
        if (slice[index] & 0xC0 != 0x80 and slice[index] != '\n') chars += 1;
        if (slice[index] == '\n' and index + 1 < slice.len and slice[index + 1] == '\n') separators += 1;
    }
    return .{ .chars = chars, .blocks = separators + 1, .clipped = clipped };
}

/// 保存时刻的相对说法：刚刚 / N 秒前 / N 分钟前 / N 小时前。
///
/// 为什么相对而不是钟点：Zig 标准库没有本地时区（HH:MM:SS 要么 UTC、
/// 要么得调平台 API），而写稿时「三分钟前存的」比「12:03 存的」少一步
/// 心算。时钟歪斜（负值）按刚刚算，不向作者展示一个负数。
pub fn relativeSaveText(buf: []u8, elapsed_ms: i64) []const u8 {
    const clamped = @max(elapsed_ms, 0);
    const seconds = @divFloor(clamped, 1000);
    if (seconds < 5) return "刚刚";
    if (seconds < 60) return std.fmt.bufPrint(buf, "{d} 秒前", .{seconds}) catch "刚刚";
    const minutes = @divFloor(seconds, 60);
    if (minutes < 60) return std.fmt.bufPrint(buf, "{d} 分钟前", .{minutes}) catch "刚刚";
    return std.fmt.bufPrint(buf, "{d} 小时前", .{@divFloor(minutes, 60)}) catch "刚刚";
}

test "selection stats count code points and blocks inside the window" {
    const text = "你好，世界。\n\n第二段在这里。";
    // 全选窗口内：13 个码点（换行是结构不是字）、2 段。
    const whole = selectionStats(text, 100, 100, 100 + text.len).?;
    try std.testing.expectEqual(@as(usize, 13), whole.chars);
    try std.testing.expectEqual(@as(usize, 2), whole.blocks);
    try std.testing.expect(!whole.clipped);
    // 只选「你好」：窗口内 4 字节起、6 字节止（两个三字节字）。
    const part = selectionStats(text, 0, 0, 6).?;
    try std.testing.expectEqual(@as(usize, 2), part.chars);
    try std.testing.expectEqual(@as(usize, 1), part.blocks);
    // 起止相同 = 没选中。
    try std.testing.expect(selectionStats(text, 0, 5, 5) == null);
}

test "selection stats mark out-of-window parts as clipped" {
    const text = "abcdef\n\ngh";
    // 选区从窗口外开始：交集只有窗口内的 5 字节，clipped 标出下界语义。
    const left = selectionStats(text, 10, 0, 15).?;
    try std.testing.expectEqual(@as(usize, 5), left.chars);
    try std.testing.expect(left.clipped);
    // 选区整个在窗口外：数不出就如实说（0 + clipped），不编一个数。
    const outside = selectionStats(text, 100, 0, 50).?;
    try std.testing.expectEqual(@as(usize, 0), outside.chars);
    try std.testing.expect(outside.clipped);
    // 越出右缘同样标出：8 个码点（两个换行不算字）。
    const right = selectionStats(text, 0, 0, 999).?;
    try std.testing.expectEqual(@as(usize, 8), right.chars);
    try std.testing.expect(right.clipped);
}

test "relative save text speaks in coarse honest units" {
    var buf: [32]u8 = undefined;
    try std.testing.expectEqualStrings("刚刚", relativeSaveText(&buf, 0));
    try std.testing.expectEqualStrings("刚刚", relativeSaveText(&buf, 4999));
    try std.testing.expectEqualStrings("5 秒前", relativeSaveText(&buf, 5000));
    try std.testing.expectEqualStrings("59 秒前", relativeSaveText(&buf, 59_499));
    try std.testing.expectEqualStrings("1 分钟前", relativeSaveText(&buf, 60_000));
    try std.testing.expectEqualStrings("59 分钟前", relativeSaveText(&buf, 3_599_999));
    try std.testing.expectEqualStrings("1 小时前", relativeSaveText(&buf, 3_600_000));
    try std.testing.expectEqualStrings("刚刚", relativeSaveText(&buf, -3000));
}
