/**
 * 设置的树：作者要改的那一项在哪里。
 *
 * 设置分成三个标签页之后，「行距在哪调」这个问题的答案是「排版 → 手稿排版
 * → 段落 → 行距」——四层，而界面上只看得见第一层。作者要么记住，要么每次
 * 逐个点开找。
 *
 * 这棵树把每一项的位置写成一条可跳转的链接：搜一个词，直接到那一项。它是
 * **索引不是权威**——真正的取值仍在 `config.toml`，这里只回答「在哪」。
 *
 * ## 一条纪律
 *
 * **不覆盖作者的任何设置。** 这棵树只导航，不写值；它连默认值都不知道。
 * 一个能顺手「帮你恢复推荐值」的索引，会在作者只是想看看某项在哪的时候
 * 把他调好的东西改掉。
 */

/** 设置的三个分类，与标签页一一对应。 */
export type SettingsSection = "appearance" | "typography" | "shortcuts";

/** 树上的一个节点。有 `leaf` 的是可跳转的修改点，没有的是分组。 */
export type SettingsNode = {
  /** 界面上显示的名字。 */
  readonly label: string;
  /** 这一项在哪个标签页。 */
  readonly section: SettingsSection;
  /**
   * 对应的配置叶子路径（`config-leaves.ts` 的那套路径）。
   *
   * 分组没有它：分组不是一个可改的值，给它一条路径会让「点开分组」
   * 变成「改了什么东西」。
   */
  readonly leaf?: string;
  /** 一句话说明这一项管什么。搜索会搜它。 */
  readonly hint?: string;
  readonly children?: readonly SettingsNode[];
};

/**
 * 全部设置项的树。
 *
 * 次序按作者找它的频率，不按配置文件里的次序——配置文件的次序是给解析器
 * 看的。
 */
export const SETTINGS_TREE: readonly SettingsNode[] = [
  {
    label: "阅读环境",
    section: "appearance",
    hint: "整套色彩、纸面边界与面板质感",
    children: [
      {
        label: "主题",
        section: "appearance",
        leaf: "appearance.theme",
        hint: "七套配色，选择本身就是预览",
      },
      {
        label: "纸面边界",
        section: "appearance",
        leaf: "appearance.paper",
        hint: "无边、发丝、纸缘",
      },
      { label: "面板质感", section: "appearance", leaf: "appearance.panel_material" },
      { label: "面板宽度", section: "appearance", leaf: "appearance.panel_width" },
      { label: "面板开合方向", section: "appearance", leaf: "appearance.panel_side" },
      { label: "面板动画", section: "appearance", leaf: "appearance.panel_animation" },
      { label: "侧栏宽度", section: "appearance", leaf: "appearance.rail_width" },
      { label: "夜灯", section: "appearance", leaf: "appearance.night_lamp", hint: "让光有来处" },
      {
        label: "代码配色",
        section: "appearance",
        leaf: "appearance.code_theme",
        hint: "留空表示跟随界面主题",
      },
      {
        label: "写作入口图标",
        section: "appearance",
        leaf: "appearance.icon_digest",
        hint: "替换编辑区写作入口的图形",
      },
      {
        label: "小窗口透明度",
        section: "appearance",
        leaf: "appearance.bento_opacity_percent",
        hint: "右键菜单这类停在正文旁边的小窗口；调低就能看见它底下的东西",
      },
    ],
  },
  {
    label: "手稿排版",
    section: "typography",
    hint: "字体、字形、段落、版心、页面留白",
    children: [
      {
        label: "字体",
        section: "typography",
        leaf: "appearance.typography.fonts",
        hint: "本机字体与内嵌字体的优先次序",
      },
      { label: "字号", section: "typography", leaf: "appearance.typography.text_size_tenths_px" },
      { label: "字重", section: "typography", leaf: "appearance.typography.font_weight" },
      {
        label: "行距",
        section: "typography",
        leaf: "appearance.typography.line_height_percent",
        hint: "行与行之间的距离",
      },
      {
        label: "字距",
        section: "typography",
        leaf: "appearance.typography.letter_spacing_thousandths_em",
      },
      {
        label: "词距",
        section: "typography",
        leaf: "appearance.typography.word_spacing_thousandths_em",
      },
      {
        label: "版心宽度",
        section: "typography",
        leaf: "appearance.typography.measure_tenths_em",
        hint: "一行放多少字",
      },
      {
        label: "首行缩进",
        section: "typography",
        leaf: "appearance.typography.first_line_indent_tenths_em",
      },
      {
        label: "段落间距",
        section: "typography",
        leaf: "appearance.typography.paragraph_spacing_percent",
      },
      { label: "对齐", section: "typography", leaf: "appearance.typography.alignment" },
      {
        label: "页面上留白",
        section: "typography",
        leaf: "appearance.typography.page_top_padding_tenths_rem",
      },
      {
        label: "页面下留白",
        section: "typography",
        leaf: "appearance.typography.page_bottom_padding_tenths_vh",
      },
      {
        label: "基线网格",
        section: "typography",
        leaf: "appearance.typography.baseline_grid_lines",
        hint: "0 关闭；1–6 表示每几行画一条",
      },
      { label: "缩放", section: "typography", leaf: "appearance.typography.zoom_percent" },
      {
        label: "自定义排版预设",
        section: "typography",
        leaf: "appearance.typography_presets",
        hint: "存下当前这套排版，之后一键换回",
      },
    ],
  },
  {
    label: "键盘操作",
    section: "shortcuts",
    hint: "已经生效的按键；本版不提供改键",
  },
];

/**
 * 搜一个词，返回命中的修改点。
 *
 * 只返回**叶子**：分组不是修改点，把它列进结果里作者点开只会看到另一层。
 * 名字与说明都搜——作者可能记得「行距」，也可能只记得「行与行之间」。
 */
export function findSettings(query: string): readonly SettingsNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];

  const hits: SettingsNode[] = [];
  const walk = (nodes: readonly SettingsNode[]): void => {
    for (const node of nodes) {
      if (node.children !== undefined) walk(node.children);
      if (node.leaf === undefined) continue;
      const haystack = `${node.label} ${node.hint ?? ""} ${node.leaf}`.toLowerCase();
      if (haystack.includes(needle)) hits.push(node);
    }
  };
  walk(SETTINGS_TREE);
  return hits;
}

/** 全部修改点，按树的次序拍平。供门禁核对每一项都真的存在于配置里。 */
export function settingsLeaves(): readonly SettingsNode[] {
  const leaves: SettingsNode[] = [];
  const walk = (nodes: readonly SettingsNode[]): void => {
    for (const node of nodes) {
      if (node.leaf !== undefined) leaves.push(node);
      if (node.children !== undefined) walk(node.children);
    }
  };
  walk(SETTINGS_TREE);
  return leaves;
}
