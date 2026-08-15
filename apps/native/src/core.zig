//! Zig 核心：`Model`、`Msg`、`update`。
//!
//! 这是 `core.ts` 的去处。今天它还没有生产读者——`app.zon` 仍指向 TS 车道，切换在
//! 单元 13。届时这个名字落到唯一的权威上，`core.ts` 与它的四个同伙一起删。
//!
//! **薄状态机**（PLAN §0-2）：域规则一律在 Rust。这里只有去处、面板栈、滚动、旗标
//! 与草稿缓冲。凡是「要判断这件事对不对」的地方都过桥问 Rust；本模块判的只是
//! 「现在该显示什么」。
//!
//! **迁移进度写在类型里而不是写在注释里**：`pending_arms` 列出还没迁的臂，一条
//! 测试保证那张表里的每个名字都是真的 `Msg` 臂——名字拼错或臂改名都会红。迁一个
//! 就从表里删一个，于是「还剩多少」是可数的，不是靠印象。
//!
//! 规格：`RefRain-work/main+SPEC.md`。

const std = @import("std");
const native_sdk = @import("native_sdk");
const workbench = @import("core/workbench.zig");
const roster = @import("core/roster.zig");
const model_mod = @import("core/model.zig");
const msg_mod = @import("core/msg.zig");
const replies = @import("core/replies.zig");
const replay_seam = @import("replay_seam.zig");
const project_request = @import("project_request.zig");
const project_view = @import("project_view.zig");
const snapshot = @import("snapshot.zig");
const protocol = @import("generated/protocol.zig");

const canvas = native_sdk.canvas;

pub const Model = model_mod.Model;
pub const Msg = msg_mod.Msg;
pub const Destination = workbench.Destination;

pub const App = native_sdk.UiApp(Model, Msg);
pub const Effects = App.Effects;

/// 还没迁过来的臂。空表：`Msg` 的 74 条臂全部在 `update` 里有具名的落地。
///
/// 表留着（而不是删掉）是因为它旁边那条测试还在干活：它把「已迁 = 总数 − 待迁」
/// 写成断言，新增一条 `Msg` 臂而忘了写它的落地时，`update` 的穷尽性检查先红。
pub const pending_arms = [_][]const u8{};

/// 定时器的身份。
///
/// 键是常量而不是字符串（TS 车道用 `"kara.away"` 这类名字）：同键重挂即重置，
/// 而重置哪一口钟是一件必须在编译期就定下来的事——一个拼错的名字在 TS 那边是
/// 一口挂不上的新钟，静默地多出一个定时器。定时器键自成命名空间（SDK 不拿它与
/// host 键对撞），所以从 1 数起就够。
const timer_key = struct {
    const search_fire: u64 = 1;
    const runs_tick: u64 = 2;
    const kara_away: u64 = 3;
    const kara_enter: u64 = 4;
    const kara_leave: u64 = 5;
    const kara_card: u64 = 6;
    const kara_interrupt: u64 = 7;
    const review_advance: u64 = 8;
};

/// 即打即搜的防抖（ms）。停下来才开火。
const search_debounce_ms: u64 = 120;
/// Run 名录的轮询间隔（ms）。链式：没有新在飞就不挂下一跳。
const runs_poll_ms: u64 = 2500;
/// 失焦多久算离开（ms）。
const kara_away_ms: u64 = 8000;
/// 进场动画多久补发 entered（ms）。
const kara_enter_ms: u64 = 700;
/// 离场动画多久补发 leaveFinished（ms）。
const kara_leave_ms: u64 = 12000;
/// 回来卡自消（ms）。
const kara_card_ms: u64 = 600;
/// 打断自消（ms）。
const kara_interrupt_ms: u64 = 4000;
/// 判后前进的延迟（ms）。
const review_advance_ms: u64 = 120;

/// KARA 六态机的状态码（与 Rust `kara.rs` 的声明序同）。
///
/// 枚举而不是裸数字：`karaState !== 2 && karaState !== 3` 这种写法要读者记得
/// 2 是写作、3 是评审。机器本体在 Rust（INV-10），这里只是它在界面上的投影。
pub const KaraState = enum(u8) {
    off = 0,
    entering = 1,
    writing = 2,
    reviewing = 3,
    away = 4,
    leaving = 5,

    /// 在写或在审：只有这两态里的失焦才算「可能离开了」。
    pub fn atWork(self: KaraState) bool {
        return self == .writing or self == .reviewing;
    }
};

/// 启动：向 Rust 握一次手。
///
/// 只握一次（`core.ts` 同）。握手的答复落地时连带把读设置发出去，排版三值与主题
/// 随它回来——设置页与正文首帧因此不必等作者先按一次「读取设置」。
pub fn initFx(model: *Model, fx: *Effects) void {
    model.* = .{};
    var buffer: [replay_seam.max_record_bytes]u8 = undefined;
    const record = replay_seam.encode(&buffer, .{ .action = .health }) catch return;
    replay_seam.request(fx, .dispatch, record, Effects.hostMsg(.host_result));
}

/// 一件事发生之后，界面变成什么样。
///
/// 就地改而不是造一个新值：`UiApp` 的 `update_fx` 拿的是 `*Model`。TS 车道必须恒返
/// `[Model, Cmd]` 元组（编译产物对混形糖的窄化会断裂，v0.3.0 真窗首派崩溃的根因），
/// 那条纪律随车道一起消失。
pub fn update(model: *Model, msg: Msg, fx: *Effects) void {
    // 探头态的解除在分派之前：任何交互都算「作者用过这栏」——栏留下，解除的只是
    // 自动收回的资格。机器自己的动静（计时、答复、帧）不解除。
    if (model.rail_peek and !keepsPeek(msg)) model.rail_peek = false;

    switch (msg) {
        // ---------------------------------------------------------- 去处与面板
        .workbench_go => |target| goTo(model, target),
        .workbench_key => |ordinal| {
            const target = workbench.destinationForOrdinal(ordinal, model.agent_destination) orelse return;
            goTo(model, target);
        },
        .panel_back => {
            const popped = model.panel_stack.pop();
            model.panel_stack = popped.rest;
            model.destination = workbench.settleAfterDocument(popped.destination, model.hasDocument());
            relayout(model);
        },
        .rail_peek_open => {
            if (model.destination == .files) return;
            model.panel_stack = model.panel_stack.push(model.destination);
            model.destination = .files;
            model.rail_peek = true;
            relayout(model);
        },
        .rail_peek_close => {
            // 栏被动过就留下：解除探头态的是交互，不是指针离开。
            if (!model.rail_peek or model.destination != .files) return;
            backToManuscript(model);
            model.rail_peek = false;
        },
        .split_resize => |fraction| {
            model.rail_fraction = workbench.clampRailFraction(fraction);
            relayout(model);
        },

        // ---------------------------------------------------------- 浮层
        .palette_toggle => {
            model.palette.open = !model.palette.open;
            // 每次打开都是一次新的「我要去…」。
            model.palette.query.clear();
        },
        .palette_query => |event| _ = model.palette.query.applyEdit(event),
        .notice_dismiss => model.notice = null,
        .noop => {},

        // ---------------------------------------------------------- Rust 的答复
        .host_result => |result| applyHostResult(model, result, fx),

        // ---------------------------------------------------------- 正稿
        .document_save => {
            if (!model.hasDocument() or model.document.save_pending) return;
            var record = projectionRecord(model);
            record.action = .apply_input;
            record.input = @intFromEnum(protocol.Input.save);
            // 保存走自己的通道：与打字共键时，在飞的保存会被下一次输入顶掉，
            // 「已保存」就成了没有证据的说法。
            send(fx, .save, record);
            model.document.save_pending = true;
        },
        .document_undo => {
            if (!model.hasDocument()) return;
            var record = projectionRecord(model);
            record.action = .apply_input;
            record.input = @intFromEnum(protocol.Input.undo);
            send(fx, .dispatch, record);
        },
        // 回档：与撤销、保存同一条请求形状，文本段带历史面板那一行的动作 id。
        .document_revert => |action_id| {
            if (!model.hasDocument()) return;
            var record = projectionRecord(model);
            record.action = .apply_input;
            record.input = @intFromEnum(protocol.Input.revert_to);
            record.text = action_id;
            send(fx, .dispatch, record);
        },
        // 打字：事件翻成生成的输入词汇表，正稿的文本状态机在 Rust。
        .document_input => |event| {
            if (!model.hasDocument()) return;
            const encoded = encodeTextEvent(event) orelse {
                setStatus(model, "这次文本事件超出了固定的 ABI 上限。");
                return;
            };
            var record = projectionRecord(model);
            record.action = .apply_input;
            record.input = encoded.input;
            record.flags = encoded.flags;
            record.anchor = encoded.anchor;
            record.focus = encoded.focus;
            record.cursor = encoded.cursor;
            record.text = encoded.text;
            send(fx, .dispatch, record);
        },
        // 滚轮是唯一按像素锚定的请求，因此它有自己的动作码。旧形是
        // `obtain_projection` 加非零偏移，于是「滚到最顶」（偏移钳到 0）与「保持当前块」
        // 在线上是同一串字节：一次向头部的大滚轮什么也不动（M13）。
        .document_scroll => |scroll| {
            const offset: f64 = scroll.offset_y;
            const unchanged = offset == model.viewport.scroll;
            model.viewport.scroll = offset;
            if (!model.hasDocument() or unchanged) return;
            var record = projectionRecord(model);
            record.action = .scroll_projection;
            send(fx, .dispatch, record);
        },
        // 命中跳块：`scroll_offset_y` 为 0 时 Rust 按块序号锚定视口，越界它钳到尾窗
        // ——界面不自己 clamp，clamping 的规则只有 Rust 一份。
        .document_jump => |block| {
            if (!model.hasDocument()) return;
            model.viewport.scroll = 0;
            model.viewport.first_block = block;
            var record = projectionRecord(model);
            record.action = .obtain_projection;
            send(fx, .dispatch, record);
        },
        .document_open => |reference| openManuscript(model, fx, reference, null),
        // 与 `document_open` 同一条路，只是多记一个挂起的块序号：打开之前没有会话，
        // 跳块无处着落，所以由打开的答复落地后补发。
        .document_open_jump => |opening| openManuscript(model, fx, opening.reference, opening.block),

        // ---------------------------------------------------------- 外观
        .theme_next => model.theme_index = nextTheme(model.theme_index),
        .theme_select => |index| model.theme_index = clampTheme(index),
        // 0 实心 / 1 亚克力 / 2 液态玻璃；越界回落实心。
        .material_select => |index| model.panel_material = if (index <= 2) index else 0,

        // ---------------------------------------------------------- 帧
        .frame => |size| {
            model.window = size;
            // 行长与视口高随真实窗宽重算；换算本身归排版，不在这里猫一份。
            model.viewport.height_px = viewportHeightPx(size.height);
            // 行长变了而稿子开着：禁则断点是按旧行长算的，连带重投影。
            if (!reflowed(model)) return;
            var record = projectionRecord(model);
            record.action = .obtain_projection;
            send(fx, .dispatch, record);
        },

        // ---------------------------------------------------------- 名录
        .roster_step => |delta| {
            if (!model.destination.hasRoster()) return;
            model.roster_cursor = roster.step(model.roster_cursor, delta, model.roster_count);
        },

        // ---------------------------------------------------------- 搜索
        // 只承载字节。查询词的分词、召回与排序都在 Rust——界面在这里做一次
        // 「太短就不搜」之类的判断，就会与 Rust 的规则各说各话。
        .search_typed => |event| {
            _ = model.search.query.applyEdit(event);
            // 即打即搜：每一下按键把铟重新挂起（同键重挂 = 重置），停下来才开火。
            // 空查询回 idle：撤钟，什么都不发。
            if (model.search.query.isEmpty()) {
                fx.cancelTimer(timer_key.search_fire);
                return;
            }
            fx.startTimer(.{
                .key = timer_key.search_fire,
                .interval_ms = search_debounce_ms,
                .on_fire = Effects.timerMsg(.search_fire),
            });
        },
        .search_precision => model.search.exact = !model.search.exact,
        // 防抖到点。空查询与没有项目都不发（回 idle 与「还没打开」都不该有结果）。
        .search_fire => |timer| {
            if (timer.outcome != .fired) return;
            if (model.search.query.isEmpty() or model.root_id.isEmpty()) return;
            var writer: project_request.Writer = .{};
            const encoded = project_request.blockSearch(
                &writer,
                model.root_id.slice(),
                model.search.query.slice(),
                model.search.exact,
            ) orelse return;
            sendProject(fx, model, encoded.bytes);
        },

        // ---------------------------------------------------------- 草稿
        .revision_typed => |event| _ = model.revising.body.applyEdit(event),
        .revision_cancel => model.revising = .{},
        .material_draft_typed => |event| _ = model.material_draft.body.applyEdit(event),
        .material_draft_cancel => model.material_draft = .{},
        .agent_argv_typed => |event| _ = model.editing_agent.body.applyEdit(event),
        .agent_edit_cancel => model.editing_agent = .{},
        .dispatch_typed => |event| _ = model.dispatch.prompt.applyEdit(event),
        .annotation_draft_typed => |event| _ = model.annotation_draft.applyEdit(event),

        // ---------------------------------------------------------- 裁决台的界面半边
        .review_reason_open => {
            model.review.reason_open = true;
            // 起笔是已记下的理由。
            model.review.reason_draft = model.review.reason;
        },
        .review_reason_typed => |event| _ = model.review.reason_draft.applyEdit(event),
        .review_reason_commit => {
            // 空串也是一条记下的理由——「有没有」由旗说，不由长度说。
            model.review.reason = model.review.reason_draft;
            model.review.reason_recorded = true;
            model.review.reason_open = false;
        },
        .review_reason_cancel => {
            // 当作没问过：草稿丢掉，已记下的不动。
            model.review.reason_draft.clear();
            model.review.reason_open = false;
        },
        .review_peer => model.review.peer = !model.review.peer,
        .verdict_close => model.review.proposal.clear(),
        .stale_dismiss => {
            model.review.stale_frozen.clear();
            model.review.stale_recovery.clear();
        },

        // ---------------------------------------------------------- 裁决本身
        // 饭盒开着就走饭盒（当场编一条 judgeVerdict）；没开盒轮到裁决台，判游标行。
        // TS 车道要在开盒时预编好 accept/reject 两串字节（子集拼不出 JSON），本核心
        // 自己调 `project_request` 的编码器，那一族摆渡字段因此不存在。
        .verdict_accept => settleVerdict(model, fx, .accept),
        .verdict_reject => settleVerdict(model, fx, .reject),
        // 落定（Alt+Enter）：改写中就把改写落成裁决，否则提交暂存的批次。
        .verdict_settle => settleRevision(model, fx),
        // 裁决台的裁决按钮：字节由绘制侧在行渲染时编好（含已记下的理由）。
        .desk_verdict => |request| {
            if (request.len == 0) return;
            armAdvance(model, true);
            sendProject(fx, model, request);
        },
        // 判后自动前进：只 +1，不跳过已判。名录在判后答复里已经重新钳过。
        .review_advance => |timer| {
            if (timer.outcome != .fired) return;
            model.roster_cursor = roster.step(model.roster_cursor, 1, model.roster_count);
            // 换了一行就翻回 A 面：竞争稿的翻看跟着行走。
            model.review.peer = false;
        },

        // ---------------------------------------------------------- 开盒与起笔
        // 三条同形：id 与起笔都由绘制侧从名录里读出来交过来——核心不自己查那份答复。
        .revision_begin => |seeded| setEditing(&model.revising, seeded),
        .material_draft_begin => |seeded| setEditing(&model.material_draft, seeded),
        // argv 的起笔是空：快照是借用模式，拼不出现有 argv 的文本。
        .agent_edit_begin => |id| {
            model.editing_agent = .{};
            model.editing_agent.id.set(id) catch return;
        },
        .verdict_begin => |seeded| {
            model.review.proposal.set(seeded.id) catch return;
            // 起笔先装进改写缓冲，但不开改写框（id 空 = 没在改写）。
            // Alt+E 才把它打开，那时字已经在里面了。
            _ = model.revising.body.setTruncated(seeded.seed);
        },
        .verdict_revise => {
            // 饭盒改写：起笔是开盒时装进去的 agent 建议，这里只把框打开。
            if (!model.review.proposal.isEmpty()) {
                model.revising.id = model.review.proposal;
                return;
            }
            // 裁决台改写（Alt+E）：游标行的提案 id 与改后正文从名录取出。只评论的
            // 提案没有改后正文：键原地不动，与按钮的灰掉同款。
            if (model.destination != .review) return;
            const row = model.roster_cursor orelse return;
            const proposal = project_view.proposalAt(replies.proposalListing(), row) orelse return;
            if (proposal.after_text.len == 0) return;
            setEditing(&model.revising, .{ .id = proposal.id, .seed = proposal.after_text });
        },

        // ---------------------------------------------------------- 派发台的界面半边
        .dispatch_agents => |delta| model.dispatch.agents = clampAgents(model.dispatch.agents, delta),
        .dispatch_orchestration => model.dispatch.orchestration = (model.dispatch.orchestration + 1) % 3,
        .dispatch_carry => |index| model.dispatch.carry = if (index <= 2) index else 0,
        .dispatch_agent => |id| model.dispatch.agent.set(id) catch model.dispatch.agent.clear(),
        .dispatch_block_toggle => |ordinal| {
            if (ordinal >= model.dispatch.checked.capacity()) return;
            model.dispatch.checked.toggle(ordinal);
        },
        .dispatch_blocks_all => {
            // 整章：铺到稿子的块总数为止，不铺满位图。
            const total: usize = @intCast(@min(model.document.blocks, model.dispatch.checked.capacity()));
            model.dispatch.checked = @TypeOf(model.dispatch.checked).initEmpty();
            var ordinal: usize = 0;
            while (ordinal < total) : (ordinal += 1) model.dispatch.checked.set(ordinal);
        },
        .dispatch_blocks_clear => model.dispatch.checked = @TypeOf(model.dispatch.checked).initEmpty(),
        .dispatch_stash => |text| {
            // 攒进发送：只记录，不打断写作。
            //
            // NUL 分隔而不是换行：攒的是正文选区原文，而正文含换行。用换行分隔时，
            // 一段带换行的选区会被 `dispatch_stash_drop` 当成两条，作者删一条只掉一半。
            // 正文不含 NUL（文本层的不变量），所以它是唯一不会与内容撞车的分隔符。
            if (text.len == 0) return;
            if (!model.dispatch.stash.isEmpty()) model.dispatch.stash.append("\x00") catch return;
            model.dispatch.stash.append(text) catch return;
            var line: model_mod.Line = .empty;
            _ = line.setTruncated("攒进了下一次派发。");
            model.notice = line;
        },
        // 去掉攒着的第 `index` 段。越界不动——一次点在空处的删除不该掉掉别人。
        .dispatch_stash_drop => |index| dropSegment(&model.dispatch.stash, index),
        .dispatch_stash_clear => model.dispatch.stash.clear(),
        // 随这次派发带不带这份材料。空路径不是一份材料。
        .dispatch_material_toggle => |path| {
            if (path.len == 0) return;
            toggleLine(&model.dispatch.materials, path);
        },
        // 轮询一跳：读一次编排快照。有没有在飞由答复落地时判——没有新在飞
        // 就不挂下一跳，轮询自己停下来。
        .runs_tick => |timer| {
            if (timer.outcome != .fired) return;
            if (model.root_id.isEmpty()) return;
            var writer: project_request.Writer = .{};
            const encoded = project_request.readHost(&writer, model.root_id.slice()) orelse return;
            sendProject(fx, model, encoded.bytes);
        },

        // ---------------------------------------------------------- 信箱
        .mailbox_tab => model.mailbox_discarded = !model.mailbox_discarded,

        // ---------------------------------------------------------- KARA
        // 机器在 Rust（INV-10）。这一组只做两件事：把事件发给 Rust，以及挂计时。
        // 在 Zig 里再写一个六态机就是第二份权威。
        .kara_toggle => karaStep(model, fx, "manualToggle"),
        .app_focus => |active| {
            if (!active) {
                // 失焦：只在写作／评审里挂 8s 离场判定——别的状态里失焦不算离开。
                if (!karaState(model).atWork()) return;
                fx.startTimer(.{
                    .key = timer_key.kara_away,
                    .interval_ms = kara_away_ms,
                    .on_fire = Effects.timerMsg(.kara_gone_away),
                });
                return;
            }
            // 回焦：机器在 away 说明离场判定已发作过，发 returned 让它回去；
            // 否则那口 8s 的钟可能还挂着，撤掉（对不存在的钟撤销是静默的）。
            if (karaState(model) == .away) {
                karaStep(model, fx, "returned");
                return;
            }
            fx.cancelTimer(timer_key.kara_away);
        },
        // 钟到点时还在写作／评审才算离开（期间回来过会被撤钟，到这里双保险）。
        .kara_gone_away => |timer| {
            if (timer.outcome != .fired or !karaState(model).atWork()) return;
            karaStep(model, fx, "goneAway");
        },
        // 进场钟到点：还在 entering 才补发（作者 700ms 内又退出就不发）。
        .kara_entered => |timer| {
            if (timer.outcome != .fired or karaState(model) != .entering) return;
            karaStep(model, fx, "entered");
        },
        // 离场钟到点：还在 leaving 才补发（v0.2.4 从没发过，机器卡死）。
        .kara_leave_finished => |timer| {
            if (timer.outcome != .fired or karaState(model) != .leaving) return;
            karaStep(model, fx, "leaveFinished");
        },
        .kara_card_done => |timer| {
            if (timer.outcome != .fired or !model.kara.card) return;
            model.kara.card = false;
            model.kara.return_tail.clear();
        },
        .kara_interrupt_done => |timer| {
            if (timer.outcome != .fired or model.kara.interrupt.isEmpty()) return;
            model.kara.interrupt.clear();
        },

        // ---------------------------------------------------------- 通用
        // 一条已经编好的项目请求（绘制侧用 `project_request.zig` 编的）。
        .project_request => |input| {
            if (input.len > protocol.event_text_bytes) {
                setStatus(model, "这条项目请求超出了固定的 ABI 上限。");
                return;
            }
            sendProject(fx, model, input);
        },

        // ---------------------------------------------------------- 退出
        // 录制会话唯一的干净出口：被信号杀掉的进程留不下结束标记，
        // 回放会判 `JournalTruncated`。
        .app_quit => fx.quitApp(),
    }
}

// ------------------------------------------------------------------ 发请求

/// 一条请求的共同部分。
///
/// 每一条过界的请求都带着「此刻看的是哪份稿子、哪一窗、行多长」，Rust 按它回
/// 禁则断点与投影。TS 车道把这十一个字段在每一条臂里手写一遍（NS1017：Cmd 必须
/// 在分支里现写），于是同一份事实有四十多份拄本。Zig 没有那条限制，因此它在
/// 这里只写一遍：一条臂只改自己那几格。
fn projectionRecord(model: *const Model) replay_seam.Record {
    return .{
        .action = .project,
        .columns_em = projectionColumnsEm(model),
        .revision = model.document.revision,
        .scroll_offset_y = model.viewport.scroll,
        .session = model.document.session,
        .viewport_first_block = model.viewport.first_block,
        .window_start = model.viewport.window_start,
    };
}

fn send(fx: *Effects, channel: replay_seam.Channel, record: replay_seam.Record) void {
    var buffer: [replay_seam.max_record_bytes]u8 = undefined;
    const bytes = replay_seam.encode(&buffer, record) catch return;
    replay_seam.request(fx, channel, bytes, Effects.hostMsg(.host_result));
}

/// 一条项目请求（不透明通道）。八个界面的一切动作都骑它。
fn sendProject(fx: *Effects, model: *const Model, text: []const u8) void {
    var record = projectionRecord(model);
    record.text = text;
    send(fx, .dispatch, record);
}

/// 正文列 chrome 占的横向像素。与绘制侧的列内边距同源，不是一条规则。
const manuscript_chrome_width_px: f64 = 48;

/// 一行能放下的字身数，随每次文档请求过桥。
///
/// 取「作者选的行长」与「视口实测能放下的」的较小者——窗宽足够时行长说了算，
/// 窗窄时版心跟着窗走。实测侧由帧宽 × 分栏投影换算（`layoutFraction` 是唯一权威，
/// 这里不抄第二张），字身宽即字号（CJK 全角 advance 恒为 1em）。
fn projectionColumnsEm(model: *const Model) f64 {
    if (model.typography.text_size <= 0) return model.typography.measure_em;
    const fraction: f64 = if (model.layout_fraction >= 1) 1 else 1 - model.layout_fraction;
    const track_px = @as(f64, model.window.width) * fraction - manuscript_chrome_width_px;
    if (track_px <= 0) return model.typography.measure_em;
    return @min(model.typography.measure_em, track_px / model.typography.text_size);
}

/// 行长重算并落地。变了且稿子开着就返回 true——调用方据此决定要不要重投影。
fn reflowed(model: *Model) bool {
    const columns = projectionColumnsEm(model);
    const changed = columns != model.viewport.columns_em;
    model.viewport.columns_em = columns;
    return changed and model.hasDocument();
}

/// 一次文本编辑翻成生成的输入词汇表。
const EncodedTextEvent = struct {
    input: u16,
    flags: u16 = 0,
    anchor: u64 = 0,
    focus: u64 = 0,
    cursor: u64 = 0,
    text: []const u8 = "",
};

/// 超上限时交出 null：截断会把一次合法的长输入变成一次语义不同的短输入。
fn encodeTextEvent(event: canvas.TextInputEvent) ?EncodedTextEvent {
    const encoded: EncodedTextEvent = switch (event) {
        .insert_text => |text| .{ .input = @intFromEnum(protocol.Input.insert_text), .text = text },
        .delete_backward => .{ .input = @intFromEnum(protocol.Input.delete_backward) },
        .delete_forward => .{ .input = @intFromEnum(protocol.Input.delete_forward) },
        .delete_word_backward => .{ .input = @intFromEnum(protocol.Input.delete_word_backward) },
        .delete_word_forward => .{ .input = @intFromEnum(protocol.Input.delete_word_forward) },
        .clear => .{ .input = @intFromEnum(protocol.Input.clear) },
        .move_caret => |move| .{
            .input = @intFromEnum(protocol.Input.move_caret),
            .flags = caretFlags(move),
        },
        .set_selection => |selection| .{
            .input = @intFromEnum(protocol.Input.set_selection),
            .anchor = @intCast(selection.anchor),
            .focus = @intCast(selection.focus),
        },
        .set_composition => |composition| .{
            .input = @intFromEnum(protocol.Input.set_composition),
            .cursor = @intCast(composition.cursor orelse composition.text.len),
            .text = composition.text,
        },
        .commit_composition => .{ .input = @intFromEnum(protocol.Input.commit_composition) },
        .cancel_composition => .{ .input = @intFromEnum(protocol.Input.cancel_composition) },
    };
    if (encoded.text.len > protocol.event_text_bytes) return null;
    return encoded;
}

/// 方向码加一面「同时拉选区」的旗。
fn caretFlags(move: anytype) u16 {
    const direction: protocol.CaretDirection = switch (move.direction) {
        .previous => .previous,
        .next => .next,
        .previous_word => .previous_word,
        .next_word => .next_word,
        .start => .start,
        .end => .end,
    };
    const code: u16 = @intFromEnum(direction);
    return if (move.extend) code + protocol.caret_extend_flag else code;
}

/// 打开一份稿子。`reference` 是 `rootId\npath`——绝对路径由 Rust 解，界面不拼路径。
///
/// `jump` 非空时还记一个挂起的块序号：打开之前没有会话，跳块无处着落。
fn openManuscript(model: *Model, fx: *Effects, reference: []const u8, jump: ?u64) void {
    if (reference.len > protocol.event_text_bytes) {
        setStatus(model, "文档引用超出了固定的 ABI 上限。");
        return;
    }
    setStatus(model, "正在打开选中的稿子…");
    // 记住打开的是哪一份：裁决与提案读取都以它为作用域。引用的形状是
    // `rootId\npath`，所以路径是换行之后那一段。
    const split = std.mem.indexOfScalar(u8, reference, '\n');
    _ = model.document.path.setTruncated(if (split) |at| reference[at + 1 ..] else "");
    model.pending_jump_block = jump;
    // 换稿同时清掉派发台的块清单与勾选（块属于上一份稿子）；攒的段落留着
    // ——它是文本 scope，对新稿子能不能定位由 Rust 在预览时具名说。
    model.dispatch.checked = @TypeOf(model.dispatch.checked).initEmpty();
    model.dispatch.blocks_next = null;
    replies.clear(.blocks);
    var record = projectionRecord(model);
    record.action = .open_manuscript;
    record.session = 0;
    record.revision = 0;
    record.scroll_offset_y = 0;
    record.viewport_first_block = 0;
    record.window_start = 0;
    record.text = reference;
    send(fx, .dispatch, record);
}

// ------------------------------------------------------------------ KARA

/// 机器此刻的状态。答复里读不出名字时算 off——一个读不懂的状态不该挂出一口钟。
fn karaState(model: *const Model) KaraState {
    return std.enums.fromInt(KaraState, model.kara.state) orelse .off;
}

/// 把一条 KARA 事件送给 Rust。无字段的变体只写 `kind`。
fn karaStep(model: *const Model, fx: *Effects, event: []const u8) void {
    var writer: project_request.Writer = .{};
    const encoded = project_request.karaStep(&writer, event) orelse return;
    sendProject(fx, model, encoded.bytes);
}

// ------------------------------------------------------------------ 裁决

/// 一次裁决的向背。serde 要的是 kebab（`accept-modified`），与邻居的 camelCase 不同。
const Verdict = enum {
    accept,
    reject,
    accept_modified,

    fn wireName(self: Verdict) []const u8 {
        return switch (self) {
            .accept => "accept",
            .reject => "reject",
            .accept_modified => "accept-modified",
        };
    }
};

/// 发出一次裁决之后的收尾：理由只骑一次裁决，判后即清；上一次失败的说辞过期。
fn armAdvance(model: *Model, armed: bool) void {
    model.review.reason.clear();
    model.review.reason_draft.clear();
    model.review.reason_recorded = false;
    model.review.reason_open = false;
    model.review.stale_frozen.clear();
    model.review.stale_recovery.clear();
    model.review.advance_armed = armed;
}

/// 已记下并随下一次裁决发出的理由。“记下了一条空理由”跟“没记”在线上同形
/// （都是 `null`）——与 `project_request` 的空切片规则对齐，两条路径逐字节同形。
fn recordedReason(model: *const Model) []const u8 {
    if (!model.review.reason_recorded) return "";
    return model.review.reason.slice();
}

/// 接受或退回。饭盒开着就判饭盒里那一条（判了即落盘），否则判裁决台游标行
/// （进批次，等合并）。两条路径共用一个臂：键盘与行内按钮是同一件事的两个入口。
fn settleVerdict(model: *Model, fx: *Effects, verdict: Verdict) void {
    var writer: project_request.Writer = .{};
    if (!model.review.proposal.isEmpty()) {
        const encoded = project_request.judgeVerdict(
            &writer,
            model.root_id.slice(),
            model.document.path.slice(),
            model.review.proposal.slice(),
            verdict.wireName(),
            "",
            "",
        ) orelse return;
        model.review.proposal.clear();
        sendProject(fx, model, encoded.bytes);
        return;
    }
    const subject = deskProposalId(model) orelse return;
    const encoded = project_request.stageVerdict(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        subject,
        verdict.wireName(),
        "",
        recordedReason(model),
    ) orelse return;
    armAdvance(model, true);
    sendProject(fx, model, encoded.bytes);
}

/// 裁决台游标行的提案 id。不在裁决台、没有行、名录不是提案名录时交出 null。
fn deskProposalId(model: *const Model) ?[]const u8 {
    if (model.destination != .review) return null;
    const row = model.roster_cursor orelse return null;
    const proposal = project_view.proposalAt(replies.proposalListing(), row) orelse return null;
    if (proposal.id.len == 0) return null;
    return proposal.id;
}

/// 落定：改写中就把改写落成裁决，否则提交暂存的批次。
fn settleRevision(model: *Model, fx: *Effects) void {
    var writer: project_request.Writer = .{};
    if (model.revising.isOpen()) {
        // 空段不落：一条改写型裁决需要它的最终正文（按钮侧同款门禁）。
        if (model.revising.body.isEmpty()) {
            setStatus(model, "改写型的裁决需要它的最终正文。");
            return;
        }
        // 饭盒走 judgeVerdict（判了即落盘，回到写作）；裁决台走 stageVerdict（进批次，
        // 等合并）。两个编码器同形但不同名，而函数值本身是 comptime-only 的，
        // 因此分支在调用处而不在选函数处。
        const bento = !model.review.proposal.isEmpty();
        const reason = if (bento) "" else recordedReason(model);
        const encoded = (if (bento) project_request.judgeVerdict(
            &writer,
            model.root_id.slice(),
            model.document.path.slice(),
            model.revising.id.slice(),
            Verdict.accept_modified.wireName(),
            model.revising.body.slice(),
            reason,
        ) else project_request.stageVerdict(
            &writer,
            model.root_id.slice(),
            model.document.path.slice(),
            model.revising.id.slice(),
            Verdict.accept_modified.wireName(),
            model.revising.body.slice(),
            reason,
        )) orelse return;
        model.revising = .{};
        model.review.proposal.clear();
        // 饭盒的落定判完就走，不前进；台上的落定才立判后前进旗。
        armAdvance(model, !bento and model.destination == .review);
        sendProject(fx, model, encoded.bytes);
        return;
    }
    // 裁决台上的落定 = 提交暂存的批次。空批次不发。
    if (model.destination != .review) return;
    if (model.review.staged_count == 0) {
        setStatus(model, "没有入批的裁决。");
        return;
    }
    const encoded = project_request.commitVerdicts(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
    ) orelse return;
    model.review.stale_frozen.clear();
    model.review.stale_recovery.clear();
    sendProject(fx, model, encoded.bytes);
}

// ------------------------------------------------------------------ 定分隔的段落

/// 去掉第 `index` 段。分隔符是 NUL（见 `.dispatch_stash`）。
fn dropSegment(draft: *model_mod.Draft, index: u32) void {
    const text = draft.slice();
    var start: usize = 0;
    var seen: u32 = 0;
    while (seen < index) : (seen += 1) {
        const at = std.mem.indexOfScalarPos(u8, text, start, 0) orelse return;
        start = at + 1;
    }
    const end = std.mem.indexOfScalarPos(u8, text, start, 0) orelse text.len;
    // 拿掉那一段连它的一个分隔符：末段拿它前面那一个，否则拿后面那一个。
    var buffer: model_mod.Draft = .empty;
    if (end >= text.len) {
        buffer.set(text[0..if (start == 0) 0 else start - 1]) catch return;
    } else {
        buffer.set(text[0..start]) catch return;
        buffer.append(text[end + 1 ..]) catch return;
    }
    draft.* = buffer;
}

/// 把一行加进或从中拿掉（换行分隔的集合）。
fn toggleLine(draft: *model_mod.Draft, line: []const u8) void {
    var rebuilt: model_mod.Draft = .empty;
    var found = false;
    var rest = draft.slice();
    while (rest.len > 0) {
        const at = std.mem.indexOfScalar(u8, rest, '\n');
        const entry = if (at) |cut| rest[0..cut] else rest;
        rest = if (at) |cut| rest[cut + 1 ..] else "";
        if (std.mem.eql(u8, entry, line)) {
            found = true;
            continue;
        }
        if (entry.len == 0) continue;
        if (!rebuilt.isEmpty()) rebuilt.append("\n") catch return;
        rebuilt.append(entry) catch return;
    }
    if (!found) {
        if (!rebuilt.isEmpty()) rebuilt.append("\n") catch return;
        rebuilt.append(line) catch return;
    }
    draft.* = rebuilt;
}

/// 这条消息不算「作者用过这栏」吗。
///
/// 两类：机器自己的动静（帧、计时、答复），以及**探头态自己的两条**。
/// 后一类必须在这里：指针离开不是一次交互，而 `rail_peek_close` 的臂要读那面旗
/// 才能决定收不收回——分派之前先把旗清了，它永远看到「栏被动过」，于是探头
/// 开出来的栏再也收不回去。测试当场抳到了这一条。
fn keepsPeek(msg: Msg) bool {
    return switch (msg) {
        .rail_peek_open, .rail_peek_close => true,
        .frame, .host_result, .app_focus => true,
        .runs_tick, .search_fire => true,
        .kara_gone_away, .kara_entered, .kara_leave_finished => true,
        .kara_card_done, .kara_interrupt_done => true,
        // 两条 `core.ts` 没列而这里列了，理由同一条：它们也不是作者的动作。
        // `noop` 是滑杆没跨过一个步距；`review_advance` 是判后 120ms 的延迟前进。
        .noop, .review_advance => true,
        else => false,
    };
}

/// 去某个去处，按 `workbench.navigate` 的裁定落地。
fn goTo(model: *Model, target: Destination) void {
    switch (workbench.navigate(model.destination, target, model.hasDocument())) {
        .moved => {
            model.panel_stack = model.panel_stack.push(model.destination);
            model.destination = target;
            // Cmd+4 记住的是 Agent 层的去处。
            if (target.isAgent()) model.agent_destination = target;
            relayout(model);
        },
        // 同键再按：回正文，不是再看一遍同一个面板。
        .close => backToManuscript(model),
        .unchanged => {},
        .needs_document => {
            var line: model_mod.Line = .empty;
            _ = line.setTruncated("先打开一份稿子。");
            model.notice = line;
        },
    }
}

fn backToManuscript(model: *Model) void {
    model.destination = .manuscript;
    model.panel_stack = .empty;
    relayout(model);
}

/// 分栏投影：唯一的权威在 `workbench.layoutFraction`，Model 只持结果。
fn relayout(model: *Model) void {
    model.layout_fraction = workbench.layoutFraction(model.destination, model.rail_fraction);
}

/// 换下一套主题，到末尾回到第一套。
fn nextTheme(current: u8) u8 {
    const count = themeCount();
    if (count == 0) return 0;
    return (current + 1) % count;
}

fn clampTheme(index: u8) u8 {
    const count = themeCount();
    if (count == 0) return 0;
    return if (index < count) index else 0;
}

fn themeCount() u8 {
    const themes = @import("generated/themes.zig");
    return @intCast(themes.themes.len);
}

/// 正文视口的像素高：窗高减去列上下内边距、行距与状态行。
///
/// 这个余量是同一处布局常量在两端的影子（绘制侧 `documentView` 的 column
/// padding），不是一条规则——改了那边就改这里。
const manuscript_chrome_height_px: f32 = 78;

fn viewportHeightPx(window_height: f32) u32 {
    if (window_height <= manuscript_chrome_height_px) return 0;
    return @intFromFloat(window_height - manuscript_chrome_height_px);
}

/// Rust 答复了。
///
/// **一个臂接两个通道四种情形**：通道由 key 认，成败由 `ok` 说。TS 车道四个臂
/// 共享一个函数体的写法（子集不允许运行期形状测试，NS1041）在这里不再必要。
fn applyHostResult(model: *Model, result: native_sdk.EffectHostResult, fx: *Effects) void {
    const channel = replay_seam.Channel.fromKey(result.key) orelse return;
    // 这次在飞结束了，无论成败——卡住「正在保存…」是谎话。
    if (channel == .save) model.document.save_pending = false;

    if (!result.ok) {
        setStatus(model, "Rust 没有应答。");
        return;
    }
    const response = protocol.decodeDispatchResponse(result.bytes) orelse {
        model.host_ready = false;
        setStatus(model, "本地内核返回了不合约的答复。");
        return;
    };
    if (response.status != 0) {
        setStatus(model, "本地内核拒绝了这次请求。");
        return;
    }

    const action = std.enums.fromInt(protocol.Action, response.action) orelse return;
    switch (action) {
        .health => {
            if (response.api_version != protocol.api_version or
                response.capabilities & protocol.capability_mask != protocol.capability_mask)
            {
                model.host_ready = false;
                setStatus(model, "本地内核的能力与表面不匹配。");
                return;
            }
            model.host_ready = true;
            setStatus(model, "Rust 已就绪。");
            // 握手只发生一次，顺带把读设置发出去：排版三值与主题随它的答复落地，
            // 设置页与正文首帧不必等作者先按一次「读取设置」。
            var buffer: [replay_seam.max_record_bytes]u8 = undefined;
            const record = replay_seam.encode(&buffer, .{
                .action = .project,
                .text = "{\"kind\":\"readConfig\"}",
            }) catch return;
            replay_seam.request(fx, .dispatch, record, Effects.hostMsg(.host_result));
        },
        .project => landProject(model, response, fx),
        .open_manuscript, .apply_input, .obtain_projection, .scroll_projection => {
            landDocument(model, response, channel, fx);
        },
    }
}

/// 一条答复里的文本段。它指向 SDK 的收包缓冲，只在本次调用内有效。
fn responseText(response: protocol.RefrainNativeResponse) []const u8 {
    const len = @min(@as(usize, response.text_len), protocol.projection_bytes);
    if (len == 0) return "";
    return response.text[0..len];
}

/// 一条项目答复落地。
///
/// 字节先落槽（`core/replies.zig`），然后从落好的那一份里读事实——不从线上字节读，
/// 因为界面下一帧要看的是落好的那份，两者必须是同一个东西。
///
/// **读法是结构化的**（`snapshot.zig`）：TS 车道在字节里找引号（`"state":{"kind":"away"`
/// 这类针），于是一个同名字段出现在另一层就读错。这里按路径取值，层次是真的。
fn landProject(model: *Model, response: protocol.RefrainNativeResponse, fx: *Effects) void {
    model.host_ready = true;
    setStatus(model, "Rust 的项目用例完成了。");
    const wire = responseText(response);
    const kind = snapshot.kind(wire);
    const kept = replies.store(replies.slotForKind(kind), wire);
    const value = snapshot.value(kept);

    // rootId 只在带 Root 的答复里出现（读设置与 KARA 的不带），缺席即保留现值。
    if (snapshot.stringField(value, "rootId")) |root| model.root_id.set(root) catch {};
    if (snapshot.stringField(value, "documentCursor")) |cursor| model.document.cursor.set(cursor) catch {};
    if (snapshot.unsignedField(value, "documentTotal")) |total| model.document.total = @intCast(total);

    if (std.mem.eql(u8, kind, "config")) landConfig(model, value);
    if (std.mem.eql(u8, kind, "kara")) {
        landKara(model, value, fx);
        return;
    }
    if (std.mem.eql(u8, kind, "proposals")) landProposals(model, kept, fx);
    if (std.mem.eql(u8, kind, "documentBlocks")) {
        // 下一页游标：答复里 `next` 恒 ≥ 1，缺席即没有下一页。
        const next = snapshot.unsignedField(value, "next") orelse 0;
        model.dispatch.blocks_next = if (next > 0) @intCast(next) else null;
    }
    // 送出成功：这次预览已被消费，再送必须重新预览。
    if (std.mem.eql(u8, kind, "dispatched")) replies.clear(.preview);
    // 草稿名录刷新 = 一次成稿／退回落了地：行内编辑态随名录换新收起。
    if (std.mem.eql(u8, kind, "materialDrafts")) model.material_draft = .{};
    // 任何一次项目用例成功，上一次失败的说辞就过期了。
    model.review.stale_frozen.clear();
    model.review.stale_recovery.clear();

    // 合并落盘后名录必须重读：已判的提案已被领域层收走，不重读台面上就停着
    // 一排判过的鬼影。
    var writer: project_request.Writer = .{};
    if (std.mem.eql(u8, kind, "decided")) {
        if (model.root_id.isEmpty() or model.document.path.isEmpty()) return;
        const encoded = project_request.readProposals(
            &writer,
            model.root_id.slice(),
            model.document.path.slice(),
        ) orelse return;
        sendProject(fx, model, encoded.bytes);
        return;
    }
    // 收取与送出之后连锁读一次编排快照：Run 名录与等待队列都变了。
    if (std.mem.eql(u8, kind, "collected") or std.mem.eql(u8, kind, "dispatched")) {
        if (model.root_id.isEmpty()) return;
        const encoded = project_request.readHost(&writer, model.root_id.slice()) orelse return;
        sendProject(fx, model, encoded.bytes);
        return;
    }
    // 编排快照落地：有在飞 Run 就挂下一跳（链式——没有新在飞就不挂，轮询自己停）。
    if (std.mem.eql(u8, kind, "host")) {
        model.roster_count = @intCast(snapshot.array(value, "runs").count());
        model.roster_cursor = roster.settle(model.roster_cursor, model.roster_count);
        if (inFlightRuns(value) and !model.root_id.isEmpty()) {
            fx.startTimer(.{
                .key = timer_key.runs_tick,
                .interval_ms = runs_poll_ms,
                .on_fire = Effects.timerMsg(.runs_tick),
            });
        }
        return;
    }
    // 行长可能随排版答复变了：禁则断点按旧行长算的，连带重投影。
    if (!reflowed(model)) return;
    var record = projectionRecord(model);
    record.action = .obtain_projection;
    send(fx, .dispatch, record);
}

/// 设置答复里的排版三值与面板材质。它们只在这一种答复里出现。
fn landConfig(model: *Model, value: snapshot.Value) void {
    const appearance = snapshot.field(value, "appearance") orelse return;
    if (snapshot.stringField(appearance, "panel_material")) |material| {
        model.panel_material = if (std.mem.eql(u8, material, "acrylic"))
            1
        else if (std.mem.eql(u8, material, "liquid")) 2 else 0;
    }
    const typography = snapshot.field(appearance, "typography") orelse return;
    // 十分之一储存（`*_tenths_*`）：持久化的数字不带小数点，单位写在字段名里。
    if (snapshot.unsignedField(typography, "text_size_tenths_px")) |tenths| {
        if (tenths > 0) model.typography.text_size = @as(f64, @floatFromInt(tenths)) / 10;
    }
    if (snapshot.unsignedField(typography, "measure_tenths_em")) |tenths| {
        if (tenths > 0) model.typography.measure_em = @as(f64, @floatFromInt(tenths)) / 10;
    }
    if (snapshot.unsignedField(typography, "line_height_percent")) |percent| {
        if (percent > 0) model.typography.line_height_percent = @intCast(percent);
    }
}

/// KARA 答复：机器的状态、安静事件队列，以及两件自消的展示。
///
/// 一次至多挂一口钟（优先状态钟——它是机器活下去的腿；回来卡与打断是自消
/// 展示，下一口答复会再挂）。
fn landKara(model: *Model, value: snapshot.Value, fx: *Effects) void {
    const state = snapshot.field(value, "state") orelse "";
    const named = snapshot.stringField(state, "kind") orelse "";
    const next: KaraState = if (std.mem.eql(u8, named, "entering"))
        .entering
    else if (std.mem.eql(u8, named, "writing"))
        .writing
    else if (std.mem.eql(u8, named, "reviewing"))
        .reviewing
    else if (std.mem.eql(u8, named, "away"))
        .away
    else if (std.mem.eql(u8, named, "leaving")) .leaving else .off;
    model.kara.state = @intFromEnum(next);
    model.kara.queued = queuedMask(value);

    // 回 Off 时三者一起清：机器下台了，它的展示不该留在屏上。
    if (next == .off) {
        model.kara.card = false;
        model.kara.return_tail.clear();
        model.kara.interrupt.clear();
        return;
    }
    const effects = snapshot.field(value, "effects") orelse "";
    const card = firstEffect(effects, "showReturnCard");
    if (card) |payload| {
        model.kara.card = true;
        const point = snapshot.field(payload, "returnPoint") orelse payload;
        _ = model.kara.return_tail.setTruncated(snapshot.stringField(point, "sentenceTail") orelse "");
    }
    const interrupt = firstEffect(effects, "interruptNow");
    if (interrupt) |payload| {
        _ = model.kara.interrupt.setTruncated(if (payload.len >= 2 and payload[0] == '"')
            payload[1 .. payload.len - 1]
        else
            payload);
    }

    if (next == .entering) {
        fx.startTimer(.{
            .key = timer_key.kara_enter,
            .interval_ms = kara_enter_ms,
            .on_fire = Effects.timerMsg(.kara_entered),
        });
        return;
    }
    if (next == .leaving) {
        fx.startTimer(.{
            .key = timer_key.kara_leave,
            .interval_ms = kara_leave_ms,
            .on_fire = Effects.timerMsg(.kara_leave_finished),
        });
        return;
    }
    if (card != null) {
        fx.startTimer(.{
            .key = timer_key.kara_card,
            .interval_ms = kara_card_ms,
            .on_fire = Effects.timerMsg(.kara_card_done),
        });
        return;
    }
    if (interrupt != null) {
        fx.startTimer(.{
            .key = timer_key.kara_interrupt,
            .interval_ms = kara_interrupt_ms,
            .on_fire = Effects.timerMsg(.kara_interrupt_done),
        });
    }
}

/// 安静事件队列的掩码：1 已保存 / 2 agent 完成 / 4 提案到达 / 8 索引刷新。
///
/// 只数 `queued` 那一列：effects 里也提这些名字（queueForDebrief），它们不是队列。
/// 按字段取值而不是全文找针，那条区分因此是结构上的，不是数字距离上的。
fn queuedMask(value: snapshot.Value) u8 {
    const names = [_][]const u8{ "save-succeeded", "agent-completed", "proposal-arrived", "index-refreshed" };
    const queued = snapshot.array(value, "queued");
    var mask: u8 = 0;
    var index: usize = 0;
    while (queued.at(index)) |entry| : (index += 1) {
        if (entry.len < 2 or entry[0] != '"') continue;
        const name = entry[1 .. entry.len - 1];
        for (names, 0..) |candidate, bit| {
            if (std.mem.eql(u8, name, candidate)) mask |= @as(u8, 1) << @intCast(bit);
        }
    }
    return mask;
}

/// KARA 答复里第一条叫这个名字的效果的载荷。没有就是 null。
fn firstEffect(effects: snapshot.Value, name: []const u8) ?snapshot.Value {
    const rows = snapshot.arrayOf(effects);
    var index: usize = 0;
    while (rows.at(index)) |row| : (index += 1) {
        if (std.mem.eql(u8, snapshot.kind(row), name)) return snapshot.value(row);
    }
    return null;
}

/// 提案名录落地：行数、批次数与游标钳制。
fn landProposals(model: *Model, kept: snapshot.Value, fx: *Effects) void {
    const listing = snapshot.value(kept);
    model.roster_count = @intCast(project_view.proposalCount(listing));
    model.review.staged_count = @intCast(snapshot.array(listing, "staged").count());
    // 游标钳进新长度：连着判三条不必每次重新找位置。
    model.roster_cursor = roster.settle(model.roster_cursor, model.roster_count);
    // 名录变了，A／B 跟着行走。
    model.review.peer = false;
    if (!model.review.advance_armed) return;
    model.review.advance_armed = false;
    fx.startTimer(.{
        .key = timer_key.review_advance,
        .interval_ms = review_advance_ms,
        .on_fire = Effects.timerMsg(.review_advance),
    });
}

/// 编排快照里还有在飞的 Run 吗。authorized／launching／dispatched 算在飞，queued 不算。
fn inFlightRuns(value: snapshot.Value) bool {
    const runs = snapshot.array(value, "runs");
    var index: usize = 0;
    while (runs.at(index)) |run| : (index += 1) {
        const progress = snapshot.field(run, "progress") orelse continue;
        const state = snapshot.kind(progress);
        if (std.mem.eql(u8, state, "authorized") or
            std.mem.eql(u8, state, "launching") or
            std.mem.eql(u8, state, "dispatched")) return true;
    }
    return false;
}

/// 一条投影答复里的会话事实。
///
/// 正稿的字节不过界（W3）：这里只收数字，文字由桥借给绘制侧。
fn landDocument(
    model: *Model,
    response: protocol.RefrainNativeResponse,
    channel: replay_seam.Channel,
    fx: *Effects,
) void {
    model.host_ready = true;
    model.document.session = response.session;
    model.document.revision = response.revision;
    model.document.bytes = response.total_bytes;
    model.document.blocks = response.total_blocks;
    model.viewport.first_block = response.first_block;
    model.viewport.window_start = response.window_start;
    // 保存的正面证据：只有保存通道上的答复才能盖这一章。
    if (channel == .save) model.document.saved_revision = response.revision;
    // 跨文档跳块：打开的答复落地了，现在才有会话可供锚定。补发一条跳块投影。
    const jump = model.pending_jump_block orelse return;
    model.pending_jump_block = null;
    if (!model.hasDocument()) return;
    model.viewport.scroll = 0;
    model.viewport.first_block = jump;
    var record = projectionRecord(model);
    record.action = .obtain_projection;
    send(fx, .dispatch, record);
}

fn setStatus(model: *Model, line: []const u8) void {
    _ = model.status.setTruncated(line);
}

/// 开一份草稿：id 与起笔一起落地。装不下的 id 宁可不开——开一个认不出自己该交
/// 回哪里的编辑框，比不开更坏。
fn setEditing(slot: *model_mod.Editing, seeded: msg_mod.Seeded) void {
    slot.* = .{};
    slot.id.set(seeded.id) catch {
        slot.* = .{};
        return;
    };
    _ = slot.body.setTruncated(seeded.seed);
}

/// 改派几个 agent。下限 1（零个 agent 的派发铸不出 Run，作者看到的是一行永远
/// 等待的 Task）；上限 4，因为并列的 Run 各跑一个真实进程。
fn clampAgents(current: u32, delta: i32) u32 {
    const moved = @as(i64, current) + delta;
    if (moved <= 1) return 1;
    if (moved >= 4) return 4;
    return @intCast(moved);
}

// ------------------------------------------------------------------ 测试

const testing = std.testing;

test "74 条臂全部有落地，待迁表是空的" {
    // 这条测试让迁移进度可数；它现在读的是终点。表里剩下的名字仍然必须是真的臂
    // ——拼错一个名字会让「还剩多少」变成一个读起来自洽的假数。
    const arms = @typeInfo(Msg).@"union".fields;
    for (pending_arms) |pending| {
        var found = false;
        inline for (arms) |arm| {
            if (std.mem.eql(u8, arm.name, pending)) found = true;
        }
        if (!found) {
            std.debug.print("pending_arms 里的 `{s}` 不是 Msg 的臂\n", .{pending});
            return error.TestUnexpectedResult;
        }
    }
    try testing.expectEqual(@as(usize, 74), arms.len);
    try testing.expectEqual(@as(usize, 0), pending_arms.len);
    try testing.expectEqual(@as(usize, 74), arms.len - pending_arms.len);
}

test "导航：够得着就走，够不着就说为什么" {
    var model: Model = .{};
    var fx: Effects = undefined;
    // 裁决台要一份稿子；没有稿子时不动去处，留下一句话。
    update(&model, .{ .workbench_go = .review }, &fx);
    try testing.expectEqual(Destination.manuscript, model.destination);
    try testing.expect(model.notice != null);

    // 读过了那句话。
    update(&model, .notice_dismiss, &fx);
    try testing.expectEqual(@as(?model_mod.Line, null), model.notice);

    // 有稿子就走得动，并且把来路压进栈。
    model.document.session = 1;
    update(&model, .{ .workbench_go = .review }, &fx);
    try testing.expectEqual(Destination.review, model.destination);
    try testing.expectEqual(@as(u8, 0), model.panel_stack.depth); // 稿子是根，不进栈
    // 裁决是 Agent 层：Cmd+4 记住了它。
    try testing.expectEqual(Destination.review, model.agent_destination.?);
}

test "同键再按回正文，退层回上一个去处" {
    var model: Model = .{ .document = .{ .session = 1 } };
    var fx: Effects = undefined;
    update(&model, .{ .workbench_go = .files }, &fx);
    update(&model, .{ .workbench_go = .dispatch }, &fx);
    try testing.expectEqual(Destination.dispatch, model.destination);
    try testing.expectEqual(@as(u8, 1), model.panel_stack.depth);

    // 退层：回文件区。
    update(&model, .panel_back, &fx);
    try testing.expectEqual(Destination.files, model.destination);

    // 同键再按：回正文，栈清空。
    update(&model, .{ .workbench_go = .files }, &fx);
    try testing.expectEqual(Destination.manuscript, model.destination);
    try testing.expectEqual(@as(u8, 0), model.panel_stack.depth);
}

test "四区键位与分栏投影一起动" {
    var model: Model = .{ .document = .{ .session = 1 } };
    var fx: Effects = undefined;
    // Cmd+2 去文件区：分栏比例跟着变成侧栏宽。
    update(&model, .{ .workbench_key = 2 }, &fx);
    try testing.expectEqual(Destination.files, model.destination);
    try testing.expectEqual(workbench.rail_fraction_default, model.layout_fraction);
    // 拖分隔条：钳进可用区间，投影跟着更新。
    update(&model, .{ .split_resize = 0.9 }, &fx);
    try testing.expectEqual(@as(f64, 0.4), model.rail_fraction);
    try testing.expectEqual(@as(f64, 0.4), model.layout_fraction);
    // 键位序号越界：这一下不接管，什么都不动。
    update(&model, .{ .workbench_key = 9 }, &fx);
    try testing.expectEqual(Destination.files, model.destination);
}

test "探头态：交互留下栏，机器的动静不解除" {
    var model: Model = .{ .document = .{ .session = 1 } };
    var fx: Effects = undefined;
    update(&model, .rail_peek_open, &fx);
    try testing.expect(model.rail_peek);
    try testing.expectEqual(Destination.files, model.destination);

    // 机器自己的动静不解除探头态。
    update(&model, .noop, &fx);
    try testing.expect(model.rail_peek);
    // 指针移出：栏没被动过，收回稿子。
    update(&model, .rail_peek_close, &fx);
    try testing.expectEqual(Destination.manuscript, model.destination);

    // 这次作者用过栏（一次交互），指针移出就不该收回。
    update(&model, .rail_peek_open, &fx);
    update(&model, .{ .roster_step = 1 }, &fx);
    try testing.expect(!model.rail_peek);
    update(&model, .rail_peek_close, &fx);
    try testing.expectEqual(Destination.files, model.destination);
}

test "名录键只在有名录的去处上动" {
    var model: Model = .{ .document = .{ .session = 1 }, .roster_count = 3 };
    var fx: Effects = undefined;
    // 稿子上没有名录：游标不动，免得作者回到台上时位置已经漂了。
    update(&model, .{ .roster_step = 1 }, &fx);
    try testing.expectEqual(@as(?u32, null), model.roster_cursor);

    update(&model, .{ .workbench_go = .dispatch }, &fx);
    update(&model, .{ .roster_step = 1 }, &fx);
    try testing.expectEqual(@as(?u32, 1), model.roster_cursor);
    // 撞到末端就停，不绕回。
    update(&model, .{ .roster_step = 9 }, &fx);
    try testing.expectEqual(@as(?u32, 2), model.roster_cursor);
}

test "理由框：空串也是一条记下的理由，取消不动已记下的" {
    var model: Model = .{};
    var fx: Effects = undefined;
    update(&model, .review_reason_open, &fx);
    try testing.expect(model.review.reason_open);
    update(&model, .{ .review_reason_typed = .{ .insert_text = "太长" } }, &fx);
    update(&model, .review_reason_commit, &fx);
    try testing.expect(model.review.reason_recorded);
    try testing.expectEqualStrings("太长", model.review.reason.slice());
    try testing.expect(!model.review.reason_open);

    // 再开一次，打了字又取消：已记下的不动。
    update(&model, .review_reason_open, &fx);
    update(&model, .{ .review_reason_typed = .{ .insert_text = "改主意" } }, &fx);
    update(&model, .review_reason_cancel, &fx);
    try testing.expectEqualStrings("太长", model.review.reason.slice());
    try testing.expect(!model.review.reason_open);
}

/// 造一条合约的答复字节。测试专用——真实的字节由 Rust 发。
fn testResponse(action: protocol.Action, edit: anytype) [protocol.response_bytes]u8 {
    var response = protocol.emptyResponse(@intFromEnum(action));
    response.protocol_version = protocol.protocol_version;
    response.api_version = protocol.api_version;
    response.capabilities = protocol.capability_mask;
    inline for (@typeInfo(@TypeOf(edit)).@"struct".fields) |f| {
        @field(response, f.name) = @field(edit, f.name);
    }
    return protocol.encodeDispatchResponse(response);
}

test "握手合约不对就不就绪，而不是装作就绪" {
    var model: Model = .{};
    var fx: Effects = undefined;
    // 能力位对不上：具名拒绝，不标就绪。
    const mismatched = testResponse(.health, .{ .capabilities = @as(u32, 0) });
    update(&model, .{ .host_result = .{
        .key = replay_seam.Channel.dispatch.key(),
        .ok = true,
        .bytes = &mismatched,
    } }, &fx);
    try testing.expect(!model.host_ready);

    // 坏字节：同样不就绪，而不是把垃圾当会话事实落地。
    update(&model, .{ .host_result = .{
        .key = replay_seam.Channel.dispatch.key(),
        .ok = true,
        .bytes = "not a response",
    } }, &fx);
    try testing.expect(!model.host_ready);
    try testing.expect(!model.status.isEmpty());
}

test "保存的证据只从保存通道上来" {
    var model: Model = .{ .document = .{ .session = 7, .revision = 4 } };
    var fx: Effects = undefined;

    // 投影通道上的答复推进了修订号，但不能算作「已保存」。
    const typed = testResponse(.apply_input, .{
        .session = @as(u64, 7),
        .revision = @as(u64, 5),
    });
    update(&model, .{ .host_result = .{
        .key = replay_seam.Channel.dispatch.key(),
        .ok = true,
        .bytes = &typed,
    } }, &fx);
    try testing.expectEqual(@as(u64, 5), model.document.revision);
    try testing.expect(model.isDirty());

    // 保存通道上的同形答复才盖章。
    const saved = testResponse(.apply_input, .{
        .session = @as(u64, 7),
        .revision = @as(u64, 5),
    });
    update(&model, .{ .host_result = .{
        .key = replay_seam.Channel.save.key(),
        .ok = true,
        .bytes = &saved,
    } }, &fx);
    try testing.expect(!model.isDirty());
    try testing.expect(!model.document.save_pending);
}

test "保存失败也结束在飞，不卡在「正在保存…」" {
    var model: Model = .{ .document = .{ .session = 1, .save_pending = true } };
    var fx: Effects = undefined;
    update(&model, .{ .host_result = .{
        .key = replay_seam.Channel.save.key(),
        .ok = false,
        .bytes = "rejected",
    } }, &fx);
    try testing.expect(!model.document.save_pending);
    // 失败不盖章：「已保存」必须有正面证据。
    try testing.expectEqual(@as(u64, 0), model.document.saved_revision);
}

test "没有稿子就不发保存，也不立在飞旗" {
    var model: Model = .{};
    var fx: Effects = undefined;
    update(&model, .document_save, &fx);
    try testing.expect(!model.document.save_pending);
}

test "主题循环与越界都落在色表内" {
    var model: Model = .{};
    var fx: Effects = undefined;
    const count = themeCount();
    try testing.expect(count > 0);
    var index: u8 = 0;
    while (index < count) : (index += 1) update(&model, .theme_next, &fx);
    try testing.expectEqual(@as(u8, 0), model.theme_index); // 转了一圈回到第一套
    update(&model, .{ .theme_select = 200 }, &fx);
    try testing.expectEqual(@as(u8, 0), model.theme_index);
    update(&model, .{ .material_select = 9 }, &fx);
    try testing.expectEqual(@as(u8, 0), model.panel_material);
}

test "开盒装好起笔但不开改写框，Alt+E 才开" {
    var model: Model = .{};
    var fx: Effects = undefined;
    update(&model, .{ .verdict_begin = .{ .id = "p-7", .seed = "改后的话" } }, &fx);
    try testing.expectEqualStrings("p-7", model.review.proposal.slice());
    // 字已经在里面，但框还没开。
    try testing.expectEqualStrings("改后的话", model.revising.body.slice());
    try testing.expect(!model.revising.isOpen());
    update(&model, .verdict_revise, &fx);
    try testing.expect(model.revising.isOpen());
    // 关盒只关盒。
    update(&model, .verdict_close, &fx);
    try testing.expect(model.review.proposal.isEmpty());
}

test "派发台：改派人数有下限，整章只铺到稿子的块数" {
    var model: Model = .{ .document = .{ .session = 1, .blocks = 3 } };
    var fx: Effects = undefined;
    // 并列的 Run 至少有一个：减到 0 是一次不会发生的派发。
    update(&model, .{ .dispatch_agents = -5 }, &fx);
    try testing.expectEqual(@as(u32, 1), model.dispatch.agents);
    // 上限 4：并列的 Run 各跑一个真实进程（与 `core.ts` 同值）。
    update(&model, .{ .dispatch_agents = 99 }, &fx);
    try testing.expectEqual(@as(u32, 4), model.dispatch.agents);

    update(&model, .dispatch_blocks_all, &fx);
    try testing.expectEqual(@as(usize, 3), model.dispatch.checked.count());
    update(&model, .{ .dispatch_block_toggle = 1 }, &fx);
    try testing.expectEqual(@as(usize, 2), model.dispatch.checked.count());
    update(&model, .dispatch_blocks_clear, &fx);
    try testing.expectEqual(@as(usize, 0), model.dispatch.checked.count());

    // 攒的段落以 NUL 分隔，空段不攒。
    update(&model, .{ .dispatch_stash = "第一段" }, &fx);
    update(&model, .{ .dispatch_stash = "" }, &fx);
    update(&model, .{ .dispatch_stash = "第二段" }, &fx);
    try testing.expectEqualStrings("第一段\x00第二段", model.dispatch.stash.slice());
    update(&model, .dispatch_stash_clear, &fx);
    try testing.expect(model.dispatch.stash.isEmpty());
}

test "攒的段落按段删，带换行的选区仍然是一段" {
    var model: Model = .{};
    var fx: Effects = undefined;
    // 换行分隔的写法会把这一段拆成两条，作者删一条只掉一半——这条测试钉的是那一点。
    update(&model, .{ .dispatch_stash = "上\n下" }, &fx);
    update(&model, .{ .dispatch_stash = "另一段" }, &fx);
    update(&model, .{ .dispatch_stash_drop = 0 }, &fx);
    try testing.expectEqualStrings("另一段", model.dispatch.stash.slice());
    // 越界的删除什么都不掉。
    update(&model, .{ .dispatch_stash_drop = 7 }, &fx);
    try testing.expectEqualStrings("另一段", model.dispatch.stash.slice());
    update(&model, .{ .dispatch_stash_drop = 0 }, &fx);
    try testing.expect(model.dispatch.stash.isEmpty());
}

test "材料开关是一个集合，再点一次就拿掉" {
    var model: Model = .{};
    var fx: Effects = undefined;
    update(&model, .{ .dispatch_material_toggle = "资料/一.md" }, &fx);
    update(&model, .{ .dispatch_material_toggle = "资料/二.md" }, &fx);
    try testing.expectEqualStrings("资料/一.md\n资料/二.md", model.dispatch.materials.slice());
    update(&model, .{ .dispatch_material_toggle = "资料/一.md" }, &fx);
    try testing.expectEqualStrings("资料/二.md", model.dispatch.materials.slice());
    // 空路径不是一份材料。
    update(&model, .{ .dispatch_material_toggle = "" }, &fx);
    try testing.expectEqualStrings("资料/二.md", model.dispatch.materials.slice());
}

test "命令面板每次打开都是新的一次" {
    var model: Model = .{};
    var fx: Effects = undefined;
    update(&model, .palette_toggle, &fx);
    update(&model, .{ .palette_query = .{ .insert_text = "裁决" } }, &fx);
    try testing.expectEqualStrings("裁决", model.palette.query.slice());
    update(&model, .palette_toggle, &fx);
    update(&model, .palette_toggle, &fx);
    // 上次的一半查询会让作者以为面板没刷新。
    try testing.expect(model.palette.query.isEmpty());
    try testing.expect(model.palette.open);
}

// ------------------------------------- 真 UiApp 上的臂：发出去的那一条请求
//
// 前面那些测试用 `fx: Effects = undefined`，因为它们判的臂不碰 `fx`。发请求与挂计时
// 的臂必须在真的 `Effects` 上判：「我写了一条 send」不是事实，「停住的那条请求带着
// 这个动作码与这段文本」才是。

const geometry = native_sdk.geometry;
const app_manifest = native_sdk.app_manifest;

const harness_canvas_label = "core-canvas";

fn harnessView(ui: *App.Ui, model: *const Model) App.Ui.Node {
    return ui.column(.{ .gap = 4, .padding = 8 }, .{
        ui.text(.{}, ui.fmt("{d}", .{model.document.session})),
    });
}

const harness_views = [_]app_manifest.ShellView{
    .{ .label = harness_canvas_label, .kind = .gpu_surface, .fill = true, .gpu_backend = .metal },
};
const harness_windows = [_]app_manifest.ShellWindow{.{
    .label = "main",
    .title = "core",
    .width = 400,
    .height = 300,
    .views = &harness_views,
}};
const harness_scene: app_manifest.ShellConfig = .{ .windows = &harness_windows };

const CoreHarness = struct {
    harness: *native_sdk.TestHarness(),
    app_state: *App,
    app: native_sdk.App,

    fn create() !CoreHarness {
        replies.clearAll();
        const harness = try native_sdk.TestHarness().create(testing.allocator, .{
            .size = geometry.SizeF.init(400, 300),
        });
        errdefer harness.destroy(testing.allocator);
        harness.null_platform.gpu_surfaces = true;
        const app_state = try testing.allocator.create(App);
        errdefer testing.allocator.destroy(app_state);
        app_state.* = App.init(std.heap.page_allocator, .{}, .{
            .name = "core-arms",
            .scene = harness_scene,
            .canvas_label = harness_canvas_label,
            .update_fx = update,
            .view = harnessView,
        });
        const app = app_state.app();
        try harness.start(app);
        try harness.runtime.dispatchPlatformEvent(app, .{ .gpu_surface_frame = .{
            .label = harness_canvas_label,
            .size = geometry.SizeF.init(400, 300),
            .scale_factor = 1,
            .frame_index = 1,
            .timestamp_ns = 1_000_000,
        } });
        app_state.effects.executor = .fake;
        return .{ .harness = harness, .app_state = app_state, .app = app };
    }

    fn destroy(self: *CoreHarness) void {
        self.app_state.deinit();
        testing.allocator.destroy(self.app_state);
        self.harness.destroy(testing.allocator);
        replies.clearAll();
    }

    fn model(self: *CoreHarness) *Model {
        return &self.app_state.model;
    }

    fn dispatch(self: *CoreHarness, msg: Msg) !void {
        try self.app_state.dispatch(&self.harness.runtime, 1, msg);
    }

    /// 停住的那条请求的载荷。一条都没发时交出 null。
    fn parkedPayload(self: *CoreHarness) ?[]const u8 {
        const fx = &self.app_state.effects;
        const count = fx.pendingHostCount();
        if (count == 0) return null;
        return fx.pendingHostAt(count - 1).?.payload;
    }

    /// 停住的那条请求的文本段。
    fn parkedText(self: *CoreHarness) []const u8 {
        const payload = self.parkedPayload() orelse return "";
        if (payload.len < protocol.offset_text) return "";
        const len = std.mem.readInt(u32, payload[protocol.offset_text_len..][0..4], .little);
        if (payload.len < protocol.offset_text + len) return "";
        return payload[protocol.offset_text..][0..len];
    }

    fn parkedAction(self: *CoreHarness) ?protocol.Action {
        const payload = self.parkedPayload() orelse return null;
        return std.enums.fromInt(protocol.Action, readScalarU16(payload, protocol.offset_action));
    }

    fn parkedInput(self: *CoreHarness) ?protocol.Input {
        const payload = self.parkedPayload() orelse return null;
        return std.enums.fromInt(protocol.Input, readScalarU16(payload, protocol.offset_input));
    }

    /// 喂一条答复进去。
    ///
    /// 一条答复总是某一条请求的答复：没有在飞的请求时先发一条，否则 SDK 以
    /// `EffectNotFound` 具名拒绝——那是它对「凭空出现的答复」的正确态度。
    fn answer(self: *CoreHarness, channel: replay_seam.Channel, bytes: []const u8) !void {
        const fx = &self.app_state.effects;
        if (fx.pendingHostCount() == 0) {
            try self.dispatch(.{ .project_request = "{\"kind\":\"readConfig\"}" });
        }
        try fx.feedHostResult(channel.key(), true, bytes);
        try self.harness.runtime.dispatchPlatformEvent(self.app, .wake);
    }
};

fn readScalarU16(payload: []const u8, offset: usize) u16 {
    if (payload.len < offset + 8) return 0;
    const value: f64 = @bitCast(std.mem.readInt(u64, payload[offset..][0..8], .little));
    if (!(value >= 0) or value > std.math.maxInt(u16)) return 0;
    return @intFromFloat(value);
}

/// 一条项目答复的线上字节。测试专用——真实的字节由 Rust 发。
fn projectResponse(buffer: []u8, text: []const u8) []const u8 {
    var response = protocol.emptyResponse(@intFromEnum(protocol.Action.project));
    response.protocol_version = protocol.protocol_version;
    response.api_version = protocol.api_version;
    response.capabilities = protocol.capability_mask;
    response.text_len = @intCast(text.len);
    // 线上编码器按 `text` 指针搬字节：只填长度不填指针，它会去读空投影。
    response.text = text.ptr;
    const encoded = protocol.encodeDispatchResponse(response);
    const total = protocol.response_header_bytes + text.len;
    @memcpy(buffer[0..total], encoded[0..total]);
    return buffer[0..total];
}

test "打开一份稿子：引用原样过界，路径只取换行之后那一段" {
    var h = try CoreHarness.create();
    defer h.destroy();
    try h.dispatch(.{ .document_open = "r-1\n章一.md" });
    try testing.expectEqual(protocol.Action.open_manuscript, h.parkedAction().?);
    try testing.expectEqualStrings("r-1\n章一.md", h.parkedText());
    try testing.expectEqualStrings("章一.md", h.model().document.path.slice());
    try testing.expectEqual(@as(?u64, null), h.model().pending_jump_block);
}

test "跨文档跳块：打开的答复落地后才补发那一条跳块投影" {
    var h = try CoreHarness.create();
    defer h.destroy();
    try h.dispatch(.{ .document_open_jump = .{ .reference = "r-1\n章二.md", .block = 12 } });
    try testing.expectEqual(@as(?u64, 12), h.model().pending_jump_block);

    const opened = testResponse(.open_manuscript, .{ .session = @as(u64, 3) });
    try h.answer(.dispatch, &opened);
    // 挂起的块序号已经兑现，不会在下一次答复里再跳一次。
    try testing.expectEqual(@as(?u64, null), h.model().pending_jump_block);
    try testing.expectEqual(@as(u64, 12), h.model().viewport.first_block);
    try testing.expectEqual(protocol.Action.obtain_projection, h.parkedAction().?);
}

test "打字翻成输入词汇表，没稿子就不发" {
    var h = try CoreHarness.create();
    defer h.destroy();
    // 没有稿子：一条请求都不该发出去。
    try h.dispatch(.{ .document_input = .{ .insert_text = "写" } });
    try testing.expect(h.parkedPayload() == null);

    h.model().document.session = 5;
    try h.dispatch(.{ .document_input = .{ .insert_text = "写" } });
    try testing.expectEqual(protocol.Action.apply_input, h.parkedAction().?);
    try testing.expectEqual(protocol.Input.insert_text, h.parkedInput().?);
    try testing.expectEqualStrings("写", h.parkedText());

    // 光标移动带方向码与拉选区的旗。
    try h.dispatch(.{ .document_input = .{ .move_caret = .{ .direction = .next_word, .extend = true } } });
    const flags = readScalarU16(h.parkedPayload().?, protocol.offset_flags);
    try testing.expectEqual(
        @as(u16, @intFromEnum(protocol.CaretDirection.next_word)),
        flags & protocol.caret_direction_mask,
    );
    try testing.expect(flags & protocol.caret_extend_flag != 0);
}

test "滚轮有自己的动作码，同一个偏移不再发一次" {
    var h = try CoreHarness.create();
    defer h.destroy();
    h.model().document.session = 5;
    try h.dispatch(.{ .document_scroll = .{ .offset_y = 240 } });
    try testing.expectEqual(protocol.Action.scroll_projection, h.parkedAction().?);
    try testing.expectEqual(@as(f64, 240), h.model().viewport.scroll);
    try testing.expectEqual(@as(usize, 1), h.app_state.effects.pendingHostCount());

    // 同一个偏移再来一次：不该有第二条。
    try h.dispatch(.{ .document_scroll = .{ .offset_y = 240 } });
    try testing.expectEqual(@as(usize, 1), h.app_state.effects.pendingHostCount());
}

test "即打即搜：打字先挂钟，到点才发一条块级搜索" {
    var h = try CoreHarness.create();
    defer h.destroy();
    try h.model().root_id.set("r-1");
    try h.dispatch(.{ .search_typed = .{ .insert_text = "素材" } });
    // 挂了钟而没有发请求：停下来才开火。
    try testing.expect(h.parkedPayload() == null);

    try h.dispatch(.{ .search_fire = .{ .key = timer_key.search_fire, .outcome = .fired } });
    try testing.expectEqual(protocol.Action.project, h.parkedAction().?);
    try testing.expectEqualStrings(
        "{\"kind\":\"blockSearch\",\"value\":{\"rootId\":\"r-1\",\"query\":\"素材\",\"precision\":\"loose\"}}",
        h.parkedText(),
    );

    // 被拒的定时器不开火——TS 车道里它与「真的烧到了」不可区分。
    const before = h.app_state.effects.pendingHostCount();
    try h.dispatch(.{ .search_fire = .{ .key = timer_key.search_fire, .outcome = .rejected } });
    try testing.expectEqual(before, h.app_state.effects.pendingHostCount());
}

test "KARA：失焦挂钟、回焦撤钟，离场之后回来发 returned" {
    var h = try CoreHarness.create();
    defer h.destroy();
    // off 里失焦不算离开：不挂钟，也不发请求。
    try h.dispatch(.{ .app_focus = false });
    try testing.expect(h.parkedPayload() == null);

    h.model().kara.state = @intFromEnum(KaraState.writing);
    try h.dispatch(.{ .app_focus = false });
    // 回来了：机器还在写作，撤钟就好，不骚扰 Rust。
    try h.dispatch(.{ .app_focus = true });
    try testing.expect(h.parkedPayload() == null);

    // 机器已经到 away：回焦要发 returned，否则它回不去。
    h.model().kara.state = @intFromEnum(KaraState.away);
    try h.dispatch(.{ .app_focus = true });
    try testing.expectEqualStrings(
        "{\"kind\":\"karaStep\",\"value\":{\"kind\":\"returned\"}}",
        h.parkedText(),
    );
}

test "KARA 答复：状态、队列与自消的展示一起落地" {
    var h = try CoreHarness.create();
    defer h.destroy();
    var buffer: [4096]u8 = undefined;
    const entering = projectResponse(&buffer,
        \\{"kind":"kara","value":{"state":{"kind":"entering"},"queued":["save-succeeded","proposal-arrived"],"effects":[]}}
    );
    try h.answer(.dispatch, entering);
    try testing.expectEqual(@intFromEnum(KaraState.entering), h.model().kara.state);
    // 1 已保存 | 4 提案到达。掩码位序与 kara.rs 的声明序同。
    try testing.expectEqual(@as(u8, 1 | 4), h.model().kara.queued);

    // 进场钟到点：还在 entering 才补发 entered。
    try h.dispatch(.{ .kara_entered = .{ .key = timer_key.kara_enter, .outcome = .fired } });
    try testing.expectEqualStrings(
        "{\"kind\":\"karaStep\",\"value\":{\"kind\":\"entered\"}}",
        h.parkedText(),
    );

    // 回来卡：卡文从 returnPoint 读出，600ms 后自消。
    var card_buffer: [4096]u8 = undefined;
    const card = projectResponse(&card_buffer,
        \\{"kind":"kara","value":{"state":{"kind":"writing"},"queued":[],"effects":[{"kind":"showReturnCard","value":{"returnPoint":{"sentenceTail":"写到这里。"}}}]}}
    );
    try h.answer(.dispatch, card);
    try testing.expect(h.model().kara.card);
    try testing.expectEqualStrings("写到这里。", h.model().kara.return_tail.slice());
    try h.dispatch(.{ .kara_card_done = .{ .key = timer_key.kara_card, .outcome = .fired } });
    try testing.expect(!h.model().kara.card);
    try testing.expect(h.model().kara.return_tail.isEmpty());

    // 回 Off：展示不该留在屏上。
    var off_buffer: [4096]u8 = undefined;
    const off = projectResponse(&off_buffer,
        \\{"kind":"kara","value":{"state":{"kind":"off"},"queued":[],"effects":[]}}
    );
    try h.answer(.dispatch, off);
    try testing.expectEqual(@intFromEnum(KaraState.off), h.model().kara.state);
    try testing.expect(h.model().kara.interrupt.isEmpty());
}

test "设置答复：排版三值与面板材质按层次取，不在字节里找引号" {
    var h = try CoreHarness.create();
    defer h.destroy();
    var buffer: [4096]u8 = undefined;
    const config = projectResponse(&buffer,
        \\{"kind":"config","value":{"appearance":{"theme":"sumi","panel_material":"acrylic","typography":{"text_size_tenths_px":185,"line_height_percent":170,"measure_tenths_em":600}}}}
    );
    try h.answer(.dispatch, config);
    try testing.expectEqual(@as(f64, 18.5), h.model().typography.text_size);
    try testing.expectEqual(@as(u32, 170), h.model().typography.line_height_percent);
    try testing.expectEqual(@as(f64, 60), h.model().typography.measure_em);
    try testing.expectEqual(@as(u8, 1), h.model().panel_material);
    // 答复落进设置槽，而不是把公共槽冲掉。
    try testing.expectEqualStrings("config", snapshot.kind(replies.borrow(.config)));
    try testing.expectEqualStrings("", replies.borrow(.project));
}

test "提案名录落地：行数、批次数、游标钳制与判后前进" {
    var h = try CoreHarness.create();
    defer h.destroy();
    h.model().document.session = 1;
    try h.dispatch(.{ .workbench_go = .review });
    h.model().roster_cursor = 5;
    h.model().review.advance_armed = true;

    var buffer: [4096]u8 = undefined;
    const listing = projectResponse(&buffer,
        \\{"kind":"proposals","value":{"proposals":[{"id":"p-1","afterText":"甲"},{"id":"p-2","afterText":"乙"}],"staged":["p-1"]}}
    );
    try h.answer(.dispatch, listing);
    try testing.expectEqual(@as(u32, 2), h.model().roster_count);
    try testing.expectEqual(@as(u32, 1), h.model().review.staged_count);
    // 游标钳进新长度，而不是停在一个不存在的行上。
    try testing.expectEqual(@as(?u32, 1), h.model().roster_cursor);
    // 判后前进的旗已经兑现成一次延迟，不会在下一条答复里再兑现一次。
    try testing.expect(!h.model().review.advance_armed);

    // 延迟到点：游标 +1，翻回 A 面。
    h.model().roster_cursor = 0;
    h.model().review.peer = true;
    try h.dispatch(.{ .review_advance = .{ .key = timer_key.review_advance, .outcome = .fired } });
    try testing.expectEqual(@as(?u32, 1), h.model().roster_cursor);
    try testing.expect(!h.model().review.peer);
}

test "裁决台的接受：主语是游标那一行，理由只骑一次裁决" {
    var h = try CoreHarness.create();
    defer h.destroy();
    h.model().document.session = 1;
    try h.model().root_id.set("r-1");
    _ = h.model().document.path.setTruncated("章一.md");
    try h.dispatch(.{ .workbench_go = .review });

    var buffer: [4096]u8 = undefined;
    const listing = projectResponse(&buffer,
        \\{"kind":"proposals","value":{"proposals":[{"id":"p-1","afterText":"甲"},{"id":"p-2","afterText":"乙"}],"staged":[]}}
    );
    try h.answer(.dispatch, listing);
    h.model().roster_cursor = 1;

    // 记下一条理由，然后接受。
    try h.dispatch(.review_reason_open);
    try h.dispatch(.{ .review_reason_typed = .{ .insert_text = "太长" } });
    try h.dispatch(.review_reason_commit);
    try h.dispatch(.verdict_accept);
    try testing.expectEqualStrings(
        "{\"kind\":\"stageVerdict\",\"value\":{\"rootId\":\"r-1\",\"path\":\"章一.md\",\"proposalId\":\"p-2\",\"kind\":\"accept\",\"finalText\":null,\"reason\":\"太长\"}}",
        h.parkedText(),
    );
    // 判后即清：理由不骑第二次裁决，判后前进的旗立起来了。
    try testing.expect(!h.model().review.reason_recorded);
    try testing.expect(h.model().review.reason.isEmpty());
    try testing.expect(h.model().review.advance_armed);
}

test "饭盒的裁决判了即落盘，且不读名录" {
    var h = try CoreHarness.create();
    defer h.destroy();
    try h.model().root_id.set("r-1");
    _ = h.model().document.path.setTruncated("章一.md");
    // 名录是空的：饭盒那条路不该问它。
    try h.dispatch(.{ .verdict_begin = .{ .id = "p-9", .seed = "改后的话" } });
    try h.dispatch(.verdict_reject);
    try testing.expectEqualStrings(
        "{\"kind\":\"judgeVerdict\",\"value\":{\"rootId\":\"r-1\",\"path\":\"章一.md\",\"proposalId\":\"p-9\",\"kind\":\"reject\",\"finalText\":null,\"reason\":null}}",
        h.parkedText(),
    );
    // 盒子关上了。
    try testing.expect(h.model().review.proposal.isEmpty());
}

test "改写的落定：空段不落，落定之后改写框收起" {
    var h = try CoreHarness.create();
    defer h.destroy();
    try h.model().root_id.set("r-1");
    _ = h.model().document.path.setTruncated("章一.md");

    // 改写框开着但字是空的：一行状态说明，不发请求。
    try h.dispatch(.{ .revision_begin = .{ .id = "p-3", .seed = "" } });
    try h.dispatch(.verdict_settle);
    try testing.expect(h.parkedPayload() == null);
    try testing.expect(!h.model().status.isEmpty());

    try h.dispatch(.{ .revision_typed = .{ .insert_text = "改后的话" } });
    try h.dispatch(.verdict_settle);
    try testing.expectEqualStrings(
        "{\"kind\":\"stageVerdict\",\"value\":{\"rootId\":\"r-1\",\"path\":\"章一.md\",\"proposalId\":\"p-3\",\"kind\":\"accept-modified\",\"finalText\":\"改后的话\",\"reason\":null}}",
        h.parkedText(),
    );
    try testing.expect(!h.model().revising.isOpen());
}

test "空批次不发提交，有批次才提交" {
    var h = try CoreHarness.create();
    defer h.destroy();
    h.model().document.session = 1;
    try h.model().root_id.set("r-1");
    _ = h.model().document.path.setTruncated("章一.md");
    try h.dispatch(.{ .workbench_go = .review });

    try h.dispatch(.verdict_settle);
    try testing.expect(h.parkedPayload() == null);

    h.model().review.staged_count = 2;
    try h.dispatch(.verdict_settle);
    try testing.expectEqualStrings(
        "{\"kind\":\"commitVerdicts\",\"value\":{\"rootId\":\"r-1\",\"path\":\"章一.md\"}}",
        h.parkedText(),
    );
}

test "编排快照：有在飞就挂下一跳，没有就停" {
    var h = try CoreHarness.create();
    defer h.destroy();
    try h.model().root_id.set("r-1");

    var idle_buffer: [4096]u8 = undefined;
    const idle = projectResponse(&idle_buffer,
        \\{"kind":"host","value":{"runs":[{"id":"a","progress":{"kind":"completed"}}]}}
    );
    try h.answer(.dispatch, idle);
    try testing.expectEqual(@as(u32, 1), h.model().roster_count);
    // 没有在飞：轮询自己停下，被拒的一跳也不发请求。
    try h.dispatch(.{ .runs_tick = .{ .key = timer_key.runs_tick, .outcome = .rejected } });
    try testing.expect(h.parkedPayload() == null);

    var busy_buffer: [4096]u8 = undefined;
    const busy = projectResponse(&busy_buffer,
        \\{"kind":"host","value":{"runs":[{"id":"a","progress":{"kind":"dispatched"}}]}}
    );
    try h.answer(.dispatch, busy);
    try h.dispatch(.{ .runs_tick = .{ .key = timer_key.runs_tick, .outcome = .fired } });
    try testing.expectEqualStrings(
        "{\"kind\":\"readHost\",\"value\":{\"rootId\":\"r-1\"}}",
        h.parkedText(),
    );
}

test "合并落盘之后名录必须重读，否则台上停着一排判过的鬼影" {
    var h = try CoreHarness.create();
    defer h.destroy();
    try h.model().root_id.set("r-1");
    _ = h.model().document.path.setTruncated("章一.md");
    var buffer: [4096]u8 = undefined;
    const decided = projectResponse(&buffer,
        \\{"kind":"decided","value":{"committed":2}}
    );
    try h.answer(.dispatch, decided);
    try testing.expectEqualStrings(
        "{\"kind\":\"readProposals\",\"value\":{\"rootId\":\"r-1\",\"path\":\"章一.md\"}}",
        h.parkedText(),
    );
}

test "一条已经编好的项目请求原样过界，超上界的具名拒绝" {
    var h = try CoreHarness.create();
    defer h.destroy();
    try h.dispatch(.{ .project_request = "{\"kind\":\"readConfig\"}" });
    try testing.expectEqual(protocol.Action.project, h.parkedAction().?);
    try testing.expectEqualStrings("{\"kind\":\"readConfig\"}", h.parkedText());

    const long = [_]u8{'x'} ** (protocol.event_text_bytes + 1);
    const before = h.app_state.effects.pendingHostCount();
    try h.dispatch(.{ .project_request = &long });
    try testing.expectEqual(before, h.app_state.effects.pendingHostCount());
    try testing.expect(!h.model().status.isEmpty());
}

test "回档带着历史面板那一行的动作 id" {
    var h = try CoreHarness.create();
    defer h.destroy();
    h.model().document.session = 5;
    try h.dispatch(.{ .document_revert = "a-42" });
    try testing.expectEqual(protocol.Action.apply_input, h.parkedAction().?);
    try testing.expectEqual(protocol.Input.revert_to, h.parkedInput().?);
    try testing.expectEqualStrings("a-42", h.parkedText());
}

test "裁决台的按钮把编好的请求原样送出，并立起判后前进旗" {
    var h = try CoreHarness.create();
    defer h.destroy();
    h.model().review.reason_recorded = true;
    try h.dispatch(.{ .desk_verdict = "{\"kind\":\"stageVerdict\",\"value\":{}}" });
    try testing.expectEqualStrings("{\"kind\":\"stageVerdict\",\"value\":{}}", h.parkedText());
    try testing.expect(h.model().review.advance_armed);
    try testing.expect(!h.model().review.reason_recorded);
    // 空请求什么都不做——一次没有主语的裁决不该过界。
    const before = h.app_state.effects.pendingHostCount();
    try h.dispatch(.{ .desk_verdict = "" });
    try testing.expectEqual(before, h.app_state.effects.pendingHostCount());
}

// ------------------------------------------------------------------ 三个入口
//
// `update` 之外，SDK 还要三条把平台事件译成 `Msg` 的路。它们不是臂，所以
// `pending_arms` 那条计数器数不到它们——单元 12 的 74/74 说的是臂，不是入口。
//
// 三条都**必须由接线显式设置**（`app_main.zig` 的 `Adapter.Options`）。转译核心
// 那条车道按导出名 comptime 探测 `frameMsg`／`keyMsg`，Zig 核心没有那层探测：
// 少写一行接线，快捷键全部静默，而这些函数的单元测试仍然全绿——因为它们测的是
// 翻译，不是接线。真窗口探针正是这样抓到 `on_command` 漏接的。

/// 一个命令 id 变成一条消息。
///
/// **接上哪个功能**：`app.zon` 声明的快捷键与系统菜单。SDK 把两者送到同一个入口，
/// 所以「Ctrl+3 去稿子」与「菜单里点稿子」必然是同一件事——两条路各写一份分派，
/// 它们就会漂开。
///
/// **只做 id → Msg 的翻译。** 「这个去处现在够不够得着」由 `update` 里的
/// `workbench.navigate` 判，这里不复制那条规则；不认识的 id 交出 `null`，由 SDK
/// 忽略，而不是猜一个默认动作。
///
/// id 的全集与它们的中文标签、键位显示串住在 `commands.zig`，`verify:command-space`
/// 钉住那张表与 `app.zon` 的交集。这里只管落点。
pub fn commandMsg(name: []const u8) ?Msg {
    if (std.mem.startsWith(u8, name, "go.") and name.len == 4) {
        const digit = name[3];
        if (digit >= '1' and digit <= '8') return .{ .workbench_key = digit - '0' };
        return null;
    }
    if (std.mem.eql(u8, name, "palette")) return .palette_toggle;
    if (std.mem.eql(u8, name, "kara.toggle")) return .kara_toggle;
    if (std.mem.eql(u8, name, "panel.back")) return .panel_back;
    if (std.mem.eql(u8, name, "panel.back.bracket")) return .panel_back;
    if (std.mem.eql(u8, name, "roster.next")) return .{ .roster_step = 1 };
    if (std.mem.eql(u8, name, "roster.previous")) return .{ .roster_step = -1 };
    if (std.mem.eql(u8, name, "document.save")) return .document_save;
    if (std.mem.eql(u8, name, "document.undo")) return .document_undo;
    // 搜索框住在文件树去处（键位序号 2）：直达即去那里，不新开一个去处。
    if (std.mem.eql(u8, name, "search")) return .{ .workbench_key = 2 };
    if (std.mem.eql(u8, name, "theme.next")) return .theme_next;
    if (std.mem.eql(u8, name, "app.quit")) return .app_quit;
    return null;
}

/// 一帧落地成一条消息。
///
/// SDK 每帧都调它，所以变化检测在这里而不在 `update`：尺寸没变交出 `null`，
/// `update` 不会被每秒六十次的空转打扰。换算规则（分栏表、宽度余量、字身宽）
/// 归 `projectionColumnsEm`／`viewportHeightPx`，这里不复制。
pub fn frameMsg(model: *const Model, frame: native_sdk.GpuFrame) ?Msg {
    if (frame.size.width == model.window.width and frame.size.height == model.window.height) {
        return null;
    }
    return .{ .frame = frame.size };
}

/// 一个原始键位变成一条消息。
///
/// **接上哪个功能**：饭盒的就地裁决键（Alt+A 接受 / Alt+B 退回 / Alt+E 改写）与
/// 裁决台的键盘流（Alt+J/K 移动、Alt+R 理由、Alt+P 竞争稿、Alt+Enter 落定）。
///
/// 只认按下那一相：`on_key` 默认不送抬起，但送不送由接线的 `key_release_events`
/// 决定，而一次抬起会让名字上唯一的动作发两遍。相由自己判，不靠接线的缺省。
///
/// 「现在开没开盒、在不在台上」由 `update` 判（饭盒字段空、游标无行、去处不是
/// 裁决台都原地不动），这里只翻译。
pub fn keyMsg(keyboard: canvas.WidgetKeyboardEvent) ?Msg {
    if (keyboard.phase != .key_down) return null;
    if (!keyboard.modifiers.alt) return null;
    if (std.mem.eql(u8, keyboard.key, "a")) return .verdict_accept;
    if (std.mem.eql(u8, keyboard.key, "b")) return .verdict_reject;
    if (std.mem.eql(u8, keyboard.key, "e")) return .verdict_revise;
    // 裁决台的移动与名录键同一条路：四个去处共用的游标不变量在 `core/roster.zig`，
    // 台上台下由 `update` 按去处判。
    if (std.mem.eql(u8, keyboard.key, "j")) return .{ .roster_step = 1 };
    if (std.mem.eql(u8, keyboard.key, "k")) return .{ .roster_step = -1 };
    if (std.mem.eql(u8, keyboard.key, "r")) return .review_reason_open;
    if (std.mem.eql(u8, keyboard.key, "p")) return .review_peer;
    if (std.mem.eql(u8, keyboard.key, "enter")) return .verdict_settle;
    return null;
}

/// 生命周期事件翻成焦点两面。
///
/// `activate`／`deactivate` 是 KARA 失焦计时（8s 判离开）的事实来源；
/// `start`／`frame`／`stop` 不译——核心只认焦点两面，把别的也译过来等于让
/// 一次启动看起来像一次回到窗前。
pub fn lifecycleMsg(event: native_sdk.LifecycleEvent) ?Msg {
    return switch (event) {
        .activate => .{ .app_focus = true },
        .deactivate => .{ .app_focus = false },
        else => null,
    };
}

test "命令 id 的落点：八个去处、两个返回同义、不认识的交出 null" {
    try testing.expectEqual(@as(u8, 3), commandMsg("go.3").?.workbench_key);
    try testing.expectEqual(@as(u8, 8), commandMsg("go.8").?.workbench_key);
    // 越界的序号不是一个去处：`go.9` 不在 app.zon 里，来了也不接管。
    try testing.expect(commandMsg("go.9") == null);
    try testing.expect(commandMsg("go.0") == null);
    try testing.expect(commandMsg("go.") == null);
    // 查找就是去文件树，不是第九个去处。
    try testing.expectEqual(@as(u8, 2), commandMsg("search").?.workbench_key);
    // Escape 与 Ctrl+[ 是同一件事的两个键。
    try testing.expectEqual(Msg.panel_back, commandMsg("panel.back").?);
    try testing.expectEqual(Msg.panel_back, commandMsg("panel.back.bracket").?);
    try testing.expectEqual(@as(i32, -1), commandMsg("roster.previous").?.roster_step);
    try testing.expect(commandMsg("nope") == null);
}

test "app.zon 声明的每一个快捷键 id 都有落点" {
    // 这条钉住的是接线的另一半：`commands.zig` 的表与 `app.zon` 由
    // `verify:command-space` 钉住，而「表里的 id 在核心里有没有落点」只有这里问。
    // 少一个落点的表现是按下去毫无反应，而翻译的单元测试仍然全绿。
    const commands = @import("commands.zig");
    for (&commands.commands) |command| {
        // Alt 系走 `keyMsg`，不在 app.zon 的 id 空间里。
        if (std.mem.startsWith(u8, command.id, "verdict.") or
            std.mem.startsWith(u8, command.id, "review.") or
            std.mem.startsWith(u8, command.id, "roster.step.")) continue;
        if (commandMsg(command.id) == null) {
            std.debug.print("commands.zig 里的 `{s}` 在核心里没有落点\n", .{command.id});
            return error.TestUnexpectedResult;
        }
    }
}

test "帧只在尺寸真的变了时才成为一条消息" {
    const model: Model = .{ .window = geometry.SizeF.init(400, 300) };
    // 同一个尺寸：不送，免得每秒六十次空转。
    try testing.expect(frameMsg(&model, .{ .size = geometry.SizeF.init(400, 300) }) == null);
    const resized = frameMsg(&model, .{ .size = geometry.SizeF.init(500, 300) }).?;
    try testing.expectEqual(@as(f32, 500), resized.frame.width);
}

test "台内键位只认按下那一相，且只认带 Alt 的" {
    // 抬起不该让同一个动作再发一遍。
    try testing.expect(keyMsg(.{ .phase = .key_up, .key = "a", .modifiers = .{ .alt = true } }) == null);
    // 不带 Alt 的 a 是作者在打字。
    try testing.expect(keyMsg(.{ .phase = .key_down, .key = "a" }) == null);
    try testing.expectEqual(
        Msg.verdict_accept,
        keyMsg(.{ .phase = .key_down, .key = "a", .modifiers = .{ .alt = true } }).?,
    );
    try testing.expectEqual(
        @as(i32, 1),
        keyMsg(.{ .phase = .key_down, .key = "j", .modifiers = .{ .alt = true } }).?.roster_step,
    );
    try testing.expectEqual(
        Msg.verdict_settle,
        keyMsg(.{ .phase = .key_down, .key = "enter", .modifiers = .{ .alt = true } }).?,
    );
    try testing.expect(keyMsg(.{ .phase = .key_down, .key = "z", .modifiers = .{ .alt = true } }) == null);
}

test "生命周期只译焦点两面" {
    try testing.expect(lifecycleMsg(.activate).?.app_focus);
    try testing.expect(!lifecycleMsg(.deactivate).?.app_focus);
    // 启动不是一次回到窗前。
    try testing.expect(lifecycleMsg(.start) == null);
    try testing.expect(lifecycleMsg(.frame) == null);
    try testing.expect(lifecycleMsg(.stop) == null);
}
