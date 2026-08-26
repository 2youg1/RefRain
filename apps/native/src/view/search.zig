//! 搜索：查询框、命中行、摘录。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

const std = @import("std");
const core = @import("../core.zig");
const replies = @import("../core/replies.zig");
const wire = @import("../generated/wire.zig");
const project_request = @import("../project_request.zig");
const project_view = @import("../project_view.zig");
const Adapter = core.App;
const Model = core.Model;
const Msg = core.Msg;
const shell_view = @import("shell.zig");
const files_view = @import("files.zig");

/// 搜索：文档名与块级两种，规则都在 Rust。
///
/// **接上哪个功能**：`DocumentSearch` 与 `BlockSearch`。中文用与查询同构的
/// 重叠 bigram，精确无果才回退宽松——这些都在 Rust，界面只送词和档位。
/// 即打即搜在 core（每次按键重挂 120ms 钟，停笔开火；空查询撤钟）。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。查询词住在 Model（`searchQuery`），
/// 不住在部件状态里：放在部件里一次重绘就会被冲掉，作者读成的是输入框自己
/// 清空了。空查询不画旧结果——答复还躺在槽里，但作者还没问。
///
/// **交互设计**：块命中画以命中为中心的 60 字摘录（`excerptAround`），不画
/// 全块——作者找的是「那段话」，不是整段的复读。命中行是 list_item：↑↓
/// 走焦点、Enter 跳过去（on_submit）、Space 选择激活，都是 SDK 的 list
/// 键图原生行为。
pub fn searchView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    // 命中住自己的槽：搜一次不再把文件树／提案名录冲成空白（v0.3.4 救援）。
    const results = replies.borrow(.search);
    const is_blocks = results.kind() == .blocks;
    const hits: []const wire.HitRow = if (results.head(.blocks)) |head|
        results.rows(wire.HitRow, head.hits)
    else
        &[_]wire.HitRow{};
    const paths: []const wire.DocumentRow = if (results.head(.documents)) |head|
        results.rows(wire.DocumentRow, head.documents)
    else
        &[_]wire.DocumentRow{};
    // 空查询不画旧结果：按 searchQuery 判空，不按答复判空。
    const searching = model.search.query.slice().len > 0;
    const found = if (is_blocks) hits.len else paths.len;
    const count = if (searching) @min(found, shell_view.max_visible_rows) else 0;
    var nodes: [shell_view.max_visible_rows]Adapter.Ui.Node = undefined;
    var index: usize = 0;
    while (index < count) : (index += 1) {
        // 块命中：路径 + 以命中为中心的摘录。高亮用「」标出命中段——
        // list_item 只渲染纯文本标签（children 不进它的绘制），而三截上色
        // 的 row 又丢掉 list_item 的键图（Enter 提交只认这个 kind）。SDK 的
        // per-text 颜色通道（style_tokens.foreground）与键盘导航不可兼得，
        // 取键图、「」标出（任务许的退路）。
        const label = if (is_blocks) blk: {
            const hit = hits[index];
            const path = results.text(hit.path);
            const text = results.text(hit.text);
            const excerpt_buf = ui.arena.alloc(u8, 4 * 60 + 12) catch break :blk path;
            break :blk ui.fmt("{s} · {s}", .{
                path,
                project_view.excerptAround(excerpt_buf, text, model.search.query.slice(), 60),
            });
        } else pathBlk: {
            const path = results.text(paths[index].path);
            break :pathBlk if (path.len > 0) path else "这一行读不出来";
        };
        const jump = if (is_blocks)
            searchHitMsg(model, results, hits[index])
        else
            files_view.openDocumentMsg(model, results.text(paths[index].path));
        nodes[index] = ui.listItem(.{
            .key = .{ .index = index },
            .on_press = jump,
            // Enter 是行主键（桌面名录惯例）：与点击同一条 searchHitMsg。
            .on_submit = jump,
            .semantics = .{ .role = .listitem },
        }, label);
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.text(.{}, "搜索"),
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.textField(.{
                .grow = 1,
                .text = model.search.query.slice(),
                .placeholder = "搜索文档或正文",
                .on_input = Adapter.Ui.inputMsg(.search_typed),
                .semantics = .{ .label = "搜索词" },
            }),
            ui.button(.{
                .on_press = .{ .search_precision = {} },
                .semantics = .{ .label = "切换精确与宽松" },
            }, if (model.search.exact) "精确" else "宽松"),
        }),
        ui.row(.{ .gap = 8 }, .{
            ui.button(.{
                .on_press = searchMsg(model, false),
                .semantics = .{ .label = "按文档名搜索" },
            }, "找文档"),
            ui.button(.{
                .on_press = searchMsg(model, true),
                .semantics = .{ .label = "在正文里搜索" },
            }, "找正文"),
        }),
        // 只印接好线的键位：list_item 的 ↑↓/Enter/Space 是 SDK 键图原生行为。
        ui.text(.{}, "↑↓ 移动 · Enter 跳过去"),
        ui.list(
            .{ .gap = 2, .semantics = .{ .role = .list, .label = "搜索结果" } },
            @as([]const Adapter.Ui.Node, nodes[0..count]),
        ),
    });
}

/// 一次搜索。空查询不发请求——空词在 Rust 那边是一次有名拒绝，
/// 而作者读成的是「搜索坏了」。
fn searchMsg(model: *const Model, comptime blocks: bool) ?Msg {
    if (model.root_id.slice().len == 0 or model.search.query.slice().len == 0) return null;
    var writer = project_request.Writer{};
    const request = if (blocks)
        project_request.blockSearch(&writer, model.root_id.slice(), model.search.query.slice(), model.search.exact)
    else
        project_request.documentSearch(&writer, model.root_id.slice(), model.search.query.slice(), model.search.exact);
    return .{ .project_request = (request orelse return null).bytes };
}

/// 点一条命中：同一份稿子的块命中直接跳过去，其余先打开那份文档。
///
/// 跨文档的跳块要等打开后的新一轮投影才点得名——那是另一段接线；先打开
/// 文档是今天就有用的那半步。块序号 clamp 归 Rust（越界钳到尾窗），这里
/// 原样送回。
fn searchHitMsg(model: *const Model, reply: wire.Reply, hit: wire.HitRow) ?Msg {
    const path = reply.text(hit.path);
    if (path.len > 0) {
        const ordinal = hit.ordinal;
        if (model.document.session != 0 and std.mem.eql(u8, path, model.document.path.slice())) {
            return .{ .document_jump = @intCast(ordinal) };
        }
        // 跨文档命中：开文档与跳块是两次请求——挂起的块序号随引用一起送，
        // 打开答复落地后 core 补发跳块（v0.2.4 的 selectDocument→revealBlock
        // 串联缝）。引用与文件树行同一块帧缓冲、同一条借用纪律；记账归
        // `files_view.borrowDocumentReference`，这里不再自己推游标。
        if (model.root_id.slice().len == 0) return null;
        const reference = files_view.borrowDocumentReference(model.root_id.slice(), path) orelse return null;
        return .{ .document_open_jump = .{
            .reference = reference,
            .block = @intCast(ordinal),
        } };
    }
    return files_view.openDocumentMsg(model, path);
}
