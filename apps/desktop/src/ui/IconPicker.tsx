// The Universal Button's icon picker (SPEC 9.8): the pipeline judges by
// content, the Config stores only the digest, and the button shows the
// normalised asset through a data URL (CSP img-src 'self' data:).

import { Show } from "solid-js";
import { unwrap } from "../bridge";
import { commands } from "../generated/bindings.gen";
import { universalIcon } from "../shell/universal-icon";

export function IconPicker() {
  const icon = universalIcon();
  const iconUrl = icon.url;
  const error = icon.error;
  let fileInput: HTMLInputElement | undefined;

  const pick = (): void => {
    fileInput?.click();
  };

  const chosen = async (event: Event): Promise<void> => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const bytes = [...new Uint8Array(await file.arrayBuffer())];
      await unwrap(commands.setUniversalIcon(bytes));
      await icon.refresh();
    } catch (cause) {
      icon.fail(cause);
    } finally {
      input.value = "";
    }
  };

  return (
    <div class="icon-picker">
      <button type="button" class="icon-button" title="写作入口图标" onClick={pick}>
        <Show
          when={iconUrl()}
          fallback={
            <svg
              class="logo-mark"
              width={18}
              height={18}
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
          {(url) => <img src={url()} alt="写作入口图标" />}
        </Show>
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".svg,image/svg+xml,.png,image/png"
        style={{ display: "none" }}
        onChange={(event) => void chosen(event)}
      />
      <Show when={error() !== null}>
        <p class="error">{error()}</p>
      </Show>
    </div>
  );
}
