import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  // Relative base: the packaged app loads from file://, where absolute paths break.
  base: "./",
  build: { outDir: "dist/renderer", emptyOutDir: true, target: "chrome150" },
  server: { port: 5173, strictPort: true },
});
