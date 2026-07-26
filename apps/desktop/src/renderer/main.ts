import { mount } from "svelte";
import App from "./App.svelte";
import "./fonts.css";
import "./themes.css";
import "./app.css";

mount(App, { target: document.getElementById("app") as HTMLElement });
