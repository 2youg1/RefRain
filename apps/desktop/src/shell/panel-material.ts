/**
 * 面板与正文的物质：一层东西看起来是什么做的。
 *
 * 三档不是三套皮肤，是同一件事的三种密度：光透过它多少。实心什么都不透，
 * 亚克力透过一层磨砂，液态玻璃连背后的形状都带过来一点。选哪一档取决于作者
 * 想不想在读一层的时候还感觉得到底下那层。
 *
 * 这里只给出**规格**——每档的模糊、饱和、透明度、边与高光。怎么画归 CSS，
 * 但数字归这里，因为「亚克力」在四个地方各写一遍就会变成四种亚克力。
 */

/** 液态玻璃的折射：背后的形状被边缘拉一下，不只是模糊。 */
export type PanelMaterial = "solid" | "acrylic" | "liquid";

export interface MaterialSpec {
  /** 背景模糊半径。0 表示不透。 */
  readonly blurPx: number;
  /** 背景饱和度。玻璃会让背后的颜色更艳一点，这是真实玻璃的行为。 */
  readonly saturate: number;
  /** 面板自身底色的不透明度，0–1。 */
  readonly opacity: number;
  /** 边缘高光强度，0–1。液态玻璃靠它读出「一块有厚度的东西」。 */
  readonly rim: number;
}

const SPECS: Readonly<Record<PanelMaterial, MaterialSpec>> = {
  // 什么都不透。可读性最高，也最不占算力——低端机与远程桌面的正确选择。
  solid: { blurPx: 0, saturate: 1, opacity: 1, rim: 0 },
  // 一层磨砂：知道底下有东西，但读不出是什么。
  acrylic: { blurPx: 20, saturate: 1.4, opacity: 0.72, rim: 0.18 },
  // 有厚度的玻璃：模糊更浅所以形状带得过来，靠边缘高光与更强的饱和读出体积。
  liquid: { blurPx: 12, saturate: 1.8, opacity: 0.52, rim: 0.42 },
};

export function materialSpec(material: PanelMaterial): MaterialSpec {
  return SPECS[material];
}

/**
 * 浏览器画不动 backdrop-filter 时退到哪一档。
 *
 * 退到实心而不是「照画不误」：一块该透而没透的玻璃比一块老实的实心板更糟——
 * 它承诺了厚度却交出一片灰。
 */
export function supportedMaterial(material: PanelMaterial): PanelMaterial {
  if (material === "solid") return "solid";
  const supported =
    globalThis.CSS?.supports?.("backdrop-filter", "blur(1px)") ||
    globalThis.CSS?.supports?.("-webkit-backdrop-filter", "blur(1px)");
  return supported ? material : "solid";
}
