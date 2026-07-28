/// <reference types="vite/client" />

/**
 * CSS reaches the bundle as a side effect, not as a value.
 *
 * TypeScript 7 refuses a side-effect import of a file it has no declaration
 * for, and `vite/client` declares the `?inline` and default-export forms but
 * not the bare `import "./app.css"` this renderer uses.
 */
declare module "*.css";

/** Injected by Vite from package.json; see vite.config.ts. */
declare const __APP_VERSION__: string;
