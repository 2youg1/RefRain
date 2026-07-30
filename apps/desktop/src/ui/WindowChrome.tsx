import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { cancelScheduledFrame, scheduleFrame } from "../frame-scheduler";
import { commands, type DisplayProfile } from "../generated/bindings.gen";

interface WindowChromeProps {
  title?: string;
  onCloseRequested: () => void;
  onError: (message: string) => void;
}

export function WindowChrome(props: WindowChromeProps) {
  const windowHandle = getCurrentWindow();
  const [maximized, setMaximized] = createSignal(false);
  const [fullscreen, setFullscreen] = createSignal(false);
  const unlisten: Array<() => void> = [];

  const title = (): string => props.title ?? "RefRain";

  const report = (error: unknown): void => {
    props.onError(error instanceof Error ? error.message : String(error));
  };

  const publishDisplay = (profile: DisplayProfile): void => {
    scheduleFrame("window.display-profile", () => {
      const root = document.documentElement;
      root.style.setProperty("--display-refresh-hz", String(profile.refreshHz));
      root.style.setProperty("--frame-budget-ms", `${profile.frameBudgetMs}ms`);
      root.style.setProperty("--hairline", `${profile.hairlineCssPx}px`);
      root.dataset.refreshMeasured = String(profile.refreshMeasured);
    });
  };

  const syncDisplay = async (): Promise<void> => {
    publishDisplay(await commands.displayProfile());
  };

  const syncWindowState = async (): Promise<void> => {
    const [isMaximized, isFullscreen] = await Promise.all([
      windowHandle.isMaximized(),
      windowHandle.isFullscreen(),
    ]);
    setMaximized(isMaximized);
    setFullscreen(isFullscreen);
  };

  const sync = async (): Promise<void> => {
    await Promise.all([syncDisplay(), syncWindowState()]);
  };

  const scheduleDisplaySync = (): void => {
    scheduleFrame("window.display-read", () => void syncDisplay().catch(report));
  };

  const scheduleWindowStateSync = (): void => {
    scheduleFrame("window.state-read", () => void syncWindowState().catch(report));
  };

  const minimize = (): void => {
    void windowHandle.minimize().catch(report);
  };

  const toggleMaximize = (): void => {
    void windowHandle.toggleMaximize().then(syncWindowState).catch(report);
  };

  const toggleFullscreen = (): void => {
    void windowHandle.setFullscreen(!fullscreen()).then(syncWindowState).catch(report);
  };

  const onTitlebarDoubleClick = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest(".window-actions")) return;
    toggleMaximize();
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "F11") return;
    event.preventDefault();
    toggleFullscreen();
  };

  onMount(() => {
    void sync().catch(report);
    window.addEventListener("keydown", onKeydown);
    void windowHandle.onResized(scheduleWindowStateSync).then((stop) => unlisten.push(stop));
    void windowHandle.onMoved(scheduleDisplaySync).then((stop) => unlisten.push(stop));
    void windowHandle.onScaleChanged(scheduleDisplaySync).then((stop) => unlisten.push(stop));
    void windowHandle
      .onCloseRequested((event) => {
        event.preventDefault();
        props.onCloseRequested();
      })
      .then((stop) => unlisten.push(stop));
  });

  onCleanup(() => {
    window.removeEventListener("keydown", onKeydown);
    cancelScheduledFrame("window.display-profile");
    cancelScheduledFrame("window.display-read");
    cancelScheduledFrame("window.state-read");
    for (const stop of unlisten) stop();
  });

  return (
    // Double-click is a pointer shortcut for native titlebar maximize. The
    // adjacent maximize button owns the keyboard-accessible action.
    // biome-ignore lint/a11y/noStaticElementInteractions: native titlebar pointer gesture
    <header class="window-chrome" data-tauri-drag-region onDblClick={onTitlebarDoubleClick}>
      <div class="brand" data-tauri-drag-region>
        <svg
          class="logo-mark"
          width={24}
          height={24}
          viewBox="0 0 48 48"
          fill="none"
          role="img"
          aria-label="RefRain"
        >
          <g stroke="currentColor" stroke-width="1.6">
            <path d="M10 11v26" stroke-width="3.2" />
            <path d="M13.6 11v26" stroke-width="1" />
            <path d="M23 13l-3.5 13M31 13l-3.5 13M39 13l-3.5 13" />
          </g>
          <path d="M18 33h23" stroke="var(--seal, #c1542f)" stroke-width="2" />
        </svg>
        <span class="wordmark" data-tauri-drag-region>
          RefRain
        </span>
        <Show when={title() !== "RefRain"}>
          <span class="document-title" data-tauri-drag-region>
            {title()}
          </span>
        </Show>
      </div>
      <nav class="window-actions" aria-label="窗口控制">
        <button type="button" aria-label="最小化" title="最小化" onClick={minimize}>
          <span class="minimize-glyph" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={maximized() ? "还原窗口" : "最大化窗口"}
          title={maximized() ? "还原窗口" : "最大化窗口"}
          onClick={toggleMaximize}
        >
          <span class="maximize-glyph" classList={{ restored: maximized() }} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={fullscreen() ? "退出全屏" : "进入全屏"}
          title={fullscreen() ? "退出全屏（F11）" : "进入全屏（F11）"}
          onClick={toggleFullscreen}
        >
          <span class="fullscreen-glyph" classList={{ active: fullscreen() }} aria-hidden="true" />
        </button>
        <button
          class="close"
          type="button"
          aria-label="关闭"
          title="关闭"
          onClick={() => props.onCloseRequested()}
        >
          <span class="close-glyph" aria-hidden="true" />
        </button>
      </nav>
    </header>
  );
}
