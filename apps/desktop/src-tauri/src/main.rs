// The window is drawn by the webview, not by a console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    refrain_desktop_lib::run();
}
