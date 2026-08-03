//! Minimal `no_std` archive linked into the Native SDK executable.

#![no_std]
#![deny(unsafe_op_in_unsafe_fn)]

#[path = "../../../../crates/refrain-app/src/native.rs"]
mod refrain_app;
mod contract;
mod protocol;

#[unsafe(no_mangle)]
pub extern "C" fn refrain_native_health(
    requested_protocol: u16,
) -> protocol::RefrainNativeHealthResult {
    contract::health_result(requested_protocol)
}

/// `compiler_builtins` retains this DWARF symbol under panic=abort. No unwind
/// reaches it; defining the symbol keeps the archive independent of libstd.
#[unsafe(no_mangle)]
pub extern "C" fn rust_eh_personality() {}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    loop {
        core::hint::spin_loop();
    }
}
