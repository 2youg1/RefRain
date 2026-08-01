/**
 * 圆角的唯一权威：G4 曲率连续的弧边（「小饭盒」）。
 *
 * ## 为什么不是 border-radius
 *
 * `border-radius` 画的是**正圆弧**。直边与圆弧交接处，曲率从 0 突变到 1/r
 * ——数学上是 G1 连续（切线连续、曲率不连续）。眼睛看得见这个突变：角落
 * 那一小段会显得比周围「紧」，一排卡片放在一起时像被啃了一口。
 *
 * G4 要的是**曲率本身也连续**地从 0 长到最大再回落。做法是超椭圆（squircle）
 * ——`|x/a|^n + |y/b|^n = 1`。n = 2 退化成正圆；n 越大越接近方形而拐角越
 * 「顺」。取 n ≈ 4~5 时曲率沿弧长的变化平滑，这正是 G4 这个名字的来处。
 *
 * ## 为什么是一个模块而不是一条 CSS 规则
 *
 * 它必须同时回答三件事，而这三件事分散在三个地方就会漂开：
 *
 * 1. **各档尺寸叫什么**（小饭盒、面板、卡片、按钮各用哪一档）；
 * 2. **路径怎么算**（超椭圆采样，供 `clip-path` 使用）；
 * 3. **降级到哪里**（不支持 `clip-path` 时退回 `border-radius`，而退回的
 *    半径必须与超椭圆的视觉尺寸相当，不能是同一个数字）。
 *
 * 样式表只引用变量，不写数字——与 `strata.ts` 同一条纪律，由
 * `verify:corner-authority` 保证。此前样式表里有二十九处裸的 `border-radius`
 * 数字，每处单看都对，合起来没有一处说明「面板与按钮的角为什么不一样」。
 */

/** 一档角。名字说的是**用在什么上**，不是它有多大。 */
export type CornerScale =
  /** 小饭盒：右键菜单、待解决面板这类停在正文旁边的小窗口。 */
  | "bento"
  /** 面板：占一整条竖带的表面。 */
  | "panel"
  /** 卡片：列表里的一格。 */
  | "card"
  /** 控件：按钮、输入框、标签。 */
  | "control"
  /** 徽标：计数、圆点这类必须读作圆的东西。 */
  | "pill";

/** 每一档的名义半径（px）与超椭圆指数。 */
type CornerSpec = {
  /** 名义半径：超椭圆在轴向上的半长，也是降级时 border-radius 的基数。 */
  readonly radius: number;
  /**
   * 超椭圆指数。2 是正圆；越大越方而拐角越顺。
   *
   * 小饭盒取 4.2：它是这套里最需要「顺」的一档——它停在正文旁边，与正文
   * 那条直边并排，角上的曲率突变在那种并排关系里最显眼。
   */
  readonly exponent: number;
};

const SPECS: Record<CornerScale, CornerSpec> = {
  bento: { radius: 12, exponent: 4.2 },
  panel: { radius: 10, exponent: 4 },
  card: { radius: 7, exponent: 3.6 },
  control: { radius: 5, exponent: 3.2 },
  // 徽标必须读作一个圆，所以它退回正圆：指数 2。给它一个超椭圆会让一个
  // 本该是圆点的东西看起来像被压扁的方块。
  pill: { radius: 999, exponent: 2 },
};

/** 全部档，供门禁与样式生成遍历。 */
export const CORNER_SCALES: readonly CornerScale[] = Object.keys(SPECS) as CornerScale[];

/** 一档的名义半径（px）。 */
export function cornerRadius(scale: CornerScale): number {
  return SPECS[scale].radius;
}

/** 一档的超椭圆指数。 */
export function cornerExponent(scale: CornerScale): number {
  return SPECS[scale].exponent;
}

/** 这一档的 CSS 变量名。样式表只引用它，不写数字。 */
export function cornerVar(scale: CornerScale): string {
  return `--corner-${scale}`;
}

/** 这一档形状（clip-path）的 CSS 变量名。 */
export function cornerShapeVar(scale: CornerScale): string {
  return `--corner-shape-${scale}`;
}

/**
 * 生成 `:root` 上的一组角变量：样式表里圆角的唯一来源。
 *
 * 同时给出半径（降级用）与形状（`clip-path` 用），因为两者必须由同一份数据
 * 推出——分开写就会出现「clip-path 换了档而 border-radius 没换」的半截样子，
 * 而那只在不支持 clip-path 的机器上看得见。
 */
export function cornerDeclarations(): string {
  return CORNER_SCALES.map((scale) => {
    const radius = SPECS[scale].radius;
    const fallback = `  ${cornerVar(scale)}: ${radius === 999 ? "999px" : `${radius}px`};`;
    const shape = `  ${cornerShapeVar(scale)}: ${squirclePath(scale)};`;
    return `${fallback}\n${shape}`;
  }).join("\n");
}

/**
 * 一档的超椭圆路径，写成百分比坐标的 `polygon()`。
 *
 * 用百分比而不是像素：同一个形状要能套在任意尺寸的盒子上，而 `clip-path`
 * 的 `polygon()` 支持百分比。代价是非正方形的盒子上角会被拉伸——这对
 * 「小饭盒」这类近似方形的表面可以接受，对细长的按钮不行，所以 `control`
 * 一档在样式里默认走 border-radius 降级路径。
 *
 * 采样点数固定 24：再多在 12px 的角上已经看不出差别，而路径字符串会随点数
 * 线性变长，它是每个用到这一档的元素都要解析的东西。
 */
export function squirclePath(scale: CornerScale, samples = 24): string {
  const exponent = SPECS[scale].exponent;
  const points: string[] = [];

  for (let index = 0; index < samples; index += 1) {
    const angle = (index / samples) * 2 * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // 超椭圆的参数式：x = |cos t|^(2/n) · sign(cos t)，y 同理。
    const x = Math.sign(cos) * Math.abs(cos) ** (2 / exponent);
    const y = Math.sign(sin) * Math.abs(sin) ** (2 / exponent);
    // 从 [-1,1] 映到 [0%,100%]。
    points.push(`${round((x + 1) * 50)}% ${round((y + 1) * 50)}%`);
  }

  return `polygon(${points.join(", ")})`;
}

/** 两位小数：路径字符串是每个元素都要解析的东西，精度到此为止。 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
