//! Cargo-linked fixed C ABI used by the Native SDK executable.
//!
//! This module is the one place a raw pointer crosses into Rust. It resolves the
//! borrowed request text into a safe slice immediately, so every module behind
//! it works with ordinary borrows under `#![deny(unsafe_code)]`.

use crate::protocol::{EVENT_TEXT_BYTES, RefrainNativeRequest, RefrainNativeResponse};

#[unsafe(no_mangle)]
pub extern "C" fn refrain_native_dispatch(request: RefrainNativeRequest) -> RefrainNativeResponse {
    let text = borrow_request_text(&request);
    crate::document::dispatch(request, text)
}

/// Resolve the borrowed request text into a slice.
///
/// The caller guarantees `text` addresses `text_len` initialised bytes that stay
/// valid for the whole synchronous dispatch call. Out-of-range lengths and null
/// pointers resolve to an empty slice, which each use case then refuses as
/// invalid input rather than reading.
fn borrow_request_text(request: &RefrainNativeRequest) -> &[u8] {
    let Ok(length) = usize::try_from(request.text_len) else {
        return &[];
    };
    if length == 0 || length > EVENT_TEXT_BYTES || request.text.is_null() {
        return &[];
    }
    // SAFETY: the Native bridge points `text` at `text_len` decoded payload
    // bytes and keeps that payload alive until this call returns. The slice is
    // consumed inside `dispatch` and never stored.
    unsafe { std::slice::from_raw_parts(request.text, length) }
}

/// Read the projection bytes a response lends to its caller.
///
/// The Zig bridge does exactly this each frame: bound the borrowed pointer by
/// `text_len` and read it before the next dispatch replaces the buffer.
#[cfg(test)]
pub(crate) fn borrow_response_text(response: &RefrainNativeResponse) -> &str {
    if response.text_len == 0 {
        return "";
    }
    // SAFETY: the response borrows the projection string owned by the session
    // that produced it, which stays alive until that session projects again.
    let bytes = unsafe { std::slice::from_raw_parts(response.text, response.text_len as usize) };
    std::str::from_utf8(bytes).expect("a projection is always UTF-8")
}
