import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { describe } from "../bridge";
import { commands } from "../generated/bindings.gen";
import { universalIcon } from "../shell/universal-icon";

type UniversalButtonProps = {
  onActivate?: () => void;
};

export function UniversalButton(props: UniversalButtonProps) {
  const [revealed, setRevealed] = createSignal(false);
  const icon = universalIcon();
  const iconUrl = icon.url;
  const error = icon.error;
  let hideTimer: number | null = null;

  const reveal = (): void => {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    setRevealed(true);
  };

  const scheduleHide = (event: PointerEvent): void => {
    const zone = event.currentTarget as HTMLElement;
    if (zone.contains(document.activeElement)) return;
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      setRevealed(false);
    }, 240);
  };

  const activate = (): void => {
    setRevealed(false);
    props.onActivate?.();
  };

  onCleanup(() => {
    if (hideTimer !== null) window.clearTimeout(hideTimer);
  });

  return (
    <>
      <div class="universal-hot-zone" aria-hidden="true" onPointerEnter={reveal} />
      <div
        class="universal-button-zone"
        classList={{ revealed: revealed() }}
        onPointerEnter={reveal}
        onPointerLeave={scheduleHide}
      >
        <button
          type="button"
          class="universal-button"
          title="打开命令菜单（Ctrl+K）"
          aria-label="打开命令菜单"
          onFocus={reveal}
          onClick={activate}
        >
          <Show
            when={iconUrl()}
            fallback={
              <svg
                class="logo-mark"
                width={20}
                height={20}
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
            }
          >
            {(url) => <img src={url()} alt="" />}
          </Show>
        </button>
        <Show when={error() !== null}>
          <span class="universal-icon-error" role="status">
            图标不可用
          </span>
        </Show>
      </div>
    </>
  );
}
