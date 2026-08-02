// 探针入口：挂上真 Workbench。Tauri 内部件由 probe-shell-wiring.ts 在页面
// 加载前注入（addInitScript），这里不分辨自己与真窗口的差别——那正是目的。
import { render } from "solid-js/web";
import { Workbench } from "../../src/shell/Workbench";
import "../../src/app.css";
import "../../src/fonts.css";
import "../../src/themes.css";
import "../../src/styles/surfaces.css";

const host = document.getElementById("app");
if (host === null) throw new Error("probe mount point #app missing");
render(() => <Workbench />, host);
