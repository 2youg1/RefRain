export type WorkbenchCommandGroup =
  | "continue"
  | "project"
  | "work"
  | "reference"
  | "agents"
  | "appearance"
  | "application";

export type WorkbenchCommandId =
  | "return-writing"
  | "open-review"
  | "open-project"
  | "create-project"
  | "open-document"
  | "new-chapter"
  | "new-material"
  | "import-material"
  | "save-document"
  | "open-dispatch"
  | "open-connections"
  | "open-source"
  | "open-appearance"
  | "open-typography"
  | "open-shortcuts"
  | "format-heading-1"
  | "format-heading-2"
  | "format-heading-3"
  | "format-quote"
  | "format-bullet-list"
  | "format-ordered-list";

export interface WorkbenchCommand {
  id: WorkbenchCommandId;
  group: WorkbenchCommandGroup;
  label: string;
  keywords: readonly string[];
  available: boolean;
  nextStep: string | null;
}

interface CommandContext {
  hasProject: boolean;
  hasDocument: boolean;
  /**
   * 打开的这篇是不是导入来的，且原件还在。
   *
   * 比 `hasDocument` 严：作者自己写的稿子没有原件可看，把「看原件」列成可用
   * 只会让他点开一个空面板。
   */
  hasImportedSource: boolean;
}

const command = (
  id: WorkbenchCommandId,
  group: WorkbenchCommandGroup,
  label: string,
  keywords: readonly string[],
  available = true,
  nextStep: string | null = null,
): WorkbenchCommand => ({ id, group, label, keywords, available, nextStep });

export function commandCatalog(context: CommandContext): WorkbenchCommand[] {
  const projectStep = context.hasProject ? null : "先打开一个项目";
  const documentStep = context.hasDocument ? null : "先打开一篇手稿";
  return [
    command(
      "return-writing",
      "continue",
      "继续写作",
      ["write", "writing", "manuscript"],
      context.hasDocument,
      documentStep,
    ),
    command(
      "open-review",
      "continue",
      "继续 Review",
      ["review", "proposal", "裁决", "提案"],
      context.hasDocument,
      documentStep,
    ),
    // 常用 Markdown 结构。走命令面板而不是常驻工具栏：中日文长文里持续遮挡
    // 正文是 SPEC:69「写作现场零滑杆」明确否决的形状。
    command(
      "format-heading-1",
      "work",
      "设为一级标题",
      ["h1", "heading", "title", "标题", "一级"],
      context.hasDocument,
      documentStep,
    ),
    command(
      "format-heading-2",
      "work",
      "设为二级标题",
      ["h2", "heading", "小标题", "二级"],
      context.hasDocument,
      documentStep,
    ),
    command(
      "format-heading-3",
      "work",
      "设为三级标题",
      ["h3", "heading", "三级"],
      context.hasDocument,
      documentStep,
    ),
    command(
      "format-quote",
      "work",
      "设为引用",
      ["quote", "blockquote", "引用", "引文"],
      context.hasDocument,
      documentStep,
    ),
    command(
      "format-bullet-list",
      "work",
      "设为无序列表",
      ["list", "bullet", "列表", "项目符号"],
      context.hasDocument,
      documentStep,
    ),
    command(
      "format-ordered-list",
      "work",
      "设为有序列表",
      ["ordered", "numbered", "编号", "有序列表"],
      context.hasDocument,
      documentStep,
    ),
    command("open-project", "project", "打开项目文件夹", ["open project", "folder", "项目"]),
    command("create-project", "project", "新建项目", ["create project", "新项目"]),
    command("open-document", "project", "打开单篇文档", ["open document", "markdown", "文档"]),
    command(
      "new-chapter",
      "project",
      "新建章节",
      ["new chapter", "chapter", "章节"],
      context.hasProject,
      projectStep,
    ),
    command(
      "new-material",
      "project",
      "新建资料",
      ["new material", "reference", "资料"],
      context.hasProject,
      projectStep,
    ),
    command(
      "import-material",
      "project",
      "导入资料",
      ["import", "pdf", "epub", "docx", "导入"],
      context.hasProject,
      projectStep,
    ),
    command(
      "save-document",
      "work",
      "保存当前手稿",
      ["save", "ctrl s", "保存"],
      context.hasDocument,
      documentStep,
    ),
    command(
      "open-dispatch",
      "work",
      "交给 Agent…",
      ["dispatch", "agent", "派发", "发送"],
      context.hasDocument,
      documentStep,
    ),
    command(
      "open-connections",
      "reference",
      "连接本机 Agent",
      ["connections", "agents", "harness", "codex", "claude", "连接"],
      context.hasProject,
      projectStep,
    ),
    command(
      "open-source",
      "reference",
      "看原件",
      ["source", "original", "pdf", "原件", "原文", "扫描", "页面"],
      context.hasImportedSource,
      context.hasImportedSource ? null : "这篇不是从文件导入的，没有原件可看",
    ),
    command(
      "open-appearance",
      "appearance",
      "调整外观",
      ["appearance", "theme", "paper", "主题", "外观"],
      context.hasProject,
      projectStep,
    ),
    command(
      "open-typography",
      "appearance",
      "调整排版",
      ["typography", "font", "layout", "字体", "版心", "排版"],
      context.hasProject,
      projectStep,
    ),
    command(
      "open-shortcuts",
      "application",
      "查看快捷键",
      ["shortcuts", "keyboard", "keys", "快捷键"],
      context.hasProject,
      projectStep,
    ),
  ];
}

export function filterCommands(
  entries: readonly WorkbenchCommand[],
  rawQuery: string,
): WorkbenchCommand[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (query === "") {
    const preferred = new Set<WorkbenchCommandId>([
      "return-writing",
      "open-review",
      "new-chapter",
      "new-material",
      "import-material",
      "save-document",
      "open-dispatch",
      "open-connections",
      "open-typography",
    ]);
    const selected = entries.filter((entry) => entry.available && preferred.has(entry.id));
    for (const entry of entries) {
      if (selected.length >= 9) break;
      if (entry.available && !selected.includes(entry)) selected.push(entry);
    }
    return selected
      .sort((left, right) => entries.indexOf(left) - entries.indexOf(right))
      .slice(0, 9);
  }
  const tokens = query.split(/\s+/);
  return entries.filter((entry) => {
    const haystack = [entry.id, entry.label, ...entry.keywords].join(" ").toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}
