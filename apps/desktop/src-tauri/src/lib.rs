//! Composition layer.
//!
//! Every command here is a one-line mapping onto a named use case. No business
//! state lives in this crate, and no domain rule is decided here (SPEC 6.2).

use refrain_core::HealthReport;
use tauri_specta::{Builder, collect_commands};

/// The commit this build was made from. Set by CI; absent in a local build,
/// and absent is reported as absent rather than as an empty string (INV-3's
/// discipline applied to identity: unknown is a value, not a blank).
const COMMIT: Option<&str> = option_env!("REFRAIN_COMMIT");

/// Proves the whole chain: a Rust type, a generated binding, a real window.
#[tauri::command]
#[specta::specta]
fn health(echo: String) -> HealthReport {
    refrain_core::health(echo, env!("CARGO_PKG_VERSION"), COMMIT)
}

/// The single command registry. Generation and the runtime read the same list,
/// so a command cannot exist in one and be missing from the other.
pub fn builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![health])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = builder();

    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running RefRain");
}
