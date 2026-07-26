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
  "welcome.open": { zh: "打开项目", en: "Open project" },
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
  "set.paper": { zh: "纸", en: "Paper" },
  "set.ink": { zh: "墨", en: "Ink" },
  "set.about": { zh: "关于", en: "About" },
  "set.noNetwork": {
    zh: "此程序不发出任何网络请求，不收集任何数据。",
    en: "This application makes no network requests and collects nothing.",
  },

  "agents.title": { zh: "Agent", en: "Agents" },
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
} as const;

export type Key = keyof typeof dict;

export const translator =
  (lang: Lang) =>
  (key: Key): string =>
    dict[key][lang];
