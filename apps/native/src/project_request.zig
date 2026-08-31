// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 产品入口的写法：一次点击变成一条 `ProjectInput`。
//!
//! **接上哪个功能**：作者能做的每一件跨界的事——打开项目、翻文件树、开文档、
//! 新建、导入、删除、搜索、改设置、推进 KARA、对选中的 Run 下命令。
//!
//! **在全局逻辑中负责什么**：只编码，不决定。「现在能不能点」归
//! `core/workbench.zig` 的 `navigate` 与 `core/roster.zig` 的游标不变量；
//! 「这条命令合不合法」归 Rust 的具名拒绝。这一层若也判一次，就会出现
//! 「界面允许点、Rust 又拒绝」的两份规矩。
//!
//! **为什么单独一个模块而不在核心里**：这一分工来自 TS 车道——请求要带作者
//! 选的路径与查询词，而那个受限子集不能拼接字符串（NS9001），于是编码必须出
//! 核心。Zig 核心没有这个限制，但分工留下了：一个地方写请求，比把编码摄回
//! `update` 的六十多条臂里好读。
//!
//! **能复用什么**：一个入口一个函数，共用 `Writer`。新增入口只加一个函数，
//! 通道、协议、action 都不动——`project_request` 已经是完整的跨界入口。

const std = @import("std");

/// 一条编好的请求，连同它借用的缓冲。
///
/// 定长缓冲而不是分配：请求受 ABI 上限约束（`event_text_bytes`），而视图每帧
/// 都可能编一条。**缓冲是模块级静态的**：`Msg` 携带的 `bytes` 要活到 core
/// 收到它、把它编进宿主请求的那一步——栈 buffer 在函数返回后失效，实测
/// 内容被复用帧覆盖成 NUL（e2e 仿真抓出：adopt 请求 55 字节全零，宿主
/// 具名拒绝）。单线程 UI 帧内消费，静态缓冲因此安全；一次只编一条请求，
/// 没有嵌套。
pub const Request = struct {
    /// 字节借自编它的那个 `Writer`，**不比它活得久**。取字节的两个口各自说出
    /// 调用方在主张哪一种寿命；旧字段名 `.bytes` 什么也不说。
    lent: []const u8,

    /// 视图侧：搬进这一道 build 的 arena，活到这棵树死。
    ///
    /// `on_press` 存的是渲染时的值，而里面的切片是借的（`ui.zig:791`）；arena
    /// 与树同生共死，开着的菜单另有世代钉住（`ui_app.zig:6314-6322`），所以
    /// 这是 SDK 认可的两个去处之一。null = 具名拒绝，调用方把那个控件画成
    /// 不可按并说出原因。
    pub fn keep(self: Request) ?[]const u8 {
        return keepBytes(self.lent);
    }

    /// `update` 侧：字节在同一语句序列里被 `replay_seam.encode` 拷走
    /// （`core.zig:536-547` → `replay_seam.zig:124`）。
    ///
    /// **叫它就是在声明“没有人会在本函数返回后读这段字节”。** 它出现在
    /// `view/` 里就是一句可 grep 的谎：那边的调用方把值交给 SDK 后就返回了。
    pub fn nowOrNever(self: Request) []const u8 {
        return self.lent;
    }
};

/// 编码用的缓冲：住在 writer 自己里，而 writer 住在调用方放它的地方。
///
/// 12 KiB 与协议的 `event_text_bytes` 同源：超过它 Rust 会具名拒绝，所以这里
/// 装不下就交出 null，让调用方显示一条拒绝，而不是送一条会被截断的请求。
///
/// **模块里没有任何 `var` 存储，这是故意的。** 之前两代都把字节放在模块级：
/// 先是一块静态 buffer（e2e 仿真抓到 55 字节的 adopt 请求被后一个按钮覆成 `}}`
/// 尾巴），后是 64 个轮换的槽（一屏 64 行的行菜单借 256 次，第 65 次起覆写还
/// 被 `on_press` 指着的字节，于是“删除”作用在别的文档上），再后是一帧一块的
/// 帧缓冲（同帧不再相互覆盖，但开着的菜单活过下一帧时仍然被切掉）。
/// 三代都在回答同一个错问题——“这块存储该多大”。真问题是“这段字节该活多久”，
/// 而 SDK 已经回答过（`ui_app.zig:6317`）：**model storage or this same build
/// arena**。所以字节现在编在栈上，然后由调用方用 `Request.keep` 搬进 arena（视图
/// 侧）或 `Request.nowOrNever` 当场用掉（`update` 侧）。
pub const max_request_bytes: usize = 12000;

/// 这一道 build 的字节从哪来。
///
/// 绑的是**分配器**，不是存储：字节仍然出自 SDK 的 build arena，只是不必
/// 穿过四十个辅助函数的签名才到得了手。先例是 `app_main.zig` 的
/// `host_bridge.bind(&app_state.effects)`——同一种“app 级资源绑进模块”。
///
/// 代价诚实写在这里：它是一个隐含上下文。在 build 之外调 `keep` 会拿到上
/// 一道的 arena，而那段内存下一道就被 reset。拦它的是两条：`update` 侧全部
/// 走 `nowOrNever`（`view/` 里出现它就是一句可 grep 的谎），且未绑时一律拒绝。
var build_arena: ?std.mem.Allocator = null;

/// 一道 build 的开头：告诉这一层它的字节这一道从哪里来。`null` 解绑（测试
/// 用它把自己的 arena 交回去，不把一个已死的分配器留给下一条测试）。
pub fn bindBuildArena(arena: ?std.mem.Allocator) void {
    build_arena = arena;
}

/// 把一段借来的字节搬进本道 build 的 arena。打开引用与失败原因标签走同一条路，
/// 所以“这一道 build 的字节归谁”只此一处记账。
pub fn keepBytes(lent: []const u8) ?[]const u8 {
    const arena = build_arena orelse return null;
    return arena.dupe(u8, lent) catch null;
}

/// 一道 build 里拼一段字（失败原因的「失败：{s}」）。字节与请求同寿命。
pub fn keepPrint(comptime fmt: []const u8, args: anytype) ?[]const u8 {
    const arena = build_arena orelse return null;
    return std.fmt.allocPrint(arena, fmt, args) catch null;
}

pub const Writer = struct {
    bytes: [max_request_bytes]u8 = undefined,
    len: usize = 0,

    /// 重新开始编一条请求。缓冲就在手上，reset 只丢掉上一条的长度。
    pub fn reset(self: *Writer) void {
        self.len = 0;
    }

    fn put(self: *Writer, bytes: []const u8) bool {
        if (self.len + bytes.len > self.bytes.len) return false;
        @memcpy(self.bytes[self.len..][0..bytes.len], bytes);
        self.len += bytes.len;
        return true;
    }

    /// 一个 JSON 字符串，转义作者可能写进标题或查询词的字符。
    ///
    /// 不转义就等于让一个带引号的文件名改写请求的结构——这不是显示问题，
    /// 是一条能改变请求含义的路径。控制字符按 `\u00XX` 走，与 serde 对齐。
    fn putString(self: *Writer, text: []const u8) bool {
        if (!self.put("\"")) return false;
        for (text) |ch| {
            const ok = switch (ch) {
                '"' => self.put("\\\""),
                '\\' => self.put("\\\\"),
                '\n' => self.put("\\n"),
                '\r' => self.put("\\r"),
                '\t' => self.put("\\t"),
                0...8, 11, 12, 14...0x1f => blk: {
                    var escape: [6]u8 = undefined;
                    const written = std.fmt.bufPrint(&escape, "\\u{x:0>4}", .{ch}) catch break :blk false;
                    break :blk self.put(written);
                },
                else => self.put(&[_]u8{ch}),
            };
            if (!ok) return false;
        }
        return self.put("\"");
    }

    fn putNumber(self: *Writer, number: u64) bool {
        var digits: [20]u8 = undefined;
        const written = std.fmt.bufPrint(&digits, "{d}", .{number}) catch return false;
        return self.put(written);
    }

    fn finish(self: *Writer) ?Request {
        return .{ .lent = self.bytes[0..self.len] };
    }

    /// `{"kind":<name>,"value":{` — 每条请求的开头。
    fn open(self: *Writer, name: []const u8) bool {
        return self.put("{\"kind\":\"") and self.put(name) and self.put("\",\"value\":{");
    }

    fn close(self: *Writer) bool {
        return self.put("}}");
    }

    fn key(self: *Writer, name: []const u8) bool {
        return self.putString(name) and self.put(":");
    }

    fn comma(self: *Writer) bool {
        return self.put(",");
    }
};

/// 打开一个项目文件夹或单份稿子。路径由 Rust 的系统选择器给出，界面不碰它。
pub fn chooseAndAdoptRoot(writer: *Writer, folder: bool) ?Request {
    writer.reset();
    if (!writer.open("chooseAndAdoptRoot")) return null;
    if (!writer.key("kind")) return null;
    if (!writer.putString(if (folder) "folder" else "file")) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 新建一个项目。父目录由 Rust 的选择器给出。
pub fn chooseAndCreateProject(writer: *Writer, name: []const u8) ?Request {
    writer.reset();
    if (!writer.open("chooseAndCreateProject")) return null;
    if (!writer.key("name") or !writer.putString(name)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 文件树的一页。`after` 为空表示第一页——分页游标由 Rust 给，界面原样送回。
pub fn documentPage(writer: *Writer, root_id: []const u8, after: []const u8) ?Request {
    writer.reset();
    if (!writer.open("documentPage")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("after")) return null;
    if (after.len == 0) {
        if (!writer.put("null")) return null;
    } else if (!writer.putString(after)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 打开文件树里的一份文档。
pub fn openDocument(writer: *Writer, root_id: []const u8, path: []const u8) ?Request {
    writer.reset();
    if (!writer.open("openDocument")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 新建一份文档。`role` 是 `chapter`／`document`／`material` 之一。
pub fn createDocument(
    writer: *Writer,
    root_id: []const u8,
    title: []const u8,
    role: []const u8,
) ?Request {
    writer.reset();
    if (!writer.open("createDocument")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("title") or !writer.putString(title)) return null;
    if (!writer.comma() or !writer.key("role") or !writer.putString(role)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 删除一份文档。进系统回收站，不是抹掉——语义归 Rust，这里只送意图。
pub fn deleteDocument(writer: *Writer, root_id: []const u8, path: []const u8) ?Request {
    writer.reset();
    if (!writer.open("deleteDocument")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 导入正文或资料。文件由 Rust 的选择器给出。
pub fn chooseAndImport(writer: *Writer, root_id: []const u8, manuscript: bool) ?Request {
    writer.reset();
    if (!writer.open(if (manuscript) "chooseAndImportManuscript" else "chooseAndImportMaterial")) {
        return null;
    }
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 文档名搜索。`exact` 决定用精确还是宽松——排序与召回规则都在 Rust。
pub fn documentSearch(
    writer: *Writer,
    root_id: []const u8,
    query: []const u8,
    exact: bool,
) ?Request {
    return search(writer, "documentSearch", root_id, query, exact);
}

/// 块级搜索：命中带上下文。与文档搜索同形，只是落点不同。
pub fn blockSearch(
    writer: *Writer,
    root_id: []const u8,
    query: []const u8,
    exact: bool,
) ?Request {
    return search(writer, "blockSearch", root_id, query, exact);
}

fn search(
    writer: *Writer,
    name: []const u8,
    root_id: []const u8,
    query: []const u8,
    exact: bool,
) ?Request {
    writer.reset();
    if (!writer.open(name)) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("query") or !writer.putString(query)) return null;
    if (!writer.comma() or !writer.key("precision")) return null;
    if (!writer.putString(if (exact) "exact" else "loose")) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 改一份材料对 Agent 的披露权限。
pub fn setDisclosure(
    writer: *Writer,
    root_id: []const u8,
    path: []const u8,
    disclosure: []const u8,
) ?Request {
    writer.reset();
    if (!writer.open("setDisclosure")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.comma() or !writer.key("disclosure") or !writer.putString(disclosure)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 读当前设置。设置面板、字体与全局排版都从这一条拿值。
///
/// 没有 value：`ReadConfig` 是无字段变体，serde 的 `content` 标签因此不写。
pub fn readConfig(writer: *Writer) ?Request {
    writer.reset();
    if (!writer.put("{\"kind\":\"readConfig\"}")) return null;
    return writer.finish();
}

/// 读材料草稿的名录：Agent 交来的草稿，等待成稿或退回。
///
/// **接上哪个功能**：派发台的材料草稿行。答复与成稿/退回共用同一份
/// 名录——动作之后界面不必再发一次读。
pub fn readMaterialDrafts(writer: *Writer, root_id: []const u8) ?Request {
    writer.reset();
    if (!writer.put("{\"kind\":\"readMaterialDrafts\",\"value\":{")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.put("}}")) return null;
    return writer.finish();
}

/// 成稿或退回一条材料草稿。`edited_body` 是作者改后的版本（null 用草稿
/// 原文）；`dismiss` 退回；`as_chapter` 直接提拔成正文（否则进资料区）。
///
/// **接上哪个功能**：派发台材料草稿行的三个按钮：收进资料区 / 收成正文 /
/// 退回。行内编辑把改后的文字经 `edited_body` 送过去。形状由
/// `examples/wire_shapes.rs` 的 commitMaterialDraft 条目守着（editedBody
/// 的 None 写成 null——省略键与显式 null 在 serde 里不是一回事）。
pub fn commitMaterialDraft(
    writer: *Writer,
    root_id: []const u8,
    draft_id: []const u8,
    edited_body: ?[]const u8,
    dismiss: bool,
    as_chapter: bool,
) ?Request {
    writer.reset();
    if (!writer.put("{\"kind\":\"commitMaterialDraft\",\"value\":{")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("draftId") or !writer.putString(draft_id)) return null;
    if (!writer.comma() or !writer.key("editedBody")) return null;
    if (edited_body) |body| {
        if (!writer.putString(body)) return null;
    } else if (!writer.put("null")) return null;
    if (!writer.comma() or !writer.key("dismiss")) return null;
    if (!writer.put(if (dismiss) "true" else "false")) return null;
    if (!writer.comma() or !writer.key("asChapter")) return null;
    if (!writer.put(if (as_chapter) "true" else "false")) return null;
    if (!writer.put("}}")) return null;
    return writer.finish();
}

/// 在选中的一段正文上留一条批注。
///
/// **接上哪个功能**：正文右键菜单的「高亮」。送原文而不是块 id——块身份
/// 由 Rust 查（与派发同一条 `locate_scope`），让这边送块 id 等于要求它先
/// 知道块怎么切，而切法随文档格式变。
///
/// **口径**：`body` 是 `Option<String>`，高亮时必须写 `null` 而不是省略
/// 这个键——省略会让 serde 拒绝整条请求，界面上表现为「标不上」。
pub fn annotate(
    writer: *Writer,
    root_id: []const u8,
    path: []const u8,
    selected: []const u8,
    body: []const u8,
) ?Request {
    writer.reset();
    if (!writer.open("annotate")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.comma() or !writer.key("selected") or !writer.putString(selected)) return null;
    if (!writer.comma() or !writer.key("body")) return null;
    if (body.len == 0) {
        if (!writer.put("null")) return null;
    } else {
        if (!writer.putString(body)) return null;
    }
    if (!writer.close()) return null;
    return writer.finish();
}

/// 调排版里的一项：字号、行高或行长。
///
/// **接上哪个功能**：设置面板的三个加减按钮。
///
/// **为什么送增量而不是绝对值**：按钮做的就是「大一点」。送绝对值，界面
/// 得先持有当前值，而那份值在并发下可能已经旧了——作者调字号的同时若
/// 有别处改过行高，一次整份替换会把行高改回旧的。范围钳在 Rust：
/// 上下界是那些字段自己的性质。
///
/// **口径**：三层嵌套，各有各的规矩——`changeConfig`（外层变体名）、
/// `adjustTypography`（`ConfigChange` 的变体名）、`textSize`（字段枚举的
/// 变体名）全是 camelCase，而 `field`／`delta` 是结构字段。实测自
/// `wire_shapes.rs`，不是按规律推的。
/// 把一段正文在全角与半角之间转换：选区块或整篇，方向二选一。
///
/// **接上哪个功能**：正文右键菜单的「转全角／转半角」（选区级）与命令
/// 面板的同名项（全文级）。转换在 Rust（`text_width` 是唯一权威），这里
/// 只把选区原文、作用域与方向送过去——送块 id 等于要求界面先知道块怎么切。
///
/// **口径**：`wholeDocument` 是 camelCase 结构字段，`direction` 是两个
/// kebab-case 词（`to-full`／`to-half`）。实测自 `wire_shapes.rs`。
pub fn convertWidth(
    writer: *Writer,
    root_id: []const u8,
    path: []const u8,
    selected: []const u8,
    whole_document: bool,
    direction: []const u8,
) ?Request {
    writer.reset();
    if (!writer.open("convertWidth")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.comma() or !writer.key("selected") or !writer.putString(selected)) return null;
    if (!writer.comma() or !writer.key("wholeDocument")) return null;
    if (whole_document) {
        if (!writer.put("true")) return null;
    } else {
        if (!writer.put("false")) return null;
    }
    if (!writer.comma() or !writer.key("direction") or !writer.putString(direction)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

test "a scope conversion names the direction and the scope" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"convertWidth\",\"value\":{\"rootId\":\"r1\",\"path\":\"章一.md\"," ++
            "\"selected\":\"abc\",\"wholeDocument\":false,\"direction\":\"to-full\"}}",
        convertWidth(&writer, "r1", "章一.md", "abc", false, "to-full").?.nowOrNever(),
    );
}

test "a whole-document conversion carries no selection text" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"convertWidth\",\"value\":{\"rootId\":\"r1\",\"path\":\"章一.md\"," ++
            "\"selected\":\"\",\"wholeDocument\":true,\"direction\":\"to-half\"}}",
        convertWidth(&writer, "r1", "章一.md", "", true, "to-half").?.nowOrNever(),
    );
}

pub fn adjustTypography(writer: *Writer, field: []const u8, delta: i64) ?Request {
    writer.reset();
    if (!writer.put("{\"kind\":\"changeConfig\",\"value\":{\"adjustTypography\":{")) return null;
    if (!writer.key("field") or !writer.putString(field)) return null;
    if (!writer.comma() or !writer.key("delta")) return null;
    if (delta < 0) {
        if (!writer.put("-")) return null;
        if (!writer.putNumber(@intCast(-delta))) return null;
    } else {
        if (!writer.putNumber(@intCast(delta))) return null;
    }
    if (!writer.put("}}}")) return null;
    return writer.finish();
}

/// 换面板材质：实心 / 亚克力 / 液态玻璃。
///
/// **接上哪个功能**：设置面板的材质三选行（2.10）。选哪一种界面立刻换肤
/// （Model 先记下标），这里是落盘的那一份——重开不回弹。
///
/// **口径**：`{"kind":"changeConfig","value":{"setPanelMaterial":"acrylic"}}`——
/// `PanelMaterial` 是 kebab-case 裸字符串（config.rs 的 serde 标注），
/// 与 toggleAgentPersona 同形。词汇以 Rust 为准（solid/acrylic/liquid），
/// 调用方只传这三个词。
pub fn setPanelMaterial(writer: *Writer, material: []const u8) ?Request {
    writer.reset();
    if (!writer.put("{\"kind\":\"changeConfig\",\"value\":{\"setPanelMaterial\":")) return null;
    if (!writer.putString(material)) return null;
    if (!writer.put("}}")) return null;
    return writer.finish();
}

/// 换一套主题。slug 取自生成的色表，调用方不自己拼名字。
///
/// **口径**：`{"kind":"changeConfig","value":{"setTheme":"sumi"}}`——与
/// `setPanelMaterial` 同形。TS 车道把七套主题写成一个七分支的 switch（受限子集
/// 拼不出字符串），于是新增一套主题要同时改色表与那个 switch——两份权威。
/// 这里只收一个 slug，它由调用方从色表里读出来。
pub fn setTheme(writer: *Writer, slug: []const u8) ?Request {
    writer.reset();
    if (!writer.put("{\"kind\":\"changeConfig\",\"value\":{\"setTheme\":")) return null;
    if (!writer.putString(slug)) return null;
    if (!writer.put("}}")) return null;
    return writer.finish();
}

/// 切换一个 Agent 的角色二态：干活 ↔ 扮演，身份原文带过去。
///
/// **接上哪个功能**：设置面板 Agent 行上的切换按钮。没有身份的 Agent
/// 切无可切（Rust 侧 no-op），界面不给出按钮。
///
/// **口径**：`{"kind":"changeConfig","value":{"toggleAgentPersona":"<id>"}}`——
/// `Id` 是 serde transparent，序列化成裸字符串。实测自 `wire_shapes.rs`。
pub fn toggleAgentPersona(writer: *Writer, agent_id: []const u8) ?Request {
    writer.reset();
    if (!writer.put("{\"kind\":\"changeConfig\",\"value\":{\"toggleAgentPersona\":")) return null;
    if (!writer.putString(agent_id)) return null;
    if (!writer.put("}}")) return null;
    return writer.finish();
}

/// 整份更新一个 Agent：名字、身份、专属 argv 一次落盘。
///
/// **接上哪个功能**：设置面板的伙伴编辑（argv 与身份说明）。`UpsertAgent`
/// 是整份替换（upsert 语义：同 id 覆盖，无 id 新建），所以调用方必须持有
/// 整份 profile——编辑 argv 时，名字与身份从 Rust 快照读回来原样回填。
///
/// **口径**：persona 是两层嵌套（`{"work":{"body":…}}`／`{"cosplay":…}`／
/// `null`），argv 是字符串数组。空 persona 写 `null` 而不是省略键——
/// 省略会被 serde 具名拒绝，而界面上作者看到的只是「保存没反应」。
/// `mode` 用 `"work"`／`"cosplay"`／空（无身份）；`connection_id` 原样
/// 回填快照值（空写 `null`）——界面不编辑它，但写死 null 会把作者
/// 手绑的连接静默抹掉（数据丢失型坏味道，审计项）。
pub fn upsertAgent(
    writer: *Writer,
    agent_id: []const u8,
    name: []const u8,
    connection_id: []const u8,
    persona_mode: []const u8,
    persona_body: []const u8,
    argv: []const u8,
) ?Request {
    writer.reset();
    if (!writer.put("{\"kind\":\"changeConfig\",\"value\":{\"upsertAgent\":{\"id\":")) return null;
    if (!writer.putString(agent_id)) return null;
    if (!writer.put(",\"name\":") or !writer.putString(name)) return null;
    if (!writer.put(",\"connection_id\":")) return null;
    if (connection_id.len == 0) {
        if (!writer.put("null")) return null;
    } else {
        if (!writer.putString(connection_id)) return null;
    }
    if (!writer.put(",\"persona\":")) return null;
    if (persona_mode.len == 0) {
        if (!writer.put("null")) return null;
    } else {
        if (!writer.put("{\"")) return null;
        if (!writer.put(persona_mode)) return null;
        if (!writer.put("\":{\"body\":") or !writer.putString(persona_body)) return null;
        if (!writer.put("}}")) return null;
    }
    if (!writer.put(",\"argv\":[")) return null;
    var rest = argv;
    var first = true;
    while (rest.len > 0) {
        const end = std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len;
        const piece = rest[0..end];
        if (piece.len > 0) {
            if (!first) {
                if (!writer.put(",")) return null;
            }
            if (!writer.putString(piece)) return null;
            first = false;
        }
        if (end == rest.len) break;
        rest = rest[end + 1 ..];
    }
    if (!writer.put("]}}}")) return null;
    return writer.finish();
}

test "an agent upsert carries the persona branch and the argv list" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"changeConfig\",\"value\":{\"upsertAgent\":{\"id\":\"a1\",\"name\":\"编辑\"," ++
            "\"connection_id\":\"c9\",\"persona\":{\"work\":{\"body\":\"改稿\"}},\"argv\":[\"--model\",\"max\"]}}}",
        upsertAgent(&writer, "a1", "编辑", "c9", "work", "改稿", "--model max").?.nowOrNever(),
    );
}

test "an agent without a persona writes a null branch" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"changeConfig\",\"value\":{\"upsertAgent\":{\"id\":\"a3\",\"name\":\"裸机\"," ++
            "\"connection_id\":null,\"persona\":null,\"argv\":[]}}}",
        upsertAgent(&writer, "a3", "裸机", "", "", "", "").?.nowOrNever(),
    );
}

test "a panel material change names the kebab word serde expects" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"changeConfig\",\"value\":{\"setPanelMaterial\":\"acrylic\"}}",
        setPanelMaterial(&writer, "acrylic").?.nowOrNever(),
    );
}

test "a run launch names the Root and the run, never a workspace" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"launchRun\",\"value\":{\"rootId\":\"r1\",\"runId\":\"run-9\"}}",
        launchRun(&writer, "r1", "run-9").?.nowOrNever(),
    );
}

/// 读一份文档改过什么：落盘的改动记录，重启之后仍在。
///
/// 与撤销分开：撤销走内存里那条链，这一条读的是磁盘上的记录——作者
/// 关掉软件第二天回来，看得见的是这一份。
pub fn readHistory(writer: *Writer, root_id: []const u8, path: []const u8) ?Request {
    writer.reset();
    if (!writer.open("readHistory")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 读一份文档上的批注：高亮与评论。
pub fn readAnnotations(writer: *Writer, root_id: []const u8, path: []const u8) ?Request {
    writer.reset();
    if (!writer.open("readAnnotations")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 探测本机装了哪些 Harness。
///
/// 不带 Root：它问的是这台机器，不是这个项目。作者在「连接」那个去处
/// 看见的是「我能连什么」，与他打开了哪个项目无关——所以这条请求在
/// 一个项目也没开的时候同样发得出去。
/// 把生成的协议装进一个 harness 的 skill 目录。作者显式点击——这是
/// Root 之外的唯一写路径。
pub fn installSkill(writer: *Writer, harness_id: []const u8) ?Request {
    writer.reset();
    if (!writer.open("installSkill")) return null;
    if (!writer.key("harnessId") or !writer.putString(harness_id)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

pub fn readHarnesses(writer: *Writer, force: bool) ?Request {
    writer.reset();
    if (!writer.open("readHarnesses")) return null;
    if (!writer.key("force")) return null;
    if (force) {
        if (!writer.put("true")) return null;
    } else if (!writer.put("false")) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 读一个 Root 的编排名录：Task、Run、授权与待恢复项。
pub fn readHost(writer: *Writer, root_id: []const u8) ?Request {
    writer.reset();
    if (!writer.open("readHost")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 读信箱：全部文档的提案与作者的安排合成的一屏。
///
/// **接上哪个功能**：`refrain_app::mailbox::entries`（默认）或
/// `refrain_app::mailbox::discarded`（回收站）。答复是刷新后的整屏，
/// 所以每个安排动作之后界面不必再发一条读——动作的答复就是新信箱。
pub fn readMailbox(writer: *Writer, root_id: []const u8, discarded: bool) ?Request {
    writer.reset();
    if (!writer.open("readMailbox")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("discarded")) return null;
    if (discarded) {
        if (!writer.put("true")) return null;
    } else if (!writer.put("false")) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 置顶或取消置顶一单。`box_name` 是这一单现在所在的格（kebab-case）——
/// 安排表按格+id 点名，界面上它来自行本身，不让作者填。
pub fn mailboxPin(
    writer: *Writer,
    root_id: []const u8,
    entry_id: []const u8,
    box_name: []const u8,
    pinned: bool,
) ?Request {
    writer.reset();
    if (!writer.open("mailboxPin")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("entryId") or !writer.putString(entry_id)) return null;
    if (!writer.comma() or !writer.key("boxName") or !writer.putString(box_name)) return null;
    if (!writer.comma() or !writer.key("pinned")) return null;
    if (!writer.put(if (pinned) "true" else "false")) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 弃置一单：软删除，单进回收站，提案行与账本原封不动（INV-4）。
pub fn mailboxDiscard(
    writer: *Writer,
    root_id: []const u8,
    entry_id: []const u8,
    box_name: []const u8,
) ?Request {
    writer.reset();
    if (!writer.open("mailboxDiscard")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("entryId") or !writer.putString(entry_id)) return null;
    if (!writer.comma() or !writer.key("boxName") or !writer.putString(box_name)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 取回一弃置的单：软删除可逆，这就是回收站的那一半。单回它被弃置时
/// 所在的那一格。没弃置过的是空操作不是错误。
pub fn mailboxRestore(
    writer: *Writer,
    root_id: []const u8,
    entry_id: []const u8,
) ?Request {
    writer.reset();
    if (!writer.open("mailboxRestore")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("entryId") or !writer.putString(entry_id)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 排一单在那一格里的位次。位次是绝对下标；相邻交换是原子的
/// `mailboxSwap`，界面不拼两条。
pub fn mailboxRank(
    writer: *Writer,
    root_id: []const u8,
    entry_id: []const u8,
    box_name: []const u8,
    rank: u32,
) ?Request {
    writer.reset();
    if (!writer.open("mailboxRank")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("entryId") or !writer.putString(entry_id)) return null;
    if (!writer.comma() or !writer.key("boxName") or !writer.putString(box_name)) return null;
    if (!writer.comma() or !writer.key("rank")) return null;
    if (!writer.putNumber(rank)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 与另一单交换位次，一次事务。相邻交换是界面唯一需要的移动语义，
/// 两条 `mailboxRank` 拼不出原子交换。
pub fn mailboxSwap(
    writer: *Writer,
    root_id: []const u8,
    entry_id: []const u8,
    other_id: []const u8,
) ?Request {
    writer.reset();
    if (!writer.open("mailboxSwap")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("entryId") or !writer.putString(entry_id)) return null;
    if (!writer.comma() or !writer.key("otherId") or !writer.putString(other_id)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 冲销一单已裁决的提案：把它的裁决行从账本退回。
///
/// 界面一次冲销一单——行就是作者指着的那一封。`proposalIds` 仍是数组，
/// 因为 `Countermand` 的领域形状是「一批」；这里只收一个 id，装成一元数组。
pub fn countermand(
    writer: *Writer,
    root_id: []const u8,
    path: []const u8,
    entry_id: []const u8,
) ?Request {
    writer.reset();
    if (!writer.open("countermand")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.comma() or !writer.key("proposalIds")) return null;
    if (!writer.put("[") or !writer.putString(entry_id) or !writer.put("]")) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 对选中的 Run 下一条只带 id 的命令：取消、重试、启动。
///
/// `command` 是 `HostCommand` 的变体名（camelCase）。**字段名是 `run_id`
/// 而不是 `runId`**：`HostCommand` 只对变体名做了 `rename_all`，字段保持
/// Rust 拼写。这一条由 `examples/wire_shapes.rs` 的实测输出确定，不是从
/// 其他类型的形状推断的——两处推断不同就是一条被静默拒绝的请求。
///
/// `at` 是时刻——宿主自己没有钟，时间随命令过河，这样它的事实可重放。
pub fn hostRunCommand(
    writer: *Writer,
    root_id: []const u8,
    command: []const u8,
    run_id: []const u8,
    at: ?u64,
) ?Request {
    writer.reset();
    if (!writer.open("hostCommand")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("command")) return null;
    if (!writer.put("{\"") or !writer.put(command) or !writer.put("\":{")) return null;
    if (!writer.key("run_id") or !writer.putString(run_id)) return null;
    if (at) |moment| {
        if (!writer.comma() or !writer.key("at") or !writer.putNumber(moment)) return null;
    }
    if (!writer.put("}}")) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 读一份打开着的稿子的块清单：派发台块段的行来自这一条。
///
/// `after` 是翻页游标（上一页末行的 ordinal），没有就写 `null`——serde 的
/// `Option<u32>` 只认数字与 null 两种，省略键会被具名拒绝。`count` 由 Rust
/// 夹到 1..=100，这里照送。
pub fn readBlocks(
    writer: *Writer,
    root_id: []const u8,
    path: []const u8,
    after: ?u64,
    count: u64,
) ?Request {
    writer.reset();
    if (!writer.open("readBlocks")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.comma() or !writer.key("after")) return null;
    if (after) |ordinal| {
        if (!writer.putNumber(ordinal)) return null;
    } else if (!writer.put("null")) return null;
    if (!writer.comma() or !writer.key("count") or !writer.putNumber(count)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 读这个项目的资料名录：派发台「这轮给 agent 读什么」的勾选行来自
/// 这一条。
pub fn readMaterials(writer: *Writer, root_id: []const u8) ?Request {
    writer.reset();
    if (!writer.open("readMaterials")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 派发台的送出/预览：块段、攒段与选区合成 scopes 的请求。
///
/// **接上哪个功能**：2.2 的派发台（`Dispatch`／`PreviewDispatch` 共用，只差
/// `kind` 与送前核对的 digest）。
///
/// **scope 合成规则**：`span` 在场时是 s1（块段，`before` 送空串——原文由
/// Rust 按块 id 取回拼接）；`stash` 按 NUL 逐段，每段一个文本 scope，标签
/// 顺着排（块段在时是 s2、s3……，不在时从 s1 起）。两者可以同在。**选区
/// 也走这里**：位图与攒段都空时，调用方把选区文本放进 stash 槽位（一段
/// 文本 scope）——委托/带稿/资料三个闸对三种范围来源同价（审计 #7）。
///
/// **能复用什么**：装不下 12KB 槽就交出 null——「装不下不送」的截断纪律，
/// 调用方据此把按钮灰掉。
pub fn dispatchDesk(
    writer: *Writer,
    root_id: []const u8,
    document: []const u8,
    prompt: []const u8,
    span: ?struct { from: u64, count: u64 },
    stash: []const u8,
    agents: u64,
    orchestration: []const u8,
    carry: []const u8,
    materials: []const []const u8,
    agent_id: []const u8,
    channel: []const u8,
    expected_digest: ?[]const u8,
    comptime kind: []const u8,
) ?Request {
    writer.reset();
    if (!writer.open(kind)) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("request")) return null;
    if (!writer.put("{")) return null;
    if (!writer.key("document") or !writer.putString(document)) return null;
    if (!writer.comma() or !writer.key("prompt") or !writer.putString(prompt)) return null;
    if (!writer.comma() or !writer.key("scopes") or !writer.put("[")) return null;
    var label: u64 = 1;
    var first = true;
    if (span) |blocks| {
        // 块段 scope：from 是起始 ordinal，before 恒空串（以块为准）。
        if (!writer.put("{")) return null;
        if (!writer.key("label") or !writer.putString("s1")) return null;
        if (!writer.comma() or !writer.key("before") or !writer.putString("")) return null;
        if (!writer.comma() or !writer.key("blocks") or !writer.put("{")) return null;
        if (!writer.key("from") or !writer.putNumber(blocks.from)) return null;
        if (!writer.comma() or !writer.key("count") or !writer.putNumber(blocks.count)) return null;
        if (!writer.put("}}")) return null;
        label += 1;
        first = false;
    }
    var rest = stash;
    while (rest.len > 0) {
        const at = std.mem.indexOfScalar(u8, rest, 0) orelse rest.len;
        const segment = rest[0..at];
        rest = if (at < rest.len) rest[at + 1 ..] else rest[0..0];
        // 空段（连着的 NUL）不成 scope：一个空 scope 会被 Rust 具名拒绝。
        if (segment.len == 0) continue;
        if (!first and !writer.comma()) return null;
        first = false;
        var label_buf: [16]u8 = undefined;
        const label_text = std.fmt.bufPrint(&label_buf, "s{d}", .{label}) catch return null;
        label += 1;
        if (!writer.put("{")) return null;
        if (!writer.key("label") or !writer.putString(label_text)) return null;
        if (!writer.comma() or !writer.key("before") or !writer.putString(segment)) return null;
        if (!writer.put("}")) return null;
    }
    if (!writer.put("]")) return null;
    if (!writer.comma() or !writer.key("agents") or !writer.putNumber(agents)) return null;
    // 排法名是 kebab-case（`alternates`／`follows`／`verifies`），由调用方给。
    if (!writer.comma() or !writer.key("orchestration") or !writer.putString(orchestration)) return null;
    // persona 恒 null（D14：harness 通道的身份由 AGENTS.md 承载），channel
    // 由调用方按委托行给——手动往返是 "manual"，具名伙伴是 "harness"。
    if (!writer.comma() or !writer.key("persona") or !writer.put("null")) return null;
    if (!writer.comma() or !writer.key("channel") or !writer.putString(channel)) return null;
    if (!writer.comma() or !writer.key("resultPath") or !writer.putString("result.md")) return null;
    if (!writer.comma() or !writer.key("maxBytes") or !writer.putNumber(64 * 1024)) return null;
    // carry／materials／agent／expectedDigest 在场才写：serde 的 default + skip
    // 纪律认缺席为默认（旧载荷 = 旧行为），多写一个默认值反而改变字节。
    // 顺序是 serde 的声明序（carry、materials、agent、expectedDigest）。
    if (carry.len > 0) {
        if (!writer.comma() or !writer.key("carry") or !writer.putString(carry)) return null;
    }
    if (materials.len > 0) {
        // 勾选的资料：只有路径过河，档位权威在名录（SetDisclosure）。
        if (!writer.comma() or !writer.key("materials") or !writer.put("[")) return null;
        for (materials, 0..) |path, index| {
            if (index > 0 and !writer.comma()) return null;
            if (!writer.putString(path)) return null;
        }
        if (!writer.put("]")) return null;
    }
    if (agent_id.len > 0) {
        if (!writer.comma() or !writer.key("agent") or !writer.putString(agent_id)) return null;
    }
    if (expected_digest) |digest| {
        if (!writer.comma() or !writer.key("expectedDigest") or !writer.putString(digest)) return null;
    }
    if (!writer.put("}")) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 读一份文档上待裁决的提案。裁决台的行来自这一条。
pub fn readProposals(writer: *Writer, root_id: []const u8, path: []const u8) ?Request {
    writer.reset();
    if (!writer.open("readProposals")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 对一条提案下裁决：记进账本并暂存进批次。
///
/// `kind` 是 `VerdictKindName` 的 serde 拼写——**kebab-case**
/// （`accept-modified`），与相邻的 camelCase 字段不同。实测自 wire_shapes。
///
/// `final_text` 只有改写型裁决带；空切片表示不带（送 `null`），而不是送一个
/// 空字符串——「改成空」与「没有改写」是两件事。
pub fn stageVerdict(
    writer: *Writer,
    root_id: []const u8,
    path: []const u8,
    proposal_id: []const u8,
    kind: []const u8,
    final_text: []const u8,
    reason: []const u8,
) ?Request {
    writer.reset();
    if (!writer.open("stageVerdict")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.comma() or !writer.key("proposalId") or !writer.putString(proposal_id)) return null;
    if (!writer.comma() or !writer.key("kind") or !writer.putString(kind)) return null;
    if (!writer.comma() or !writer.key("finalText")) return null;
    if (final_text.len == 0) {
        if (!writer.put("null")) return null;
    } else if (!writer.putString(final_text)) return null;
    if (!writer.comma() or !writer.key("reason")) return null;
    if (reason.len == 0) {
        if (!writer.put("null")) return null;
    } else if (!writer.putString(reason)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 提交这份文档暂存的裁决批次。裁决即落盘（D1／F-01）。
pub fn commitVerdicts(writer: *Writer, root_id: []const u8, path: []const u8) ?Request {
    writer.reset();
    if (!writer.open("commitVerdicts")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 判了就落盘：记账与提交一次完成（`JudgeVerdict`）。
///
/// **接上哪个功能**：饭盒的 接受/退回/改后接受——判完即落盘，作者回到
/// 写作。与裁决台的 `stageVerdict` + `commitVerdicts` 两步分开：那是
/// 「先看看再一起落」，这是「判完就走」。
pub fn judgeVerdict(
    writer: *Writer,
    root_id: []const u8,
    path: []const u8,
    proposal_id: []const u8,
    kind: []const u8,
    final_text: []const u8,
    reason: []const u8,
) ?Request {
    writer.reset();
    if (!writer.open("judgeVerdict")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("path") or !writer.putString(path)) return null;
    if (!writer.comma() or !writer.key("proposalId") or !writer.putString(proposal_id)) return null;
    if (!writer.comma() or !writer.key("kind") or !writer.putString(kind)) return null;
    if (!writer.comma() or !writer.key("finalText")) return null;
    if (final_text.len == 0) {
        if (!writer.put("null")) return null;
    } else if (!writer.putString(final_text)) return null;
    if (!writer.comma() or !writer.key("reason")) return null;
    if (reason.len == 0) {
        if (!writer.put("null")) return null;
    } else if (!writer.putString(reason)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 收取一次派发的结果。产出还没出现时是 `waiting`，不是错误。
pub fn collectRun(writer: *Writer, root_id: []const u8, run_id: []const u8) ?Request {
    writer.reset();
    if (!writer.open("collectRun")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("runId") or !writer.putString(run_id)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 发射一条已授权的 Run（2.11）。
///
/// **接上哪个功能**：派发台与信箱 Run 行上的「开始」按钮——Run 铸成
/// （authorized）之后等的就是这一声发令枪。手动往返（L0）与接力/校验的
/// 第一棒都经它；工作区的组成归 Rust（`staging::run_workspace` 唯一权威），
/// 界面只点名 run，不拼路径。
///
/// **在全局逻辑中负责什么**：只派 Msg。「现在能不能发射」的状态门在
/// `project_view.runActions`（仅 authorized 显示按钮），合不合法归 host
/// 的具名拒绝（等上游、未授权）——两边不各判一次。
pub fn launchRun(writer: *Writer, root_id: []const u8, run_id: []const u8) ?Request {
    writer.reset();
    if (!writer.open("launchRun")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("runId") or !writer.putString(run_id)) return null;
    if (!writer.close()) return null;
    return writer.finish();
}

/// 推进 KARA 状态机。机器在 Rust（INV-10），跨界只送事件、取转移。
///
/// `KaraEvent` 与 `ProjectInput` 同一种标签形状（`kind`／`value`），无字段的
/// 变体只写 `kind`——多写一个空 `value` 会让 serde 具名拒绝整条请求。
pub fn karaStep(writer: *Writer, event: []const u8) ?Request {
    writer.reset();
    if (!writer.put("{\"kind\":\"karaStep\",\"value\":{\"kind\":\"")) return null;
    if (!writer.put(event) or !writer.put("\"}}")) return null;
    return writer.finish();
}

test "a verdict distinguishes 'no rewrite' from 'rewrite to empty'" {
    // `finalText` 是 `Option<String>`：null 是「这条裁决不带改写」，`""` 是
    // 「改成空字符串」。把前者送成后者，一条只留评论的裁决会被当成把整段
    // 删掉——而两条请求单看都合法。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"stageVerdict\",\"value\":{\"rootId\":\"r1\",\"path\":\"章.md\",\"proposalId\":\"p1\",\"kind\":\"accept\",\"finalText\":null,\"reason\":null}}",
        stageVerdict(&writer, "r1", "章.md", "p1", "accept", "", "").?.nowOrNever(),
    );
    // 改写型带正文与理由，且 kind 是 kebab-case（与相邻字段的 camelCase 不同）。
    try std.testing.expectEqualStrings(
        "{\"kind\":\"stageVerdict\",\"value\":{\"rootId\":\"r1\",\"path\":\"章.md\",\"proposalId\":\"p1\",\"kind\":\"accept-modified\",\"finalText\":\"改后的一段。\",\"reason\":\"语气\"}}",
        stageVerdict(&writer, "r1", "章.md", "p1", "accept-modified", "改后的一段。", "语气").?.nowOrNever(),
    );
}

test "the review round trip writes three separable requests" {
    // 读、判、提交是作者的三个动作，不是一个。合成一条会让「改主意」变成
    // 不可能——账本只增，写下去就只能再写一条逆向裁决。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"readProposals\",\"value\":{\"rootId\":\"r1\",\"path\":\"章.md\"}}",
        readProposals(&writer, "r1", "章.md").?.nowOrNever(),
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"commitVerdicts\",\"value\":{\"rootId\":\"r1\",\"path\":\"章.md\"}}",
        commitVerdicts(&writer, "r1", "章.md").?.nowOrNever(),
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"collectRun\",\"value\":{\"rootId\":\"r1\",\"runId\":\"run-7\"}}",
        collectRun(&writer, "r1", "run-7").?.nowOrNever(),
    );
}

test "each entry writes the tagged shape serde expects" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"chooseAndAdoptRoot\",\"value\":{\"kind\":\"folder\"}}",
        chooseAndAdoptRoot(&writer, true).?.nowOrNever(),
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"openDocument\",\"value\":{\"rootId\":\"r1\",\"path\":\"章.md\"}}",
        openDocument(&writer, "r1", "章.md").?.nowOrNever(),
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"readConfig\"}",
        readConfig(&writer).?.nowOrNever(),
    );
}

test "an empty page cursor asks for the first page instead of a page named empty" {
    // `after` 是 `Option<String>`：null 是第一页，`""` 是「游标为空串」——
    // 后者会让 Rust 从一个不存在的位置往后找，作者看到的是一棵空文件树。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"documentPage\",\"value\":{\"rootId\":\"r1\",\"after\":null}}",
        documentPage(&writer, "r1", "").?.nowOrNever(),
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"documentPage\",\"value\":{\"rootId\":\"r1\",\"after\":\"十.md\"}}",
        documentPage(&writer, "r1", "十.md").?.nowOrNever(),
    );
}

test "a quote in a title cannot rewrite the request around it" {
    // 不转义的话，一个带引号的标题会提前闭合 JSON 字符串，后面的字节就变成
    // 请求结构的一部分。这不是显示问题，是一条能改写请求含义的路径。
    var writer = Writer{};
    const written = createDocument(&writer, "r1", "他说\"走\"\n然后", "chapter").?.nowOrNever();
    try std.testing.expectEqualStrings(
        "{\"kind\":\"createDocument\",\"value\":{\"rootId\":\"r1\",\"title\":\"他说\\\"走\\\"\\n然后\",\"role\":\"chapter\"}}",
        written,
    );
    // 反斜杠自身也要转义，否则结尾的 `\` 会把闭合引号吃掉。
    const slash = createDocument(&writer, "r1", "路径\\", "chapter").?.nowOrNever();
    try std.testing.expectEqualStrings(
        "{\"kind\":\"createDocument\",\"value\":{\"rootId\":\"r1\",\"title\":\"路径\\\\\",\"role\":\"chapter\"}}",
        slash,
    );
}

test "a request larger than the ABI bound refuses instead of being truncated" {
    // 极值：超过 `event_text_bytes` 的请求被 Rust 具名拒绝。截断着送出去会
    // 变成一条语法坏掉的 JSON，作者读到的是「解码失败」而不是「太长了」。
    var writer = Writer{};
    var huge: [13000]u8 = undefined;
    @memset(&huge, 'x');
    try std.testing.expect(documentSearch(&writer, "r1", &huge, true) == null);
}

test "a run command carries its moment so the host stays replayable" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"hostCommand\",\"value\":{\"rootId\":\"r1\",\"command\":{\"cancelRun\":{\"run_id\":\"run-7\",\"at\":1200}}}}",
        hostRunCommand(&writer, "r1", "cancelRun", "run-7", 1200).?.nowOrNever(),
    );
    // 重试不带时刻：它开的是一个新 Run，时刻由那次授权决定。
    try std.testing.expectEqualStrings(
        "{\"kind\":\"hostCommand\",\"value\":{\"rootId\":\"r1\",\"command\":{\"retryRun\":{\"run_id\":\"run-7\"}}}}",
        hostRunCommand(&writer, "r1", "retryRun", "run-7", null).?.nowOrNever(),
    );
}

test "search names its precision rather than defaulting silently" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"blockSearch\",\"value\":{\"rootId\":\"r1\",\"query\":\"克制\",\"precision\":\"exact\"}}",
        blockSearch(&writer, "r1", "克制", true).?.nowOrNever(),
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"documentSearch\",\"value\":{\"rootId\":\"r1\",\"query\":\"克制\",\"precision\":\"loose\"}}",
        documentSearch(&writer, "r1", "克制", false).?.nowOrNever(),
    );
}

test "a request still says what it said after sixty-four more were encoded" {
    // F-01 的形状：字节住在模块级时，最早那一条被后来的覆写，而指着它的
    // `on_press` 仍然活着——作者点第一行，删掉的是别的文档。一屏 64 行的
    // 行菜单就编 256 条，所以这个数不是构造出来的极值。现在每个 writer 自带
    // 字节，“谁的字节”因此是一个作用域问题，不再是一个容量问题。
    var first_writer = Writer{};
    const first = openDocument(&first_writer, "r1", "第一.md").?.nowOrNever();
    var index: usize = 0;
    while (index < 64) : (index += 1) {
        var later = Writer{};
        _ = openDocument(&later, "r1", "后来.md");
    }
    try std.testing.expect(std.mem.indexOf(u8, first, "第一.md") != null);
}

test "what a view keeps outlives the writer that encoded it" {
    // 视图侧的真正危险：`Writer` 在栈上，而 `on_press` 到点击时才读。
    // `keep` 把字节搬进这一道 build 的 arena，所以栈帧死了它还在。
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    bindBuildArena(arena.allocator());
    defer bindBuildArena(null);
    const kept = keptElsewhere();
    try std.testing.expectEqualStrings(
        "{\"kind\":\"openDocument\",\"value\":{\"rootId\":\"r1\",\"path\":\"第一.md\"}}",
        kept.?,
    );
}

/// 编完就返回：字节如果还在 writer 里，这一段栈早已可以被下一个调用写掉。
fn keptElsewhere() ?[]const u8 {
    var writer = Writer{};
    const request = openDocument(&writer, "r1", "第一.md") orelse return null;
    return request.keep();
}

test "a build with nowhere to keep a request refuses instead of lending the stack" {
    bindBuildArena(null);
    var writer = Writer{};
    try std.testing.expect(openDocument(&writer, "r1", "第一.md").?.keep() == null);
    bindBuildArena(std.testing.failing_allocator);
    defer bindBuildArena(null);
    try std.testing.expect(openDocument(&writer, "r1", "第一.md").?.keep() == null);
}

test "reusing one writer does not leave the previous request behind" {
    // 近失手：忘了 reset 的话，第二条请求会拼在第一条后面，而两条单看都合法。
    var writer = Writer{};
    _ = openDocument(&writer, "r1", "一.md");
    try std.testing.expectEqualStrings(
        "{\"kind\":\"readHost\",\"value\":{\"rootId\":\"r2\"}}",
        readHost(&writer, "r2").?.nowOrNever(),
    );
}

test "a dispatch matches the two-layer camelCase serde asks for" {
    // 这条是逐字节对着 `wire_shapes.rs` 的实测输出写的，不是按规律推的。
    // 相邻的 `hostCommand` 字段保持 Rust 拼写（`run_id`），而这里两层都是
    // camelCase——按同一种规律猜，两处必有一处被静默拒绝。
    // 选区/攒段走 stash 槽位成一个文本 scope；委托的具名伙伴随请求过河
    // （审计 #7 修复后agent 字段在场），channel 由委托行定。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"dispatch\",\"value\":{\"rootId\":\"r1\",\"request\":{" ++
            "\"document\":\"章一.md\",\"prompt\":\"改克制些。\"," ++
            "\"scopes\":[{\"label\":\"s1\",\"before\":\"剑一直握在他手里。\"}]," ++
            "\"agents\":2,\"orchestration\":\"alternates\",\"persona\":null,\"channel\":\"harness\",\"resultPath\":\"result.md\",\"maxBytes\":65536," ++
            "\"agent\":\"a1\"}}}",
        dispatchDesk(
            &writer,
            "r1",
            "章一.md",
            "改克制些。",
            null,
            "剑一直握在他手里。",
            2,
            "alternates",
            "",
            &.{},
            "a1",
            "harness",
            null,
            "dispatch",
        ).?.nowOrNever(),
    );
}

test "a manual dispatch carries no agent and the manual channel" {
    // 手动往返（L0）：没有具名伙伴时 channel 是 manual、agent 字段缺席——
    // 身份随请求走，不点名。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"previewDispatch\",\"value\":{\"rootId\":\"r1\",\"request\":{" ++
            "\"document\":\"章一.md\",\"prompt\":\"改。\"," ++
            "\"scopes\":[{\"label\":\"s1\",\"before\":\"一段。\"}]," ++
            "\"agents\":1,\"orchestration\":\"alternates\",\"persona\":null,\"channel\":\"manual\",\"resultPath\":\"result.md\",\"maxBytes\":65536}}}",
        dispatchDesk(
            &writer,
            "r1",
            "章一.md",
            "改。",
            null,
            "一段。",
            1,
            "alternates",
            "",
            &.{},
            "",
            "manual",
            null,
            "previewDispatch",
        ).?.nowOrNever(),
    );
}

test "a scope carrying a quotation mark is escaped, not truncated" {
    // 作者选的正文里有引号是常事（对话）。不转义会让 JSON 在那里断掉，
    // 而 Rust 那边收到的是一个语法错误——界面上表现为「派发没反应」。
    var writer = Writer{};
    const request = dispatchDesk(
        &writer,
        "r1",
        "章一.md",
        "改。",
        null,
        "他说「走」，然后\"停\"了。",
        1,
        "alternates",
        "",
        &.{},
        "",
        "manual",
        null,
        "dispatch",
    ).?;
    try std.testing.expect(std.mem.indexOf(u8, request.nowOrNever(), "\\\"停\\\"") != null);
}

test "a typographic adjustment matches the three nested camelCase layers" {
    // 三层各有各的口径，逐字节对着 `wire_shapes.rs` 的实测输出写。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"changeConfig\",\"value\":{\"adjustTypography\":{\"field\":\"textSize\",\"delta\":10}}}",
        adjustTypography(&writer, "textSize", 10).?.nowOrNever(),
    );
}

test "a persona toggle names the agent by a bare id string" {
    // `Id` 是 serde transparent：裸字符串，不是 `{"0": "..."}`。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"changeConfig\",\"value\":{\"toggleAgentPersona\":\"00000000-0000-0000-0000-000000000001\"}}",
        toggleAgentPersona(&writer, "00000000-0000-0000-0000-000000000001").?.nowOrNever(),
    );
}

test "a negative adjustment keeps its sign" {
    // 「小一点」是负增量。丢掉负号，每个按钮都变成放大——而两个按钮
    // 都「有反应」，作者要按好几次才发现小的那个也在放大。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"changeConfig\",\"value\":{\"adjustTypography\":{\"field\":\"lineHeight\",\"delta\":-5}}}",
        adjustTypography(&writer, "lineHeight", -5).?.nowOrNever(),
    );
}

test "a highlight sends a null body rather than omitting the key" {
    // 省略 `body`，serde 拒绝整条请求——而界面上作者看到的只是「标不上」。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"annotate\",\"value\":{\"rootId\":\"r1\",\"path\":\"章一.md\"," ++
            "\"selected\":\"剑\",\"body\":null}}",
        annotate(&writer, "r1", "章一.md", "剑", "").?.nowOrNever(),
    );
}

test "a comment carries its body as a string" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"annotate\",\"value\":{\"rootId\":\"r1\",\"path\":\"章一.md\"," ++
            "\"selected\":\"剑\",\"body\":\"太满了\"}}",
        annotate(&writer, "r1", "章一.md", "剑", "太满了").?.nowOrNever(),
    );
}

test "a kara event names the camelCase variant serde expects" {
    // 无字段变体只写 `kind`，多一个空 `value` 会被具名拒绝。事件名写成
    // `manual-toggle` 或 `ManualToggle` 同样被拒——而界面上作者看到的
    // 只是「切换按钮没反应」。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"karaStep\",\"value\":{\"kind\":\"manualToggle\"}}",
        karaStep(&writer, "manualToggle").?.nowOrNever(),
    );
}

test "a mailbox read names the Root and the page" {
    // `discarded` 是结构字段：false 也写进 value——省略键会被 serde
    // 具名拒绝，而界面上作者看到的只是「回收站页签读不出来」。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"readMailbox\",\"value\":{\"rootId\":\"r1\",\"discarded\":false}}",
        readMailbox(&writer, "r1", false).?.nowOrNever(),
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"readMailbox\",\"value\":{\"rootId\":\"r1\",\"discarded\":true}}",
        readMailbox(&writer, "r1", true).?.nowOrNever(),
    );
}

test "a mailbox pin carries the entry's own box in kebab-case" {
    // 格名是 kebab-case（`MailboxBoxName` 的口径），与相邻 camelCase 的
    // `boxName` 键并排——写成 `unRead` 会得到一条被具名拒绝的请求。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"mailboxPin\",\"value\":{\"rootId\":\"r1\",\"entryId\":\"p1\",\"boxName\":\"unread\",\"pinned\":true}}",
        mailboxPin(&writer, "r1", "p1", "unread", true).?.nowOrNever(),
    );
}

test "a mailbox discard names the entry and its box" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"mailboxDiscard\",\"value\":{\"rootId\":\"r1\",\"entryId\":\"p1\",\"boxName\":\"done\"}}",
        mailboxDiscard(&writer, "r1", "p1", "done").?.nowOrNever(),
    );
}

test "a countermand wraps the one pointed entry in an array" {
    // 领域形状是「一批」，界面一次指着一封——一元数组是两边的合约。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"countermand\",\"value\":{\"rootId\":\"r1\",\"path\":\"章.md\",\"proposalIds\":[\"p1\"]}}",
        countermand(&writer, "r1", "章.md", "p1").?.nowOrNever(),
    );
}
