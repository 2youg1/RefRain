// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 正稿轨：版面度量、锚点、裁决便当、状态行、右键菜单。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

const std = @import("std");
const native_sdk = @import("native_sdk");
const protocol = @import("../generated/protocol.zig");
const themes = @import("../generated/themes.zig");
const core = @import("../core.zig");
const replies = @import("../core/replies.zig");
const host_bridge = @import("../host_bridge.zig");
const commands = @import("../commands.zig");
const material_paint = @import("../material_paint.zig");
const project_request = @import("../project_request.zig");
const project_view = @import("../project_view.zig");
const document_language = @import("../document_language.zig");
const Adapter = core.App;
const Model = core.Model;
const Msg = core.Msg;
const shell_view = @import("shell.zig");
const view_harness = @import("harness.zig");
const review_view = @import("review.zig");

test "the document track inverts the projection's scroll anchor" {
    const text = "a\n\nb";
    // 视口高与行高由调用方按 Model 换算后传入；这里沿用旧的 650/18 直接给值，
    // 几何断言不变——换签名不换语义。
    const top = documentLayout(.{
        .text = text,
        .window_start = 0,
        .window_end = text.len,
        .first_block = 0,
        .block_count = 2,
        .document_selection_start = 0,
        .document_selection_end = 0,
        .selection = null,
        .composition = null,
        .line_count = 3,
        .format = 0,
        .ranges = &.{},
        .line_starts = &.{},
    }, 100_000, 650, 18);
    try std.testing.expectEqual(@as(f32, 0), top.leading);

    const tail = documentLayout(.{
        .text = text,
        .window_start = 1000 - text.len,
        .window_end = 1000,
        .first_block = 50_000,
        .block_count = 2,
        .document_selection_start = 0,
        .document_selection_end = 0,
        .selection = null,
        .composition = null,
        .line_count = 3,
        .format = 0,
        .ranges = &.{},
        .line_starts = &.{},
    }, 100_000, 650, 18);
    // 互逆：把前导空白当成一次滚轮的偏移交回 Rust 的映射，得回同一块。
    // 注入证明：把 `leading` 改回按比例摊，这一条立刻报出别的块号。
    try std.testing.expectEqual(
        @as(u64, 50_000),
        @as(u64, @intFromFloat(@floor(tail.leading / document_block_height))),
    );
    // 末窗之后没有可滚的余量：拖尾归零，轨底恰是最后一屏的底。
    const at_last_window = documentLayout(.{
        .text = text,
        .window_start = 0,
        .window_end = text.len,
        .first_block = 99_904,
        .block_count = 96,
        .document_selection_start = 0,
        .document_selection_end = 0,
        .selection = null,
        .composition = null,
        .line_count = 3,
        .format = 0,
        .ranges = &.{},
        .line_starts = &.{},
    }, 100_000, 650, 18);
    try std.testing.expectEqual(@as(f32, 0), at_last_window.trailing);
    try std.testing.expectEqual(@as(f32, 99_904 * 36), at_last_window.leading);

    // 一屏装得下整份稿子：没有行程，轨高就是投影实高。
    const short = documentLayout(.{
        .text = text,
        .window_start = 0,
        .window_end = text.len,
        .first_block = 0,
        .block_count = 2,
        .document_selection_start = 0,
        .document_selection_end = 0,
        .selection = null,
        .composition = null,
        .line_count = 3,
        .format = 0,
        .ranges = &.{},
        .line_starts = &.{},
    }, 2, 650, 18);
    try std.testing.expectEqual(@as(f32, 0), short.leading);
    try std.testing.expectEqual(@as(f32, 0), short.trailing);
    try std.testing.expectEqual(@as(f32, 650), short.projection);
}

const document_block_height: f32 = @floatCast(protocol.virtual_block_height);

/// 帧前的滚动布局缺省：帧还没到（`frameMsg` 未落地）时视口高先用它，
/// 首帧一到即被真实窗口换算值替换。旧的 650 硬编码的错误不在数值，
/// 在于帧到了还用——这里只担保第一帧之前。
const pre_frame_viewport_height: f32 = 650;

const DocumentLayout = struct {
    leading: f32,
    projection: f32,
    trailing: f32,
};

/// 行高（px）：与编辑区部件的绘制同一式——字号 × 行高百分比。
/// 排版三值经 core 从设置答复落地进 Model；缺省与 Rust
/// `TypographyConfig::default`（config.rs）同源（17px / 190%）。
pub fn documentLineHeightPx(model: *const Model) f32 {
    const size: f32 = @floatCast(model.typography.text_size);
    const percent: f32 = @floatFromInt(model.typography.line_height_percent);
    if (size <= 0 or percent <= 0) return 0;
    return size * percent / 100;
}

/// 视口高（px）：帧到了用 core 按真实窗高换算的值（`viewportHeightPx`），
/// 没到用帧前缺省。滚动布局每帧都要一个值，不等第一帧。
pub fn documentViewportHeightPx(model: *const Model) f32 {
    if (model.viewport.height_px > 0) return @floatFromInt(model.viewport.height_px);
    return pre_frame_viewport_height;
}

/// 正文列宽（px）：生效行长（core 的 `projectionColumnsEm`：作者行长与
/// 视口实测取小）× 字号——字身宽即字号（CJK 全角 advance 恒为 1em）。
/// 0 表示帧还没到，编辑区自动宽。
pub fn documentColumnWidthPx(model: *const Model) f32 {
    if (model.viewport.columns_em <= 0 or model.typography.text_size <= 0) return 0;
    return @floatCast(model.viewport.columns_em * model.typography.text_size);
}

/// 滚动轨道的几何：投影窗口的真实内容高、窗口前后的空白。行高与视口高
/// 由调用方按 Model 换算——本函数是纯几何，不认识排版配置（同一式只有
/// `documentLineHeightPx` 一处，这里与测试都不抄第二遍）。
///
/// **刻度与锚定互逆**：Rust 的滚动锚点算 `首块 = floor(偏移 / 虚拟块高)`
/// （`DocumentAnchor::Scroll`），这里的前导空白就得是 `首块 × 虚拟块高`——
/// 一次滚轮落在哪一块，那一块的顶边就落在同一个偏移上。旧式按
/// `travel × 首块 / 末窗` 摊，摊的是「轨高减投影实高」，而投影实高只有绘制
/// 侧知道：两边各算一套映射，滚动条与窗口因此对不上（M13 的后半）。
///
/// 末窗 = 总块数 − 一屏块数，与 Rust 的 `anchor_block` 同式；一屏块数取
/// 协议常量，因为核心每条请求都发它。轨高随之是「末窗的滚动行程 + 投影
/// 实高」，可滚区间恰好覆盖 Rust 认得的 `[0, 末窗 × 虚拟块高]`，越界的
/// 钳制仍只有 Rust 一份。
pub fn documentLayout(document: host_bridge.DocumentView, total_blocks: u64, viewport_height: f32, line_height: f32) DocumentLayout {
    const projection_height = @max(viewport_height, @as(f32, @floatFromInt(document.line_count)) * line_height);
    const last_window = total_blocks -| @as(u64, protocol.default_viewport_blocks);
    const first_block = @min(document.first_block, last_window);
    const leading = @as(f32, @floatFromInt(first_block)) * document_block_height;
    const trailing = @as(f32, @floatFromInt(last_window - first_block)) * document_block_height;
    return .{
        .leading = leading,
        .projection = projection_height,
        .trailing = trailing,
    };
}

/// 正文上的右键菜单：把边栏的常用动作带到光标旁边。
///
/// **接上哪个功能**：保存、撤销、去文件树、去裁决台、去信箱、换主题。它们
/// 本来只住在窗口边缘的工具栏与侧栏里。
///
/// **在全局逻辑中负责什么**：只是同一批 Msg 的第二个入口，不是第二套规则——
/// 每一项派的都是 `commandMsg` 那些消息，所以菜单、快捷键、工具栏三处必然
/// 一致。「这个去处现在够不够得着」仍由 `update` 里的 `navigate` 判。
///
/// **为什么值得做**：KARA 模式下正文占满屏幕，而作者的手在触控板上——去一趟
/// 屏幕边缘要一次长距离移动加一次瞄准。菜单开在光标处，同样的动作是一次
/// 短按。macOS 的触控板习惯（双指轻点）本来就落在这个入口上。
///
/// 呈现由平台决定：有原生菜单宿主就用 `NSMenu`／`TrackPopupMenu`，没有就退回
/// SDK 自绘的一层——而那一层读的是 `manuscriptTokens`，所以昼间主题上它是
/// 纸色的，不是一块黑板。
pub fn manuscriptMenu(model: *const Model) []const Adapter.Ui.ContextMenuItem {
    // 这两块静态存储**不是轮换池**，别按轮换池读它们（`project_request` 那一家
    // 已经搬进 build arena 了）。`table` 每次重写而 SDK 把菜单**数组**拷进
    // arena（`ui.zig:1624,1645`），所以下一帧重写它碰不到已呈现的那份；
    // `hint_labels` 是「标签　键位」拼接串的定址槽，**一个命令一个下标、永不
    // 推进**，内容每帧相同。两者都不会把一个行的字节写成另一个行的。
    const State = struct {
        var table: [16]Adapter.Ui.ContextMenuItem = undefined;
        var hint_labels: [6][64]u8 = undefined;
    };
    const selected = selectedText(host_bridge.documentView());
    // 高亮要有选区才有意义。灰掉而不是移除：一个时有时无的菜单项会让
    // 作者以为自己记错了菜单的样子。
    State.table = .{
        .{ .label = "高亮这一段", .msg = annotateMsg(model, selected), .enabled = selected.len > 0 },
        .{ .label = "转全角", .msg = review_view.convertWidthMsg(model, selected, false, "to-full"), .enabled = selected.len > 0 },
        .{ .label = "转半角", .msg = review_view.convertWidthMsg(model, selected, false, "to-half"), .enabled = selected.len > 0 },
        // 攒进发送：把选区原文存进派发台的攒段（NUL 分隔），送出时逐段
        // 成 scope。与「高亮这一段」同一条选区纪律——空选区灰掉。
        .{ .label = "攒进发送", .msg = @as(?Msg, .{ .dispatch_stash = selected }), .enabled = selected.len > 0 },
        .{ .separator = true },
        // 全文级：不用选区，作者在任意处都能叫出整篇转换。
        .{ .label = "整篇转全角", .msg = review_view.convertWidthMsg(model, "", true, "to-full"), .enabled = true },
        .{ .label = "整篇转半角", .msg = review_view.convertWidthMsg(model, "", true, "to-half"), .enabled = true },
        .{ .separator = true },
        // 键位印在菜单项上（「保存　Ctrl+S」，浏览器右键同款）——让人
        // 用着用着就学会了。键位从命令表拼。
        .{ .label = commands.withHint(&State.hint_labels[0], "document.save"), .msg = .{ .document_save = {} } },
        .{ .label = commands.withHint(&State.hint_labels[1], "document.undo"), .msg = .{ .document_undo = {} } },
        .{ .separator = true },
        // 三个最常用的去处直达。八个全列会让菜单变成一张目录，
        // 而目录已经是命令面板（⌘K）的活。只有文件有固定键位（Ctrl+2 =
        // go.2 → FILES）；裁决/派发走 workbench_go 直达到处下标——
        // workbench_key 的 ordinal  remap 后 3 是稿子、4 是动态的 Agent
        // 去处，印它们的键位会教作者一个按到别处的组合。
        .{ .label = commands.withHint(&State.hint_labels[2], "go.2"), .msg = .{ .workbench_key = 2 } },
        .{ .label = "裁决", .msg = .{ .workbench_go = .review } },
        .{ .label = "派发", .msg = .{ .workbench_go = .dispatch } },
        .{ .separator = true },
        .{ .label = commands.withHint(&State.hint_labels[5], "palette"), .msg = .{ .palette_toggle = {} } },
    };
    return &State.table;
}

/// 在选中的一段正文上留一条高亮。
///
/// 只做高亮不做评论：评论要作者写一段字，而右键菜单按下即执行。
/// 评论走批注面板（尚未接）。
fn annotateMsg(model: *const Model, selected: []const u8) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    if (selected.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.annotate(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        selected,
        // 空 body 即高亮。
        "",
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 作者此刻选中的那段正文。
///
/// 从投影里切：选区的偏移是相对 `document.text` 的，而那正是 Rust 送过来
/// 的那一窗字节。空选区返回空切片——不猜「他大概想派发整段」。
pub fn selectedText(document: host_bridge.DocumentView) []const u8 {
    const selection = document.selection orelse return &.{};
    const start = @min(selection.anchor, selection.focus);
    const end = @max(selection.anchor, selection.focus);
    if (end <= start or end > document.text.len) return &.{};
    return document.text[start..end];
}

/// 印点几何：块右缘内侧的 9px 方点，垂直居中于命中的那一行。
/// 一窗至多画 max_anchor_dots 颗——窗口里通常只有几颗，超了宁可少画
/// 也不让叠放数组越界。
const anchor_dot_size: f32 = 9;

pub const max_anchor_dots: usize = 32;

/// 行首表是升序的（第一项恒 0）：命中的行是最后一个 ≤ at 的下标。
fn lineIndexOf(line_starts: []const u32, at: u32) usize {
    var lo: usize = 0;
    var hi: usize = line_starts.len;
    while (lo + 1 < hi) {
        const mid = lo + (hi - lo) / 2;
        if (line_starts[mid] <= at) lo = mid else hi = mid;
    }
    return lo;
}

/// 一颗提案印点：点开就地饭盒。位置由禁则行首推（y）与版心右缘（x）——
/// 与正文同一坐标系，所以滚动时它跟着段落走。
pub fn anchorDot(
    ui: *Adapter.Ui,
    model: *const Model,
    range: protocol.AnchorRangeWire,
    column_width: f32,
    line_height: f32,
    line_starts: []const u32,
) Adapter.Ui.Node {
    const line = lineIndexOf(line_starts, range.start);
    return ui.button(.{
        .frame = native_sdk.geometry.RectF.init(
            @max(0, column_width - anchor_dot_size - 3),
            @as(f32, @floatFromInt(line)) * line_height + @max(0, (line_height - anchor_dot_size) / 2),
            anchor_dot_size,
            anchor_dot_size,
        ),
        .on_press = verdictBeginMsg(model, range),
        .semantics = .{ .label = "这里有提案，点开裁决（Alt+A 接受 / Alt+B 退回）" },
    }, "");
}

/// 就地裁决饭盒：一次一个，开在命中行的下缘。接受/退回的请求在
/// `verdict_begin` 里预编好（提案 id 是变量，core 子集不拼 JSON）——
/// 按钮与 Alt 键送出的是同一条。
///
/// **交互设计（2.1a）**：在正文里判，不切台——作者写着写着看到印点，
/// 点一下（或记住键位后 Alt 系）就地判完继续写。与裁决台的差别在
/// 落盘时机：饭盒判了即落盘（judgeVerdict = 记账+提交一步，v0.2.4
/// 信箱侧「接受类立即合并、退回只记录」的语义），判完饭盒消失、作者
/// 回到写作；裁决台是批量台，判完进批次等合并。键位：Alt+A 接受 /
/// Alt+B 退回 / Alt+E 改后接受（起笔是 agent 的建议）/ Alt+Enter
/// 落定改写 / Escape 关盒（panel_back 分层里它在最内层）。键位印在
/// 按钮上：作者多数时候鼠标停在文本区，第一次用眼睛学，之后用手。
/// 一次只开一个盒：两处同时判会让「我判的是哪一条」失去答案。
pub fn verdictBento(
    ui: *Adapter.Ui,
    model: *const Model,
    document: host_bridge.DocumentView,
    column_width: f32,
    line_height: f32,
) ?Adapter.Ui.Node {
    if (model.review.proposal.slice().len == 0) return null;
    for (document.ranges) |range| {
        if (range.kind != 3) continue;
        if (!std.mem.eql(u8, &range.id, model.review.proposal.slice())) continue;
        const line = lineIndexOf(document.line_starts, range.start);
        const width = @min(@as(f32, 340), @max(@as(f32, 240), column_width));
        const revising = std.mem.eql(u8, model.revising.id.slice(), model.review.proposal.slice());
        var bento = ui.el(.panel, .{
            .frame = native_sdk.geometry.RectF.init(
                @max(0, column_width - width),
                (@as(f32, @floatFromInt(line)) + 1) * line_height + 8,
                width,
                0,
            ),
            .padding = 8,
        }, .{
            ui.column(.{ .gap = 6 }, .{
                ui.row(.{ .gap = 8 }, .{
                    ui.button(.{
                        .on_press = @as(?Msg, .verdict_accept),
                        .semantics = .{ .label = "接受这条提案（Alt+A）" },
                    }, "接受 (Alt+A)"),
                    ui.button(.{
                        .on_press = @as(?Msg, .verdict_revise),
                        .semantics = .{ .label = "改写这条提案（Alt+E）" },
                    }, "改后接受 (Alt+E)"),
                    ui.button(.{
                        .on_press = @as(?Msg, .verdict_reject),
                        .semantics = .{ .label = "退回这条提案（Alt+B）" },
                    }, "退回 (Alt+B)"),
                    ui.button(.{
                        .on_press = @as(?Msg, .verdict_close),
                        .semantics = .{ .label = "关上饭盒（Escape）" },
                    }, "关 (Esc)"),
                }),
                if (revising)
                    ui.column(.{ .gap = 6 }, .{
                        ui.code(.{
                            .language = document_language.syntaxOf(document.format),
                            .editable = true,
                            .wrap = true,
                            .on_input = Adapter.Ui.inputMsg(.revision_typed),
                            .semantics = .{ .label = "改写后的正文" },
                        }, model.revising.body.slice()),
                        ui.button(.{
                            .variant = .primary,
                            .disabled = model.revising.body.slice().len == 0,
                            .on_press = judgeRevisionMsg(model),
                            .semantics = .{ .label = "按我改的这版接受并落盘" },
                        }, "落定 (Alt+Enter)"),
                    })
                else
                    ui.el(.stack, .{ .height = 0 }, .{}),
            }),
        });
        // 饭盒也吃材质（2.10）：它是编辑区词汇不是浮窗，但与功能区面板
        // 同一份配方——透光度/模糊一张表，不存在「饭盒另是一层皮」。
        material_paint.apply(
            &bento.widget,
            model.panel_material,
            &themes.themes[shell_view.currentThemeIndex(model)],
        );
        return bento;
    }
    return null;
}

/// 点开印点：带提案 id 与起笔（名录没在读就空起笔）。
///
/// 单元 13 之前这里还预编两条 `judgeVerdict` 请求随 `Msg` 搭过去，因为受限子集
/// 拼不出 JSON，只能让 Zig 在渲染时先编好。Zig 核心自己调得动编码器，那一族摆渡
/// 字段因此不存在（`core/msg.zig` 里有一条测试钉着它不要回来）。
fn verdictBeginMsg(model: *const Model, range: protocol.AnchorRangeWire) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    const id: []const u8 = &range.id;
    return .{ .verdict_begin = .{ .id = id, .seed = proposalSeedById(id) } };
}

/// 从裁决名录里按 id 读起笔（agent 的建议）。名录没在读就空起笔。
fn proposalSeedById(id: []const u8) []const u8 {
    if (replies.borrow(.proposals).kind() != .proposals) return "";
    const listing = replies.borrow(.proposals);
    var index: usize = 0;
    while (index < shell_view.card_rows) : (index += 1) {
        const proposal = project_view.proposalAt(listing, index) orelse break;
        if (std.mem.eql(u8, proposal.id, id)) return proposal.after_text;
    }
    return "";
}

/// 改后接受并落盘：作者写的那段成为最终正文，一次完成（judgeVerdict
/// 把记账与提交合成一步——饭盒不停留，作者回到写作）。
fn judgeRevisionMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    if (model.revising.id.slice().len == 0 or model.revising.body.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.judgeVerdict(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        model.revising.id.slice(),
        "accept-modified",
        model.revising.body.slice(),
        "",
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 状态行（2.6）：保存点、选中统计、活动句。
///
/// **接上哪个功能**：core 的 `savePending/savedRevision`（保存证据链，
/// native-save 通道）与投影的 `document_selection_*`（全文字节偏移）。
/// 措辞的唯一权威是这里——状态行只有一行，每一句都要值得那一行。
///
/// **交互设计**：句序 = 作者此刻最想知道的：活动在飞（正在保存…）>
/// 有未保存改动 > 已保存 · 相对时刻。选中段只在有选区时出现，越出
/// 视窗的部分如实标「+」不假装数得出。保存是原子动作、没有可量的
/// 进度，所以等待只说「正在保存…」，不画假装进度的百分比。没有稿子
/// 时说「还没有打开稿子」，不画一串零。
pub fn statuslineText(ui: *Adapter.Ui, model: *const Model, document: host_bridge.DocumentView) []const u8 {
    if (model.document.session == 0) return "还没有打开稿子";
    const save_seg = saveSegment(ui, model);
    const stats = project_view.selectionStats(
        document.text,
        document.window_start,
        document.document_selection_start,
        document.document_selection_end,
    ) orelse return save_seg;
    if (stats.chars == 0 and stats.clipped) return ui.fmt("{s} · 选中（越出视窗）", .{save_seg});
    return ui.fmt("{s} · 选中 {d} 字 · {d} 段{s}", .{
        save_seg,
        stats.chars,
        stats.blocks,
        if (stats.clipped) "+" else "",
    });
}

/// 保存段的墙钟打戳：渲染时观测 `savedRevision` 的变化沿，变化的那帧
/// 打上本地毫秒戳。这是 UI 的观测不是协议——与真实落盘最多差一帧；
/// core 子集没有墙钟，钟只能长在视图侧（注释即约定，读数别当协议用）。
///
/// **两者都是可选的，而不是从 0 起算。** 旧式拿 `0` 当「还没打过戳」，于是一份
/// 打开时就已落盘的稿子——`saved_revision` 与戳都是 0，永远碰不到变化沿——把
/// `nowMs() - 0` 当成了间隔，状态行写着「已保存 · 496341 小时前」，那是 Unix
/// 纪元。读错以外它还每过一小时变一次，于是每一条打开稿子的 journal 在录制后
/// 一小时内就失效：上两轮会话都在本机看见 8/8，而 CI 稍后跑到同一步全红，
/// 两次都被归因成了别的东西（M8 的余波、录制过期）。
///
/// `null` 说的是「本会话没观测到任何一次保存」，那时候视图手里没有钟读数可报，
/// 就不报——而不是拿一个哨兵值假装成一次保存。
var statusline_stamped_revision: ?u64 = null;

var statusline_save_ms: ?i64 = null;

/// 保存段说的四件事之一。穷尽枚举而不是「可能为空的字串」：
/// `saved_unobserved`（已落盘，但本会话没看见过那一次保存）是一个具名的答案，
/// 不是一个缺省——正是把它当缺省，才让状态行报出了 Unix 纪元。
pub const SaveState = union(enum) {
    saving,
    dirty,
    saved_unobserved,
    saved_since_ms: i64,
};

/// 保存段的判定。不认识 `Ui`，也不自己读钟——戳与当下都由调用方给，
/// 所以这条规则可以在没有窗口的测试里被钉住。
pub fn saveState(
    save_pending: bool,
    revision: u64,
    saved_revision: u64,
    observed_save_ms: ?i64,
    now_ms: i64,
) SaveState {
    if (save_pending) return .saving;
    if (revision != saved_revision) return .dirty;
    const at = observed_save_ms orelse return .saved_unobserved;
    return .{ .saved_since_ms = now_ms - at };
}

test "the save segment never reports a save this session did not observe" {
    // 打开一份打开时就已落盘的稿子：没有观测到保存沿，就没有钟读数可报。
    // 旧式在这里算 `now - 0`，状态行写出「已保存 · 496341 小时前」（Unix 纪元），
    // 而且那个数每过一小时变一次——每一条打开稿子的 journal 因此在录制后一小时
    // 内失效，本机 8/8 而 CI 全红。注入证明：把 `orelse` 换回一个 0 缺省，
    // 这一条立刻读出一个纪元量级的间隔。
    try std.testing.expectEqual(SaveState.saved_unobserved, saveState(false, 3, 3, null, 1_760_000_000_000));
    try std.testing.expectEqual(SaveState.saving, saveState(true, 3, 3, null, 0));
    try std.testing.expectEqual(SaveState.dirty, saveState(false, 4, 3, null, 0));
    // 观测到保存之后才有间隔可报，而它是「当下减那一戳」，不是「当下减纪元」。
    try std.testing.expectEqual(
        SaveState{ .saved_since_ms = 3_000 },
        saveState(false, 3, 3, 1_000, 4_000),
    );
}

fn saveSegment(ui: *Adapter.Ui, model: *const Model) []const u8 {
    // 只在「不在保存中且没有未落盘改动」的帧上观测沿，与旧式同序：
    // 这两种状态下 `saved_revision` 还不是作者看见的那一份。
    if (!model.document.save_pending and model.document.revision == model.document.saved_revision) {
        if (statusline_stamped_revision) |stamped| {
            if (stamped != model.document.saved_revision) {
                statusline_stamped_revision = model.document.saved_revision;
                // 墙钟走 SDK 的 runtime.nowMs（三平台一致，Windows 用 NT 精确系统
                // 时间）：Zig 0.16 的 std.time 已不再暴露墙钟。
                statusline_save_ms = native_sdk.runtime.nowMs();
            }
        } else {
            // 第一次看见这份稿子已是落盘态：那是打开时就有的，不是本会话保存的。
            // 记下版次好让下一次真的保存被认成变化沿，但不打钟戳。
            statusline_stamped_revision = model.document.saved_revision;
        }
    }
    return switch (saveState(
        model.document.save_pending,
        model.document.revision,
        model.document.saved_revision,
        statusline_save_ms,
        native_sdk.runtime.nowMs(),
    )) {
        .saving => "正在保存…",
        .dirty => "有未保存改动",
        .saved_unobserved => "已保存",
        .saved_since_ms => |elapsed| blk: {
            var buf: [32]u8 = undefined;
            break :blk ui.fmt("已保存 · {s}", .{project_view.relativeSaveText(&buf, elapsed)});
        },
    };
}

test "状态行报的是这一份投影说的选区，不是一串零" {
    // 状态行是作者判断「我选中了多少」的唯一读数，而它的输入是一次投影的
    // 窗口坐标。这一条不碰任何模块级存储：`DocumentView` 是按值传进来的，
    // 所以它问的正是「同一份投影进去，出来的话对不对」。
    //
    // 没开稿子时它必须说人话，不是画一串零——那是同一个函数最容易退化的方向。
    var surface = view_harness.Surface.init(std.testing.allocator);
    defer surface.deinit();
    surface.ui = Adapter.Ui.init(surface.arena.allocator());
    var model: Model = .{};

    const empty: host_bridge.DocumentView = .{
        .text = "",
        .window_start = 0,
        .window_end = 0,
        .first_block = 0,
        .block_count = 0,
        .document_selection_start = 0,
        .document_selection_end = 0,
        .selection = null,
        .composition = null,
        .line_count = 1,
        .format = 0,
        .ranges = &.{},
        .line_starts = &.{},
    };
    try std.testing.expectEqualStrings(
        "还没有打开稿子",
        statuslineText(&surface.ui, &model, empty),
    );

    // 开了稿子、选中两个字：读数必须是那两个字，而不是窗口里的全部。
    model.document.session = 1;
    const text = "剑一直握在他手里。";
    const opened: host_bridge.DocumentView = .{
        .text = text,
        .window_start = 0,
        .window_end = text.len,
        .first_block = 0,
        .block_count = 1,
        .document_selection_start = 0,
        .document_selection_end = 6,
        .selection = .{ .anchor = 0, .focus = 6 },
        .composition = null,
        .line_count = 1,
        .format = 0,
        .ranges = &.{},
        .line_starts = &.{},
    };
    const line = statuslineText(&surface.ui, &model, opened);
    try std.testing.expect(std.mem.indexOf(u8, line, "选中 2 字") != null);
}
