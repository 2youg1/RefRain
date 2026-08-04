//! 产品入口的写法：一次点击变成一条 `ProjectInput`。
//!
//! **接上哪个功能**：作者能做的每一件跨界的事——打开项目、翻文件树、开文档、
//! 新建、导入、删除、搜索、改设置、推进 KARA、对选中的 Run 下命令。
//!
//! **在全局逻辑中负责什么**：只编码，不决定。「现在能不能点」归 `core.ts` 的
//! `navigate` 与 `roster.ts` 的游标不变量；「这条命令合不合法」归 Rust 的具名
//! 拒绝。这一层若也判一次，就会出现「界面允许点、Rust 又拒绝」的两份规矩。
//!
//! **为什么在 Zig 而不在 core.ts**：请求要带作者选的路径与查询词，而 core 子集
//! 不能拼接字符串（NS9001：无插值模板字面量，字符串编成定长数组）。`ChangeConfig`
//! 那类定值请求仍留在 core.ts 的常量表里——它们不带变量。
//!
//! **能复用什么**：一个入口一个函数，共用 `Writer`。新增入口只加一个函数，
//! 通道、协议、action 都不动——`project_request` 已经是完整的跨界入口。

const std = @import("std");

/// 一条编好的请求，连同它借用的缓冲。
///
/// 定长缓冲而不是分配：请求受 ABI 上限约束（`event_text_bytes`），而视图每帧
/// 都可能编一条。缓冲住在调用者的栈上，请求出不了那一帧——正是它的寿命。
pub const Request = struct {
    bytes: []const u8,
};

/// 编码用的定长缓冲。
///
/// 12 KiB 与协议的 `event_text_bytes` 同源：超过它 Rust 会具名拒绝，所以这里
/// 装不下就交出 null，让调用方显示一条拒绝，而不是送一条会被截断的请求。
pub const Writer = struct {
    buffer: [12000]u8 = undefined,
    len: usize = 0,

    /// 重新开始编一条请求。
    pub fn reset(self: *Writer) void {
        self.len = 0;
    }

    fn put(self: *Writer, bytes: []const u8) bool {
        if (self.len + bytes.len > self.buffer.len) return false;
        @memcpy(self.buffer[self.len..][0..bytes.len], bytes);
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
        return .{ .bytes = self.buffer[0..self.len] };
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
pub fn readHarnesses(writer: *Writer) ?Request {
    writer.reset();
    if (!writer.put("{\"kind\":\"readHarnesses\"}")) return null;
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

/// 派发一次改写请求：选中的范围 → 冻结的请求 → 若干个就绪的 Run。
///
/// **接上哪个功能**：派发去处的「送出去」。三步（起任务、授权、铸 Run）
/// 收在 Rust 的 `refrain_app::dispatch` 里——中间两步各要上一步生成的东西，
/// 这边拼不出来，拼了也只是把领域顺序复制一份。
///
/// **口径**：外层 `ProjectInput` 是 camelCase，`DispatchRequest` 自己也标了
/// camelCase，所以 `resultPath`／`maxBytes` 两个词都要驼峰——与相邻的
/// `hostCommand`（字段保持 Rust 拼写 `run_id`）**正好相反**。这不是可以按
/// 规律推的，`verify:wire-shapes` 逐字节守着它。
///
/// 一次只送一个范围：多范围要作者能在界面上框出好几段，而那要先有就地
/// 多选。少一个参数好过留一个永远只传一个元素的数组。
pub fn dispatchScope(
    writer: *Writer,
    root_id: []const u8,
    document: []const u8,
    prompt: []const u8,
    label: []const u8,
    before: []const u8,
    agents: u64,
    orchestration: []const u8,
    result_path: []const u8,
    max_bytes: u64,
) ?Request {
    writer.reset();
    if (!writer.open("dispatch")) return null;
    if (!writer.key("rootId") or !writer.putString(root_id)) return null;
    if (!writer.comma() or !writer.key("request")) return null;
    if (!writer.put("{")) return null;
    if (!writer.key("document") or !writer.putString(document)) return null;
    if (!writer.comma() or !writer.key("prompt") or !writer.putString(prompt)) return null;
    if (!writer.comma() or !writer.key("scopes") or !writer.put("[{")) return null;
    if (!writer.key("label") or !writer.putString(label)) return null;
    if (!writer.comma() or !writer.key("before") or !writer.putString(before)) return null;
    if (!writer.put("}]")) return null;
    if (!writer.comma() or !writer.key("agents") or !writer.putNumber(agents)) return null;
    // 排法是 kebab-case（`alternates`／`follows`／`verifies`）——同一份请求里
    // 相邻的键是 camelCase，两种口径并存，`verify:wire-shapes` 守着它。
    if (!writer.comma() or !writer.key("orchestration") or !writer.putString(orchestration)) return null;
    // persona 与 channel：身份由 `AGENTS.md` 承载（D14），所以这里写
    // `null` 并声明走 harness 通道——两条路同时携带身份全文，会让同一份
    // 身份投递两次，此后各自漂移。写死 `null` 而不是省略这个键：serde
    // 要求它在场，省略会被静默拒绝，界面上表现为「派发按钮没反应」。
    if (!writer.comma() or !writer.key("persona") or !writer.put("null")) return null;
    if (!writer.comma() or !writer.key("channel") or !writer.putString("harness")) return null;
    if (!writer.comma() or !writer.key("resultPath") or !writer.putString(result_path)) return null;
    if (!writer.comma() or !writer.key("maxBytes") or !writer.putNumber(max_bytes)) return null;
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

/// 收取一次派发的结果。产出还没出现时是 `waiting`，不是错误。
pub fn collectRun(writer: *Writer, root_id: []const u8, run_id: []const u8) ?Request {
    writer.reset();
    if (!writer.open("collectRun")) return null;
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
        stageVerdict(&writer, "r1", "章.md", "p1", "accept", "", "").?.bytes,
    );
    // 改写型带正文与理由，且 kind 是 kebab-case（与相邻字段的 camelCase 不同）。
    try std.testing.expectEqualStrings(
        "{\"kind\":\"stageVerdict\",\"value\":{\"rootId\":\"r1\",\"path\":\"章.md\",\"proposalId\":\"p1\",\"kind\":\"accept-modified\",\"finalText\":\"改后的一段。\",\"reason\":\"语气\"}}",
        stageVerdict(&writer, "r1", "章.md", "p1", "accept-modified", "改后的一段。", "语气").?.bytes,
    );
}

test "the review round trip writes three separable requests" {
    // 读、判、提交是作者的三个动作，不是一个。合成一条会让「改主意」变成
    // 不可能——账本只增，写下去就只能再写一条逆向裁决。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"readProposals\",\"value\":{\"rootId\":\"r1\",\"path\":\"章.md\"}}",
        readProposals(&writer, "r1", "章.md").?.bytes,
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"commitVerdicts\",\"value\":{\"rootId\":\"r1\",\"path\":\"章.md\"}}",
        commitVerdicts(&writer, "r1", "章.md").?.bytes,
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"collectRun\",\"value\":{\"rootId\":\"r1\",\"runId\":\"run-7\"}}",
        collectRun(&writer, "r1", "run-7").?.bytes,
    );
}

test "each entry writes the tagged shape serde expects" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"chooseAndAdoptRoot\",\"value\":{\"kind\":\"folder\"}}",
        chooseAndAdoptRoot(&writer, true).?.bytes,
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"openDocument\",\"value\":{\"rootId\":\"r1\",\"path\":\"章.md\"}}",
        openDocument(&writer, "r1", "章.md").?.bytes,
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"readConfig\"}",
        readConfig(&writer).?.bytes,
    );
}

test "an empty page cursor asks for the first page instead of a page named empty" {
    // `after` 是 `Option<String>`：null 是第一页，`""` 是「游标为空串」——
    // 后者会让 Rust 从一个不存在的位置往后找，作者看到的是一棵空文件树。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"documentPage\",\"value\":{\"rootId\":\"r1\",\"after\":null}}",
        documentPage(&writer, "r1", "").?.bytes,
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"documentPage\",\"value\":{\"rootId\":\"r1\",\"after\":\"十.md\"}}",
        documentPage(&writer, "r1", "十.md").?.bytes,
    );
}

test "a quote in a title cannot rewrite the request around it" {
    // 不转义的话，一个带引号的标题会提前闭合 JSON 字符串，后面的字节就变成
    // 请求结构的一部分。这不是显示问题，是一条能改写请求含义的路径。
    var writer = Writer{};
    const written = createDocument(&writer, "r1", "他说\"走\"\n然后", "chapter").?.bytes;
    try std.testing.expectEqualStrings(
        "{\"kind\":\"createDocument\",\"value\":{\"rootId\":\"r1\",\"title\":\"他说\\\"走\\\"\\n然后\",\"role\":\"chapter\"}}",
        written,
    );
    // 反斜杠自身也要转义，否则结尾的 `\` 会把闭合引号吃掉。
    const slash = createDocument(&writer, "r1", "路径\\", "chapter").?.bytes;
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
        hostRunCommand(&writer, "r1", "cancelRun", "run-7", 1200).?.bytes,
    );
    // 重试不带时刻：它开的是一个新 Run，时刻由那次授权决定。
    try std.testing.expectEqualStrings(
        "{\"kind\":\"hostCommand\",\"value\":{\"rootId\":\"r1\",\"command\":{\"retryRun\":{\"run_id\":\"run-7\"}}}}",
        hostRunCommand(&writer, "r1", "retryRun", "run-7", null).?.bytes,
    );
}

test "search names its precision rather than defaulting silently" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"blockSearch\",\"value\":{\"rootId\":\"r1\",\"query\":\"克制\",\"precision\":\"exact\"}}",
        blockSearch(&writer, "r1", "克制", true).?.bytes,
    );
    try std.testing.expectEqualStrings(
        "{\"kind\":\"documentSearch\",\"value\":{\"rootId\":\"r1\",\"query\":\"克制\",\"precision\":\"loose\"}}",
        documentSearch(&writer, "r1", "克制", false).?.bytes,
    );
}

test "reusing one writer does not leave the previous request behind" {
    // 近失手：忘了 reset 的话，第二条请求会拼在第一条后面，而两条单看都合法。
    var writer = Writer{};
    _ = openDocument(&writer, "r1", "一.md");
    try std.testing.expectEqualStrings(
        "{\"kind\":\"readHost\",\"value\":{\"rootId\":\"r2\"}}",
        readHost(&writer, "r2").?.bytes,
    );
}

test "a dispatch matches the two-layer camelCase serde asks for" {
    // 这条是逐字节对着 `wire_shapes.rs` 的实测输出写的，不是按规律推的。
    // 相邻的 `hostCommand` 字段保持 Rust 拼写（`run_id`），而这里两层都是
    // camelCase——按同一种规律猜，两处必有一处被静默拒绝。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"dispatch\",\"value\":{\"rootId\":\"r1\",\"request\":{" ++
            "\"document\":\"章一.md\",\"prompt\":\"改克制些。\"," ++
            "\"scopes\":[{\"label\":\"s1\",\"before\":\"剑一直握在他手里。\"}]," ++
            "\"agents\":2,\"orchestration\":\"alternates\",\"persona\":null,\"channel\":\"harness\",\"resultPath\":\"result.md\",\"maxBytes\":65536}}}",
        dispatchScope(
            &writer,
            "r1",
            "章一.md",
            "改克制些。",
            "s1",
            "剑一直握在他手里。",
            2,
            "alternates",
            "result.md",
            65536,
        ).?.bytes,
    );
}

test "a scope carrying a quotation mark is escaped, not truncated" {
    // 作者选的正文里有引号是常事（对话）。不转义会让 JSON 在那里断掉，
    // 而 Rust 那边收到的是一个语法错误——界面上表现为「派发没反应」。
    var writer = Writer{};
    const request = dispatchScope(
        &writer,
        "r1",
        "章一.md",
        "改。",
        "s1",
        "他说「走」，然后\"停\"了。",
        1,
        "alternates",
        "result.md",
        1024,
    ).?;
    try std.testing.expect(std.mem.indexOf(u8, request.bytes, "\\\"停\\\"") != null);
}

test "a typographic adjustment matches the three nested camelCase layers" {
    // 三层各有各的口径，逐字节对着 `wire_shapes.rs` 的实测输出写。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"changeConfig\",\"value\":{\"adjustTypography\":{\"field\":\"textSize\",\"delta\":10}}}",
        adjustTypography(&writer, "textSize", 10).?.bytes,
    );
}

test "a negative adjustment keeps its sign" {
    // 「小一点」是负增量。丢掉负号，每个按钮都变成放大——而两个按钮
    // 都「有反应」，作者要按好几次才发现小的那个也在放大。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"changeConfig\",\"value\":{\"adjustTypography\":{\"field\":\"lineHeight\",\"delta\":-5}}}",
        adjustTypography(&writer, "lineHeight", -5).?.bytes,
    );
}

test "a highlight sends a null body rather than omitting the key" {
    // 省略 `body`，serde 拒绝整条请求——而界面上作者看到的只是「标不上」。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"annotate\",\"value\":{\"rootId\":\"r1\",\"path\":\"章一.md\"," ++
            "\"selected\":\"剑\",\"body\":null}}",
        annotate(&writer, "r1", "章一.md", "剑", "").?.bytes,
    );
}

test "a comment carries its body as a string" {
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"annotate\",\"value\":{\"rootId\":\"r1\",\"path\":\"章一.md\"," ++
            "\"selected\":\"剑\",\"body\":\"太满了\"}}",
        annotate(&writer, "r1", "章一.md", "剑", "太满了").?.bytes,
    );
}

test "a kara event names the camelCase variant serde expects" {
    // 无字段变体只写 `kind`，多一个空 `value` 会被具名拒绝。事件名写成
    // `manual-toggle` 或 `ManualToggle` 同样被拒——而界面上作者看到的
    // 只是「切换按钮没反应」。
    var writer = Writer{};
    try std.testing.expectEqualStrings(
        "{\"kind\":\"karaStep\",\"value\":{\"kind\":\"manualToggle\"}}",
        karaStep(&writer, "manualToggle").?.bytes,
    );
}
