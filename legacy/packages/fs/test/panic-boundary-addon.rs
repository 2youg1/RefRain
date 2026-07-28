//! Deliberately panicking N-API addon for the A-10 release boundary gate.
//!
//! This is an example target rather than production surface. Cargo compiles it
//! with the package's real release profile, then the boundary test loads the
//! resulting dynamic library in a disposable Node process.

use napi_derive::napi;

#[napi(catch_unwind)]
pub fn panic_at_napi_boundary() {
    panic!("A-10 panic boundary probe");
}

#[napi]
pub fn boundary_survived() -> String {
    "alive-after-panic".into()
}
