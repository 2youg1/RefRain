// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 裁决台：提案行、A/B 面、理由、批注、过期提案。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

const std = @import("std");
const core = @import("../core.zig");
const replies = @import("../core/replies.zig");
const host_bridge = @import("../host_bridge.zig");
const commands = @import("../commands.zig");
const wire = @import("../generated/wire.zig");
const project_request = @import("../project_request.zig");
const project_view = @import("../project_view.zig");
const view_harness = @import("harness.zig");
const document_language = @import("../document_language.zig");
const Adapter = core.App;
const Model = core.Model;
const Msg = core.Msg;
const shell_view = @import("shell.zig");
const document_view = @import("document.zig");

/// 裁决台：一列提案，每条带前后文与三个裁决动作。
///
/// **接上哪个功能**：`ReadProposals`、`StageVerdict`、`CommitVerdicts`。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。判过没判过归 Rust 送来的
/// `staged`（它已按账本配对到提案 id），落盘的三态归 `DecisionReport`——
/// 界面不自己记「我判了几条」，那会与账本漂开。
///
/// **为什么前后文都画**：作者判的是「这一改值不值得」，只看新文本判不了。
///
/// **交互设计（v0.2.4 回迁，2.1b）**：这一台是为「坐着不动、连判十二条」
/// 设计的——作者厌大范围鼠标移动，所以每个动作都有键位，键位就印在
/// 按钮上（浏览器右键同款，让肌肉自己学会）：
///
/// - Alt+J/K 上下移动游标（高亮行）；就是名录键 roster_step，四个去处
///   共用一份越界钳制（roster.ts）。判完一条 120ms 后游标自动 +1——
///   延迟挂在答复落地时（core 的 reviewAdvanceArmed → Cmd.delay），
///   判失败不动：作者的注意力不该被一次失败推着走。只 +1 不跳过已判，
///   与 v0.2.4 一致：已判行留着标「已判」，作者看得见自己判到哪。
/// - Alt+A 接受 / Alt+B 退回 / Alt+E 改后接受：直接判游标行。退回键
///   与就地饭盒统一用 Alt+B（v0.2.4 桌面曾是 Alt+X——一词一义，一个
///   动作不教两种键）。「只评论」没有键：它是少见动作，按钮够得着。
/// - Alt+R 理由：单行框开在游标行，Enter 记（空也记）、Escape 当作没
///   问过；记下的理由随下一次裁决发出，判后即清——它不赖着影响下
///   一条。理由框内 Escape 被 SDK 文本部件吃掉，所以「取消」按钮是
///   兜底出口（v0.2.4 纪律：快捷键不能是唯一入口）。
/// - Alt+P 翻竞争稿：同 scope（同一段）的另一条提案是竞争者，翻 B 面
///   把它的改法画出来对照；再翻回 A 面。v0.2.4 只翻角标不换内容
///   （未完成特性），这里把内容真的画出来。跟着行走不跟着台子走。
/// - Alt+Enter 落定：改写中 = 把改写落成裁决；否则 = 提交暂存的批次
///   （空批次不发，按钮先灰）。合并落盘后名录自动重读——已判提案被
///   领域层收走，不重读台面就停着一排鬼影。
/// - Escape 逐层关（core 的 panel_back）：饭盒 > 理由框 > 改写框 >
///   过期面板 > 退栈，一次只关一层。
///
/// **两条请求路径**：行内按钮的字节在本文件渲染时由 project_request.zig
/// 编好（`desk_verdict` 臂）；键盘路径等不到带数据的 Zig 事件，字节由
/// core 的 wire_json 拼出——两侧逐字节同形，wire-shapes 门禁钉着。
/// 与 v0.2.4 的刻意差异：无 Alt+S 入批开关（native 的 stage 即写账本
/// +入批，没有单独的入批态）；进度显示 `{staged}/{total} 已判` 同理，
/// native 里「已判」与「待合并」恒等，不硬凑两个数。
pub fn reviewView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) {
        return ui.column(.{ .gap = 8, .padding = 12 }, .{
            ui.text(.{}, "待裁决的提案"),
            ui.text(.{}, "先打开一份稿子"),
        });
    }
    const listing = replies.borrow(.proposals);
    const total = project_view.proposalCount(listing);
    const window = @min(total, shell_view.max_visible_rows);
    var rows: [shell_view.max_visible_rows]Adapter.Ui.Node = undefined;
    var index: usize = 0;
    while (index < window) : (index += 1) {
        rows[index] = proposalRow(ui, model, listing, index);
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            // 裁决独占整屏（stage 例外），前往树不在——这枚按钮是鼠标的回路，
            // 与 Escape 同一个落点（v0.3.4：没有它，慢鼠标画像在裁决台上被困住）。
            ui.button(.{
                .on_press = .{ .workbench_go = .manuscript },
                .semantics = .{ .label = "回稿子" },
            }, "← 稿子 (Esc)"),
            ui.text(.{ .grow = 1 }, "待裁决的提案"),
            // 批次进度跟着台账走（stagedCount 由 core 从答复提取），
            // 界面不自己数「我判了几条」——那会与账本漂开。
            ui.text(.{}, ui.fmt("{d}/{d} 已判", .{ model.review.staged_count, total })),
            ui.button(.{
                .on_press = readProposalsMsg(model),
                .semantics = .{ .label = "重新读取待裁决的提案" },
            }, "读取"),
            ui.button(.{
                .variant = .primary,
                // 空批次不发提交：按钮先灰掉，作者按下去之前就知道，
                // 而不是收到一次拒绝。
                .disabled = model.review.staged_count == 0,
                .on_press = commitVerdictsMsg(model),
                .semantics = .{ .label = "把判过的这些落盘" },
            }, ui.fmt("{s} {d} 条 ({s})", .{
                commands.labelOf("verdict.settle"),
                model.review.staged_count,
                commands.hintOf("verdict.settle"),
            })),
        }),
        // 键位即提示：从命令表拼，与 core.ts 的 keyMsg 同名同键。
        ui.text(.{}, ui.fmt("{s}/{s} 移动 · {s} 接受 · {s} 退回 · {s} 改后接受 · {s} 理由 · {s} 竞争稿 · {s} 合并", .{
            commands.hintOf("roster.step.next"),
            commands.hintOf("roster.step.previous"),
            commands.hintOf("verdict.accept"),
            commands.hintOf("verdict.reject"),
            commands.hintOf("verdict.revise"),
            commands.hintOf("review.reason"),
            commands.hintOf("review.peer"),
            commands.hintOf("verdict.settle"),
        })),
        // 过期面板压在名录之上：它是上一次派发失败的说辞，先交代清楚再判。
        if (model.review.stale_recovery.slice().len > 0)
            stalePanel(ui, model)
        else
            ui.el(.stack, .{ .height = 0 }, .{}),
        if (total == 0)
            ui.text(.{}, "没有等待裁决的提案")
        else
            ui.list(
                .{ .gap = 6, .semantics = .{ .role = .list, .label = "待裁决的提案" } },
                @as([]const Adapter.Ui.Node, rows[0..window]),
            ),
        // 落盘的结局要说出来：三态各说各的，`decisionMessage` 判。
        ui.text(.{}, project_view.decisionMessage(replies.borrow(.project))),
        annotationsSection(ui, model),
    });
}

/// 过期面板：这一段在派发之后被改过了，提案没有套用（SPEC 7.4：不静默
/// 套用，也不静默丢弃）。
///
/// **接上哪个功能**：`staleFrozen`（Agent 当时读到的字）与 `staleRecovery`
/// （恢复步骤码，\n 连接）。两者由 core 在答复落空时写下，「知道了」派
/// `.stale_dismiss` 清掉。
///
/// **交互设计**：它出现在「提交批次被领域层拒绝（stale-proposal）」之后，
/// 压在名录之上——先交代清楚这次失败，作者才好继续判。面板只出示信息
/// 不替他选：冻结原文（作者自己改过那段，只有他能判断建议还成不成立）
/// 与两条具名恢复步骤（对照冻结原文 / 按现状重发），次序随领域层给的
/// 数组，界面不重排。出口有两个：「知道了」按钮与 Escape（panel_back
/// 分层里它在退栈之前）；任何一次项目用例成功也会把它清掉（core 在
/// ACTION_PROJECT 落地时清）——失败的说辞不赖着。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。步骤码的中文读法归
/// `project_view.staleStepLabel`（中文字面量纪律），不认识的码原样显示。
fn stalePanel(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    // 步骤码逐行画。码表是 core 写死的三条（留两条槽给将来的码），
    // 数组有界：标题 + 冻结段两行 + 步骤 + 按钮。
    var children: [12]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    children[count] = ui.text(.{}, "这一段在派发之后被改过了，提案没有套用。");
    count += 1;
    if (model.review.stale_frozen.slice().len > 0) {
        children[count] = ui.text(.{}, "Agent 当时读到的是：");
        count += 1;
        children[count] = ui.text(.{}, model.review.stale_frozen.slice());
        count += 1;
    }
    var rest = model.review.stale_recovery.slice();
    while (rest.len > 0 and count + 1 < children.len) {
        const at = std.mem.indexOfScalar(u8, rest, '\n') orelse rest.len;
        // 空段（连着的 \n 或收尾的 \n）不画——一行空步骤会被读成界面坏了。
        if (at > 0) {
            children[count] = ui.text(.{}, project_view.staleStepLabel(rest[0..at]));
            count += 1;
        }
        rest = if (at < rest.len) rest[at + 1 ..] else rest[0..0];
    }
    children[count] = ui.button(.{
        .on_press = @as(?Msg, .stale_dismiss),
        .semantics = .{ .label = "关掉过期提案的说明" },
    }, "知道了");
    count += 1;
    return ui.el(.card, .{ .padding = 8 }, .{
        ui.column(.{ .gap = 4 }, @as([]const Adapter.Ui.Node, children[0..count])),
    });
}

/// 批注与评论：这份稿子上标过的那些。
///
/// **接上哪个功能**：`ReadAnnotations` 读、`Annotate` 写。评论在这里写：
/// 作者先在正文框一段字，切到这一屏看见选区的预览，在输入框里写下要说
/// 的话，按「发评论」——高亮与评论是同一族，草稿为空发的就是高亮。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。草稿字节住在 Model
/// （`annotationDraft`），与派发框同一条路径；「这段字够不够清楚」不是
/// 这一屏能判的，范围对不上块由 Rust 在入口具名拒绝。
fn annotationsSection(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const listing = replies.borrow(.annotations);
    var rows: [shell_view.card_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const annotation = project_view.annotationAt(listing, count) orelse break;
        rows[count] = ui.listItem(.{
            .key = .{ .index = count },
            .semantics = .{ .role = .listitem },
        }, if (annotation.comment)
            ui.fmt("「{s}」 · {s}", .{ annotation.quote, annotation.body })
        else
            ui.fmt("「{s}」", .{annotation.quote}));
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "批注与评论"),
            ui.button(.{
                .on_press = readAnnotationsMsg(model),
                .semantics = .{ .label = "重新读这份稿子的批注" },
            }, "读取"),
        }),
        // 写评论：选区的预览是批注的对象。没有选区时灰掉——一条没有
        // 对象的评论会让 Rust 具名拒绝，而作者读成的是「按钮坏了」。
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{
                .grow = 1,
            }, if (document_view.selectedText(host_bridge.documentView()).len > 0)
                ui.fmt("「{s}」", .{document_view.selectedText(host_bridge.documentView())})
            else
                "先在正文框一段字"),
        }),
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.textField(.{
                .grow = 1,
                .text = model.annotation_draft.slice(),
                .placeholder = "写评论（留空就是高亮）",
                .on_input = Adapter.Ui.inputMsg(.annotation_draft_typed),
                .semantics = .{ .label = "评论草稿" },
            }),
            ui.button(.{
                .disabled = document_view.selectedText(host_bridge.documentView()).len == 0,
                .on_press = commentMsg(model),
                .semantics = .{ .label = "在选中的这一段上发这条评论" },
            }, "发评论"),
        }),
        if (count == 0)
            ui.text(.{}, "这份稿子上还没有批注")
        else
            ui.column(
                .{ .gap = 2, .semantics = .{ .role = .list, .label = "批注与评论" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// 把一段正文在全角与半角之间转换。
///
/// **接上哪个功能**：正文右键菜单——选区级（`whole_document = false`）
/// 与全文级（`whole_document = true`）两档。转换在 Rust（`text_width` 是
/// 唯一权威）：这里只送选区原文、作用域与方向，块身份由 Rust 按
/// `locate_scope` 查——送块 id 等于要求界面先知道块怎么切。
///
/// **在全局逻辑中负责什么**：只拼请求。全文级时 `selected` 留空（Rust
/// 侧不看它）；「没有可转的字符」由 Rust 具名拒绝（定义域外的文字转换
/// 不动一个字节），这里不猜。
pub fn convertWidthMsg(
    model: *const Model,
    selected: []const u8,
    whole_document: bool,
    direction: []const u8,
) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    if (!whole_document and selected.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.convertWidth(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        selected,
        whole_document,
        direction,
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 在选中的一段正文上发一条评论：正文是选区原文，评论是草稿字节。
/// 草稿为空就是高亮——与正文右键菜单同一族，只是这里能写字。
fn commentMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    const selected = document_view.selectedText(host_bridge.documentView());
    if (selected.len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.annotate(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        selected,
        model.annotation_draft.slice(),
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 读这份文档的批注。没打开稿子就没有可读的——按钮因此返回 null。
fn readAnnotationsMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readAnnotations(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 一条提案：范围、原文、改后，以及四个裁决动作与理由框。
///
/// 游标行（`rosterCursor` 指着的那条）多三样：选中底色、竞争稿徽标与
/// B 面、理由框。翻页与开框都跟着行走——换一行，它们跟着换，不赖在
/// 原来的行上。
/// 一条提案行：原文、改后、动作按钮，以及游标行的三件额外物（竞争稿、
/// 理由框、已记理由的提示）。
///
/// **交互设计**：行有两种状态——普通行与游标行（`rosterCursor` 指着，
/// 高亮复用 SDK card 的 selected 底色，不新写几何）。键盘动作（Alt+A/B/E）
/// 永远作用在游标行；按钮则每行都有（v0.2.4 纪律：快捷键不能是唯一
/// 入口），文案自带键位提示，让作者从按钮学会键位。理由框只开在游标
/// 行：理由随下一次裁决发出，与行绑定才不会让作者以为它是整批的。
/// 竞争稿（Alt+P 的 B 面）也只跟着游标行翻——一台只对照一处。
fn proposalRow(
    ui: *Adapter.Ui,
    model: *const Model,
    listing: wire.Reply,
    index: usize,
) Adapter.Ui.Node {
    const proposal = project_view.proposalAt(listing, index) orelse
        return ui.text(.{}, "这一条读不出来");
    // 正在改写的是不是这一条。只有这一条展开编辑区——同时展开多条会让
    // 作者以为可以一次改好几处，而每次提交只带一条的最终正文。
    const revising = model.revising.id.slice().len > 0 and
        std.mem.eql(u8, model.revising.id.slice(), proposal.id);
    // 游标是 `?u32`：null 就是没有行。旧形用 −1 占这个位，每个读取点都得记得。
    const on_cursor = if (model.roster_cursor) |row| index == @as(usize, row) else false;
    // 竞争稿只在游标行找：翻 B 面跟着行走，不跟着台子走。
    const competitor = if (on_cursor) project_view.competitorOf(listing, index) else null;
    return ui.el(.card, .{
        .key = .{ .index = index },
        .padding = 8,
        // 游标高亮复用 SDK card 面自带的 selected 底色（与命令面板的
        // listItem 同一条通道），不新写几何。
        .selected = on_cursor,
    }, .{
        ui.column(.{ .gap = 4 }, .{
            ui.row(.{ .gap = 8, .cross = .center }, .{
                ui.text(.{ .grow = 1 }, proposal.scope),
                // 游标行有竞争者时，翻到哪面就亮哪面的徽标。
                ui.text(.{}, if (competitor != null)
                    (if (model.review.peer) "竞争 B" else "竞争 A")
                else
                    ""),
                // 判过的行标出来，作者据此知道自己判到第几条。
                ui.text(.{}, if (proposal.staged) "已判" else ""),
            }),
            ui.text(.{}, proposal.before_text),
            // 只留评论的提案没有改后文本，那一行就不画——一个空的「改成」
            // 会被读成「改成空」。
            if (proposal.after_text.len > 0)
                ui.text(.{}, proposal.after_text)
            else
                ui.text(.{}, "（只留评论，不改正文）"),
            // B 面：竞争稿的正文画在原文与改后之下。找不到就说没有——
            // 画一段空气会被读成「竞争稿是空的」。
            if (on_cursor and model.review.peer)
                (if (competitor) |peer|
                    (if (peer.after_text.len > 0)
                        ui.text(.{}, ui.fmt("竞争稿：{s}", .{peer.after_text}))
                    else
                        ui.text(.{}, "（只留评论，不改正文）"))
                else
                    ui.text(.{}, "这一条没有竞争稿"))
            else
                ui.el(.stack, .{ .height = 0 }, .{}),
            ui.row(.{ .gap = 8 }, .{
                ui.button(.{
                    .disabled = proposal.staged,
                    .on_press = verdictMsg(model, proposal.id, "accept"),
                    .semantics = .{ .label = "接受这一条" },
                    // 键位从命令表拼（一处改键，处处跟着）。
                }, ui.fmt("{s} ({s})", .{ commands.labelOf("verdict.accept"), commands.hintOf("verdict.accept") })),
                ui.button(.{
                    .disabled = proposal.staged,
                    .on_press = verdictMsg(model, proposal.id, "reject"),
                    .semantics = .{ .label = "退回这一条" },
                }, ui.fmt("{s} ({s})", .{ commands.labelOf("verdict.reject"), commands.hintOf("verdict.reject") })),
                ui.button(.{
                    // 只留评论的提案没有可改的正文：改写它等于凭空写一段，
                    // 那是「退回后自己写」，不是改写。
                    .disabled = proposal.staged or proposal.after_text.len == 0,
                    .on_press = beginRevisionMsg(listing, index),
                    .semantics = .{ .label = "改写这一条再接受" },
                }, ui.fmt("{s} ({s})", .{ commands.labelOf("verdict.revise"), commands.hintOf("verdict.revise") })),
                ui.button(.{
                    .disabled = proposal.staged,
                    .on_press = verdictMsg(model, proposal.id, "comment-only"),
                    .semantics = .{ .label = "只留评论，不改正文" },
                }, "只评论"),
                ui.button(.{
                    .on_press = @as(?Msg, .review_reason_open),
                    .semantics = .{ .label = "给下一次裁决记下一条理由" },
                }, ui.fmt("{s} ({s})", .{ commands.labelOf("review.reason"), commands.hintOf("review.reason") })),
            }),
            // 理由框只开在游标行：理由随下一次裁决发出，与行绑定才不会
            // 让作者以为它是整批的。
            if (on_cursor and model.review.reason_open)
                ui.row(.{ .gap = 8, .cross = .center }, .{
                    ui.textField(.{
                        .grow = 1,
                        .text = model.review.reason_draft.slice(),
                        .placeholder = "理由（可留空）",
                        .on_input = Adapter.Ui.inputMsg(.review_reason_typed),
                        .on_submit = @as(?Msg, .review_reason_commit),
                        // 边沿触发：开框那一帧 false→true 拉一次焦点，
                        // 之后保持 true 也不会再抢作者的焦点。
                        .autofocus = true,
                        .semantics = .{ .label = "这一条裁决的理由" },
                    }),
                    ui.button(.{
                        .on_press = @as(?Msg, .review_reason_commit),
                        .semantics = .{ .label = "记下这条理由" },
                    }, "记下"),
                    // Escape 在框内被部件吃掉，取消按钮是兜底出口（SDK
                    // 键优先级：焦点在 text-entry 上时按键被静默消费，
                    // 到不了 core 的 panel_back）。
                    ui.button(.{
                        .on_press = @as(?Msg, .review_reason_cancel),
                        .semantics = .{ .label = "当作没问过" },
                    }, "取消"),
                })
            else
                ui.el(.stack, .{ .height = 0 }, .{}),
            // 已记下的理由亮出来：它随下一次裁决发出，作者要知道它还在。
            if (on_cursor and model.review.reason_recorded)
                ui.text(.{}, ui.fmt("理由：{s} · 随下一次裁决发出", .{
                    if (model.review.reason.slice().len > 0) model.review.reason.slice() else "（空）",
                }))
            else
                ui.el(.stack, .{ .height = 0 }, .{}),
            if (revising) revisionEditor(ui, model) else ui.el(.stack, .{ .height = 0 }, .{}),
        }),
    });
}

/// 改写区：作者把 Agent 的建议改成自己要的样子。
///
/// **接上哪个功能**：改写型裁决的编辑与提交。文字住在 Model
/// （`revisionText`），编辑规则在 `core.ts` 的 `revisionAfterEdit`——放在
/// 部件状态里，一次重绘就会把作者写的字冲掉。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。「改写型必须带最终正文」这条
/// 规则在 Rust 的入口（`stage_verdict`），这里不复制它；按钮在文字为空时
/// 灰掉，是为了让作者在按下之前就知道，而不是收到一次拒绝。
fn revisionEditor(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    return ui.column(.{ .gap = 6, .padding = 6 }, .{
        ui.text(.{}, "改成："),
        // 用 `ui.code(editable)` 而不是 `textField`：一段改写文字可以有多行，
        // 而 `textField` 是单行。SDK 的 code 部件在 editable 时正是引擎的
        // 多行编辑器（内部就是 textarea），顺带按稿子的语法上色——作者改的
        // 是这份稿子的一段，看到的颜色因此与正文一致。
        ui.code(.{
            .language = document_language.syntaxOf(host_bridge.documentView().format),
            .editable = true,
            .wrap = true,
            .on_input = Adapter.Ui.inputMsg(.revision_typed),
            .semantics = .{ .label = "改写后的正文" },
        }, model.revising.body.slice()),
        ui.row(.{ .gap = 8 }, .{
            ui.button(.{
                .variant = .primary,
                .disabled = model.revising.body.slice().len == 0,
                .on_press = commitRevisionMsg(model),
                .semantics = .{ .label = "按我改的这版接受" },
            }, "按我改的接受"),
            ui.button(.{
                .on_press = @as(?Msg, .revision_cancel),
                .semantics = .{ .label = "放弃这次改写" },
            }, "取消"),
        }),
    });
}

/// 对一条提案下裁决。
///
/// 改写型（`accept-modified`）走 `commitRevisionMsg`：它多带一段作者写的
/// 正文，而这三种不带。空切片编成 `null` 而不是空串——「不改」与「改成空」
/// 是两件事，后者会把那一段抹掉。
///
/// 已记下的理由随这一次裁决发出（没记下就是空切片，写器出 `null`，与
/// core 键盘路径逐字节同形）。返回 `desk_verdict` 而不是通用
/// `project_request`：core 发它时连带清掉理由、挂起判后前进的旗。
fn verdictMsg(model: *const Model, proposal_id: []const u8, kind: []const u8) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.stageVerdict(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        proposal_id,
        kind,
        "",
        if (model.review.reason_recorded) model.review.reason.slice() else "",
    ) orelse return null;
    return .{ .desk_verdict = request.keep() orelse return null };
}

/// 开始改写一条提案：以 Agent 建议的改后文字为起点。
///
/// **接上哪个功能**：改写型裁决。起点在这里读而不是在 core 读——core 子集
/// 答复是结构化的行（`generated/wire.zig`），种类对不上就交出 null。
///
/// 起点用建议而不是空白：作者多数时候只改一两个词。从空白开始等于让他
/// 重打一遍，那会把「改写」变成「拒绝后自己重写」。
fn beginRevisionMsg(listing: wire.Reply, index: usize) ?Msg {
    const proposal = project_view.proposalAt(listing, index) orelse return null;
    return .{ .revision_begin = .{
        .id = proposal.id,
        .seed = proposal.after_text,
    } };
}

/// 提交改写：作者写的那一段成为最终正文。
///
/// 与其余三种裁决共用 `stageVerdict`，只是多带 `final_text`。Rust 侧在入口
/// 就拒绝「改写型但没有最终正文」，所以这里不必自己判——但空文字仍然拦下，
/// 让作者在按钮上就知道还没写，而不是按下去收到一次拒绝。
///
/// 理由与返回通道同 `verdictMsg`：记下的理由随这次裁决发出，桌面裁决走
/// `desk_verdict`（core 连带清理由、挂判后前进）。
fn commitRevisionMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    if (model.revising.id.slice().len == 0 or model.revising.body.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.stageVerdict(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        model.revising.id.slice(),
        "accept-modified",
        model.revising.body.slice(),
        if (model.review.reason_recorded) model.review.reason.slice() else "",
    ) orelse return null;
    return .{ .desk_verdict = request.keep() orelse return null };
}

/// 提交暂存的裁决批次。裁决即落盘（D1／F-01）。
fn commitVerdictsMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.commitVerdicts(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 读这份文档上待裁决的提案。
fn readProposalsMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readProposals(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 读这份稿子的块清单（派发台的行）。`after` 是翻页游标：null 读第一页。
pub fn readBlocksMsg(model: *const Model, after: ?u64) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readBlocks(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        after,
        100,
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 读这个项目的资料名录（派发台的资料分区）。
pub fn readMaterialsMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readMaterials(&writer, model.root_id.slice()) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 收取选中那一条 Run 的结果。
pub fn collectRunMsg(model: *const Model, run_id: []const u8) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.collectRun(&writer, model.root_id.slice(), run_id) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 发射一条已授权的 Run（2.11）：工作区由 Rust 组成，界面只点名 run。
/// 手动往返的作者在按下它之后拿到一份可以亲手送给 Agent 的请求
/// （工作区里的 request），发令枪与下游自动发射同一条命令。
pub fn launchRunMsg(model: *const Model, run_id: []const u8) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.launchRun(&writer, model.root_id.slice(), run_id) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

test "裁决台没有提案时不绑任何裁决动作" {
    // 裁决是不可逆的写入（账本只追加），所以「没有可判的东西」必须表现为
    // 一个动作也绑不出来，而不是一颗按下去会被 Rust 拒绝的按钮。
    var surface = view_harness.Surface.init(std.testing.allocator);
    defer surface.deinit();
    var model: Model = .{};
    const built = surface.build(&model, reviewView);
    try std.testing.expect(!view_harness.anyRequestContains(built, "\"decide\""));
}
