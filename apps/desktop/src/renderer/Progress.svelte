<script lang="ts">
  interface Props {
    /** 0 to 1. */
    value: number;
    style: "gradient" | "solid" | "minimap" | "off";
    place: "top" | "right";
    /** Paragraph offsets as fractions, for the minimap's tick marks. */
    marks?: number[];
  }

  const { value, style, place, marks = [] }: Props = $props();

  const pct = $derived(Math.max(0, Math.min(1, value)) * 100);
</script>

{#if style !== "off"}
  {#if style === "minimap"}
    <!--
      A minimap of the document rather than a bar: each paragraph is a tick, and
      the read position is a band across them. It answers "how far in am I"
      and "how is this chapter shaped" with the same glance.
    -->
    <div class="minimap" class:right={place === "right"}>
      {#each marks as mark, index (index)}
        <span class="tick" style="--at: {mark * 100}%" class:passed={mark <= value}></span>
      {/each}
      <span class="cursor" style="--at: {pct}%"></span>
    </div>
  {:else}
    <div class="bar {place}" class:solid={style === "solid"}>
      <span class="fill" style="--pct: {pct}%"></span>
    </div>
  {/if}
{/if}

<style>
  .bar {
    position: absolute;
    z-index: 20;
    background: color-mix(in oklab, var(--rule) 55%, transparent);
    pointer-events: none;
  }

  .bar.top {
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
  }

  .bar.right {
    top: 0;
    right: 0;
    bottom: 0;
    width: 2px;
  }

  .fill {
    display: block;
    /*
     * The gradient runs through the seal rather than between two arbitrary
     * ends: it starts in the ink, warms through the seal red, and resolves in
     * a lighter ochre. Stops are placed in OKLCH so the path stays even in
     * lightness and never crosses a muddy band.
     */
    background: linear-gradient(
      var(--progress-direction, 90deg),
      oklch(0.32 0.06 45),
      oklch(0.44 0.13 40) 28%,
      oklch(0.56 0.17 38) 55%,
      oklch(0.68 0.15 52) 78%,
      oklch(0.78 0.11 68)
    );
    transition: width 160ms var(--ease), height 160ms var(--ease);
  }

  .bar.top .fill {
    width: var(--pct);
    height: 100%;
  }

  .bar.right .fill {
    height: var(--pct);
    width: 100%;
    --progress-direction: 180deg;
  }

  .bar.solid .fill {
    background: var(--seal);
  }

  .minimap {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 14px;
    z-index: 20;
    pointer-events: none;
  }

  .tick {
    position: absolute;
    top: var(--at);
    right: 4px;
    width: 6px;
    height: 1px;
    background: var(--rule-strong);
    transition: background 200ms var(--ease), width 200ms var(--ease);
  }

  .tick.passed {
    background: color-mix(in oklab, var(--seal) 55%, transparent);
    width: 9px;
  }

  .cursor {
    position: absolute;
    top: var(--at);
    right: 2px;
    width: 10px;
    height: 2px;
    background: var(--seal);
    border-radius: 1px;
    transition: top 160ms var(--ease);
  }
</style>
