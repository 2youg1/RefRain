/**
 * Two languages, one dictionary. Kept as a flat map rather than nested objects
 * so a missing key is a type error rather than a runtime `undefined` rendered
 * into the interface.
 */

export type Lang = "zh" | "en";

export const dict = {
  "app.tagline": {
    zh: "校勘——多个抄本送到面前，由一个人裁决，裁决被记录下来。",
    en: "Collation — competing readings, one human judge, a recorded judgment.",
  },
  "welcome.hint": { zh: "随时按 Ctrl K 唤出全部命令", en: "Ctrl K brings up every command" },
  "welcome.open": { zh: "打开文件夹", en: "Open folder" },
  "welcome.openFile": { zh: "打开单个文件", en: "Open a file" },
  "welcome.create": { zh: "新建项目", en: "New project" },
  "welcome.drop": { zh: "或把文件夹拖进这里", en: "or drop a folder here" },
  "welcome.fine": {
    zh: "项目就是一个装着 Markdown 文件的普通文件夹。不联网、不上传、无需账号。",
    en: "A project is a plain folder of Markdown files. No network, no upload, no account.",
  },
  "welcome.recent": { zh: "最近", en: "Recent" },

  "palette.placeholder": {
    zh: "输入命令，或按 ? 看全部",
    en: "Type a command, or press ? for all",
  },
  "palette.empty": { zh: "没有匹配的命令", en: "No matching command" },
  "palette.hint": { zh: "Ctrl K 唤出命令", en: "Ctrl K for commands" },

  "cmd.open": { zh: "打开项目…", en: "Open project…" },
  "cmd.create": { zh: "新建项目…", en: "New project…" },
  "cmd.newChapter": { zh: "新建章节…", en: "New chapter…" },
  "cmd.save": { zh: "保存", en: "Save" },
  "cmd.zen": { zh: "禅模式", en: "Zen mode" },
  "cmd.dispatch": { zh: "交给 Agent…", en: "Send to an agent…" },
  "cmd.review": { zh: "审阅提案", en: "Review proposals" },
  "cmd.ledger": { zh: "裁决账本", en: "Verdict ledger" },
  "cmd.agents": { zh: "管理 Agent…", en: "Manage agents…" },
  "cmd.typography": { zh: "排版…", en: "Typography…" },
  "cmd.settings": { zh: "设置…", en: "Settings…" },
  "cmd.theme": { zh: "切换明暗", en: "Toggle theme" },
  "cmd.chapters": { zh: "跳到章节…", en: "Go to chapter…" },

  "group.project": { zh: "项目", en: "Project" },
  "group.write": { zh: "写作", en: "Writing" },
  "group.collab": { zh: "协作", en: "Collaboration" },
  "group.view": { zh: "视图", en: "View" },

  "zen.exit": { zh: "Esc 退出禅模式", en: "Esc to leave Zen" },

  "typo.title": { zh: "排版", en: "Typography" },
  "typo.family": { zh: "字体", en: "Typeface" },
  "typo.serif": { zh: "衬线", en: "Serif" },
  "typo.sans": { zh: "无衬线", en: "Sans" },
  "typo.mono": { zh: "等宽", en: "Mono" },
  "typo.size": { zh: "字号", en: "Size" },
  "typo.leading": { zh: "行距", en: "Leading" },
  "typo.tracking": { zh: "字距", en: "Tracking" },
  "typo.measure": { zh: "版心", en: "Measure" },
  "typo.grid": { zh: "基线网格", en: "Baseline grid" },
  "typo.gridOff": { zh: "关", en: "Off" },
  "typo.display": { zh: "标题体", en: "Display" },
  "typo.weight": { zh: "字重", en: "Weight" },
  "typo.wordSpacing": { zh: "词距", en: "Word spacing" },
  "typo.indent": { zh: "首行缩进", en: "First-line indent" },
  "typo.paraSpacing": { zh: "段距", en: "Paragraph spacing" },
  "typo.marginTop": { zh: "上边距", en: "Top margin" },
  "typo.marginBottom": { zh: "下边距", en: "Bottom margin" },
  "typo.align": { zh: "对齐", en: "Alignment" },
  "typo.alignLeft": { zh: "左对齐", en: "Left" },
  "typo.alignJustify": { zh: "两端对齐", en: "Justified" },
  "typo.gridEvery": { zh: "每", en: "every" },
  "typo.everyN": { zh: "行", en: "lines" },
  "typo.none": { zh: "无", en: "none" },
  "typo.reset": { zh: "恢复默认", en: "Reset to defaults" },
  "typo.cjk": { zh: "中文字体", en: "Chinese face" },
  "typo.latin": { zh: "西文字体", en: "Latin face" },
  "typo.system": { zh: "系统字体", en: "Installed on this machine" },
  "typo.searchFont": { zh: "搜索字体…", en: "Search fonts…" },
  "typo.systemHint": {
    zh: "点击即用作中文字体。西文字体请在上方输入名称。",
    en: "Click to use as the Chinese face. Type a name above for the Latin face.",
  },
  "typo.typeName": { zh: "或直接输入字体名", en: "or type a font name" },
  "typo.chars": { zh: "字", en: "ch" },
  "typo.lineNumbers": { zh: "行号", en: "Line numbers" },
  "typo.breathe": { zh: "段落呼吸", en: "Breathing" },
  "typo.breatheHint": {
    zh: "正在写的那一段保持全墨，其余稍稍退后。不是遮蔽，是靠近。",
    en: "The paragraph you are in holds full ink; the others step back a little. Not a blackout — a lean.",
  },
  "typo.progress": { zh: "进度条", en: "Progress" },
  "typo.gradient": { zh: "渐变", en: "Gradient" },
  "typo.solid": { zh: "纯色", en: "Solid" },
  "typo.minimap": { zh: "小地图", en: "Minimap" },
  "typo.top": { zh: "顶部", en: "Top" },
  "typo.right": { zh: "右侧", en: "Right" },
  "typo.customPlaceholder": {
    zh: "或输入你系统里的字体名，例如 方正书宋",
    en: "or name a font from your own library",
  },
  "typo.preview": {
    zh: "夜色从窗缝里渗进来，纸上的字迹开始发沉。",
    en: "The measure of a line is the measure of a thought.",
  },

  "set.title": { zh: "设置", en: "Settings" },
  "set.language": { zh: "语言", en: "Language" },
  "set.theme": { zh: "主题", en: "Theme" },
  "set.ai": { zh: "雨", en: "Rain" },
  "set.kozo": { zh: "楮", en: "Kōzo" },
  "set.ink": { zh: "夜", en: "Night" },
  "set.about": { zh: "关于", en: "About" },
  "set.appearance": { zh: "外观", en: "Appearance" },
  "set.editor": { zh: "编辑器", en: "Editor" },
  "set.shortcuts": { zh: "快捷键", en: "Shortcuts" },
  "theme.tou": { zh: "濤", en: "Tou" },
  "theme.kasumi": { zh: "霞", en: "Kasumi" },
  "theme.kare": { zh: "枯", en: "Kare" },
  "theme.hayashi": { zh: "林", en: "Hayashi" },
  "theme.seiji": { zh: "瓷", en: "Seiji" },
  "theme.sumi": { zh: "墨", en: "Sumi" },
  "theme.yu": { zh: "幽", en: "Yū" },
  "theme.shigure": { zh: "時雨", en: "Shigure" },
  "set.day": { zh: "日间", en: "Day" },
  "set.night": { zh: "夜间", en: "Night" },

  "set.surface": { zh: "窗口质感", en: "Surface" },
  "set.sei": { zh: "晴", en: "Clear" },
  "set.moya": { zh: "靄", en: "Haze" },
  "set.kasa": { zh: "傘", en: "Umbrella" },
  "set.garasu": { zh: "硝子", en: "Glass" },
  "set.surfaceHint": {
    zh: "面板与菜单的底色。玻璃在深色主题下最明显。",
    en: "How panels and menus are filled. Glass shows most in the dark theme.",
  },
  "set.sheet": { zh: "纸面", en: "Sheet" },
  "set.sheetNone": { zh: "无纸", en: "None" },
  "set.sheetHairline": { zh: "细边半透", en: "Hairline" },
  "set.sheetPaper": { zh: "白纸", en: "Paper" },
  "set.sheetHint": {
    zh: "默认无纸——正文直接落在台面上，最不刺眼。想要页面边界时再打开。",
    en: "None by default: the text sits on the desk, which is easiest on the eye. Turn on a sheet when you want the page boundary.",
  },
  "set.layout": { zh: "版式", en: "Layout" },
  "set.page": { zh: "书页", en: "Page" },
  "set.canvas": { zh: "画布", en: "Canvas" },
  "set.layoutHint": {
    zh: "书页：一次一章，像一本书。画布式排布还没做，标点的那一项即是。",
    en: "Page: one chapter at a time, like a book. The canvas layout is not built yet — the dotted option is it.",
  },
  "set.icon": { zh: "万能按钮图标", en: "Key button icon" },
  "set.iconPick": { zh: "选一张图片", en: "Choose a picture" },
  "set.iconReset": { zh: "用回印章", en: "Back to the seal" },
  "set.iconHint": {
    zh: "任意图片都可以。它只存在本机。",
    en: "Any picture. It stays on this machine.",
  },
  "set.fonts": {
    zh: "内置五款 SIL 开放字体协议字体：Chiron Sung HK、Antic Didone、Jost、Murecho、Courier Prime。",
    en: "Five bundled typefaces under the SIL Open Font License: Chiron Sung HK, Antic Didone, Jost, Murecho, Courier Prime.",
  },
  "set.noNetwork": {
    zh: "此程序不发出任何网络请求，不收集任何数据。",
    en: "This application makes no network requests and collects nothing.",
  },
  "set.repo": { zh: "源码仓库", en: "Source repository" },
  "set.issues": { zh: "报告缺陷", en: "Report a defect" },
  "set.discussions": { zh: "讨论区", en: "Discussions" },
  "set.licence": { zh: "开源协议 GPL-3.0", en: "Licence · GPL-3.0" },
  "set.openExternal": {
    zh: "以下链接在系统浏览器中打开；程序自身仍不发出任何请求。",
    en: "These open in your system browser; the application itself still makes no requests.",
  },

  "list.join": { zh: "、", en: ", " },
  "conflict.title": {
    zh: "这个文件在别处被改过了",
    en: "This file was changed somewhere else",
  },
  "conflict.body": {
    zh: "自本次打开以来，磁盘上的内容变了。两个版本都在，由你决定留哪一个。",
    en: "The file on disk changed since this session opened it. Both versions exist; you decide which stays.",
  },
  // Distinct labels: identical ones are ambiguous under a screen reader, in
  // keyboard focus, and in the memory of what you just pressed.
  "conflict.mine": { zh: "留下我这边的", en: "Keep mine" },
  "conflict.theirs": { zh: "留下磁盘上的", en: "Keep the file's" },
  // Parallel phrasing, both naming the action and the loss. An asymmetric pair
  // makes one option read as gentler than it is.
  "conflict.mineCost": {
    zh: "写入磁盘，覆盖别处那次改动",
    en: "Writes to disk, discarding the other edit",
  },
  "conflict.theirsCost": {
    zh: "载入磁盘内容，丢弃本次未保存的输入",
    en: "Loads the file, discarding what you typed",
  },
  "conflict.later": { zh: "先不决定", en: "Decide later" },
  "conflict.postponed": {
    zh: "还没保存。你这边的文字仍在编辑器里。",
    en: "Not saved. Your text is still in the editor.",
  },
  "conflict.mineLabel": { zh: "我这边（未保存）", en: "Mine, unsaved" },
  "conflict.theirsLabel": { zh: "磁盘上的", en: "On disk" },
  "conflict.stillChanging": {
    zh: "文件还在被改动，没有保存。请先看一眼那个文件。",
    en: "The file is still changing; nothing was saved. Take a look at it first.",
  },
  "files.noTrashHere": {
    zh: "这个位置没有回收站，此处无法安全删除。",
    en: "This location has no trash, so nothing here can be deleted safely.",
  },
  "files.trashViaHome": { zh: "移到系统回收站", en: "Move it to the system trash" },
  "files.noTrashAnywhere": {
    zh: "系统回收站也不可用，文件留在原处：",
    en: "The system trash is unavailable too; these stayed where they were: ",
  },
  "files.keepHere": { zh: "留在原处", en: "Leave it" },

  "review.acceptAll": { zh: "全部接受", en: "Accept all" },
  "review.rejectAll": { zh: "全部退回", en: "Refuse all" },

  "agents.title": { zh: "Agent", en: "Agents" },

  "persona.why": {
    zh: "给这个 Agent 一个身份。同一个 harness、同一个模型，靠不同身份就是不同的协作者。",
    en: "Give this agent an identity. The same harness and model, under different briefs, are different collaborators.",
  },
  "persona.unnamed": { zh: "未命名", en: "Unnamed" },
  "persona.namePlaceholder": { zh: "身份名字", en: "Identity name" },
  "persona.briefPlaceholder": {
    zh: "它该做什么、不该做什么。写你自己的话。",
    en: "What it should and should not do, in your own words.",
  },
  "persona.carryLabel": { zh: "何时随请求发送", en: "When it travels" },
  "persona.carry.first-round": { zh: "只发第一轮", en: "First round only" },
  "persona.carry.every-round": { zh: "每轮都发", en: "Every round" },
  "persona.carry.never": { zh: "不发", en: "Never" },
  "persona.cost": { zh: "长度", en: "Length" },
  "persona.chars": { zh: "字", en: "chars" },
  "agents.name": { zh: "名字", en: "Name" },
  "agents.command": { zh: "启动命令", en: "Launch command" },
  "agents.commandHint": {
    zh: "留空则用文件通道：程序写出 request.md，你交给任何 Agent，再把回复贴回 result.md。",
    en: "Leave empty for the file channel: the app writes request.md, you hand it to any agent, and paste the reply into result.md.",
  },
  "agents.placeholderCmd": {
    zh: "例如 codex exec --file {request}",
    en: "e.g. codex exec --file {request}",
  },
  "agents.add": { zh: "建立", en: "Create" },
  "agents.none": {
    zh: "还没有 Agent。任何能读写文件的都可以。",
    en: "No agents yet. Anything that can read and write a file will do.",
  },
  "agents.fileChannel": { zh: "文件通道", en: "file channel" },
  "agents.connect": { zh: "连接一个 Agent", en: "Connect an agent" },
  "agents.ready": { zh: "已连接", en: "connected" },
  "agents.checking": { zh: "检测中", en: "checking" },
  "agents.unreachable": { zh: "连不上", en: "unreachable" },
  "agents.file": { zh: "文件通道", en: "file channel" },
  "agents.recheck": { zh: "重新检测", en: "Check again" },
  "agents.remove": { zh: "移除", en: "Remove" },
  "agents.presets": { zh: "常见 Harness", en: "Known harnesses" },
  "agents.fileExplains": {
    zh: "最省事的方式是文件通道：程序把请求写成 request.md，你交给任何 Agent，再把回复贴回 result.md。不需要命令，也不需要联网。",
    en: "The simplest path is the file channel: the app writes request.md, you hand it to any agent, and paste the reply into result.md. No command, no network.",
  },

  "dispatch.title": { zh: "交给 Agent", en: "Send to an agent" },
  "dispatch.selection": { zh: "选中的文字", en: "Selected text" },
  "dispatch.noSelection": {
    zh: "先在正文里选一段。它是 Agent 唯一能改写的范围。",
    en: "Select a passage first. It is the only range an agent may rewrite.",
  },
  "dispatch.who": { zh: "交给谁", en: "To whom" },
  "dispatch.prompt": { zh: "要求", en: "Instruction" },
  "dispatch.promptPlaceholder": {
    zh: "例如：把这段改得更冷，不要解释情绪。",
    en: "e.g. make this colder; do not explain the feeling.",
  },
  "dispatch.queue": { zh: "加入待发", en: "Queue it" },
  "dispatch.send": { zh: "一次送出全部", en: "Send everything, once" },
  "dispatch.manifest": { zh: "待发清单", en: "Send manifest" },
  "dispatch.runs": { zh: "次运行", en: "runs" },
  "dispatch.noPrice": {
    zh: "此处不显示价格。本程序不做任何计费换算。",
    en: "No prices here. This application performs no billing math.",
  },
  "dispatch.drifted": {
    zh: "正文已变动，由你决定是否重读",
    en: "the manuscript moved; you decide whether to re-read",
  },
  "dispatch.collect": { zh: "读取结果", en: "Collect" },

  "review.title": { zh: "审阅", en: "Review" },
  "review.empty": {
    zh: "还没有提案。把段落交给 Agent，结果回来后在这里逐句裁决。",
    en: "No proposals yet. Hand a passage to an agent, then judge the result line by line.",
  },
  "review.accept": { zh: "接受", en: "Accept" },
  "review.reject": { zh: "拒绝", en: "Reject" },
  "review.rewrite": { zh: "改写", en: "Rewrite" },
  "review.reason": { zh: "理由", en: "Reason" },
  "review.reasonPlaceholder": {
    zh: "为什么这样判断——这句会随下一轮送回给 Agent",
    en: "Why — this sentence goes back to the agent next round",
  },
  "review.useMine": { zh: "用我的写法", en: "Use mine" },
  "review.cancel": { zh: "取消", en: "Cancel" },
  "review.staged": { zh: "项待合并", en: "staged" },
  "review.clear": { zh: "全部撤下", en: "Unstage all" },
  "review.commit": { zh: "合并进正文", en: "Merge into the manuscript" },
  "review.refused": { zh: "整批未合并", en: "The batch did not commit" },
  "review.comment": { zh: "批注", en: "Comment" },

  "ledger.title": { zh: "账本", en: "Ledger" },
  "ledger.empty": {
    zh: "账本是空的。每一次裁决连同理由都会留在这里，并随下一轮送回给 Agent。",
    en: "The ledger is empty. Every judgment and its stated reason stays here, and goes back to the agent next round.",
  },
  "ledger.count": { zh: "项裁决", en: "judgments" },
  "ledger.noReason": { zh: "未写理由", en: "no reason stated" },
  "ledger.reply": { zh: "送回 Agent 的内容", en: "What goes back to the agent" },
  "ledger.close": { zh: "关闭", en: "Close" },

  "kind.accept": { zh: "接受", en: "accepted" },
  "kind.accept-modified": { zh: "改写后接受", en: "rewritten" },
  "kind.reject": { zh: "拒绝", en: "refused" },
  "kind.comment-only": { zh: "仅批注", en: "comment" },

  "chapter.none": { zh: "未选择章节", en: "No chapter open" },
  "chapter.saved": { zh: "已保存", en: "Saved" },
  "chapter.unsaved": { zh: "未保存", en: "Unsaved" },
  "chapter.empty": {
    zh: "这个文件夹里还没有 Markdown 文件",
    en: "No Markdown files in this folder yet",
  },
  "chapter.new": { zh: "新章节名", en: "Chapter name" },
  "chapter.pickOne": {
    zh: "从左边选一章，或者开一章新的。",
    en: "Choose a chapter, or start a new one.",
  },

  "cmd.openFile": { zh: "打开单个文件…", en: "Open a file…" },
  "cmd.edits": { zh: "修改记录", en: "What I changed" },

  "edits.title": { zh: "修改记录", en: "What I changed" },
  "edits.empty": {
    zh: "还没有改动。保存之后，每一处改写都会在这里列出，可以单独撤回，也可以一并送给 Agent。",
    en: "No changes yet. After a save, every rewrite is listed here — revert any one of them, or send the lot to an agent.",
  },
  "edits.count": { zh: "处改动", en: "changes" },
  "edits.replace": { zh: "改写", en: "rewrote" },
  "edits.insert": { zh: "新增", en: "added" },
  "edits.remove": { zh: "删去", en: "removed" },
  "edits.revert": { zh: "撤回", en: "Revert" },
  "edits.revertAll": { zh: "全部撤回", en: "Revert all" },
  "edits.toAgent": { zh: "告诉 Agent", en: "Tell the agent" },
  "edits.addNote": { zh: "＋ 写下理由", en: "＋ Say why" },
  "edits.notePlaceholder": {
    zh: "为什么这样改——会随改动一起送给 Agent",
    en: "Why — this goes to the agent with the change",
  },
  "edits.attached": {
    zh: "改动已附在下一次请求里",
    en: "Your changes will travel with the next request",
  },

  "edit.bold": { zh: "加粗", en: "Bold" },
  "edit.italic": { zh: "斜体", en: "Italic" },
  "edit.strike": { zh: "删除线", en: "Strikethrough" },
  "edit.code": { zh: "代码", en: "Code" },
  "edit.annotate": { zh: "写批注", en: "Annotate" },
  "edit.toAgent": { zh: "交给 Agent", en: "Send to an agent" },
  "edit.selectFirst": { zh: "先选中一段文字", en: "Select some text first" },

  "palette.navigate": { zh: "选择", en: "move" },
  "palette.run": { zh: "执行", en: "run" },
  "palette.dismiss": { zh: "关闭", en: "close" },

  "keys.press": { zh: "按下组合键…", en: "Press a chord…" },
  "keys.reset": { zh: "恢复默认快捷键", en: "Reset to defaults" },
  "keys.open": { zh: "打开文件夹", en: "Open folder" },
  "keys.newChapter": { zh: "新建章节", en: "New chapter" },
  "keys.save": { zh: "保存", en: "Save" },
  "keys.saveAll": { zh: "全部保存", en: "Save all" },
  "keys.bold": { zh: "加粗", en: "Bold" },
  "keys.italic": { zh: "斜体", en: "Italic" },
  "keys.annotate": { zh: "写批注", en: "Annotate" },
  "keys.undo": { zh: "撤销", en: "Undo" },
  "keys.redo": { zh: "重做", en: "Redo" },
  "keys.find": { zh: "查找", en: "Find" },
  "keys.dispatch": { zh: "交给 Agent", en: "Send to agent" },
  "keys.review": { zh: "审阅", en: "Review" },
  "keys.edits": { zh: "修改记录", en: "What I changed" },
  "keys.ledger": { zh: "账本", en: "Ledger" },
  "keys.palette": { zh: "命令面板", en: "Command palette" },
  "keys.zen": { zh: "禅模式", en: "Zen mode" },
  "keys.settings": { zh: "设置", en: "Settings" },
  "keys.zoomIn": { zh: "放大", en: "Zoom in" },
  "keys.zoomOut": { zh: "缩小", en: "Zoom out" },
  "keys.zoomReset": { zh: "还原缩放", en: "Reset zoom" },

  "cmd.files": { zh: "文件浏览", en: "Browse files" },
  "files.title": { zh: "文件", en: "Files" },
  "files.search": { zh: "搜索文件", en: "Search files" },
  "files.sort": { zh: "排序", en: "Sort" },
  "files.name": { zh: "名称", en: "Name" },
  "files.modified": { zh: "修改时间", en: "Modified" },
  "files.size": { zh: "大小", en: "Size" },
  "files.count": { zh: "个文件", en: "files" },
  /*
   * Measured on Linux: a workspace on a volume without a writable trash
   * directory cannot delete recoverably. The file stays, and saying so is the
   * whole point — a writer who thinks a chapter is gone will not look for it.
   */
  "files.trashFailed": {
    zh: "没能移到废纸篓，文件还在原处：",
    en: "Could not move to Trash; the file is still where it was: ",
  },
  /*
   * "移到废纸篓" rather than "删除": the wording is the promise. A control
   * labelled delete and a control that is recoverable should not read alike,
   * and the writer needs to know which one they are about to press.
   */
  "files.trash": { zh: "移到废纸篓", en: "Move to Trash" },
  "files.unavailable": {
    zh: "这台机器上没有文件层的原生组件，文件浏览暂不可用。编辑、保存与协作不受影响。",
    en: "The native file layer has no build for this machine, so browsing is unavailable. Editing, saving, and review are unaffected.",
  },
} as const;

export type Key = keyof typeof dict;

export const translator =
  (lang: Lang) =>
  (key: Key): string =>
    dict[key][lang];
