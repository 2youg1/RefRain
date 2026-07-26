<script lang="ts">
import type { Key, Lang } from "./i18n.ts";

interface Props {
  lang: Lang;
  theme: "paper" | "ink";
  t: (key: Key) => string;
  onLang: (next: Lang) => void;
  onTheme: (next: "paper" | "ink") => void;
}

const { lang, theme, t, onLang, onTheme }: Props = $props();
</script>

<div class="settings">
  <div class="field">
    <span class="label">{t("set.language")}</span>
    <div class="segmented">
      <button class:on={lang === "zh"} onclick={() => onLang("zh")}>中文</button>
      <button class:on={lang === "en"} onclick={() => onLang("en")}>English</button>
    </div>
  </div>

  <div class="field">
    <span class="label">{t("set.theme")}</span>
    <div class="segmented">
      <button class:on={theme === "paper"} onclick={() => onTheme("paper")}>{t("set.paper")}</button>
      <button class:on={theme === "ink"} onclick={() => onTheme("ink")}>{t("set.ink")}</button>
    </div>
  </div>

  <div class="field about">
    <span class="label">{t("set.about")}</span>
    <p>Recension 0.1.1</p>
    <p class="quiet">{t("set.noNetwork")}</p>
  </div>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 1.6rem;
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

  .about p {
    font-family: var(--serif);
    color: var(--ink-soft);
    line-height: 1.9;
  }

  .quiet {
    font-size: var(--step--1);
    color: var(--ink-faint);
  }
</style>
