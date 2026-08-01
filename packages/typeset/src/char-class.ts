/**
 * 字符类：排版的第一步，其余每一步都问它。
 *
 * CLREQ 与 JLREQ 都从「这个字属于哪一类」起步，因为间距、挤压、禁则、悬挂
 * 全都按类定规矩，而不是按具体字符。判定只看 code point 与预设，不看字体、
 * 不看 DOM——同一个字在两个平台上必须落进同一类，否则同一份稿子会有两种
 * 版面，而那正是本项目最不能接受的一类不一致。
 *
 * 分类比 Unicode 的通用类别粗：这里要的是「排版上怎么对待它」。全角句号与
 * 全角逗号在 Unicode 里一个是 Po 一个也是 Po，但一个后面可以断行、一个前面
 * 不可以，所以它们在这里是两类。
 */

/**
 * 排版意义上的字符类。
 *
 * 顺序即语义分组：先是表意文字与假名，再是标点的四种（开、闭、中点、句读），
 * 然后是西文与数字，最后是空白与其余。
 */
export type CharClass =
  /** 汉字、假名等全角表意文字。 */
  | "ideograph"
  /** 开括号类：「（【〔《 等。行尾不可留，前面可压。 */
  | "open"
  /** 闭括号类：」）】〕》 等。行首不可现，后面可压。 */
  | "close"
  /** 中点类：・：； 等。两侧规矩对称。 */
  | "middle"
  /** 句读点：。、，．等。行首不可现。 */
  | "stop"
  /** 长标点：…… —— 等，成对出现且不可拆。 */
  | "extender"
  /** 西文字母。 */
  | "latin"
  /** 数字。 */
  | "digit"
  /** 空白。 */
  | "space"
  /** 其余：符号、控制字符等。 */
  | "other";

/** 开括号类。行首可以是它，行尾不可以。 */
const OPEN = new Set([
  "「",
  "『",
  "（",
  "〔",
  "［",
  "｛",
  "〈",
  "《",
  "【",
  "〖",
  "〘",
  "〚",
  "“",
  "‘",
]);

/** 闭括号类。行尾可以是它，行首不可以。 */
const CLOSE = new Set([
  "」",
  "』",
  "）",
  "〕",
  "］",
  "｝",
  "〉",
  "》",
  "】",
  "〗",
  "〙",
  "〛",
  "”",
  "’",
]);

/** 句读点。行首不可现，行尾可压。 */
const STOP = new Set(["。", "．", "、", "，", "：", "；", "？", "！"]);

/** 中点。两侧对称，与句读点的压缩规矩不同。 */
const MIDDLE = new Set(["・", "·", "･"]);

/** 长标点。它们成对出现，判断不可分序列时要认出这一点。 */
const EXTENDER = new Set(["…", "—", "―", "－", "〜", "～"]);

/**
 * 这个字属于哪一类。
 *
 * 入参是一个字符（可能是代理对，所以按 code point 而非 UTF-16 单元判断）。
 */
export function classOf(character: string): CharClass {
  const point = character.codePointAt(0);
  if (point === undefined) return "other";

  if (OPEN.has(character)) return "open";
  if (CLOSE.has(character)) return "close";
  if (STOP.has(character)) return "stop";
  if (MIDDLE.has(character)) return "middle";
  if (EXTENDER.has(character)) return "extender";

  if (character === " " || character === "\t" || character === "\u3000") return "space";

  // 数字与拉丁字母只认 ASCII 范围：全角数字与全角字母在排版上跟着表意文字
  // 走（它们占一个字身），把它们归进 digit/latin 会让混排间距在本来没有
  // script 边界的地方插入空隙。
  if (point >= 0x30 && point <= 0x39) return "digit";
  if ((point >= 0x41 && point <= 0x5a) || (point >= 0x61 && point <= 0x7a)) return "latin";

  if (isIdeographic(point)) return "ideograph";
  return "other";
}

/**
 * 表意文字与假名的范围。
 *
 * 假名与汉字同归一类：混排间距问的是「这里有没有跨 script 的边界」，而
 * 汉字与假名之间没有那条边界。
 */
function isIdeographic(point: number): boolean {
  return (
    // CJK 统一表意文字（含扩展 A）
    (point >= 0x3400 && point <= 0x4dbf) ||
    (point >= 0x4e00 && point <= 0x9fff) ||
    // 兼容表意文字
    (point >= 0xf900 && point <= 0xfaff) ||
    // 平假名、片假名
    (point >= 0x3040 && point <= 0x30ff) ||
    // 全角形式（全角字母、数字、部分标点）
    (point >= 0xff01 && point <= 0xff60) ||
    // 扩展 B 及以后
    (point >= 0x20000 && point <= 0x2ebef)
  );
}

/** 这一类是不是全角标点。挤压只作用于它们。 */
export function isFullWidthPunctuation(kind: CharClass): boolean {
  return kind === "open" || kind === "close" || kind === "stop" || kind === "middle";
}

/** 这一类是不是「西文一侧」。混排间距要在它与表意文字之间插入空隙。 */
export function isWesternSide(kind: CharClass): boolean {
  return kind === "latin" || kind === "digit";
}
