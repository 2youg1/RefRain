/**
 * Matching the display.
 *
 * Two facts about the monitor change how the application should draw, and
 * neither is knowable at build time:
 *
 * **Refresh rate.** A 165 Hz panel has a 6.06 ms frame budget, a 60 Hz panel
 * 16.67 ms. Animation durations quantised to 60 Hz stutter on the first and
 * waste headroom on the second. The target is the panel's actual rate, read at
 * run time — not a constant, and not an assumption.
 *
 * **Pixel density.** Hairlines are the visible case. A 1px border at 300%
 * scaling is a blurry 3-physical-pixel smear unless it is expressed as one
 * device pixel; the manuscript's ruled baseline grid is made of hairlines, so
 * this is not a detail.
 *
 * Electron reports both through `screen`. This module turns them into the two
 * numbers the renderer needs and nothing more.
 */

import type { Display, Screen } from "electron";

export interface DisplayProfile {
  /** Frames per second the panel actually runs at. */
  readonly refreshHz: number;
  /** Milliseconds per frame. The budget every interaction must fit inside. */
  readonly frameBudgetMs: number;
  /** Device pixels per CSS pixel: 1 on 1080p, 2 on a Retina panel, 1.5 on many 4K Windows setups. */
  readonly scaleFactor: number;
  /** One device pixel, in CSS pixels. The width a hairline should be. */
  readonly hairlineCss: number;
  /** Logical size, for remembering a window's place. */
  readonly width: number;
  readonly height: number;
  /** True when the panel is denser than a classic 96 DPI display. */
  readonly highDensity: boolean;
  /** True when the panel runs faster than the 60 Hz most CSS is written for. */
  readonly highRefresh: boolean;
}

/**
 * Electron reports 0 Hz on some Linux compositors and inside virtual displays.
 * Sixty is the safe reading: too slow wastes headroom, too fast schedules work
 * the panel cannot show and drops frames the user does see.
 */
const FALLBACK_HZ = 60;

/**
 * Above this, a panel is "high refresh" and the interface stops quantising
 * animation to 60 Hz multiples. 61 rather than 75 because 72 Hz panels exist
 * and benefit.
 */
const HIGH_REFRESH_ABOVE = 61;

export const profileOf = (display: Display): DisplayProfile => {
  const reported = display.displayFrequency;
  const refreshHz = Number.isFinite(reported) && reported > 0 ? Math.round(reported) : FALLBACK_HZ;
  const scaleFactor = display.scaleFactor > 0 ? display.scaleFactor : 1;

  return {
    refreshHz,
    frameBudgetMs: 1000 / refreshHz,
    scaleFactor,
    hairlineCss: 1 / scaleFactor,
    width: display.size.width,
    height: display.size.height,
    highDensity: scaleFactor > 1,
    highRefresh: refreshHz >= HIGH_REFRESH_ABOVE,
  };
};

/**
 * The profile for the display a window currently sits on.
 *
 * Per-window rather than per-application: dragging from a 60 Hz laptop panel to
 * a 165 Hz monitor must change the target, and a multi-monitor desk is the
 * common case for anyone writing with reference material open.
 */
export const profileForBounds = (
  screen: Screen,
  bounds: { x: number; y: number; width: number; height: number },
): DisplayProfile => profileOf(screen.getDisplayMatching(bounds));

/**
 * CSS custom properties the renderer applies to `:root`.
 *
 * Sent as data rather than injected as a stylesheet: the renderer owns its own
 * cascade, and a main process writing CSS would put styling authority in two
 * places.
 */
export const cssVariables = (profile: DisplayProfile): Record<string, string> => ({
  "--frame-budget": `${profile.frameBudgetMs.toFixed(3)}ms`,
  "--hairline": `${profile.hairlineCss}px`,
  "--scale-factor": `${profile.scaleFactor}`,
  // Durations are expressed in frames so motion reads the same on every panel:
  // eight frames is 133 ms at 60 Hz and 48 ms at 165 Hz, and both feel like the
  // same gesture because both are eight frames of the display the user has.
  "--motion-quick": `${(profile.frameBudgetMs * 4).toFixed(3)}ms`,
  "--motion-normal": `${(profile.frameBudgetMs * 8).toFixed(3)}ms`,
  "--motion-slow": `${(profile.frameBudgetMs * 16).toFixed(3)}ms`,
});
