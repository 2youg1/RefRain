<script lang="ts">
interface Props {
  size?: number;
  /** A picture the author chose instead of the mark. */
  custom?: string | null;
  title?: string;
  /** On the dark rail the rule stays cinnabar; only the strokes change. */
  inverted?: boolean;
}

const { size = 40, custom = null, title = "RefRain", inverted = false }: Props = $props();

/**
 * The mark: 起段, a repeat sign.
 *
 * This component used to draw something else entirely — a square seal with a
 * caret knocked out of it — while `assets/mark.svg` held the repeat sign and
 * `make-icon.ts` rendered *that* into the application icon. Two marks, both in
 * the repository, one on screen and the other on the desktop, and nothing said
 * which was the mark. They are now one: this file and that file must draw the
 * same thing, and `verify-mark.ts` fails if they drift apart again.
 *
 * The barline is deliberately uneven — thick then thin, tight together. Two
 * equal bars at this size read as a pause button; a real repeat sign is
 * uneven, so copying the notation is what avoids the misread.
 *
 * A repeat sign is the right figure for this application: it marks the point a
 * passage returns to and is read again. Nothing here is a literal colour — the
 * strokes take `currentColor` and the rule reads `--role-pending` — so one
 * drawing serves all eight themes, light and dark.
 */
const rule = $derived(inverted ? "var(--seal-bright)" : "var(--role-pending, var(--seal))");
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
    <g stroke="currentColor" stroke-width="1.6">
      <path d="M10 11v26" stroke-width="3.2" />
      <path d="M13.6 11v26" stroke-width="1" />
      <path d="M23 13l-3.5 13M31 13l-3.5 13M39 13l-3.5 13" />
    </g>
    <path d="M18 33h23" stroke={rule} stroke-width="2" />
  </svg>
{/if}

<style>
  .mark {
    display: block;
    flex: none;
  }

  .custom {
    object-fit: cover;
    border-radius: 2px;
  }
</style>
