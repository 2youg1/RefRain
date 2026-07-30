/* App mounts and provides. It holds no state machine and coordinates nothing
   (SPEC 9.10); a gate fails the build past 120 lines. */

import { listen } from "@tauri-apps/api/event";
import { createEffect, createSignal, onMount } from "solid-js";
import { unwrap } from "./bridge";
import { scheduleFrame } from "./frame-scheduler";
import { commands } from "./generated/bindings.gen";
import { Workbench } from "./shell/Workbench";
import { applyTypography } from "./typography";

export function App() {
  const [theme, setTheme] = createSignal("tou");

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
      scheduleFrame("appearance", () => {
        document.documentElement.dataset.paper = appearance.paper;
        applyTypography(document.documentElement, appearance.typography);
      });
    } catch {
      // A damaged Config is the Settings surface's story to tell, not a reason
      // the author cannot write today (SPEC 10.1).
    }
  };

  onMount(async () => {
    await listen("config-changed", () => void applyConfig());
    await applyConfig();
  });

  return (
    <main class="shell">
      <Workbench onThemeChanged={setTheme} />
    </main>
  );
}
