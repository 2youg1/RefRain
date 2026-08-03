//! Cargo-linked fixed C ABI used by the Native SDK executable.

use crate::protocol::{RefrainNativeRequest, RefrainNativeResponse};

#[unsafe(no_mangle)]
pub extern "C" fn refrain_native_dispatch(request: RefrainNativeRequest) -> RefrainNativeResponse {
    crate::document::dispatch(request)
}
