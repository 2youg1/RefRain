// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 设置去处：主题、材质、排版三滑杆、字体、Agent、连接配置。
//!
//! 单元 34 从 `app_main.zig` 搬来，逐字未改；路由仍在那一侧。

const std = @import("std");
const material_paint = @import("../material_paint.zig");
const material_recipe = @import("../material.zig");
const themes = @import("../generated/themes.zig");
const core = @import("../core.zig");
const replies = @import("../core/replies.zig");
const commands = @import("../commands.zig");
const wire = @import("../generated/wire.zig");
const project_request = @import("../project_request.zig");
const project_view = @import("../project_view.zig");
const Adapter = core.App;
const Model = core.Model;
const Msg = core.Msg;
const shell_view = @import("shell.zig");
const view_harness = @import("harness.zig");

/// 设置：读当前值，改一项，立刻落盘。
///
/// **接上哪个功能**：`ReadConfig` 与 `ChangeConfig`。旧栈的设置只住在 Tauri 的
/// `lib.rs` 里，原生表面够不着同一份；现在两边读的是 `ConfigStore` 那一份。
///
/// **在全局逻辑中负责什么**：只画与只派 Msg。值的合法性归 `ConfigChange`
/// 的变体集合，落盘归 `ConfigStore`——界面不校验，也不缓存第二份。
pub fn settingsView(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    // 设置读 configReply 槽而不是 projectResult：后者是「最后一次答复」的
    // 公共槽，一次搜索就把它换成搜索结果——设置页随作者上一把操作漂移，
    // 「还没读到」其实是读错了槽。configReply 只收 config 答复（core 按
    // kind 落槽），换主题、改排版、切身份的答复都会刷新它。
    const config = replies.borrow(.config);
    const theme = if (config.head(.config)) |shown| config.text(shown.theme) else "";
    const theme_grid = themeButtons(ui, model);
    return ui.column(.{ .gap = 12, .padding = 16 }, .{
        ui.text(.{}, "设置"),
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "主题"),
            // 落盘那一份才是真的：显示读回来的值，而不是 Model 里的下标。
            // 两者漂开的表现是「界面看着换了、重开又变回去」。
            ui.text(.{}, if (theme.len > 0) theme else "还没读到"),
            ui.button(.{
                .on_press = .{ .theme_next = {} },
                .semantics = .{ .label = "换下一套主题" },
                // 键位印在按钮上：标签与键位都读命令表（唯一权威），
                // 与右键菜单同款，作者按几次就记住了 Ctrl+Shift+T。
            }, ui.fmt("{s} ({s})", .{ commands.labelOf("theme.next"), commands.hintOf("theme.next") })),
        }),
        // 直选网格：七套各一颗按钮。直选是鼠标的路，「换主题」轮换是键盘
        // 的路——两个入口同一条落盘链，不会出现「点了但快捷键以为没换」。
        ui.row(.{ .gap = 4, .cross = .center }, @as([]const Adapter.Ui.Node, theme_grid[0..])),
        // 材质三选：实心 / 亚克力 / 液态玻璃是三种「密度」（透光度递增），
        // 不是一种皮肤的三个颜色——透光多少是材质自己的事，七套主题都成立
        // （material.zig 配方表的唯一权威）。按下即换肤，落盘随答复。
        ui.row(.{ .gap = 4, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "面板材质"),
            materialButton(ui, model, .solid, "实心"),
            materialButton(ui, model, .acrylic, "亚克力"),
            materialButton(ui, model, .liquid, "液态玻璃"),
            materialSwatch(ui, model),
        }),
        // KARA：写作状态机的手动开关。Ctrl+Enter（app.zon 的 kara.toggle）
        // 也走同一条消息——两个入口一条路径，不会出现「按钮开了但快捷键
        // 以为还关着」。
        ui.row(.{ .gap = 8, .cross = .center }, .{
            ui.text(.{ .grow = 1 }, "专注写作（KARA）"),
            ui.button(.{
                .on_press = karaToggleMsg(),
                .semantics = .{ .label = "进入或退出专注写作" },
            }, ui.fmt("切换 ({s})", .{commands.hintOf("kara.toggle")})),
        }),
        // 排版三项：字号、行高、行长。只列这三项是因为它们决定一行有
        // 多少字、字有多大、行与行隔多远——作者真正会反复调的就是这些。
        // 其余（首行缩进、基线网格、页边距）定下来就不动。
        typographyRow(ui, model, "字号", "textSize"),
        typographyRow(ui, model, "行高", "lineHeight"),
        typographyRow(ui, model, "行长", "measure"),
        fontsSection(ui, config),
        connectionsConfigSection(ui, config),
        agentsSection(ui, model, config),
        ui.button(.{
            .on_press = readConfigMsg(),
            .semantics = .{ .label = "重新读取设置" },
        }, "读取设置"),
    });
}

/// 主题直选网格：七套各一颗按钮，当前套高亮。
///
/// **接上哪个功能**：`theme_select` 臂（core 记下标 + 落盘 SetTheme）。
/// 高亮读 Model 的下标而不是设置答复的名字——下标是按下那一刻就生效的
/// （颜色立刻换），答复晚一拍到；跟着答复走高亮会慢半拍，作者以为没点上。
///
/// **交互设计**：高亮复用 SDK 的 `.selected` 底色（与名录游标同一画法，
/// 零新几何）；按钮文字就是主题名，鼠标停在文本区附近就能点到。
fn themeButtons(ui: *Adapter.Ui, model: *const Model) [themes.themes.len]Adapter.Ui.Node {
    var buttons: [themes.themes.len]Adapter.Ui.Node = undefined;
    const current = shell_view.currentThemeIndex(model);
    inline for (themes.themes, 0..) |theme, index| {
        buttons[index] = ui.button(.{
            .on_press = .{ .theme_select = @intCast(index) },
            .selected = index == current,
            .semantics = .{ .label = "选用主题 " ++ theme.name },
        }, theme.name);
    }
    return buttons;
}

/// 当前材质的小样：把配方算出的表面／描边两色画成一块 64×28 的面。
///
/// **为什么需要它**：栏地按红线永远实心（rail.zig 模块头），材质的真实
/// 舞台是浮面（菜单、饭盒、回来卡）——于是在设置页上点三颗按钮只能看出
/// 亮度微差（v0.3.4 作者实测原话）。小样让选择当场可见，不必先去开
/// 一个右键菜单。
fn materialSwatch(ui: *Adapter.Ui, model: *const Model) Adapter.Ui.Node {
    const theme = &themes.themes[shell_view.currentThemeIndex(model)];
    const kind = model.panel_material;
    var swatch = ui.el(.stack, .{
        .width = 64,
        .height = 28,
        .semantics = .{ .label = "材质小样" },
    }, .{});
    swatch.widget.style.background = material_paint.surfacePaint(kind, theme);
    swatch.widget.style.border = material_paint.borderPaint(kind, theme);
    return swatch;
}

/// 材质三选的一颗按钮：按下记下那一种材质，当前材质高亮
/// （复用 `.selected` 底色，与主题网格同一画法，零新几何）。
fn materialButton(
    ui: *Adapter.Ui,
    model: *const Model,
    comptime kind: material_recipe.Kind,
    comptime label: []const u8,
) Adapter.Ui.Node {
    return ui.button(.{
        .on_press = .{ .material_select = kind },
        .selected = model.panel_material == kind,
        .semantics = .{ .label = "把面板换成" ++ label },
    }, label);
}

/// Agent 名录：名字、身份模式，和二态开关。
///
/// **接上哪个功能**：`ConfigChange::ToggleAgentPersona`——干活 ↔ 扮演，
/// 身份原文由 Rust 带过去，界面只按 id 点名。答复是刷新后的整份 Config，
/// 所以切换之后不必再发一条读。
fn agentsSection(ui: *Adapter.Ui, model: *const Model, config: wire.Reply) Adapter.Ui.Node {
    const agents = config;
    var rows: [shell_view.card_rows]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const agent = project_view.agentAt(agents, count) orelse break;
        const editing = model.editing_agent.id.slice().len > 0 and
            std.mem.eql(u8, model.editing_agent.id.slice(), agent.id);
        rows[count] = ui.el(.card, .{ .key = .{ .index = count }, .padding = 8 }, .{
            ui.column(.{ .gap = 4 }, .{
                ui.row(.{ .gap = 8, .cross = .center }, .{
                    ui.text(.{ .grow = 1 }, ui.fmt("{s} · {s}", .{ agent.name, agent.mode_label })),
                    ui.button(.{
                        .disabled = !agent.has_persona,
                        .on_press = toggleAgentPersonaMsg(agent),
                        .semantics = .{ .label = "切换这个 Agent 的身份模式" },
                    }, "切换"),
                    if (editing)
                        ui.button(.{
                            .on_press = @as(?Msg, .agent_edit_cancel),
                            .semantics = .{ .label = "放弃这次参数编辑" },
                        }, "取消")
                    else
                        ui.button(.{
                            .on_press = beginAgentEditMsg(agent.id),
                            .semantics = .{ .label = "编辑这个 Agent 的专属参数" },
                        }, "编辑参数"),
                }),
                // 身份说明回显：作者写给这个 Agent 的那段字。没有身份的
                // 不画一行空——「空说明」与「没有说明」是同一件事。
                if (agent.persona_body.len > 0)
                    ui.text(.{}, agent.persona_body)
                else
                    ui.spacer(0),
                ui.text(.{}, ui.fmt("专属参数 {d} 项", .{agent.argv_count})),
                if (editing) agentArgvEditor(ui, model, agent) else ui.spacer(0),
            }),
        });
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.text(.{}, "Agent 名录"),
        if (count == 0)
            ui.text(.{}, "还没有读到 Agent——按「读取设置」取一份")
        else
            ui.column(
                .{ .gap = 2, .semantics = .{ .role = .list, .label = "Agent 名录" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// 当前字体：西文、中文、日文三个槽各装哪张脸。
///
/// **接上哪个功能**：`Config.appearance.fonts`（设置面板读的同一份 Config）。
/// 只读——「改字体」需要枚举机器字库的选择器（`list_fonts` 通道尚未接），
/// 这里先让作者看见现在用的是什么；字号行高在排版三行那里调。
fn fontsSection(ui: *Adapter.Ui, config: wire.Reply) Adapter.Ui.Node {
    // 三面字体在答复的头上各占一格：以前要走 appearance.typography.fonts
    // 三层，而读错一层会把「有字体」读成「还没读到」。
    const head = config.head(.config);
    const latin = if (head) |shown| config.text(shown.font_latin) else "";
    const chinese = if (head) |shown| config.text(shown.font_chinese) else "";
    const japanese = if (head) |shown| config.text(shown.font_japanese) else "";
    return ui.column(.{ .gap = 4 }, .{
        ui.text(.{}, "字体"),
        if (latin.len + chinese.len + japanese.len == 0)
            ui.text(.{}, "还没读到字体——按「读取设置」取一份")
        else
            ui.column(.{ .gap = 2 }, .{
                ui.text(.{}, ui.fmt("西文 {s}", .{latin})),
                ui.text(.{}, ui.fmt("中文 {s}", .{chinese})),
                ui.text(.{}, ui.fmt("日文 {s}", .{japanese})),
            }),
    });
}

/// 已存连接参数：每个适配器一行，显示程序与参数项数。
///
/// **接上哪个功能**：`Config.harness_connections`（设置面板读的同一份
/// Config）。只读——编辑走伙伴编辑（agent 级 argv）或直接改 `config.toml`；
/// 连接级 argv 的图形编辑入口尚未接，这里先让作者看见「有没有参数」。
fn connectionsConfigSection(ui: *Adapter.Ui, config: wire.Reply) Adapter.Ui.Node {
    const connections = config;
    var rows: [8]Adapter.Ui.Node = undefined;
    var count: usize = 0;
    while (count < rows.len) : (count += 1) {
        const connection = project_view.connectionAt(connections, count) orelse break;
        rows[count] = ui.listItem(.{
            .key = .{ .index = count },
            .semantics = .{ .role = .listitem },
        }, ui.fmt("{s} · {s} · 参数 {d} 项", .{
            connection.adapter,
            connection.executable,
            connection.argv_count,
        }));
    }
    return ui.column(.{ .gap = 4 }, .{
        ui.text(.{}, "连接参数"),
        if (count == 0)
            ui.text(.{}, "还没有存过连接——派发时选「文件通道」之外的方式会存")
        else
            ui.column(
                .{ .gap = 2, .semantics = .{ .role = .list, .label = "连接参数" } },
                @as([]const Adapter.Ui.Node, rows[0..count]),
            ),
    });
}

/// 编辑这个 Agent 的参数： 是 ，带字段的变体先构造
/// 再赋值——直接在  里写匿名结构会在 ReleaseFast 下类型推断失败。
fn beginAgentEditMsg(agent_id: []const u8) Msg {
    // core 子集把单字段变体压平为裸值（`agent_edit_begin: []const u8`），
    // 所以这里直接传 id，不套结构。
    return @unionInit(Msg, "agent_edit_begin", agent_id);
}

/// 一个 Agent 的专属参数编辑区：一段以空格分隔的文本 + 保存。
///
/// **接上哪个功能**：伙伴编辑（`UpsertAgent`）。保存按空格分词后整份
/// upsert——名字与身份从 Rust 快照回填，只改参数。编辑态与草稿住在
/// Model（`editingAgent`／`agentArgvDraft`），与改写区同一条纪律。
fn agentArgvEditor(ui: *Adapter.Ui, model: *const Model, agent: project_view.Agent) Adapter.Ui.Node {
    return ui.column(.{ .gap = 4 }, .{
        ui.textField(.{
            .text = model.editing_agent.body.slice(),
            .placeholder = "--model max --temperature 0.2",
            .on_input = Adapter.Ui.inputMsg(.agent_argv_typed),
            .semantics = .{ .label = "这个 Agent 的专属参数" },
        }),
        ui.button(.{
            .variant = .primary,
            .on_press = upsertAgentMsg(model, agent),
            .semantics = .{ .label = "按这份参数保存这个 Agent" },
        }, "保存参数"),
    });
}

/// 整份保存一个 Agent：名字与身份从快照回填，参数用编辑草稿；连接 id
/// 原样回填（快照读到的）——不编辑它不等于可以抹掉它（审计项）。
fn upsertAgentMsg(model: *const Model, agent: project_view.Agent) ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.upsertAgent(
        &writer,
        agent.id,
        agent.name,
        agent.connection_id,
        agentPersonaMode(agent),
        agent.persona_body,
        model.editing_agent.body.slice(),
    ) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 这个 Agent 的身份模式：work／cosplay／空（无身份）。从快照的变体键
/// 读来——「干活」的标签在 Zig，跨界那个词是 Rust 的枚举名。
fn agentPersonaMode(agent: project_view.Agent) []const u8 {
    if (!agent.has_persona) return "";
    return if (std.mem.eql(u8, agent.mode_label, "干活")) "work" else "cosplay";
}

/// 切换一个 Agent 的二态。无身份的切无可切，按钮因此返回 null。
fn toggleAgentPersonaMsg(agent: project_view.Agent) ?Msg {
    if (!agent.has_persona) return null;
    var writer = project_request.Writer{};
    const request = project_request.toggleAgentPersona(&writer, agent.id) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 排版里一项的加减。
///
/// **接上哪个功能**：`ConfigChange::AdjustTypography`。送增量而不是绝对值——
/// 按钮做的就是「大一点」，而送绝对值要界面先持有当前值，那份值在并发下
/// 可能已经旧了。
///
/// **在全局逻辑中负责什么**：只派 Msg。范围钳在 Rust（上下界是那些字段
/// 自己的性质），所以这里不判「还能不能再大」——判了就会与 Rust 各说
/// 各话，而作者看到的是按钮灰着但值其实还能动。
///
/// 步长与量程归 `project_view.typographySliderSpec`（与 Rust `TypographyField::bounds`
/// 同一张表）：行长的单位是十分之一 em，与字号的十分之一像素不同量纲，
/// 共用一个步长会让其中一项每次只动一丝。
///
/// **交互设计**：滑杆与 ± 按钮共存——滑杆走大范围，按钮走两端微调。拇指
/// 位置与数值实时读 Model（答复落回来即刷新）；滑杆贴步距，没跨步不发
/// 请求（`noop`）：SDK 的 slider 按帧合并报值、没有「落定」事件，一次
/// 拖动的落盘次数因此被步数限住而不是被帧率限住。这是与 v0.2.4「一次
/// 拖动=一次修改」的刻意差异——等价的限流靠步距量化达成，且拖动中
/// 实时预览。玻璃垫 + 慢鼠标的画像：滑轨 `grow = 1` 尽量拉宽，一步的
/// 鼠标行程就越大，微调越不需要精准。
fn typographyRow(
    ui: *Adapter.Ui,
    model: *const Model,
    comptime label: []const u8,
    comptime field: []const u8,
) Adapter.Ui.Node {
    const spec = comptime project_view.typographySliderSpec(field);
    const slider = TypographySliderMsg(field);
    // 当前值既是拇指位置的来源，也是闭包基准的真值来源（渲染时重写基准，
    // 答复落回来的值因此自愈拖动中的任何漂移）。
    const current = currentTypographyUnits(model, field);
    slider.setBase(current);
    // 数值跟着标签走：作者拖动时看到的是「字号 17.5 px」在动，不是一根
    // 没有刻度的轨——滑杆没有刻度是 SDK 部件的形状，数值由我们补上。
    const value_text = if (comptime std.mem.eql(u8, field, "textSize"))
        ui.fmt("{d:.1} px", .{model.typography.text_size})
    else if (comptime std.mem.eql(u8, field, "lineHeight"))
        ui.fmt("{d}%", .{model.typography.line_height_percent})
    else
        ui.fmt("{d:.1} em", .{model.typography.measure_em});
    return ui.row(.{ .gap = 8, .cross = .center }, .{
        ui.text(.{}, ui.fmt("{s} {s}", .{ label, value_text })),
        ui.button(.{
            .on_press = adjustTypographyMsg(field, -spec.step_units),
            .semantics = .{ .label = label ++ "小一点" },
        }, "−"),
        ui.el(.slider, .{
            .grow = 1,
            .value = project_view.sliderFraction(spec, current),
            .on_value = slider.msg,
            .semantics = .{ .label = label },
        }, .{}),
        ui.button(.{
            .on_press = adjustTypographyMsg(field, spec.step_units),
            .semantics = .{ .label = label ++ "大一点" },
        }, "+"),
    });
}

/// Model 里的排版值换算成 `adjustTypography` 的 delta 单位。
/// 三字段量纲不同（十分之一像素 / 百分点 / 十分之一 em），按字段词汇分派；
/// 词汇表以 Rust 为准，这里多一个词就是第二份权威。
fn currentTypographyUnits(model: *const Model, comptime field: []const u8) i32 {
    if (comptime std.mem.eql(u8, field, "textSize")) {
        return @intFromFloat(model.typography.text_size * 10);
    }
    if (comptime std.mem.eql(u8, field, "lineHeight")) {
        return @intCast(model.typography.line_height_percent);
    }
    return @intFromFloat(model.typography.measure_em * 10);
}

/// 排版滑杆的消息闭包：一个字段一个实例，实例里装着上一次落定的值。
///
/// **为什么要有 base**：SDK 的 `ValueMsgFn` 是裸函数指针（`*const fn (f32) Msg`），
/// 带不了上下文；而 `adjustTypography` 要增量，增量 = 新值 − 基准。渲染时
/// 基准从 Model 写入（答复落回来的真值）；事件时基准立刻更新成新值——
/// 拖动中答复还在路上、Model 是旧值，基准必须跟着事件走，增量链才不多算
/// （17→18→19 拖两步，基准不动会送出 +10 +20 而不是 +5 +5）。
/// comptime 实例各自持有自己的 base：三个滑杆互不串台。
fn TypographySliderMsg(comptime field: []const u8) type {
    const spec = comptime project_view.typographySliderSpec(field);
    return struct {
        var base_units: i32 = 0;

        fn setBase(units: i32) void {
            base_units = units;
        }

        fn msg(fraction: f32) Msg {
            const next = project_view.sliderSnap(spec, fraction);
            const delta = next - base_units;
            base_units = next;
            // 没跨步：不编请求。拖动在轨上停留的每一帧都会报值，其中只有
            // 跨步的那些值得一次落盘；noop 让 core 原样返回，零重建。
            if (delta == 0) return .noop;
            var writer = project_request.Writer{};
            const request = project_request.adjustTypography(&writer, field, delta) orelse return .noop;
            // 这一条的返回型是 `Msg` 而不是 `?Msg`（滑块回调的形），所以“无处可
            // 放”在这里的具名拒绝就是 `.noop`：滑块不动，而不是送一条指向已死
            // 栈帧的请求。
            return .{ .project_request = request.keep() orelse return .noop };
        }
    };
}

fn adjustTypographyMsg(comptime field: []const u8, comptime delta: i64) ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.adjustTypography(&writer, field, delta) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 手动切换 KARA。
///
/// **接上哪个功能**：`KaraEvent::ManualToggle`——六态机在 Rust（INV-10），
/// 这边只送事件、取转移。界面不判「现在是开还是关」：判了就会与那台
/// 状态机各说各话，而作者看到的是按钮说开着、正文却没进专注。
fn karaToggleMsg() ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.karaStep(&writer, "manualToggle") orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

/// 读当前设置。没有 value：`ReadConfig` 是无字段变体。
fn readConfigMsg() ?Msg {
    var writer = project_request.Writer{};
    const request = project_request.readConfig(&writer) orelse return null;
    return .{ .project_request = request.keep() orelse return null };
}

test "三颗材质按钮里，高亮的恰是 Model 记着的那一种" {
    // `.selected` 是作者判断「我现在用的是哪一种」的唯一线索。三颗按钮共用
    // 一条画法，所以它们只可能一起对或一起错——逐个换过去问一遍。
    var model: Model = .{};
    for ([_]material_recipe.Kind{ .solid, .acrylic, .liquid }) |kind| {
        model.panel_material = kind;
        var surface = view_harness.Surface.init(std.testing.allocator);
        defer surface.deinit();
        const built = surface.build(&model, settingsView);
        const label = switch (kind) {
            .solid => "把面板换成实心",
            .acrylic => "把面板换成亚克力",
            .liquid => "把面板换成液态玻璃",
        };
        const chosen = view_harness.find(built, label) orelse return error.TestUnexpectedResult;
        try std.testing.expect(chosen.widget.state.selected);
    }
}
