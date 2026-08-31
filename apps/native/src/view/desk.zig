// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 派发台：块清单、资料、预览、Run 名录、资料草稿。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

const std = @import("std");
const core = @import("../core.zig");
const replies = @import("../core/replies.zig");
const host_bridge = @import("../host_bridge.zig");
const wire = @import("../generated/wire.zig");
const project_request = @import("../project_request.zig");
const project_view = @import("../project_view.zig");
const Adapter = core.App;
const Model = core.Model;
const Msg = core.Msg;
const shell_view = @import("shell.zig");
const document_view = @import("document.zig");
const review_view = @import("review.zig");
const mailbox_view = @import("mailbox.zig");
const connections_view = @import("connections.zig");
const view_harness = @import("harness.zig");

/// 块清单一页的行数上限：Rust 把 count 夹在 100 以内，这里留一页的余量。
const desk_block_rows = 128;

/// 派发台：框出要改的段落，写下要求，委托给一个伙伴，送出去。
///
/// **接上哪个功能**：`refrain_app::dispatch`（2.2 派发深度回迁）。范围有
/// 三个来源：块清单的勾选（`ReadBlocks` 读来的块）、正文右键攒下的段
/// （`dispatchStash`）、正文当前的选区。三者同走 `dispatchDesk` 一个写器
/// （选区只在位图与攒段都空时作数），委托/带稿/资料三个闸同价（审计 #7）。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。勾选位图、攒段、带稿档位与
/// 委托对象都住在 Model（core.ts）；「这段原文还在不在稿子里」由 Rust 在
/// 派发入口判（对不回块就具名拒绝），这里不复制那条规则。
///
/// **交互设计**：这一台为「段落 → 要求 → 委托 → 范围 → 送出」的票据流
/// 设计。票头四格让作者一眼看到还缺什么（送出钮的灰态是第五格）；鼠标
/// 路径全是近距点击，键位印在按钮上。本轮只接了 Ctrl+Enter（焦点在要求
/// 框里时送出）；Space 勾选与台内移动键 2.8 才接，hint 行因此不印它们
/// ——印在界面上的键位必须是接好线的。
///
/// Run 名录是「送出去之后看它们跑到哪」的地方：收取只在在途时可点，
/// 轮询只在有 Run 在飞时自己走（2500ms 链式，core 管），接力/校验的
/// 下游在上游收取后自动发射（领域层管）——这一节只读快照，一条编排
/// 规则也不复制。材料草稿的「改」在行内完成：作者不离台。
pub fn dispatchView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const document = host_bridge.documentView();
    const selected = document_view.selectedText(document);
    const span = coverageSpan(model);
    // 就绪 = 有范围 ∧ 要求非空 ∧ 委托可送。委托恒可送（没有具名伙伴时
    // 「手动往返」兜底行总在），所以它不进这个式子。
    const ready = (span != null or model.dispatch.stash.slice().len > 0 or selected.len > 0) and
        model.dispatch.prompt.slice().len > 0;
    // 请求先编一次：攒段/选区太长装不下 12KB 槽时编不出——按钮灰掉并
    // 说原因。不灰不按、按了没反应，都是谎话（审计 #13）。
    const preview_msg = previewDispatchMsg(model, selected);
    const dispatch_msg = dispatchMsg(model, selected);
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        deskTicket(ui, model, selected, span),
        deskBlockList(ui, model),
        deskMaterials(ui, model),
        deskStash(ui, model),
        // 先让作者看见他要派发的是哪一段。派发出去之后请求就冻结了，
        // 而这一刻是他唯一能核对范围的地方。
        if (selected.len > 0)
            ui.text(.{}, selected)
        else
            ui.text(.{}, "先在正文里选一段要改的文字"),
        ui.text(.{}, "要求："),
        // 要求框直接画 textarea：editable 的 ui.code 内部就是这个部件，而
        // CodeOptions 收不了 on_submit。多行部件上 Ctrl+Enter 触发
        // on_submit（SDK 的 isSubmitKeyboard：Enter 留给换行），绑到送出。
        ui.el(.textarea, .{
            .wrap = true,
            .text = model.dispatch.prompt.slice(),
            .on_input = Adapter.Ui.inputMsg(.dispatch_typed),
            .on_submit = dispatchMsg(model, selected),
            .semantics = .{ .label = "写给 agent 的要求" },
        }, .{}),
        deskAgentRow(ui, model),
        deskCarryRow(ui, model),
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "agent"),
            ui.button(.{
                .on_press = .{ .dispatch_agents = -1 },
                .semantics = .{ .label = "少派一个" },
            }, "−"),
            ui.text(.{}, ui.fmt("{d}", .{model.dispatch.agents})),
            ui.button(.{
                .on_press = .{ .dispatch_agents = 1 },
                .semantics = .{ .label = "多派一个" },
            }, "+"),
        }),
        // 排法只在多于一个 agent 时有意义。一个 agent 时仍然画出来但灰掉，
        // 而不是整行消失——一行凭空出现的控件会让作者以为界面刚才坏了。
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, connections_view.orchestrationAt(model.dispatch.orchestration).hint),
            ui.button(.{
                .disabled = model.dispatch.agents < 2,
                .on_press = @as(?Msg, .dispatch_orchestration),
                .semantics = .{ .label = "换一种排法" },
            }, connections_view.orchestrationAt(model.dispatch.orchestration).label),
        }),
        ui.row(.{ .gap = 8 }, .{
            ui.button(.{
                .disabled = !ready or preview_msg == null,
                .on_press = preview_msg,
                .semantics = .{ .label = "先编译请求包给作者核对" },
            }, "预览"),
            ui.button(.{
                .variant = .primary,
                .disabled = !ready or dispatch_msg == null,
                .on_press = dispatch_msg,
                .semantics = .{ .label = "把这些段落和要求送出去" },
            }, "送出去"),
        }),
        if (ready and dispatch_msg == null)
            ui.text(.{}, "攒下的段落一次送不出去了——分两次送，或先丢掉几段")
        else
            ui.spacer(0),
        // 只印接好线的键位：Space 勾选与台内移动 2.8 才接。
        ui.text(.{}, "Ctrl+Enter 送出（在要求框里）"),
        dispatchPreviewSection(ui),
        deskRunRoster(ui, model),
        materialDraftsSection(ui, model),
    });
}

/// 勾选覆盖的连续块段：from 是起始 ordinal，count 是块数。
const DeskSpan = struct { from: u64, count: u64 };

/// 勾选位图的第 i 位。越界当 0。
///
/// 旧形是一个按需长长的字节数组，每个读取点自己做 `>>3` 与 `&7`；现在是
/// `StaticBitSet(1024)`，那两次移位连同「越界当 0」的约定一起归它。
fn deskBit(model: *const Model, ordinal: usize) bool {
    if (ordinal >= model.dispatch.checked.capacity()) return false;
    return model.dispatch.checked.isSet(ordinal);
}

/// 勾了几块。
fn deskCheckedCount(model: *const Model) usize {
    return model.dispatch.checked.count();
}

/// 勾选的最小覆盖：首末置位之间的连续块段。一块也没勾时是 null。
fn coverageSpan(model: *const Model) ?DeskSpan {
    var first: ?usize = null;
    var last: usize = 0;
    var ordinal: usize = 0;
    while (ordinal < model.dispatch.checked.capacity()) : (ordinal += 1) {
        if (deskBit(model, ordinal)) {
            if (first == null) first = ordinal;
            last = ordinal;
        }
    }
    const start = first orelse return null;
    return .{ .from = @intCast(start), .count = @intCast(last - start + 1) };
}

/// 攒了几段：NUL 数 + 1。空串是零段。
fn stashCount(model: *const Model) usize {
    if (model.dispatch.stash.slice().len == 0) return 0;
    var count: usize = 1;
    for (model.dispatch.stash.slice()) |ch| {
        if (ch == 0) count += 1;
    }
    return count;
}

/// 字符数（不是字节数）：按 UTF-8 序列长度走，坏字节当一个字符。
fn charCount(text: []const u8) usize {
    var count: usize = 0;
    var index: usize = 0;
    while (index < text.len) {
        index += std.unicode.utf8ByteSequenceLength(text[index]) catch 1;
        count += 1;
    }
    return count;
}

/// 前 n 个字符，char 边界安全——攒段预览不截半个字。
fn firstChars(text: []const u8, n: usize) []const u8 {
    var count: usize = 0;
    var index: usize = 0;
    while (index < text.len and count < n) {
        index += std.unicode.utf8ByteSequenceLength(text[index]) catch 1;
        count += 1;
    }
    return text[0..index];
}

/// config 答复里的 agents 数组原文。没有答复时是空数组。
fn configAgents() wire.Reply {
    return replies.borrow(.config);
}

/// 手动往返的哨兵词（agent id 是 uuid，这个词不会撞）：空 dispatchAgent
/// 是「还没选」（默认预选第一个具名伙伴），哨兵才是作者亲手选的手动往返——
/// 没有这个区分，配上伙伴的项目里手动往返永远选不中（审计 #6）。
const manual_agent_sentinel = "manual";

/// 当前生效的委托对象：哨兵是手动往返（空 id）；`dispatchAgent` 非空是它；
/// 空时视同第一个具名伙伴（显示上亮第一个）；一个伙伴也没有时是手动往返。
fn effectiveDispatchAgent(model: *const Model) []const u8 {
    if (std.mem.eql(u8, model.dispatch.agent.slice(), manual_agent_sentinel)) return "";
    if (model.dispatch.agent.slice().len > 0) return model.dispatch.agent.slice();
    const first = project_view.agentAt(configAgents(), 0) orelse return "";
    return first.id;
}

/// 票头「委托」格的名字：具名伙伴亮名字，手动往返照实说。
fn deskAgentLabel(model: *const Model) []const u8 {
    const effective = effectiveDispatchAgent(model);
    if (effective.len == 0) return "手动往返";
    var index: usize = 0;
    while (project_view.agentAt(configAgents(), index)) |agent| : (index += 1) {
        if (std.mem.eql(u8, agent.id, effective)) return agent.name;
    }
    return "—";
}

/// 票头四格：段落、要求、委托、范围——还缺什么一眼看见。
fn deskTicket(ui: *Adapter.Ui, model: *const Model, selected: []const u8, span: ?DeskSpan) Adapter.Ui.Node {
    // 段落数 = 勾选位数 + 攒段数 + 当前选区一段（若有）。注意它与送出的
    // scope 数不恒等：选区只在位图与攒段都空时才作为 scope 送出
    // （见 dispatchDeskMsg 的选区路径）。这一格数的是「手上有的段落」。
    const segments = deskCheckedCount(model) + stashCount(model) + @as(usize, @intFromBool(selected.len > 0));
    return ui.row(.{ .gap = 12 }, .{
        ui.text(.{}, ui.fmt("段落 {d} 块", .{segments})),
        ui.text(.{}, if (model.dispatch.prompt.slice().len > 0)
            ui.fmt("要求 {d} 字", .{charCount(model.dispatch.prompt.slice())})
        else
            "要求 —"),
        ui.text(.{}, ui.fmt("委托 {s}", .{deskAgentLabel(model)})),
        // b 的序号与块清单行的显示同一个口径（ordinal + 1）。
        ui.text(.{}, if (span) |s|
            ui.fmt("范围 覆盖 b{d}–b{d}", .{ s.from + 1, s.from + s.count })
        else
            "范围 —"),
    });
}

/// 块清单：`ReadBlocks` 读来的行，勾选合成范围。
///
/// core 的 `deskBlocks` 槽是替换语义（每页答复换掉整槽），位图跨页
/// 存活——翻页不丢勾选，显示的是当前这页。
fn deskBlockList(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const listing = replies.borrow(.blocks);
    var rows: [desk_block_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const block = project_view.deskBlockAt(listing, count) orelse break;
        const checked = deskBit(model, block.ordinal);
        rows[count] = ui.button(.{
            .key = .{ .index = count },
            // 勾选态用前缀字符而不是 SDK 的 checkbox 部件：它不画标签，
            // 用了行会变成「框一个命中、字一个命中」两个目标。
            // 字取 ■/□ 而不是 ☑/☐：后者不在界面字面里，画出来是方块，
            // 而方块恰好长得像个空框——`verify:font-coverage` 抓到的第二处。
            .on_press = .{ .dispatch_block_toggle = @intCast(block.ordinal) },
            .semantics = .{ .label = "勾选或取消这一块" },
        }, ui.fmt("{s}b{d} · {s} · {d} 字", .{
            if (checked) "■ " else "□ ",
            block.ordinal + 1,
            block.peek,
            block.chars,
        }));
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "段落"),
            // 已装 / 总数：槽里这页的行数 对 这份稿子的总块数。
            ui.text(.{}, ui.fmt("{d}/{d}", .{ count, model.document.blocks })),
            ui.button(.{
                .on_press = @as(?Msg, .dispatch_blocks_all),
                .semantics = .{ .label = "勾上整章" },
            }, "整章"),
            ui.button(.{
                .disabled = deskCheckedCount(model) == 0,
                .on_press = @as(?Msg, .dispatch_blocks_clear),
                .semantics = .{ .label = "清掉全部勾选" },
            }, "清空"),
        }),
        if (count == 0)
            ui.button(.{
                .on_press = review_view.readBlocksMsg(model, null),
                .semantics = .{ .label = "读入这份稿子的块清单" },
            }, "读入块清单")
        else
            ui.list(
                .{ .gap = 2, .semantics = .{ .role = .list, .label = "段落清单" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
        if (count > 0)
            ui.button(.{
                // null = 没有下页（旧形用 −1 当哨兵）。
                .disabled = model.dispatch.blocks_next == null,
                .on_press = review_view.readBlocksMsg(model, if (model.dispatch.blocks_next) |next| @as(u64, next) else null),
                .semantics = .{ .label = "读入下一页块" },
            }, "再读一页")
        else
            ui.el(.stack, .{ .height = 0 }, .{}),
    });
}

/// 资料分区：这轮给 agent 读什么的勾选。
///
/// **接上哪个功能**：`ReadMaterials`（deskMaterials 槽）与
/// `DispatchRequest.materials`——勾选的路径随送出/预览过河。
///
/// **交互设计**：资料是票据流里「读什么」的那一格。只有路径过河，档位的
/// 权威在名录（`SetDisclosure` 写它）——界面照名录画、只把勾选的路径送
/// 回去。勾选态住在 Model（`dispatchMaterials`，\n 分隔），这一节一条
/// 规则也不复制。
fn deskMaterials(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (replies.borrow(.materials).kind() != .materials) {
        return ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "资料"),
            ui.button(.{
                .on_press = review_view.readMaterialsMsg(model),
                .semantics = .{ .label = "读入这个项目的资料名录" },
            }, "读取资料"),
        });
    }
    const listing = replies.borrow(.materials);
    var rows: [shell_view.card_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const material = project_view.materialAt(listing, count) orelse break;
        const checked = materialChecked(model, material.path);
        rows[count] = ui.button(.{
            .key = .{ .index = count },
            // 与块清单同一款行：前缀字符而不是 SDK checkbox（它不画标签，
            // 会把行劈成两个命中目标）。
            .on_press = .{ .dispatch_material_toggle = material.path },
            .semantics = .{ .label = "勾选或取消这份资料" },
        }, ui.fmt("{s}{s} · {s}", .{
            if (checked) "■ " else "□ ",
            material.path,
            material.disclosure_label,
        }));
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "资料"),
            ui.button(.{
                .on_press = review_view.readMaterialsMsg(model),
                .semantics = .{ .label = "重新读资料名录" },
            }, "刷新"),
        }),
        ui.column(
            .{ .gap = 2, .semantics = .{ .role = .list, .label = "资料名录" } },
            @as([]const Adapter.Ui.Node, rows[0..count]),
        ),
    });
}

/// 这份资料勾了吗：`dispatchMaterials` 是 \n 分隔的路径表，逐段比对。
fn materialChecked(model: *const Model, path: []const u8) bool {
    var rest = model.dispatch.materials.slice();
    while (rest.len > 0) {
        const at = std.mem.indexOfScalar(u8, rest, '\n') orelse rest.len;
        if (std.mem.eql(u8, rest[0..at], path)) return true;
        rest = if (at < rest.len) rest[at + 1 ..] else rest[0..0];
    }
    return false;
}

/// 勾选的资料路径切进 `out`，返回条数。空段（连着的 \n）跳过。
fn checkedMaterials(model: *const Model, out: [][]const u8) usize {
    var count: usize = 0;
    var rest = model.dispatch.materials.slice();
    while (rest.len > 0 and count < out.len) {
        const at = std.mem.indexOfScalar(u8, rest, '\n') orelse rest.len;
        const segment = rest[0..at];
        rest = if (at < rest.len) rest[at + 1 ..] else rest[0..0];
        if (segment.len == 0) continue;
        out[count] = segment;
        count += 1;
    }
    return count;
}

/// 攒段区：正文右键「攒进发送」存下的段。每段在送出时成为一个文本
/// scope（顺在块段后面）。空时不画这一节。
fn deskStash(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (model.dispatch.stash.slice().len == 0) return ui.el(.stack, .{ .height = 0 }, .{});
    // 与信箱同一条窗口纪律：画前 shell_view.card_rows 段，更多的照送但不全画。
    var rows: [shell_view.card_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    var rest = model.dispatch.stash.slice();
    while (rest.len > 0 and count < rows.len) {
        const at = std.mem.indexOfScalar(u8, rest, 0) orelse rest.len;
        const segment = rest[0..at];
        rest = if (at < rest.len) rest[at + 1 ..] else rest[0..0];
        if (segment.len == 0) continue;
        rows[count] = ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, firstChars(segment, 40)),
            ui.button(.{
                .on_press = .{ .dispatch_stash_drop = @intCast(count) },
                .semantics = .{ .label = "把这一段从攒段里丢掉" },
            }, "丢"),
        });
        count += 1;
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, ui.fmt("已攒 {d} 段", .{stashCount(model)})),
            ui.button(.{
                .on_press = @as(?Msg, .dispatch_stash_clear),
                .semantics = .{ .label = "清空攒下的全部段" },
            }, "清空"),
        }),
        ui.column(.{ .gap = 2 }, @as([]const Adapter.Ui.Node, rows[0..count])),
    });
}

/// 委托行：config 名录里的具名伙伴各一个按钮（选中态高亮），末尾
/// 「手动往返」。一个伙伴也没有时只剩手动往返那行。
fn deskAgentRow(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const agents = configAgents();
    const effective = effectiveDispatchAgent(model);
    var rows: [shell_view.card_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const agent = project_view.agentAt(agents, count) orelse break;
        rows[count] = ui.button(.{
            .selected = std.mem.eql(u8, agent.id, effective),
            .on_press = .{ .dispatch_agent = agent.id },
            .semantics = .{ .label = ui.fmt("委托给 {s}", .{agent.name}) },
        }, agent.name);
        count += 1;
    }
    // 手动往返是兜底行：没有自动通道，身份随请求走（L0）。选中态读生效值：
    // 选了哨兵、或一个伙伴也没有时，生效的就是手动往返。
    const manual = ui.button(.{
        .selected = effective.len == 0,
        .on_press = .{ .dispatch_agent = manual_agent_sentinel },
        .semantics = .{ .label = "不具名，手动往返" },
    }, "手动往返");
    return ui.row(.{ .gap = 8, .cross = .center }, .{
        ui.text(.{}, "委托"),
        ui.row(.{ .gap = 4, .grow = 1 }, @as([]const Adapter.Ui.Node, rows[0..count])),
        manual,
    });
}

/// 带稿模式三档：增量／全文／不带。当前档高亮。默认增量是界面替作者
/// 选的——线协议的默认是不带（旧载荷旧行为），所以「不带」送出时不写
/// carry 这个词。
fn deskCarryRow(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const modes = [_][]const u8{ "增量", "全文", "不带" };
    var buttons: [3]Adapter.Ui.Node = undefined;
    for (modes, 0..) |label, index| {
        buttons[index] = ui.button(.{
            .selected = model.dispatch.carry == @as(i64, @intCast(index)),
            .on_press = .{ .dispatch_carry = @intCast(index) },
            .semantics = .{ .label = label },
        }, label);
    }
    return ui.row(.{ .gap = 8, .cross = .center }, .{
        ui.text(.{}, "带稿"),
        buttons[0],
        buttons[1],
        buttons[2],
    });
}

/// Run 名录节：这份稿子送出去的 Run 跑到哪了。
///
/// **接上哪个功能**：`ReadHost`（deskHost 槽）与 `CollectRun`／`cancelRun`／
/// `retryRun`。行只列当前文档的 Run——`project_view.runsForDocument` 按
/// tasks∩runs 的交集筛，别份稿子的 Run 不进这一节。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。允许什么动作归
/// `project_view.runActions`（收取仅在途、取消仅非终态、重试仅失败/取消）；
/// 轮询链与下游自动发射都不在这里——core 与领域层各管各的，这一节只读
/// 快照。
fn deskRunRoster(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    if (replies.borrow(.host).kind() != .host) {
        return ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "Run 名录"),
            ui.button(.{
                .on_press = mailbox_view.readHostMsg(model),
                .semantics = .{ .label = "读入派发的状况" },
            }, "读取 Run 名录"),
        });
    }
    const host = replies.borrow(.host);
    var rows: [shell_view.card_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const row = project_view.runsForDocument(host, model.document.path.slice(), count) orelse break;
        rows[count] = deskRunRow(ui, model, host, row, count);
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "Run 名录"),
            ui.button(.{
                .on_press = mailbox_view.readHostMsg(model),
                .semantics = .{ .label = "重新读派发的状况" },
            }, "刷新"),
        }),
        if (count == 0)
            ui.text(.{}, "这份稿子还没有送出去的 Run")
        else
            ui.column(
                .{ .gap = 4, .semantics = .{ .role = .list, .label = "Run 名录" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// Run 名录的一行：状态措辞 + workspace（有就画）+ 允许的动作。
fn deskRunRow(
    ui: *Adapter.Ui,
    model: *const Model,
    host: wire.Reply,
    row: wire.RunRow,
    index: usize,
) Adapter.Ui.Node {
    const run_id = host.text(row.id);
    if (run_id.len == 0) {
        return ui.listItem(.{ .key = .{ .index = index }, .disabled = true }, "这一行读不出来");
    }
    const actions = project_view.runActions(row);
    const workspace = host.text(row.workspace);
    return ui.el(.card, .{ .key = .{ .index = index }, .padding = 8 }, .{
        ui.column(.{ .gap = 2 }, .{
            // 状态措辞的唯一权威是 progressLabel（七态表），这里不另写。
            ui.text(.{}, project_view.progressLabel(host, row)),
            if (workspace.len > 0)
                ui.text(.{}, workspace)
            else
                ui.el(.stack, .{ .height = 0 }, .{}),
            ui.row(.{ .gap = 8 }, .{
                ui.button(.{
                    // 开始仅已授权可按：发令枪只在 Run 铸成之后、送出之前
                    // 有意义（2.11 的 LaunchRun 通路；手动往返的第一棒）。
                    .disabled = !actions.launchable,
                    .on_press = review_view.launchRunMsg(model, run_id),
                    .semantics = .{ .label = "发射这一次派发" },
                }, "开始"),
                ui.button(.{
                    // 收取仅在途可按：还没送出时按钮先灰掉，作者不必按一次
                    // 才知道结果是 waiting。
                    .disabled = !actions.collectable,
                    .on_press = review_view.collectRunMsg(model, run_id),
                    .semantics = .{ .label = "收取这一次派发的结果" },
                }, "收取"),
                ui.button(.{
                    .disabled = !actions.cancellable,
                    .on_press = mailbox_view.runCommandMsg("cancelRun", model, run_id),
                    .semantics = .{ .label = "取消这一次派发" },
                }, "取消"),
                ui.button(.{
                    .disabled = !actions.retryable,
                    .on_press = mailbox_view.runCommandMsg("retryRun", model, run_id),
                    .semantics = .{ .label = "重试这一次派发" },
                }, "重试"),
            }),
        }),
    });
}

/// 派发预览清单：各节名字/来源/字节/token 三态 + digest 前 12 位 +
/// 稳定前缀字节——「送前核对」的读法（SPEC 8.2 的授权落点）。预览住专槽
/// `deskPreview`（审计 #8）：刷新名录/读取资料不再把它冲掉，清单活到被
/// 消费（送出成功清槽）或被下一次预览替换。
fn dispatchPreviewSection(ui: *Adapter.Ui) Adapter.Ui.Node {
    if (replies.borrow(.preview).kind() != .dispatch_preview) {
        return ui.el(.stack, .{ .height = 0 }, .{});
    }
    const package = replies.borrow(.preview);
    const preview_head = package.head(.dispatch_preview);
    const digest = if (preview_head) |head| package.text(head.digest) else "";
    const prefix_bytes: u64 = if (preview_head) |head| head.prefix_bytes else 0;
    var rows: [shell_view.card_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const entry = project_view.manifestEntryAt(package, count) orelse break;
        rows[count] = ui.text(.{}, ui.fmt("{s} · {s} · {d} B · token {s}", .{
            entry.section,
            entry.source,
            entry.bytes,
            entry.tokens_label,
        }));
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.text(.{}, ui.fmt("核对 {s} · 稳定前缀 {d} B", .{
            digest[0..@min(12, digest.len)],
            prefix_bytes,
        })),
        ui.column(.{ .gap = 2 }, @as([]const Adapter.Ui.Node, rows[0..count])),
    });
}

/// 材料草稿行：Agent 交来的草稿在这里等成稿或退回。
///
/// **接上哪个功能**：`ReadMaterialDrafts`／`CommitMaterialDraft`——答复与
/// 回执共用同一份名录（动作之后界面不再发一次读），所以这一节只在名录
/// 是最新答复时画行，否则给一个「读草稿」入口。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。成稿的角色（资料区还是正文）
/// 由按钮说清，规则（草稿存没存在、落哪）归 Rust。
///
/// **交互设计**：「改」在行内完成——作者不离台。编辑态住在 Model
/// （`materialDraftId`／`materialDraftText`），与改写框同一条
/// `draftAfterEdit` 路径；编辑中的行把「收进资料区／收成正文」换成带
/// 编辑后正文的版本（`edited_body` 通道，M3 备好的那条）。
fn materialDraftsSection(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    // 草稿住自己的槽：旧形读 `.project` 而草稿答复按 kind 落 `.material_drafts`，
    // 这一段因此永远画不出行——两份权威对不上的又一处（v0.3.4 救援）。
    const is_drafts = replies.borrow(.material_drafts).kind() == .material_drafts;
    const listing = replies.borrow(.material_drafts);
    var rows: [shell_view.card_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    if (is_drafts) {
        while (count < rows.len) : (count += 1) {
            const draft = project_view.materialDraftAt(listing, count) orelse break;
            // 正在改的是不是这一条：同时只编辑一条（与裁决台的改写区同
            // 一条纪律——一次提交只带一条的正文）。
            const editing = model.material_draft.id.slice().len > 0 and
                std.mem.eql(u8, model.material_draft.id.slice(), draft.id);
            rows[count] = ui.el(.card, .{ .key = .{ .index = count }, .padding = 8 }, .{
                ui.column(.{ .gap = 4 }, .{
                    ui.text(.{}, ui.fmt("{s} · {s}", .{ draft.title, draft.kind })),
                    if (editing)
                        ui.column(.{ .gap = 4 }, .{
                            // 与裁决台改写区同款编辑器（ui.code editable 内部
                            // 是 textarea）。高度随内容撑开：SDK 没有「按行数」
                            // 的声明通道，硬编像素值违反几何纪律。
                            ui.code(.{
                                .language = .markdown,
                                .editable = true,
                                .wrap = true,
                                .on_input = Adapter.Ui.inputMsg(.material_draft_typed),
                                .semantics = .{ .label = "改这条草稿的正文" },
                            }, model.material_draft.body.slice()),
                            ui.row(.{ .gap = 8 }, .{
                                ui.button(.{
                                    .on_press = commitMaterialDraftMsg(model, draft.id, model.material_draft.body.slice(), false, false),
                                    .semantics = .{ .label = "按改后的正文收进资料区" },
                                }, "收进资料区"),
                                ui.button(.{
                                    .on_press = commitMaterialDraftMsg(model, draft.id, model.material_draft.body.slice(), false, true),
                                    .semantics = .{ .label = "按改后的正文提拔成正文" },
                                }, "收成正文"),
                                ui.button(.{
                                    .on_press = @as(?Msg, .material_draft_cancel),
                                    .semantics = .{ .label = "放弃这次修改" },
                                }, "取消"),
                            }),
                        })
                    else
                        ui.row(.{ .gap = 8 }, .{
                            ui.button(.{
                                .on_press = commitMaterialDraftMsg(model, draft.id, null, false, false),
                                .semantics = .{ .label = "收进资料区" },
                            }, "收进资料区"),
                            ui.button(.{
                                .on_press = commitMaterialDraftMsg(model, draft.id, null, false, true),
                                .semantics = .{ .label = "直接提拔成正文" },
                            }, "收成正文"),
                            ui.button(.{
                                .on_press = commitMaterialDraftMsg(model, draft.id, null, true, false),
                                .semantics = .{ .label = "退回这条草稿" },
                            }, "退回"),
                            ui.button(.{
                                // 起笔是草稿当前的正文（body 随名录行走）。
                                .on_press = @as(?Msg, .{ .material_draft_begin = .{
                                    .id = draft.id,
                                    .seed = draft.body,
                                } }),
                                .semantics = .{ .label = "在行内改这条草稿" },
                            }, "改"),
                        }),
                }),
            });
        }
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "材料草稿"),
            ui.button(.{
                .on_press = readMaterialDraftsMsg(model),
                .semantics = .{ .label = "读取材料草稿名录" },
            }, "刷新"),
        }),
        if (is_drafts and count == 0)
            ui.text(.{}, "没有等待成稿的草稿")
        else if (!is_drafts)
            ui.text(.{}, "草稿在这里等成稿——点刷新读取")
        else
            ui.column(.{ .gap = 4 }, @as([]const Adapter.Ui.Node, rows[0..count])),
    });
}

/// 读材料草稿名录。没有项目时不发——Rust 会具名拒绝，而按钮根本不该送到。
fn readMaterialDraftsMsg(model: *const Model) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.readMaterialDrafts(&writer, model.root_id.slice()) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 成稿或退回一条草稿。`edited_body` 是行内编辑后的正文（2.2 接上）；
/// 没编辑过就是 null——空切片与「没编辑」是两件事，serde 写 null。
fn commitMaterialDraftMsg(
    model: *const Model,
    draft_id: []const u8,
    edited_body: ?[]const u8,
    dismiss: bool,
    as_chapter: bool,
) ?Msg {
    if (model.root_id.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = project_request.commitMaterialDraft(
        &writer,
        model.root_id.slice(),
        draft_id,
        edited_body,
        dismiss,
        as_chapter,
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 最新预览答复里的 digest。预览住专槽 `deskPreview`（审计 #8）：无关答复
/// 不再把它冲掉；槽空（没预览过、或上次送出已消费）时交出空切片——
/// 「送出去」因此带不上核对，Rust 按无核对处理。
fn previewedDigest() []const u8 {
    const preview = replies.borrow(.preview);
    const head = preview.head(.dispatch_preview) orelse return "";
    return preview.text(head.digest);
}

/// 送出去。
///
/// 范围的三个来源按规则合成：位图覆盖的块段、攒段的文本段、选区的一段
/// （选区只在前两者都空时才作数）——同走 `dispatchDesk` 一个写器，三个闸
/// （委托/带稿/资料）对三种来源同价。三个都空交出 null——按钮因此灰掉，
/// 作者按下去之前就知道。
fn dispatchMsg(model: *const Model, selected: []const u8) ?Msg {
    return dispatchDeskMsg(model, selected, "dispatch");
}

/// 预览：与送出同一份合成规则，只是不铸 Run、不带送前核对的 digest。
fn previewDispatchMsg(model: *const Model, selected: []const u8) ?Msg {
    return dispatchDeskMsg(model, selected, "previewDispatch");
}

fn dispatchDeskMsg(model: *const Model, selected: []const u8, comptime kind: []const u8) ?Msg {
    if (model.root_id.slice().len == 0 or model.document.path.slice().len == 0) return null;
    if (model.dispatch.prompt.slice().len == 0) return null;
    const agents: u64 = @intCast(@max(1, model.dispatch.agents));
    // 一个 agent 时排法无意义，送并列：让 Rust 那边少一个「作者选了
    // 接力却只派了一个」的边角情况。
    const orchestration = if (model.dispatch.agents < 2) "alternates" else connections_view.orchestrationAt(model.dispatch.orchestration).wire;
    const span = coverageSpan(model);
    // 选区路径并入 desk 写器（审计 #7）：位图与攒段都空时，选区当成一段
    // 文本 scope 走 stash 槽位送出——委托/带稿/资料三个闸从此在选区派发
    // 也生效（旧路径把它们写死丢了：persona 恒 null、channel 恒 harness、
    // carry/materials/agent 全不送）。2.2 的纪律不变：选区只在位图与攒段
    // 都空时才作为 scope。
    const has_blocks = span != null or model.dispatch.stash.slice().len > 0;
    if (!has_blocks and selected.len == 0) return null;
    const agent = effectiveDispatchAgent(model);
    // 手动往返（空 id）走 L0：channel 是 manual，agent 字段不写。
    const channel: []const u8 = if (agent.len > 0) "harness" else "manual";
    // 带稿档位：0 增量 / 1 全文 / 2 不带。「不带」不写这个词——与 serde
    // 的 skip 同形，旧载荷旧行为。
    const carry: []const u8 = switch (model.dispatch.carry) {
        1 => "full",
        2 => "",
        else => "diff",
    };
    // 送前核对只在送出时带；预览不带（与旧的一对同一条分工）。
    const digest = previewedDigest();
    const expected: ?[]const u8 = if (comptime std.mem.eql(u8, kind, "dispatch"))
        (if (digest.len > 0) digest else null)
    else
        null;
    // 勾选的资料随块段/攒段路径走：只有路径过河，档位权威在名录。
    // 定长数组而不是分配：Msg 在帧内消费，路径切片借的是 Model 的字节。
    var material_paths: [200][]const u8 = undefined;
    const material_count = checkedMaterials(model, &material_paths);
    var writer = project_request.Writer{};
    const request = project_request.dispatchDesk(
        &writer,
        model.root_id.slice(),
        model.document.path.slice(),
        model.dispatch.prompt.slice(),
        if (span) |s| .{ .from = s.from, .count = s.count } else null,
        if (has_blocks) model.dispatch.stash.slice() else selected,
        agents,
        orchestration,
        carry,
        material_paths[0..material_count],
        agent,
        channel,
        expected,
        kind,
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

test "F-02：Run 名录满屏时，每一行说的是它自己那一条 Run 的失败原因" {
    // 「行绑定到正确的行」的第三条，也是 F-02 在**视图层**的断言。进度标签曾
    // 出自四个轮换的槽，而派遣台一屏 `shell_view.card_rows` = 24 行、每行一个
    // 标签：第五行起写回第一个槽，而第一行那个 `ui.text` 还指着它——失败的 Run
    // 于是显示另一条 Run 的原因。这一条在屏幕上直接可见，而无障碍指纹比对的是
    // 画出来的文字，所以只有把这一屏真的建出来、逐行读回文字，才问得出它。
    var reply_bytes: [16384]u8 = undefined;
    var reasons: [shell_view.card_rows][40]u8 = undefined;
    var written: [shell_view.card_rows][]const u8 = undefined;
    for (0..shell_view.card_rows) |index| {
        written[index] = std.fmt.bufPrint(&reasons[index], "harness-{d:0>2} 退出", .{index}) catch unreachable;
    }
    view_harness.storeFailedRuns(&reply_bytes, "章.md", &written);
    defer replies.clearAll();

    var surface = view_harness.Surface.init(std.testing.allocator);
    defer surface.deinit();
    var model: Model = .{};
    try model.document.path.set("章.md");
    const screen = surface.build(&model, dispatchView);

    var label: [64]u8 = undefined;
    for (0..shell_view.card_rows) |index| {
        const wanted = std.fmt.bufPrint(&label, "失败：{s}", .{written[index]}) catch unreachable;
        try std.testing.expect(view_harness.findText(screen, wanted));
    }
}
