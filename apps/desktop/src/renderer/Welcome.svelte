<script lang="ts">
import type { Key } from "./i18n.ts";
import Mark from "./Mark.svelte";
import Palette, { type Command } from "./Palette.svelte";

interface Props {
  t: (key: Key) => string;
  icon: string | null;
  commands: Command[];
  paletteOpen: boolean;
  dragging: boolean;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onCreate: () => void;
  onPaletteOpen: () => void;
  onPaletteClose: () => void;
}

const {
  t,
  icon,
  commands,
  paletteOpen,
  dragging,
  onOpenFolder,
  onOpenFile,
  onCreate,
  onPaletteOpen,
  onPaletteClose,
}: Props = $props();
</script>

<main class="welcome" class:dragging>
  <Mark size={54} custom={icon} />
  <h1>RefRain</h1>
  <p class="tagline">{t("app.tagline")}</p>

  <div class="actions">
    <button class="primary" onclick={onOpenFolder}>{t("welcome.open")}</button>
    <button onclick={onOpenFile}>{t("welcome.openFile")}</button>
    <button onclick={onCreate}>{t("welcome.create")}</button>
  </div>

  <p class="drop">{t("welcome.drop")}</p>
  <p class="fine">{t("welcome.fine")}</p>
  <p class="fine key">{t("welcome.hint")}</p>

  <!-- The palette must be mounted for its keyboard shortcut to work, but the
       welcome screen has its own three buttons and does not need the control. -->
  <div class="hidden-entry">
    <Palette open={paletteOpen} {commands} {t} {icon} onOpen={onPaletteOpen} onClose={onPaletteClose} />
  </div>
</main>

<style>
.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  gap: 0;
  text-align: center;
  /* Optically centred: the block is top-heavy, so geometric centring sinks it. */
  padding: 2rem 2rem 9vh;
  transition: background 200ms var(--ease);
}

.welcome.dragging {
  background: var(--seal-wash);
}

h1 {
  font-family: var(--display);
  font-size: var(--step-4);
  font-weight: 400;
  letter-spacing: 0.04em;
  margin-top: 1.4rem;
}

/*
 * `line-break: strict` and `word-break: keep-all` keep Chinese from breaking
 * inside a word: an earlier build split 不联网 across two lines, which reads
 * as a typo rather than as a wrap. One measure for both paragraphs, so the
 * ragged edge stays in one place.
 */
.tagline {
  font-family: var(--serif);
  color: var(--ink-soft);
  max-width: 30em;
  line-height: 1.95;
  margin-top: 1.5rem;
  line-break: strict;
  word-break: keep-all;
  text-wrap: balance;
}

.actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 2.3rem;
}

.actions button {
  padding: 0.58rem 1.3rem;
  border: 1px solid var(--rule-strong);
  border-radius: 3px;
  font-size: var(--step--1);
  color: var(--ink-soft);
  background: var(--paper-raised);
  transition:
    transform 200ms var(--spring),
    border-color 160ms var(--ease),
    color 160ms var(--ease);
}

.actions button:hover {
  border-color: var(--seal);
  color: var(--seal);
  transform: translateY(-1px);
}

.actions .primary {
  background: var(--ink);
  border-color: var(--ink);
  color: var(--paper-raised);
}

.actions .primary:hover {
  background: var(--seal);
  border-color: var(--seal);
  color: var(--paper-raised);
}

/*
 * A functional affordance outranks the background note beneath it. An earlier
 * build had these reversed, so the one sentence describing a real capability
 * was the faintest thing on the screen.
 */
.drop {
  font-size: var(--step--1);
  color: var(--ink-faint);
  margin-top: 0.9rem;
}

.welcome.dragging .drop {
  color: var(--seal);
}

.fine {
  font-size: var(--step--2);
  color: var(--ink-ghost);
  max-width: 30em;
  margin-top: 2.6rem;
  line-height: 1.9;
  line-break: strict;
  word-break: keep-all;
  text-wrap: balance;
}

/* The one keystroke that reaches everything else. Stated once, on first run. */
.fine.key {
  margin-top: 0.5rem;
  color: var(--ink-faint);
  letter-spacing: 0.03em;
}

.hidden-entry {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}
</style>
