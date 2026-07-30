/* The shell mounts and provides. It holds no state machine and coordinates
   nothing (SPEC 9.10). */

import { render } from "solid-js/web";
import { App } from "./App";
import "./app.css";
import "./fonts.css";
import "./themes.css";
import "./styles/surfaces.css";

const host = document.getElementById("app");
if (host === null) throw new Error("mount point #app is missing from index.html");
render(() => <App />, host);
