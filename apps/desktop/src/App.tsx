/* App mounts and provides. It holds no state machine and coordinates nothing
   (SPEC 9.10); a gate fails the build past 120 lines. */

import { type CodeTheme, codeThemeFor, normalizeCodeTheme } from "@refrain/editor";
import { listen } from "@tauri-apps/api/event";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { unwrap } from "./bridge";
import { scheduleFrame } from "./frame-scheduler";
import { commands } from "./generated/bindings.gen";
import { applyAppearance } from "./shell/appearance";
import { Workbench } from "./shell/Workbench";

export function App() {
  const [theme, setTheme] = createSignal("tou");
  const [codeTheme, setCodeTheme] = createSignal<CodeTheme>(codeThemeFor("tou"));

  // The generated selectors live on :root[data-theme]; the shell element is
  // not :root. One projection, one direction (INV-15).
  createEffect(() => {
    document.documentElement.dataset.theme = theme();
  });

  const applyConfig = async (): Promise<void> => {
    try {
      const snapshot = await unwrap(commands.readConfig());
      const appearance = snapshot.config.appearance;
      if (appearance === undefined) return;
      setTheme(appearance.theme);
      // normalizeCodeTheme folds retired palette names into day/night and
      // follows the interface theme when nothing was ever chosen.
      setCodeTheme(normalizeCodeTheme(appearance.code_theme, appearance.theme));
      scheduleFrame("appearance", () => {
        applyAppearance(document.documentElement, appearance);
      });
    } catch {
      // A damaged Config is the Settings surface's story to tell, not a reason
      // the author cannot write today (SPEC 10.1).
    }
  };

  onMount(async () => {
    const unlisten = await listen("config-changed", () => void applyConfig());
    onCleanup(unlisten);
    await applyConfig();
  });

  return (
    <main class="shell">
      <Workbench codeTheme={codeTheme()} onThemeChanged={setTheme} />
    </main>
  );
}
