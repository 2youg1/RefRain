<script lang="ts">
  
  import type { Snippet } from "svelte";
import type { Key, Lang } from "./i18n.ts";

  export type Section =
    | "appearance"
    | "typography"
    | "editor"
    | "agents"
    | "shortcuts"
    | "about"
    | null;

  /**
   * The four addresses the About page offers. Main holds the same list and
   * refuses anything else, so this constant is a convenience rather than the
   * security boundary.
   */
  const REPOSITORY = "https://github.com/kaile9/RefRain";

  interface Props {
    lang: Lang;
    version: string;
    theme: "rain" | "kozo" | "ink";
    surface: "opaque" | "translucent" | "glass";
    sheet: "none" | "hairline" | "paper";
    layout: "page" | "canvas";
    t: (key: Key) => string;
    section: Section;
    onSection: (next: Section) => void;
    onLang: (next: Lang) => void;
    onTheme: (next: "rain" | "kozo" | "ink") => void;
    onSurface: (next: "opaque" | "translucent" | "glass") => void;
    onSheet: (next: "none" | "hairline" | "paper") => void;
    onLayout: (next: "page" | "canvas") => void;
    onIcon: (dataUrl: string | null) => void;
    onOpenUrl: (url: string) => void;
    typography: Snippet;
    agents: Snippet;
    shortcuts: Snippet;
  }

  const {
    lang,
    version,
    theme,
    surface,
    sheet,
    layout,
    t,
    section,
    onSection,
    onLang,
    onTheme,
    onSurface,
    onSheet,
    onLayout,
    onIcon,
    onOpenUrl,
    typography,
    agents,
    shortcuts,
  }: Props = $props();

  /**
   * Settings is a place, not a panel. Each subject opens as its own page so a
   * long list of controls never has to share a scroll with an unrelated one —
   * and so typography, which has fifteen of them, gets the room it needs.
   */
  const sections: { id: Exclude<Section, null>; label: Key }[] = [
    { id: "appearance", label: "set.appearance" },
    { id: "typography", label: "typo.title" },
    { id: "editor", label: "set.editor" },
    { id: "agents", label: "agents.title" },
    { id: "shortcuts", label: "set.shortcuts" },
    { id: "about", label: "set.about" },
  ];

  const pickIcon = (event: Event): void => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onIcon(String(reader.result));
    reader.readAsDataURL(file);
  };
</script>

<div class="settings">
  <nav>
    {#each sections as entry (entry.id)}
      <button class:on={section === entry.id} onclick={() => onSection(entry.id)}>
        {t(entry.label)}
      </button>
    {/each}
  </nav>

  <div class="page">
    {#if section === "appearance"}
      <div class="field">
        <span class="label">{t("set.theme")}</span>
        <div class="segmented">
          <button class:on={theme === "rain"} onclick={() => onTheme("rain")}>{t("set.ai")}</button>
          <button class:on={theme === "kozo"} onclick={() => onTheme("kozo")}>
            {t("set.kozo")}
          </button>
          <button class:on={theme === "ink"} onclick={() => onTheme("ink")}>{t("set.ink")}</button>
        </div>
      </div>

      <div class="field">
        <span class="label">{t("set.surface")}</span>
        <div class="segmented">
          <button class:on={surface === "opaque"} onclick={() => onSurface("opaque")}>
            {t("set.opaque")}
          </button>
          <button class:on={surface === "translucent"} onclick={() => onSurface("translucent")}>
            {t("set.translucent")}
          </button>
          <button class:on={surface === "glass"} onclick={() => onSurface("glass")}>
            {t("set.glass")}
          </button>
        </div>
        <p class="hint">{t("set.surfaceHint")}</p>
      </div>

      <div class="field">
        <span class="label">{t("set.language")}</span>
        <div class="segmented">
          <button class:on={lang === "zh"} onclick={() => onLang("zh")}>中文</button>
          <button class:on={lang === "en"} onclick={() => onLang("en")}>English</button>
        </div>
      </div>

      <div class="field">
        <span class="label">{t("set.icon")}</span>
        <div class="icon-row">
          <label class="file">
            {t("set.iconPick")}
            <input type="file" accept="image/*" onchange={pickIcon} />
          </label>
          <button class="quiet" onclick={() => onIcon(null)}>{t("set.iconReset")}</button>
        </div>
        <p class="hint">{t("set.iconHint")}</p>
      </div>
    {:else if section === "typography"}
      {@render typography()}
    {:else if section === "editor"}
      <div class="field">
        <span class="label">{t("set.sheet")}</span>
        <div class="segmented">
          <button class:on={sheet === "none"} onclick={() => onSheet("none")}>
            {t("set.sheetNone")}
          </button>
          <button class:on={sheet === "hairline"} onclick={() => onSheet("hairline")}>
            {t("set.sheetHairline")}
          </button>
          <button class:on={sheet === "paper"} onclick={() => onSheet("paper")}>
            {t("set.sheetPaper")}
          </button>
        </div>
        <p class="hint">{t("set.sheetHint")}</p>
      </div>

      <div class="field">
        <span class="label">{t("set.layout")}</span>
        <div class="segmented">
          <button class:on={layout === "page"} onclick={() => onLayout("page")}>
            {t("set.page")}
          </button>
          <!--
            The canvas layout is designed but not built. A switch that changes
            nothing is worse than an absent one: it teaches the author that
            settings here may be decorative.
          -->
          <button class="pending" disabled>{t("set.canvas")}</button>
        </div>
        <p class="hint">{t("set.layoutHint")}</p>
      </div>
    {:else if section === "agents"}
      {@render agents()}
    {:else if section === "shortcuts"}
      {@render shortcuts()}
    {:else if section === "about"}
      <div class="field about">
        <p class="version">RefRain {version}</p>
        <p class="quiet-text">{t("set.noNetwork")}</p>
        <p class="quiet-text">{t("set.fonts")}</p>
        <p class="quiet-text">{t("set.openExternal")}</p>
        <div class="links">
          <!--
            An external link opens in the system browser, never in a window of
            this application: the app makes no requests of its own, and a page
            rendered inside it would be exactly that.
          -->
          <button class="link" onclick={() => onOpenUrl(REPOSITORY)}>{t("set.repo")}</button>
          <button class="link" onclick={() => onOpenUrl(`${REPOSITORY}/issues`)}>
            {t("set.issues")}
          </button>
          <button class="link" onclick={() => onOpenUrl(`${REPOSITORY}/discussions`)}>
            {t("set.discussions")}
          </button>
          <button class="link" onclick={() => onOpenUrl(`${REPOSITORY}/blob/main/LICENSE`)}>
            {t("set.licence")}
          </button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .settings {
    display: grid;
    grid-template-columns: 128px minmax(0, 1fr);
    gap: 1.4rem;
    height: 100%;
    min-height: 0;
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-right: 1px solid var(--rule);
    padding-right: 0.6rem;
  }

  nav button {
    text-align: left;
    padding: 0.42rem 0.55rem;
    border-radius: 3px;
    font-size: var(--step--1);
    color: var(--ink-faint);
    border-left: 2px solid transparent;
  }

  nav button:hover {
    color: var(--ink-soft);
  }

  nav button.on {
    color: var(--ink);
    border-left-color: var(--seal);
    background: color-mix(in oklab, var(--seal) 6%, transparent);
  }

  .page {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    overflow-y: auto;
    min-height: 0;
    padding-right: 0.4rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .segmented {
    display: flex;
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    overflow: hidden;
  }

  .segmented button {
    flex: 1;
    padding: 0.5rem 0;
    font-size: var(--step--1);
    color: var(--ink-soft);
    background: var(--paper-raised);
    border-right: 1px solid var(--rule);
  }

  .segmented button:last-child {
    border-right: none;
  }

  .segmented button.on {
    background: var(--ink);
    color: var(--paper-raised);
  }

  .segmented button.pending {
    color: var(--ink-ghost);
    cursor: not-allowed;
  }

  .segmented button.pending::after {
    content: " ·";
    color: var(--seal);
  }

  .hint {
    font-size: var(--step--2);
    color: var(--ink-faint);
    line-height: 1.75;
  }

  .icon-row {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }

  .file {
    padding: 0.4rem 0.8rem;
    font-size: var(--step--1);
    border: 1px solid var(--rule-strong);
    border-radius: 2px;
    color: var(--ink-soft);
    cursor: pointer;
  }

  .file:hover {
    border-color: var(--seal);
    color: var(--seal);
  }

  .file input {
    display: none;
  }

  .quiet {
    font-size: var(--step--2);
    color: var(--ink-ghost);
  }

  .quiet:hover {
    color: var(--refused);
  }

  .about p {
    line-height: 1.95;
  }

  .version {
    font-family: var(--serif);
    font-size: var(--step-0);
  }

  .quiet-text {
    font-size: var(--step--1);
    color: var(--ink-faint);
  }

  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 1.4rem;
    margin-top: 0.9rem;
  }

  .link {
    font-size: var(--step--1);
    color: var(--seal);
    padding: 0;
    /* An underline offset by the descender height, so it reads as a link
       without cutting through the hooks of 源 or 议. */
    text-decoration: underline;
    /* Chinese needs a heavier rule than Latin at the same size: at 1px and 45%
       opacity the line vanished into the strokes of 源 and 议, so only the
       link containing Latin characters read as underlined at all. */
    text-underline-offset: 0.24em;
    text-decoration-thickness: 1.5px;
    text-decoration-color: color-mix(in oklab, var(--seal) 68%, transparent);
  }

  .link:hover {
    color: var(--seal-bright);
    text-decoration-color: currentColor;
  }
</style>
