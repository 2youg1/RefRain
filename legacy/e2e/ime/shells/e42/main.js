// Shared Electron shell. Usage: electron main.js <shellName>
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const shellName = process.argv[2] || "unknown";
const outDir = path.join(__dirname, "..", "..", "results", shellName);
fs.mkdirSync(outDir, { recursive: true });

let win;
app.whenReady().then(() => {
  win = new BrowserWindow({
    x: 60,
    y: 60,
    width: 1100,
    height: 800,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true },
  });
  const page = path.join(__dirname, "..", "..", "page", "editor.html");
  win.loadFile(page, { query: { shell: shellName } });
  win.webContents.on("did-finish-load", () => {
    setInterval(async () => {
      try {
        if (!win || win.isDestroyed()) return;
        const ready = await win.webContents.executeJavaScript(
          "!!(window.__ime && window.__ime.ready)",
        );
        if (ready) fs.writeFileSync(path.join(outDir, "ready.flag"), String(Date.now()));
        const json = await win.webContents.executeJavaScript(
          'window.__getReport ? JSON.stringify(window.__getReport()) : "{}"',
        );
        fs.writeFileSync(path.join(outDir, "latest.json"), json);
      } catch (e) {
        /* window navigating/closing */
      }
    }, 1000);
  });
});
app.on("window-all-closed", () => app.quit());
