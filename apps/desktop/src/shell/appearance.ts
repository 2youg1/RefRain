/**
 * 一整份外观配置，变成界面上的一次投影。
 *
 * 版面（纸的三档）、面板的方向与时长、面板的材质、夜间灯、排版——它们的共同点
 * 是「Config 里的一个值决定屏幕上的一个样子」，而且必须**一起**落地：材质变了而
 * 方向没变、灯亮了而版面还是旧的，都是作者会看见的错位。
 *
 * 所以这是一个函数而不是五个。调用方只需要知道「把这份 appearance 画上去」。
 */

import type { AppearanceConfig } from "../generated/bindings.gen";
import { applyTypography } from "../typography";
import { lampFacing, lampPlacement } from "./lamp";
import { materialSpec, supportedMaterial } from "./panel-material";
import { panelMotion, prefersReducedMotion } from "./panel-motion";
import { panelWidthPx, railWidthPx } from "./surface-width";

export function applyAppearance(root: HTMLElement, appearance: AppearanceConfig): void {
  root.dataset.paper = appearance.paper;

  // 方向与时长：panelMotion 把「作者的选择」与「系统要求减少动效」合成一个答案。
  const motion = panelMotion(
    appearance.panel_side ?? "left",
    appearance.panel_animation ?? true,
    prefersReducedMotion(),
  );
  root.dataset.panelSide = motion.side;
  root.style.setProperty("--panel-motion", `${motion.duration}ms`);
  root.style.setProperty("--panel-easing", motion.easing);
  root.style.setProperty("--panel-enter-from", motion.enterFrom);

  // 材质：画不动 backdrop-filter 的机器退到实心——一块该透而没透的玻璃
  // 比一块老实的板更糟。
  const material = materialSpec(supportedMaterial(appearance.panel_material ?? "solid"));
  root.style.setProperty("--panel-blur", `${material.blurPx}px`);
  root.style.setProperty("--panel-saturate", String(material.saturate));
  root.style.setProperty("--panel-opacity", String(material.opacity));
  root.style.setProperty("--panel-rim", String(material.rim));
  // The name travels too: blur(0) still allocates a compositing filter layer,
  // so solid panels drop backdrop-filter entirely (a WebView2 stall class on
  // large fullscreen surfaces lives behind that layer).
  root.dataset.panelMaterial = appearance.panel_material ?? "solid";

  // Lamp position is the authority for highlights, shadows, and the lit panel edge.
  const lamp = lampPlacement(appearance.night_lamp ?? "off", motion.side);
  root.dataset.lamp = appearance.night_lamp ?? "off";
  if (lamp) {
    root.style.setProperty("--lamp-x", `${lamp.x * 100}%`);
    root.style.setProperty("--lamp-y", `${lamp.y * 100}%`);
    root.style.setProperty("--lamp-reach", `${lamp.reach * 100}%`);
    root.style.setProperty("--lamp-power", String(lamp.power));
    root.style.setProperty("--lamp-facing", String(lampFacing(lamp)));
  } else {
    for (const name of ["x", "y", "reach", "power", "facing"]) {
      root.style.removeProperty(`--lamp-${name}`);
    }
  }

  // 宽度：面板与侧栏各自三档，铺满是其中一档而不是另一个模式。
  root.style.setProperty("--panel-width", `${panelWidthPx(appearance.panel_width ?? "regular")}px`);
  root.style.setProperty("--rail-width", `${railWidthPx(appearance.rail_width ?? "narrow")}px`);
  // 铺满是一档宽度，不是另一个模式——但它要让 CSS 认得出来，因为铺满时
  // 正文一点也不让，与另外两档的让位规则相反。
  root.dataset.panelWidth = appearance.panel_width ?? "regular";

  applyTypography(root, appearance.typography);
}
