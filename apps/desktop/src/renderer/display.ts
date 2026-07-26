/**
 * The renderer's half of display matching.
 *
 * The main process measures the panel; this applies the result to `:root` and
 * keeps it current when the window moves between monitors. Nothing here decides
 * anything — the numbers arrive already computed, because a second opinion
 * about the frame budget is a second source of truth.
 */

export interface DisplayProfile {
  readonly refreshHz: number;
  readonly frameBudgetMs: number;
  readonly scaleFactor: number;
  readonly hairlineCss: number;
  readonly width: number;
  readonly height: number;
  readonly highDensity: boolean;
  readonly highRefresh: boolean;
  readonly css: Record<string, string>;
}

/**
 * Sensible values for a browser preview or a main process that has not answered
 * yet. Sixty rather than zero: a budget of zero would make every interaction
 * appear over budget the moment it was measured.
 */
export const FALLBACK: DisplayProfile = {
  refreshHz: 60,
  frameBudgetMs: 1000 / 60,
  scaleFactor: 1,
  hairlineCss: 1,
  width: 1920,
  height: 1080,
  highDensity: false,
  highRefresh: false,
  css: {
    "--frame-budget": "16.667ms",
    "--hairline": "1px",
    "--scale-factor": "1",
    "--motion-quick": "66.667ms",
    "--motion-normal": "133.333ms",
    "--motion-slow": "266.667ms",
  },
};

/**
 * Write the profile's variables onto the document root.
 *
 * Also sets two data attributes, so a stylesheet can branch on panel class
 * without reading a number: `[data-density="high"]` and `[data-refresh="high"]`.
 */
export const applyProfile = (profile: DisplayProfile, root: HTMLElement): void => {
  for (const [name, value] of Object.entries(profile.css)) {
    root.style.setProperty(name, value);
  }
  root.dataset.density = profile.highDensity ? "high" : "standard";
  root.dataset.refresh = profile.highRefresh ? "high" : "standard";
};

/**
 * Ask the main process for the current panel and keep listening.
 *
 * Returns an unsubscribe function. Without one, a component that mounts and
 * unmounts repeatedly accumulates listeners on the same channel — the leak is
 * invisible until the window has been dragged between monitors a few times.
 */
export const trackDisplay = (
  bridge: {
    displayProfile?: () => Promise<DisplayProfile>;
    onDisplayChange?: (listener: (profile: DisplayProfile) => void) => () => void;
  },
  onChange: (profile: DisplayProfile) => void,
): (() => void) => {
  if (!bridge.displayProfile) {
    onChange(FALLBACK);
    return () => {};
  }

  void bridge
    .displayProfile()
    .then(onChange)
    .catch(() => onChange(FALLBACK));
  return bridge.onDisplayChange?.(onChange) ?? (() => {});
};

/**
 * Schedule work for the next frame, with the panel's budget in hand.
 *
 * A caller that wants to stay interactive gives up the rest of its slice when
 * it has used the budget. This is what keeps a long file list from blocking
 * input on a 165 Hz panel just as it would on a 60 Hz one.
 */
export const withinBudget = (budgetMs: number): (() => boolean) => {
  const deadline = performance.now() + budgetMs;
  return () => performance.now() < deadline;
};
