# e2e/ime — Windows IME (TSF) acceptance gate

Same ProseMirror page (~100k chars of Chinese text, fully instrumented) loaded into four
shells, driven by the real Microsoft Pinyin IME via `SendInput`:

| shell | engine |
|---|---|
| `e42` | Electron 42.7.1 (Chromium 148) — the pinned baseline |
| `e43` | Electron 43.2.0 (Chromium 150) |
| `e44` | Electron 44.0.0-alpha.6 (Chromium 152) |
| `wv2` | WebView2 (Tauri's Windows engine), hosted via PowerShell + WebView2 SDK |

Criteria per shell: first-click focus with candidate window, 60 s continuous pinyin with
zero dropped words, `，。？！` × 10 each committed on first press, no composition stuck
over 3 s, no rendering stall. `driver/assert.js` turns these into exit codes; CI runs it
as the `ime-gate` workflow and uploads `results/` (JSON event logs + full-screen PNGs)
as an artifact.

## Run locally (Windows, MS Pinyin installed)

```powershell
e2e/ime/scripts/prepare.ps1                          # once: deps + Electron binaries + page build
e2e/ime/driver/drive.ps1 -Shell e43                  # one shell, ~2.5 min, takes over mouse/keyboard
node e2e/ime/driver/analyze.js; node e2e/ime/driver/assert.js
```

Do not touch the machine while a run is active: the driver moves the real mouse, clicks
the editor, and types through the real IME. `BASELINE-2026-07-25.md` records the first
four-shell green run and its measurement caveats (machine-paced typing; wv2 is an
engine-equivalent stand-in for Tauri, not the Tauri runtime itself).
