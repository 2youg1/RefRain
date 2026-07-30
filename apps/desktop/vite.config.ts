import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  // Tauri serves the built files; a fixed port keeps devUrl honest.
  server: { port: 5173, strictPort: true },
  build: { target: "chrome120", sourcemap: true, emptyOutDir: true },
});
