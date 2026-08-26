//! 项目界面：文件树、名录行，和它们上面的动作。
//!
//! **接上哪个功能**：`ProjectInput` 的十六个产品入口。规则、测试与跨界通道
//! 早就在 Rust 里，缺的一直是这一层——把答复画成行，把点击编成请求。
//!
//! **在全局逻辑中负责什么**：只画与只送。行的形状归 `generated/wire.zig`（由
//! `protocol/host.json` 生成），写法归 `project_request.zig`，游标不变量归
//! `core/roster.zig`，去处规则归 `core/workbench.zig`。这里一条规则也不复制
//! ——复制的那一刻就会出现「界面允许点、Rust 又拒绝」。
//!
//! **单元 11 之后这里少了一半。** 以前它还兼着「把一坨 JSON 读成行」，那一半
//! 连同 `snapshot.zig` 一起没了：Rust 直接送结构体。留下的是**判断**——
//! 一个状态该显示成哪句中文、选中的这一行现在允许哪些动作、一段命中怎么摘录。
//!
//! **中文字面量住在这里**，与去处表同一条纪律（core 子集不允许非 ASCII 进
//! rodata，NS9001）。而每一张读法表现在都 `switch` 在生成的枚举上：新增一个
//! 状态而忘了给它一句中文，是编译错误，不是一行「未知」。

const std = @import("std");
const wire = @import("generated/wire.zig");
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
pub fn documentRow(reply: wire.Reply, row: wire.DocumentRow) ?Row {
    const path = reply.text(row.path);
    if (path.len == 0) return null;
    return .{ .label = path, .detail = roleLabel(row.role) };
}

/// 文档角色的中文名。
///
/// 未知角色照实说「未知」，不猜一个：猜一个的代价是一份资料被显示成正文，
/// 作者据此把它派给 Agent 当稿子改。
pub fn roleLabel(role: wire.DocumentRole) []const u8 {
    return switch (role) {
        .chapter => "正文",
        .document => "文档",
        .material => "资料",
        .unknown => "未知",
    };
}

/// 一个 Run 在名录上说的话。
pub fn runRow(reply: wire.Reply, row: wire.RunRow) ?Row {
    const id = reply.text(row.id);
    if (id.len == 0) return null;
    return .{ .label = id, .detail = progressLabel(reply, row) };
}

/// Run 的状态的中文名。
///
/// 措辞的唯一权威是这里（v0.2.4 的七态表）：排队／已授权／启动／在途／
/// 完成／失败／取消。失败带原因时说原因——作者据此决定重试还是放弃。
///
/// 未知状态照实说「未知」：把它显示成某个已知状态，作者会对一个还在跑的 Run
/// 按下取消并以为它已经结束。
pub fn progressLabel(reply: wire.Reply, row: wire.RunRow) []const u8 {
    return switch (row.progress) {
        .authorized => "已授权",
        .queued => "排队",
        .launching => "启动",
        .dispatched => "在途",
        .completed => "完成",
        .failed => failedLabel(reply.text(row.failure)),
        .cancelled => "取消",
        .unknown => "未知",
    };
}

/// 「失败：{原因}」要拼一个字串，而 `ui.text` 存切片不拷贝：字节必须活到
/// 这棵树死。它因此与请求字节同一个去处——这一道 build 的 arena。
///
/// 旧形是四个轮换的槽，而派遣台一屏 `shell.card_rows` = 24 行、每行一个
/// 标签：第五行起写回第一个槽，而第一行那个 `ui.text` 还指着它——失败的
/// Run 于是显示另一个 Run 的原因，这一条在屏幕上直接可见（F-02）。
///
/// 分配不到就退回无原因的「失败」（静态字面，永远活着）：少说，不说错。
/// 单条上限沿用旧形的 288 B，截断落在 char 边界上——半个字不是预览，是坏字节。
const progress_label_max_bytes: usize = 288;

fn failedLabel(reason: []const u8) []const u8 {
    if (reason.len == 0) return "失败";
    var len: usize = @min(reason.len, progress_label_max_bytes);
    // 真的截了才退到 char 边界：continuation 字节（10xxxxxx）不是字符起点。
    while (len > 0 and len < reason.len and (reason[len] & 0xC0) == 0x80) len -= 1;
    return project_request.keepPrint("失败：{s}", .{reason[0..len]}) orelse "失败";
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

pub fn runActions(row: wire.RunRow) RunActions {
    if (row.needs_recovery) {
        return .{
            .cancellable = false,
            .retryable = false,
            .collectable = false,
            .launchable = false,
            .needs_recovery = true,
        };
    }
    return switch (row.progress) {
        .queued, .launching => .{
            .cancellable = true,
            .retryable = false,
            .collectable = false,
            .launchable = false,
            .needs_recovery = false,
        },
        .authorized => .{
            .cancellable = true,
            .retryable = false,
            .collectable = false,
            .launchable = true,
            .needs_recovery = false,
        },
        .dispatched => .{
            .cancellable = true,
            .retryable = false,
            .collectable = true,
            .launchable = false,
            .needs_recovery = false,
        },
        .failed, .cancelled => .{
            .cancellable = false,
            .retryable = true,
            .collectable = false,
            .launchable = false,
            .needs_recovery = false,
        },
        // 完成与未知都不给动作：前者已经结束，后者是这份界面还不认识的状态，
        // 而对一个读不懂的状态按下任何键都是在赌。
        .completed, .unknown => .{
            .cancellable = false,
            .retryable = false,
            .collectable = false,
            .launchable = false,
            .needs_recovery = false,
        },
    };
}

/// 这份文档的第 index 个 Run。
///
/// tasks × runs 的内连接现在在 Rust 侧做（`RunRow.document`）：界面以前要为
/// 每一行走一遍两张表，而配对本来就是那一侧知道的事。
pub fn runsForDocument(reply: wire.Reply, path: []const u8, index: usize) ?wire.RunRow {
    const head = reply.head(.host) orelse return null;
    var seen: usize = 0;
    for (reply.rows(wire.RunRow, head.runs)) |row| {
        if (!std.mem.eql(u8, reply.text(row.document), path)) continue;
        if (seen == index) return row;
        seen += 1;
    }
    return null;
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
    /// 这条答复带不带 Root。读设置与 KARA 不带，缺席即保留现值——一条空的
    /// root_id 会让下一次「按 root 读」失去收件人。
    carries_root: bool,
    /// 这条答复带不带目录游标与总数。同上：不带的答复不该把它们清零。
    carries_documents: bool,
};

const no_facts = Facts{
    .root_id = "",
    .document_cursor = "",
    .document_count = 0,
    .document_total = 0,
    .roster_count = 0,
    .carries_root = false,
    .carries_documents = false,
};

/// 读一段答复里的事实。读不懂就交出全空——上层据此保留当前状态。
pub fn facts(reply: wire.Reply) Facts {
    return switch (reply.kind()) {
        .opened => blk: {
            const head = reply.head(.opened) orelse break :blk no_facts;
            break :blk .{
                .root_id = reply.text(head.root_id),
                .document_cursor = reply.text(head.document_cursor),
                .document_count = @intCast(reply.rows(wire.DocumentRow, head.documents).len),
                // 真实条数由答复自己带：界面数 `documents.len()` 得到的是
                // 「装得下的那些」，而作者读成的是「一共这么多」。
                .document_total = head.document_total,
                .roster_count = 0,
                .carries_root = true,
                .carries_documents = true,
            };
        },
        .page => blk: {
            const head = reply.head(.page) orelse break :blk no_facts;
            break :blk .{
                .root_id = "",
                .document_cursor = reply.text(head.document_cursor),
                .document_count = @intCast(reply.rows(wire.DocumentRow, head.documents).len),
                .document_total = head.document_total,
                .roster_count = 0,
                .carries_root = false,
                .carries_documents = true,
            };
        },
        .host => blk: {
            const head = reply.head(.host) orelse break :blk no_facts;
            break :blk .{
                .root_id = "",
                .document_cursor = "",
                .document_count = 0,
                .document_total = 0,
                // 名录数的是 Run。`run_total` 是真实条数（含为装进 ABI 而丢掉的），
                // 画出来的却只能是手上这些——两者都要，差额是可见事实。
                .roster_count = @intCast(reply.rows(wire.RunRow, head.runs).len),
                .carries_root = false,
                .carries_documents = false,
            };
        },
        .documents => blk: {
            const head = reply.head(.documents) orelse break :blk no_facts;
            const count: u32 = @intCast(reply.rows(wire.DocumentRow, head.documents).len);
            break :blk .{
                .root_id = "",
                .document_cursor = "",
                .document_count = count,
                .document_total = count,
                .roster_count = 0,
                .carries_root = false,
                .carries_documents = false,
            };
        },
        .blocks => blk: {
            const head = reply.head(.blocks) orelse break :blk no_facts;
            const count: u32 = @intCast(reply.rows(wire.HitRow, head.hits).len);
            break :blk .{
                .root_id = "",
                .document_cursor = "",
                .document_count = count,
                .document_total = count,
                .roster_count = 0,
                .carries_root = false,
                .carries_documents = false,
            };
        },
        else => no_facts,
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
///
/// 「判过了吗」由 Rust 逐行答（`ProposalRow.staged`）：账本里存的是账本行 id，
/// 而界面画的是提案行，配对在那一侧做过一次，这里就不必再走一遍名单。
pub fn proposalAt(reply: wire.Reply, index: usize) ?Proposal {
    const head = reply.head(.proposals) orelse return null;
    const row = reply.row(wire.ProposalRow, head.proposals, index) orelse return null;
    const id = reply.text(row.id);
    if (id.len == 0) return null;
    return .{
        .id = id,
        .scope = reply.text(row.scope),
        .before_text = reply.text(row.before_text),
        // 空的 after_text 是「只留评论」，不是读失败——两者在界面上是不同的
        // 行：前者不该显示一个空的「改成」。
        .after_text = reply.text(row.after_text),
        .staged = row.staged,
    };
}

/// 这份文档上有几条提案。
pub fn proposalCount(reply: wire.Reply) usize {
    const head = reply.head(.proposals) orelse return 0;
    return reply.rows(wire.ProposalRow, head.proposals).len;
}

/// 同一 scope 上的另一条提案：这一条的竞争稿。
///
/// 并列方案共享一个 scope（改的是同一段），靠 id 区分——裁决台翻 B 面
/// （Alt+P）时按它取稿。找不到交出 null：界面据此说「这一条没有竞争稿」，
/// 而不是画一段凭空的对照。
pub fn competitorOf(reply: wire.Reply, index: usize) ?Proposal {
    const current = proposalAt(reply, index) orelse return null;
    var other: usize = 0;
    while (proposalAt(reply, other)) |candidate| : (other += 1) {
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
/// 与搜索命中的 `HitRow` 不是同一族：这行来自活 Manuscript 的
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

/// 读块清单的第 index 行。缺 id 的行交 null——点不了名的行只会让作者以为
/// 界面坏了。
pub fn deskBlockAt(reply: wire.Reply, index: usize) ?DeskBlock {
    const head = reply.head(.document_blocks) orelse return null;
    const row = reply.row(wire.DeskBlockRow, head.blocks, index) orelse return null;
    const id = reply.text(row.id);
    if (id.len == 0) return null;
    return .{
        .id = id,
        .ordinal = row.ordinal,
        .kind = reply.text(row.kind),
        .peek = reply.text(row.peek),
        .chars = row.chars,
    };
}

/// 资料名录的一行：派发台「这轮给 agent 读什么」的勾选行。
pub const DeskMaterial = struct {
    /// Root 相对路径——勾选过河只带它。
    path: []const u8,
    /// 披露档位的中文读法。
    disclosure_label: []const u8,
};

/// 读资料名录的第 index 行。缺 path 的行交 null——勾不了的行是死行。
pub fn materialAt(reply: wire.Reply, index: usize) ?DeskMaterial {
    const head = reply.head(.materials) orelse return null;
    const row = reply.row(wire.MaterialRow, head.materials, index) orelse return null;
    const path = reply.text(row.path);
    if (path.len == 0) return null;
    return .{ .path = path, .disclosure_label = disclosureLabel(row.disclosure) };
}

/// 披露档位的中文读法。缺席在 Rust 侧已经按默认档（可检索）答完，与它读名录时
/// `unwrap_or_default` 同一个答案。措辞与文件树右键菜单的披露三档同一套
/// （app_main 的 disclosureMsg 那处），不造第二份。
pub fn disclosureLabel(disclosure: wire.Disclosure) []const u8 {
    return switch (disclosure) {
        .outline_only => "只给目录",
        .retrievable => "可检索",
        .full => "全文可读",
        .unknown => "未知",
    };
}

/// 一个 Harness 在这台机器上的样子。
///
/// 状态与等级都翻成中文：作者看的是「装好了 · 能取消」，不是 `ready` / `launch`。
pub const Harness = struct {
    id: []const u8,
    /// 协议装载状态的中文名。
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

/// 协议装载状态的中文名。认不出的说「未知」——猜一种状态会让作者以为协议是
/// 对的或坏的，而它只是这份界面还不认识。
pub fn skillLabel(skill: wire.HarnessSkill) []const u8 {
    return switch (skill) {
        .none => "未装",
        .current => "协议最新",
        .stale => "协议过期",
        .unknown => "未知",
    };
}

/// 读一行 Harness。缺 id 的行不画：一个没有身份的连接点不下去。
pub fn harnessAt(reply: wire.Reply, index: usize) ?Harness {
    const head = reply.head(.harnesses) orelse return null;
    const row = reply.row(wire.HarnessRow, head.harnesses, index) orelse return null;
    const id = reply.text(row.id);
    if (id.len == 0) return null;
    return .{
        .id = id,
        .skill = skillLabel(row.skill),
        .program = reply.text(row.program),
        .state = harnessStateLabel(row.state),
        .version = reply.text(row.version),
        .tier = harnessTierLabel(row.tier),
        .ready = row.state == .ready,
    };
}

/// 这一行的 skill 原样（给徽章排序或调试用）。
pub fn harnessSkillOf(reply: wire.Reply, index: usize) wire.HarnessSkill {
    const head = reply.head(.harnesses) orelse return .unknown;
    const row = reply.row(wire.HarnessRow, head.harnesses, index) orelse return .unknown;
    return row.skill;
}

/// 「没装」与「装了但读不出来」要分开说。
///
/// 合成一句「不可用」，作者会去装一个他已经装了的程序——而真正坏的是
/// PATH 上那个同名的东西，或者那个可执行文件本身。
fn harnessStateLabel(state: wire.HarnessState) []const u8 {
    return switch (state) {
        .ready => "装好了",
        .not_installed => "没装",
        .unreadable => "装了，但读不出版本",
        .unknown => "状况不明",
    };
}

/// 等级决定这个 Harness 能做什么，作者在派发之前就该看见。
fn harnessTierLabel(tier: wire.HarnessTier) []const u8 {
    return switch (tier) {
        .usage => "能报用量",
        .launch => "能取消",
        .file => "只能写文件",
        .none => "",
    };
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

/// 读一行改动记录。缺 id 或序号的行不画：第 0 步不存在，画出来作者会以为
/// 链的起点在那里。
pub fn changeAt(reply: wire.Reply, index: usize) ?Change {
    const head = reply.head(.history) orelse return null;
    const row = reply.row(wire.ChangeRow, head.changes, index) orelse return null;
    const id = reply.text(row.id);
    if (id.len == 0 or row.ordinal == 0) return null;
    return .{
        .id = id,
        .ordinal = row.ordinal,
        .cause = reply.text(row.cause),
        .undone = row.undone,
    };
}

/// 信箱里的一单在界面上的样子。
///
/// 行就是提案（信箱服务的投影）：作者在这一屏安排「先看哪封、放弃哪封」，
/// 已处理的可以冲销。
pub const MailboxEntry = struct {
    id: []const u8,
    document: []const u8,
    scope: []const u8,
    before_text: []const u8,
    after_text: []const u8,
    /// 格的线上值。pin 与 discard 的点名依据——安排动作把它原样送回。
    box: wire.MailboxBox,
    /// 格的中文名。认不出的格说「未知」，不落到某个已知格上。
    box_label: []const u8,
    pinned: bool,
    /// 作者排过的位次。缺席表示从没排过——相邻交换按钮只在双方都有
    /// 位次时可用，缺席的单在自然序里，没有可交换的邻居。
    rank: ?u32,
};

/// 读信箱里的一单。缺 id 的行不画——点不了名的行只会让作者以为界面坏了。
pub fn mailboxEntryAt(reply: wire.Reply, index: usize) ?MailboxEntry {
    const head = reply.head(.mailbox) orelse return null;
    const row = reply.row(wire.MailboxRow, head.entries, index) orelse return null;
    const id = reply.text(row.id);
    if (id.len == 0) return null;
    return .{
        .id = id,
        .document = reply.text(row.document),
        .scope = reply.text(row.scope),
        .before_text = reply.text(row.before_text),
        .after_text = reply.text(row.after_text),
        .box = row.box_name,
        .box_label = boxLabel(row.box_name),
        .pinned = row.pinned,
        .rank = if (row.ranked) row.rank else null,
    };
}

/// 三格的中文名。信箱跨文档合并，作者按格读出「这封到哪一步了」。
fn boxLabel(box: wire.MailboxBox) []const u8 {
    return switch (box) {
        .draft => "草稿",
        .unread => "未读",
        .done => "已处理",
        .unknown => "未知",
    };
}

/// 格的线名：安排动作要把它原样送回，译名送回去会被具名拒绝。
pub fn boxWireName(box: wire.MailboxBox) []const u8 {
    return switch (box) {
        .draft => "draft",
        .unread => "unread",
        .done => "done",
        .unknown => "",
    };
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
/// （动作之后界面不再发一次读）。
pub fn materialDraftAt(reply: wire.Reply, index: usize) ?MaterialDraftRow {
    const head = reply.head(.material_drafts) orelse return null;
    const row = reply.row(wire.MaterialDraftRow, head.drafts, index) orelse return null;
    const id = reply.text(row.id);
    if (id.len == 0) return null;
    return .{
        .id = id,
        .title = reply.text(row.title),
        .kind = reply.text(row.kind),
        .body = reply.text(row.body),
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

/// 读派发预览清单的第 index 节。
pub fn manifestEntryAt(reply: wire.Reply, index: usize) ?ManifestRow {
    const head = reply.head(.dispatch_preview) orelse return null;
    const row = reply.row(wire.ManifestRow, head.manifest, index) orelse return null;
    return .{
        .section = reply.text(row.section),
        .source = reply.text(row.source),
        .bytes = row.bytes,
        .tokens_label = tokensLabel(row.tokens),
    };
}

/// token 三态的中文读法。
fn tokensLabel(tokens: wire.Tokens) []const u8 {
    return switch (tokens) {
        .actual => "实测",
        .estimated => "约",
        .unknown => "说不上",
    };
}

/// 一个 Agent 在设置面板上的样子：名字、身份模式、能不能切。
///
/// 二态的规则住在 `refrain_core::persona`：干活时作者写下的就是全部，
/// 扮演时应用补一套演法。
pub const Agent = struct {
    id: []const u8,
    name: []const u8,
    /// 「干活」／「扮演」／「无身份」。认不出的模式说「未知」。
    mode_label: []const u8,
    /// 身份说明：作者写给这个 Agent 的那段字（persona body），逐字节。
    /// 没有身份就是空——「空说明」与「没有说明」是一回事。
    persona_body: []const u8,
    /// 这个 Agent 绑的连接 id（空 = L0 文件通道）。整份 upsert 时原样
    /// 回填——界面不编辑它，但写 null 会把作者手绑的连接静默抹掉。
    connection_id: []const u8,
    /// 这个 Agent 的专属 argv 有几项。显示与编辑不共用同一份文本：
    /// 「有没有参数」在这里，具体内容由作者在伙伴编辑里重写。
    argv_count: usize,
    /// 有没有身份可切。无身份的 Agent 在 Rust 侧切无可切——按钮灰掉，
    /// 而不是让作者按下去什么也没发生。
    has_persona: bool,
};

/// 读 Agent 名录里的一位。缺 id 的行不画：切换要点名，点不了名是死行。
pub fn agentAt(reply: wire.Reply, index: usize) ?Agent {
    const head = reply.head(.config) orelse return null;
    const row = reply.row(wire.AgentRow, head.agents, index) orelse return null;
    const id = reply.text(row.id);
    if (id.len == 0) return null;
    return .{
        .id = id,
        .name = reply.text(row.name),
        .mode_label = switch (row.mode) {
            .work => "干活",
            .cosplay => "扮演",
            .none => "无身份",
            .unknown => "未知",
        },
        .persona_body = reply.text(row.persona_body),
        .connection_id = reply.text(row.connection_id),
        .argv_count = row.argv_count,
        .has_persona = row.mode == .work or row.mode == .cosplay,
    };
}

/// 这一位 Agent 的身份模式线名：切换动作要把它原样送回。
pub fn agentModeName(mode: wire.PersonaMode) []const u8 {
    return switch (mode) {
        .work => "work",
        .cosplay => "cosplay",
        .none, .unknown => "",
    };
}

/// 读第 index 位 Agent 的身份模式。
pub fn agentModeAt(reply: wire.Reply, index: usize) wire.PersonaMode {
    const head = reply.head(.config) orelse return .none;
    const row = reply.row(wire.AgentRow, head.agents, index) orelse return .none;
    return row.mode;
}

/// 一条已存连接的样子：为哪个适配器、跑哪个程序、带几项参数。
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
pub fn connectionAt(reply: wire.Reply, index: usize) ?Connection {
    const head = reply.head(.config) orelse return null;
    const row = reply.row(wire.ConnectionRow, head.connections, index) orelse return null;
    const adapter = reply.text(row.adapter);
    if (adapter.len == 0) return null;
    return .{
        .adapter = adapter,
        .executable = reply.text(row.executable),
        .argv_count = row.argv_count,
    };
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

/// 读一条批注。
pub fn annotationAt(reply: wire.Reply, index: usize) ?Annotation {
    const head = reply.head(.annotations) orelse return null;
    const row = reply.row(wire.AnnotationRow, head.annotations, index) orelse return null;
    const quote = reply.text(row.quote);
    if (quote.len == 0) return null;
    return .{ .quote = quote, .comment = row.comment, .body = reply.text(row.body) };
}

/// 一次裁决落盘的结局，讲成作者读得懂的一句话。
///
/// **三态各说各的**：正文落盘但派生状态待修，与磁盘被别人改过，是两件不同
/// 的事。把它们讲成同一句「保存失败」，作者会对第二种按重试，而那正是会
/// 覆盖别人改动的动作。
pub fn decisionMessage(reply: wire.Reply) []const u8 {
    const head = reply.head(.decided) orelse return "";
    return switch (head.state) {
        .durable => "已接受并落盘",
        .body_durable => "正文已落盘，历史待修复",
        .conflict => "磁盘上的正文已被别处改过，未覆盖",
        .none => "",
    };
}

/// 一次收取的结局，讲成一句话。
pub fn collectMessage(reply: wire.Reply) []const u8 {
    const head = reply.head(.collected) orelse return "";
    return switch (head.state) {
        .waiting => "结果还没出现",
        .completed => "已收取",
        .failed => "这一次派发失败",
        .none => "",
    };
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

test "a failed run keeps its own reason after the build writes more labels" {
    // F-02 的形状：派遣台一屏 24 行，每行一个标签。标签字节一旦回头覆盖，
    // 屏上直接可见：失败的 Run 显示另一个 Run 的原因。
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    project_request.bindBuildArena(arena.allocator());
    defer project_request.bindBuildArena(null);
    const first = failedLabel("第一个原因");
    var index: usize = 0;
    while (index < 24) : (index += 1) _ = failedLabel("后来的原因");
    try std.testing.expect(std.mem.indexOf(u8, first, "第一个原因") != null);
}

test "a build with nowhere to keep a label says less rather than wrong" {
    project_request.bindBuildArena(null);
    try std.testing.expectEqualStrings("失败", failedLabel("磁盘满了"));
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


// ---------------------------------------------- 读典型答复（单元 11 之后）

/// 一条答复的线上字节，测试专用。与 Rust 的 `wire::Writer` 同一条纪律：
/// 头留在最前面，行与文本追加在它后面，最后头被填回去——所以 `Rows` 与
/// `Str` 的偏移在写下它们的那一刻就是最终值。
const TestReply = struct {
    buf: [4096]u8 align(4) = @splat(0),
    len: usize = 0,

    fn init(self: *TestReply, comptime kind: wire.Kind) void {
        self.len = @sizeOf(wire.Header) + @sizeOf(wire.headType(kind));
        @memset(self.buf[0..self.len], 0);
    }

    fn text(self: *TestReply, value: []const u8) wire.Str {
        if (value.len == 0) return .{};
        const off = self.len;
        @memcpy(self.buf[off..][0..value.len], value);
        self.len += value.len;
        return .{ .off = @intCast(off), .len = @intCast(value.len) };
    }

    fn rows(self: *TestReply, comptime Shape: type, list: []const Shape) wire.Rows {
        while (self.len % 4 != 0) : (self.len += 1) self.buf[self.len] = 0;
        const off = self.len;
        for (list) |item| {
            @memcpy(self.buf[self.len..][0..@sizeOf(Shape)], std.mem.asBytes(&item));
            self.len += @sizeOf(Shape);
        }
        return .{ .off = @intCast(off), .len = @intCast(list.len) };
    }

    fn finish(self: *TestReply, comptime kind: wire.Kind, head: wire.headType(kind)) wire.Reply {
        const Head = wire.headType(kind);
        const header = wire.Header{
            .magic = wire.magic,
            .kind = @intFromEnum(kind),
            .bytes = @intCast(self.len),
        };
        @memcpy(self.buf[0..@sizeOf(wire.Header)], std.mem.asBytes(&header));
        @memcpy(self.buf[@sizeOf(wire.Header)..][0..@sizeOf(Head)], std.mem.asBytes(&head));
        return .{ .bytes = self.buf[0..self.len] };
    }
};

test "文件树的一行说出路径与它是哪一类文档" {
    var builder = TestReply{};
    builder.init(.opened);
    const row = wire.DocumentRow{ .path = builder.text("第一章.md"), .role = .chapter };
    const rows = builder.rows(wire.DocumentRow, &.{row});
    const reply = builder.finish(.opened, .{ .documents = rows });
    const rendered = documentRow(reply, row).?;
    try std.testing.expectEqualStrings("第一章.md", rendered.label);
    try std.testing.expectEqualStrings("正文", rendered.detail);
    // 没有路径的行不画：一个点不开的文件行只会让作者以为界面坏了。
    try std.testing.expect(documentRow(reply, .{}) == null);
    // 认不出的角色照实说「未知」——把一份资料显示成正文，作者会据此把它
    // 派给 Agent 当稿子改。
    try std.testing.expectEqualStrings("未知", roleLabel(.unknown));
}

test "一行 Harness 把「没装」与「装了但读不出来」分开说" {
    // 两者要作者做的事完全不同：一个去装，一个去查 PATH。合并它们，
    // 作者会去装一个他已经装了的程序。
    var builder = TestReply{};
    builder.init(.harnesses);
    const missing = wire.HarnessRow{
        .id = builder.text("kimi-print"),
        .program = builder.text("kimi"),
        .state = .not_installed,
        .tier = .file,
    };
    const broken = wire.HarnessRow{
        .id = builder.text("claude-print"),
        .program = builder.text("claude"),
        .state = .unreadable,
        .tier = .file,
    };
    const ready = wire.HarnessRow{
        .id = builder.text("pi-print"),
        .program = builder.text("pi"),
        .version = builder.text("1.2.3"),
        .state = .ready,
        .tier = .usage,
        .skill = .current,
    };
    const rows = builder.rows(wire.HarnessRow, &.{ missing, broken, ready });
    const reply = builder.finish(.harnesses, .{ .harnesses = rows });

    try std.testing.expectEqualStrings("没装", harnessAt(reply, 0).?.state);
    try std.testing.expectEqualStrings("装了，但读不出版本", harnessAt(reply, 1).?.state);
    try std.testing.expect(!harnessAt(reply, 0).?.ready and !harnessAt(reply, 1).?.ready);
    const third = harnessAt(reply, 2).?;
    try std.testing.expect(third.ready);
    try std.testing.expectEqualStrings("1.2.3", third.version);
    // 等级要说出来：作者按这个决定派给谁。「能报用量」与「能取消」是两件事。
    try std.testing.expectEqualStrings("能报用量", third.tier);
    try std.testing.expectEqualStrings("协议最新", third.skill);
    // 越界交出 null，不读过表尾。
    try std.testing.expect(harnessAt(reply, 3) == null);
}

test "已撤销的改动留在列表里标出来，而不是消失" {
    // 已撤销的行是作者做过的事。从列表里消失，他会以为自己记错了——
    // 而撤销本身是可以再撤销回来的。
    var builder = TestReply{};
    builder.init(.history);
    const undone = wire.ChangeRow{
        .id = builder.text("a"),
        .cause = builder.text("native text input"),
        .ordinal = 3,
        .undone = true,
    };
    const standing = wire.ChangeRow{
        .id = builder.text("b"),
        .cause = builder.text("verdict"),
        .ordinal = 2,
    };
    // 第 0 步不存在，缺 id 的行点不了名：两者都不画。
    const nameless = wire.ChangeRow{ .cause = builder.text("x"), .ordinal = 1 };
    const rows = builder.rows(wire.ChangeRow, &.{ undone, standing, nameless });
    const reply = builder.finish(.history, .{ .changes = rows });

    try std.testing.expect(changeAt(reply, 0).?.undone);
    try std.testing.expect(!changeAt(reply, 1).?.undone);
    // 序号保留：撤销不改变它在链上的位置。id 是回档点名的依据。
    try std.testing.expectEqual(@as(u64, 3), changeAt(reply, 0).?.ordinal);
    try std.testing.expectEqualStrings("a", changeAt(reply, 0).?.id);
    try std.testing.expect(changeAt(reply, 2) == null);
    try std.testing.expect(changeAt(reply, 3) == null);
}

test "信箱的一单同时带格的线上值与中文名" {
    // 两个都要：中文给作者读，线上值给安排动作点名——译名送回去会被具名拒绝。
    var builder = TestReply{};
    builder.init(.mailbox);
    const done = wire.MailboxRow{
        .id = builder.text("p1"),
        .document = builder.text("章一.md"),
        .before_text = builder.text("原文。"),
        .after_text = builder.text("改后。"),
        .rank = 1,
        .box_name = .done,
        .pinned = true,
        .ranked = true,
    };
    const unread = wire.MailboxRow{
        .id = builder.text("p2"),
        .document = builder.text("章二.md"),
        .box_name = .unread,
    };
    const nameless = wire.MailboxRow{ .box_name = .draft };
    const rows = builder.rows(wire.MailboxRow, &.{ done, unread, nameless });
    const reply = builder.finish(.mailbox, .{ .entries = rows });

    const first = mailboxEntryAt(reply, 0).?;
    try std.testing.expectEqualStrings("p1", first.id);
    try std.testing.expectEqualStrings("done", boxWireName(first.box));
    try std.testing.expectEqualStrings("已处理", first.box_label);
    try std.testing.expect(first.pinned);
    try std.testing.expectEqual(@as(?u32, 1), first.rank);
    const second = mailboxEntryAt(reply, 1).?;
    try std.testing.expectEqualStrings("章二.md", second.document);
    try std.testing.expectEqualStrings("", second.after_text);
    try std.testing.expect(!second.pinned);
    // 从没排过位次的单没有可交换的邻居——缺席与 0 是两回事。
    try std.testing.expect(second.rank == null);
    // 认不出的格说「未知」：显示成一个已知格，作者会对一封草稿按冲销。
    try std.testing.expectEqualStrings("未知", boxLabel(.unknown));
    // 缺 id 的行与越界都交出 null，不画死行。
    try std.testing.expect(mailboxEntryAt(reply, 2) == null);
    try std.testing.expect(mailboxEntryAt(reply, 3) == null);
}

test "一位 Agent 的身份模式与它能不能切一起读出来" {
    var builder = TestReply{};
    builder.init(.config);
    const worker = wire.AgentRow{
        .id = builder.text("a1"),
        .name = builder.text("编辑"),
        .persona_body = builder.text("改稿"),
        .connection_id = builder.text("c9"),
        .mode = .work,
    };
    const player = wire.AgentRow{
        .id = builder.text("a2"),
        .name = builder.text("剑士"),
        .persona_body = builder.text("台词少"),
        .mode = .cosplay,
        .argv_count = 2,
    };
    const bare = wire.AgentRow{ .id = builder.text("a3"), .name = builder.text("裸机") };
    const nameless = wire.AgentRow{ .name = builder.text("x") };
    const rows = builder.rows(wire.AgentRow, &.{ worker, player, bare, nameless });
    const reply = builder.finish(.config, .{ .agents = rows });

    const first = agentAt(reply, 0).?;
    try std.testing.expectEqualStrings("干活", first.mode_label);
    try std.testing.expect(first.has_persona);
    // 绑了连接的行读出连接 id（整份 upsert 要原样回填）；缺席是 L0 文件通道。
    try std.testing.expectEqualStrings("c9", first.connection_id);
    try std.testing.expectEqualStrings("work", agentModeName(agentModeAt(reply, 0)));
    const second = agentAt(reply, 1).?;
    try std.testing.expectEqualStrings("扮演", second.mode_label);
    try std.testing.expectEqualStrings("", second.connection_id);
    try std.testing.expectEqual(@as(usize, 2), second.argv_count);
    const third = agentAt(reply, 2).?;
    try std.testing.expectEqualStrings("无身份", third.mode_label);
    try std.testing.expect(!third.has_persona);
    // 缺 id 的行与越界都交出 null：切换要点名，点不了名是死行。
    try std.testing.expect(agentAt(reply, 3) == null);
    try std.testing.expect(agentAt(reply, 4) == null);
}

test "一条连接只数参数项数，不拼参数文本" {
    var builder = TestReply{};
    builder.init(.config);
    const first = wire.ConnectionRow{
        .adapter = builder.text("kimi-code"),
        .executable = builder.text("kimi.exe"),
        .argv_count = 2,
    };
    const second = wire.ConnectionRow{
        .adapter = builder.text("pi"),
        .executable = builder.text("pi"),
    };
    const nameless = wire.ConnectionRow{ .executable = builder.text("x") };
    const rows = builder.rows(wire.ConnectionRow, &.{ first, second, nameless });
    const reply = builder.finish(.config, .{ .connections = rows });

    try std.testing.expectEqualStrings("kimi-code", connectionAt(reply, 0).?.adapter);
    try std.testing.expectEqual(@as(usize, 2), connectionAt(reply, 0).?.argv_count);
    try std.testing.expectEqualStrings("pi", connectionAt(reply, 1).?.adapter);
    try std.testing.expectEqual(@as(usize, 0), connectionAt(reply, 1).?.argv_count);
    // 连在哪一类 harness 上都说不出的行不画，越界同样。
    try std.testing.expect(connectionAt(reply, 2) == null);
    try std.testing.expect(connectionAt(reply, 3) == null);
}

test "一条批注分得清高亮与评论" {
    var builder = TestReply{};
    builder.init(.annotations);
    const highlight = wire.AnnotationRow{ .quote = builder.text("剑") };
    const comment = wire.AnnotationRow{
        .quote = builder.text("太满了"),
        .body = builder.text("这里收一下"),
        .comment = true,
    };
    // 说不出自己标了什么的行不画。
    const mute = wire.AnnotationRow{ .comment = true };
    const rows = builder.rows(wire.AnnotationRow, &.{ highlight, comment, mute });
    const reply = builder.finish(.annotations, .{ .annotations = rows });

    try std.testing.expectEqualStrings("剑", annotationAt(reply, 0).?.quote);
    try std.testing.expect(!annotationAt(reply, 0).?.comment);
    try std.testing.expect(annotationAt(reply, 1).?.comment);
    try std.testing.expectEqualStrings("这里收一下", annotationAt(reply, 1).?.body);
    try std.testing.expect(annotationAt(reply, 2) == null);
    try std.testing.expect(annotationAt(reply, 3) == null);
}

test "预览清单的一节读出节名、来源、字节与 token 三态" {
    var builder = TestReply{};
    builder.init(.dispatch_preview);
    const before = wire.ManifestRow{
        .section = builder.text("before"),
        .source = builder.text("章一.md"),
        .bytes = 1024,
        .tokens = .estimated,
    };
    const contract = wire.ManifestRow{
        .section = builder.text("contract"),
        .source = builder.text("skill"),
        .bytes = 100,
    };
    const rows = builder.rows(wire.ManifestRow, &.{ before, contract });
    const digest = builder.text("abcdef0123456789");
    const reply = builder.finish(.dispatch_preview, .{ .manifest = rows, .digest = digest });

    const first = manifestEntryAt(reply, 0).?;
    try std.testing.expectEqualStrings("before", first.section);
    try std.testing.expectEqualStrings("章一.md", first.source);
    try std.testing.expectEqual(@as(u64, 1024), first.bytes);
    try std.testing.expectEqualStrings("约", first.tokens_label);
    try std.testing.expectEqualStrings("说不上", manifestEntryAt(reply, 1).?.tokens_label);
    try std.testing.expect(manifestEntryAt(reply, 2) == null);
}

test "一条材料草稿把正文随行带出来" {
    var builder = TestReply{};
    builder.init(.material_drafts);
    const first = wire.MaterialDraftRow{
        .id = builder.text("d1"),
        .title = builder.text("全文摘要"),
        .kind = builder.text("chapter-synopsis"),
        .body = builder.text("这一章写河湾起雾。"),
    };
    const second = wire.MaterialDraftRow{ .id = builder.text("d2"), .title = builder.text("人物志") };
    const rows = builder.rows(wire.MaterialDraftRow, &.{ first, second });
    const reply = builder.finish(.material_drafts, .{ .drafts = rows });

    const row = materialDraftAt(reply, 0).?;
    try std.testing.expectEqualStrings("d1", row.id);
    try std.testing.expectEqualStrings("全文摘要", row.title);
    try std.testing.expectEqualStrings("chapter-synopsis", row.kind);
    // body 随行走：行内编辑（「改」）从它起笔，不必再发一次读。
    try std.testing.expectEqualStrings("这一章写河湾起雾。", row.body);
    try std.testing.expectEqualStrings("d2", materialDraftAt(reply, 1).?.id);
    try std.testing.expect(materialDraftAt(reply, 2) == null);
}

test "资料名录的一行带它的披露档，缺席按默认档" {
    var builder = TestReply{};
    builder.init(.materials);
    const outline = wire.MaterialRow{
        .path = builder.text("设定.md"),
        .disclosure = .outline_only,
    };
    // Rust 侧读名录时 `unwrap_or_default`，所以缺席在过界之前就已经是可检索。
    const plain = wire.MaterialRow{ .path = builder.text("年表.md") };
    const nameless = wire.MaterialRow{ .disclosure = .full };
    const rows = builder.rows(wire.MaterialRow, &.{ outline, plain, nameless });
    const reply = builder.finish(.materials, .{ .materials = rows, .truncated = true });

    try std.testing.expectEqualStrings("只给目录", materialAt(reply, 0).?.disclosure_label);
    try std.testing.expectEqualStrings("可检索", materialAt(reply, 1).?.disclosure_label);
    // 勾不了的行是死行。
    try std.testing.expect(materialAt(reply, 2) == null);
    try std.testing.expect(reply.head(.materials).?.truncated);
}

test "派发台的一行块清单点得了名、说得出多长" {
    var builder = TestReply{};
    builder.init(.document_blocks);
    const first = wire.DeskBlockRow{
        .id = builder.text("b-1"),
        .kind = builder.text("paragraph"),
        .peek = builder.text("河湾起雾的那天。"),
        .ordinal = 0,
        .chars = 8,
    };
    const nameless = wire.DeskBlockRow{ .kind = builder.text("fence"), .ordinal = 1 };
    const rows = builder.rows(wire.DeskBlockRow, &.{ first, nameless });
    const reply = builder.finish(.document_blocks, .{ .blocks = rows, .next = 2 });

    const row = deskBlockAt(reply, 0).?;
    try std.testing.expectEqualStrings("b-1", row.id);
    try std.testing.expectEqualStrings("paragraph", row.kind);
    try std.testing.expectEqual(@as(usize, 8), row.chars);
    try std.testing.expect(deskBlockAt(reply, 1) == null);
    try std.testing.expectEqual(@as(u32, 2), reply.head(.document_blocks).?.next);
}

test "选中的这一行允许什么由状态自己说，不由「是不是终态」推断" {
    // F-08 的修法：旧栈为所有非终态 Run 显示「取消」，于是重启后的
    // Dispatched Run 上有一个后端必然拒绝的按钮。
    const dispatched = runActions(.{ .progress = .dispatched });
    try std.testing.expect(dispatched.cancellable and dispatched.collectable);
    try std.testing.expect(!dispatched.launchable and !dispatched.retryable);
    const authorized = runActions(.{ .progress = .authorized });
    try std.testing.expect(authorized.launchable and authorized.cancellable);
    try std.testing.expect(!authorized.collectable);
    const failed = runActions(.{ .progress = .failed });
    try std.testing.expect(failed.retryable and !failed.cancellable);
    const completed = runActions(.{ .progress = .completed });
    try std.testing.expect(!completed.cancellable and !completed.retryable);
    // 待恢复的 Run 一个动作都不给：取消会被拒绝，重试也不接受它。
    const stranded = runActions(.{ .progress = .dispatched, .needs_recovery = true });
    try std.testing.expect(!stranded.cancellable and !stranded.collectable);
    try std.testing.expect(stranded.needs_recovery);
    // 读不懂的状态同样不给动作——对一个读不懂的状态按下任何键都是在赌。
    const strange = runActions(.{ .progress = .unknown });
    try std.testing.expect(!strange.cancellable and !strange.retryable);
}

test "这份文档的 Run 只列这份文档的，连接由 Rust 做过一次" {
    // 失败原因要拼一段字，而拼出来的字节住在这一道 build 的 arena 里。
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    project_request.bindBuildArena(arena.allocator());
    defer project_request.bindBuildArena(null);
    var builder = TestReply{};
    builder.init(.host);
    const mine = wire.RunRow{
        .id = builder.text("r1"),
        .document = builder.text("章一.md"),
        .progress = .dispatched,
    };
    const other = wire.RunRow{
        .id = builder.text("r2"),
        .document = builder.text("章二.md"),
        .progress = .queued,
    };
    const also_mine = wire.RunRow{
        .id = builder.text("r3"),
        .document = builder.text("章一.md"),
        .failure = builder.text("adapter 退出码 1"),
        .progress = .failed,
    };
    const rows = builder.rows(wire.RunRow, &.{ mine, other, also_mine });
    const reply = builder.finish(.host, .{ .runs = rows, .run_total = 3 });

    try std.testing.expectEqualStrings("r1", reply.text(runsForDocument(reply, "章一.md", 0).?.id));
    try std.testing.expectEqualStrings("r3", reply.text(runsForDocument(reply, "章一.md", 1).?.id));
    // 别份稿子的 Run 不算进来，越界交出 null。
    try std.testing.expect(runsForDocument(reply, "章一.md", 2) == null);
    try std.testing.expectEqualStrings("r2", reply.text(runsForDocument(reply, "章二.md", 0).?.id));
    // 失败带原因时说原因——作者据此决定重试还是放弃。
    const the_failed = runsForDocument(reply, "章一.md", 1).?;
    try std.testing.expectEqualStrings("失败：adapter 退出码 1", progressLabel(reply, the_failed));
    try std.testing.expectEqualStrings("在途", progressLabel(reply, mine));
    try std.testing.expectEqualStrings("r1", runRow(reply, mine).?.label);
}

test "一条提案带前后文，判过的那条自己说" {
    var builder = TestReply{};
    builder.init(.proposals);
    const first = wire.ProposalRow{
        .id = builder.text("p-1"),
        .scope = builder.text("b3"),
        .before_text = builder.text("原文。"),
        .after_text = builder.text("甲"),
        .staged = true,
    };
    // 同一 scope 上的另一条：这一条的竞争稿。
    const competitor = wire.ProposalRow{
        .id = builder.text("p-2"),
        .scope = builder.text("b3"),
        .after_text = builder.text("乙"),
    };
    const nameless = wire.ProposalRow{ .scope = builder.text("b9") };
    const rows = builder.rows(wire.ProposalRow, &.{ first, competitor, nameless });
    const reply = builder.finish(.proposals, .{ .proposals = rows, .staged_count = 1 });

    try std.testing.expectEqual(@as(usize, 3), proposalCount(reply));
    const judged = proposalAt(reply, 0).?;
    try std.testing.expectEqualStrings("p-1", judged.id);
    try std.testing.expectEqualStrings("原文。", judged.before_text);
    try std.testing.expect(judged.staged);
    try std.testing.expect(!proposalAt(reply, 1).?.staged);
    // 只留评论的提案没有新文本，那不是读失败。
    try std.testing.expectEqualStrings("乙", proposalAt(reply, 1).?.after_text);
    try std.testing.expectEqualStrings("p-2", competitorOf(reply, 0).?.id);
    // 缺 id 的行不画；越界不是最后一行——那会让一次裁决落在别人身上。
    try std.testing.expect(proposalAt(reply, 2) == null);
    try std.testing.expect(proposalAt(reply, 3) == null);

    // 换了名录之后一律交出空，而不是在错的表里数行。
    var other = TestReply{};
    other.init(.documents);
    const documents = other.finish(.documents, .{});
    try std.testing.expectEqual(@as(usize, 0), proposalCount(documents));
    try std.testing.expect(proposalAt(documents, 0) == null);
}

test "答复带不带 Root 与目录，是两件要分开说的事" {
    // 读设置与 KARA 不带 Root：写一个空的进去，下一次「按 root 读」就失去
    // 了收件人。以前这靠「字段缺席」表达，现在靠 carries_* 说出来。
    var opened = TestReply{};
    opened.init(.opened);
    const root = opened.text("root-7");
    const cursor = opened.text("章三.md");
    const facts_opened = facts(opened.finish(.opened, .{
        .root_id = root,
        .document_cursor = cursor,
        .document_total = 256,
    }));
    try std.testing.expect(facts_opened.carries_root and facts_opened.carries_documents);
    try std.testing.expectEqualStrings("root-7", facts_opened.root_id);
    // 真实条数由答复自己带：数出来的是「装得下的那些」。
    try std.testing.expectEqual(@as(u32, 256), facts_opened.document_total);
    try std.testing.expectEqual(@as(u32, 0), facts_opened.document_count);

    var config = TestReply{};
    config.init(.config);
    const facts_config = facts(config.finish(.config, .{}));
    try std.testing.expect(!facts_config.carries_root and !facts_config.carries_documents);

    // 翻页答复带目录游标但不带 Root。
    var page = TestReply{};
    page.init(.page);
    const next = page.text("章九.md");
    const facts_page = facts(page.finish(.page, .{ .document_cursor = next, .document_total = 9 }));
    try std.testing.expect(!facts_page.carries_root and facts_page.carries_documents);
    try std.testing.expectEqualStrings("章九.md", facts_page.document_cursor);
}

test "两种结局各说各的，不合成一句「失败」" {
    // 正文落盘但派生状态待修，与磁盘被别人改过，是两件不同的事。讲成同一句
    // 「保存失败」，作者会对第二种按重试——而那正是会覆盖别人改动的动作。
    var durable = TestReply{};
    durable.init(.decided);
    try std.testing.expectEqualStrings(
        "已接受并落盘",
        decisionMessage(durable.finish(.decided, .{ .state = .durable })),
    );
    var conflict = TestReply{};
    conflict.init(.decided);
    try std.testing.expectEqualStrings(
        "磁盘上的正文已被别处改过，未覆盖",
        decisionMessage(conflict.finish(.decided, .{ .state = .conflict })),
    );
    var waiting = TestReply{};
    waiting.init(.collected);
    try std.testing.expectEqualStrings(
        "结果还没出现",
        collectMessage(waiting.finish(.collected, .{ .state = .waiting })),
    );
    // 种类对不上的答复一句话都不说，而不是说错一句。
    try std.testing.expectEqualStrings("", decisionMessage(waiting.finish(.collected, .{})));
}

test "读不懂的一段字节交出空视图，而不是某一种答复的空形态" {
    // 一份读错的名录比一份空名录危险得多。
    const blank: [32]u8 align(4) = @splat(0);
    const nonsense = wire.Reply{ .bytes = &blank };
    try std.testing.expectEqual(wire.Kind.none, nonsense.kind());
    try std.testing.expect(nonsense.head(.opened) == null);
    try std.testing.expectEqualStrings("", nonsense.text(.{ .off = 8, .len = 4 }));
    try std.testing.expectEqual(@as(usize, 0), proposalCount(nonsense));

    // 越界的 Str 不许读到相邻答复的内容。
    var builder = TestReply{};
    builder.init(.opened);
    const reply = builder.finish(.opened, .{ .root_id = .{ .off = 4000, .len = 32 } });
    try std.testing.expectEqualStrings("", reply.text(reply.head(.opened).?.root_id));
    // 对不齐的行偏移整列作废，不交半行。
    try std.testing.expectEqual(
        @as(usize, 0),
        reply.rows(wire.DocumentRow, .{ .off = 17, .len = 3 }).len,
    );
}
