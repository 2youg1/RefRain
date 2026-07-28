import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  // Tauri serves the built files; a fixed port keeps devUrl honest.
  server: { port: 5173, strictPort: true },
  build: { target: "chrome120", sourcemap: true, emptyOutDir: true },
});
