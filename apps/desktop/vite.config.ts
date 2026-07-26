import { readFileSync } from "node:fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The About page reads this. A version typed into a component goes stale the
// first time someone forgets it — which is how it came to say 0.1.2 while the
// package said 0.1.3.
const { version } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [svelte()],
  // Relative base: the packaged app loads from file://, where absolute paths break.
  base: "./",
  build: { outDir: "dist/renderer", emptyOutDir: true, target: "chrome150" },
  server: { port: 5173, strictPort: true },
});
