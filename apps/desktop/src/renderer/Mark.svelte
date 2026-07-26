<script lang="ts">
  interface Props {
    size?: number;
    /** A picture the author chose instead of the mark. */
    custom?: string | null;
    title?: string;
    /** On the dark rail the ground stays cinnabar; only the surround changes. */
    inverted?: boolean;
  }

  const { size = 40, custom = null, title = "RefRain", inverted = false }: Props = $props();

  /**
   * The mark: a caret, cut into a seal face.
   *
   * Two earlier attempts failed in opposite directions. A rounded square with a
   * red outline was the grammar of a favicon — the frame shut the colour inside
   * a container instead of letting it sit on the page. Removing the frame
   * removed the metaphor with it, leaving a red button.
   *
   * A seal is square, edge to edge, with no rounding and no shadow, because it
   * is pressed into the surface rather than floating above it. The strokes are
   * reversed out of the ground — 白文, white text — which is what a carved seal
   * does. Nothing lands square, so the whole impression leans, the edges are
   * uneven, and the ink is thin in one corner where the pressure was light.
   */
  const ground = $derived(inverted ? "var(--seal-bright)" : "var(--seal)");
</script>

{#if custom}
  <img class="mark custom" src={custom} alt={title} width={size} height={size} />
{:else}
  <svg
    class="mark"
    width={size}
    height={size}
    viewBox="0 0 48 48"
    role="img"
    aria-label={title}
    fill="none"
  >
    <defs>
      <!-- Uneven pressure: the ink thins toward one corner. -->
      <linearGradient id="press" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color={ground} stop-opacity="1" />
        <stop offset="0.72" stop-color={ground} stop-opacity="0.96" />
        <stop offset="1" stop-color={ground} stop-opacity="0.82" />
      </linearGradient>
      <mask id="cut">
        <rect width="48" height="48" fill="#fff" />
        <!-- The caret, reversed out of the impression. -->
        <path
          d="M12.6 34.4 L23.4 13.2 Q24 12.1 24.6 13.2 L35.4 34.4"
          stroke="#000"
          stroke-width="5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path d="M17.4 39.6 Q24 37.4 30.6 39.6" stroke="#000" stroke-width="3" stroke-linecap="round" />
      </mask>
    </defs>

    <!--
      The impression: square, unrounded, and never quite true. The corners are
      each clipped by a different amount and no two edges are the same length,
      because a cut seal is worn unevenly and a mathematically perfect square
      is the one thing that reads as a logo rather than as an impression.
    -->
    <path
      d="M4.8 3.9 L43.4 3.4 L44.3 42.6 L43.1 44.4 L5.4 44.8 L3.6 43.2 L3.9 5.6 Z"
      fill="url(#press)"
      mask="url(#cut)"
      transform="rotate(-1.8 24 24)"
    />
  </svg>
{/if}

<style>
  .mark {
    display: block;
    flex: none;
  }

  .custom {
    border-radius: 2px;
    object-fit: cover;
  }
</style>
