import type { JSX } from "solid-js";

export type LogoMarkProps = {
  size?: number;
  label?: string;
};

export function LogoMark(props: LogoMarkProps): JSX.Element {
  return (
    <svg
      class="logo-mark"
      width={props.size ?? 28}
      height={props.size ?? 28}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label={props.label ?? "RefRain"}
    >
      <g stroke="currentColor" stroke-width="1.6">
        <path d="M10 11v26" stroke-width="3.2" />
        <path d="M13.6 11v26" stroke-width="1" />
        <path d="M23 13l-3.5 13M31 13l-3.5 13M39 13l-3.5 13" />
      </g>
      <path d="M18 33h23" stroke="var(--seal, #c1542f)" stroke-width="2" />
    </svg>
  );
}
