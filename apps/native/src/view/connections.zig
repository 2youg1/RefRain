//! 连接：编排目录与装技能。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

const std = @import("std");
const core = @import("../core.zig");
const replies = @import("../core/replies.zig");
const wire = @import("../generated/wire.zig");
const project_request = @import("../project_request.zig");
const project_view = @import("../project_view.zig");
const Adapter = core.App;
const Msg = core.Msg;

/// 连接：这台机器上能派活给谁。
///
/// **接上哪个功能**：`refrain_app::harness::probe_harnesses`。名单固定
/// （认识几个适配器就是几行），所以一台什么都没装的机器上作者仍然看得见
/// 「可以连这两个」——只报装了的，那个界面是空的，而空界面读起来与
/// 「这个功能坏了」一样。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。「装了没有」「能做到哪一层」
/// 都由 Rust 探测，这里一条也不猜。中文标签住在 `project_view` 的翻译里。
pub fn connectionsView(ui: *Adapter.Ui) Adapter.Ui.Node {
    const listing = replies.borrow(.harnesses);
    var rows: [8]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const harness = project_view.harnessAt(listing, count) orelse break;
        // 一行装不下三件事（程序名、状况、能做什么），所以用卡片——
        // 与裁决台的提案行同族，不新起一套画法。
        const installed = std.mem.eql(u8, harness.skill, "current");
        rows[count] = ui.el(.card, .{ .key = .{ .index = count }, .padding = 8 }, .{
            ui.column(.{ .gap = 2 }, .{
                ui.row(.{ .gap = 8, .cross = .center }, .{
                    ui.text(.{ .grow = 1 }, harness.program),
                    ui.text(.{}, harness.state),
                }),
                // 探不到时不画等级：一个「只能写文件」会被读成它装好了
                // 而只是能力弱，而实际上它根本没装。空串也不占行：没装的
                // 卡片曾经留着两行空白，作者把大片留白读成「界面坏了」。
                if (harness.ready and harness.tier.len > 0)
                    ui.text(.{}, harness.tier)
                else
                    ui.spacer(0),
                if (harness.version.len > 0)
                    ui.text(.{}, harness.version)
                else
                    ui.spacer(0),
                // 协议徽章 + 安装/更新：只有装好了的 harness 才有协议可装；
                // 装协议是 Root 之外唯一的写路径，按钮是它的唯一入口。
                if (harness.ready)
                    ui.row(.{ .gap = 8, .cross = .center }, .{
                        ui.text(.{ .grow = 1 }, harness.skill),
                        ui.button(.{
                            .on_press = installSkillMsg(harness.id),
                            .semantics = .{ .label = "把当前协议装进这个 harness 的 skill 目录" },
                        }, if (installed) "更新协议" else "安装协议"),
                    })
                else
                    ui.spacer(0),
            }),
        });
    }
    return ui.column(.{ .gap = 8, .padding = 12 }, .{
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "本机 Harness"),
            ui.button(.{
                // 手动按钮走 force：探测要起 2 秒级子进程，自动读有 15 秒
                // 缓存，而「重新探测」的意思就是「别信缓存」。
                .on_press = readHarnessesMsg(true),
                .semantics = .{ .label = "重新探测本机装了什么" },
            }, "重新探测"),
        }),
        if (count == 0)
            ui.text(.{}, "按「重新探测」看这台机器上能连什么")
        else
            ui.column(
                .{ .gap = 4, .semantics = .{ .role = .list, .label = "本机 Harness" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// 把当前协议装进一个 harness 的 skill 目录。作者显式点击才到达——
/// 这是 Root 之外唯一的写路径。
fn installSkillMsg(harness_id: []const u8) ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.installSkill(&writer, harness_id) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 探测本机装了哪些 Harness。不带 Root——它问的是这台机器。
fn readHarnessesMsg(force: bool) ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.readHarnesses(&writer, force) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 三种排法：作者看见的名字，与跨界送的那个词。
///
/// 下标在 Model，名字在这里——与去处表、主题名同一条纪律（中文进不了
/// core 子集的 rodata）。跨界那个词是 kebab-case，实测自 `wire_shapes.rs`。
const orchestrations = [_]struct {
    label: []const u8,
    wire: []const u8,
    hint: []const u8,
}{
    .{ .label = "并列", .wire = "alternates", .hint = "各写各的，互相看不见" },
    .{ .label = "接力", .wire = "follows", .hint = "后一个读前一个的完整产出" },
    .{ .label = "验证", .wire = "verifies", .hint = "第一个写，其余只出批注" },
};

/// 这个下标的排法。越界回落并列——它是唯一不给 Run 之间强加顺序的那种。
pub fn orchestrationAt(index: i64) @TypeOf(orchestrations[0]) {
    if (index < 0 or index >= orchestrations.len) return orchestrations[0];
    return orchestrations[@intCast(index)];
}
