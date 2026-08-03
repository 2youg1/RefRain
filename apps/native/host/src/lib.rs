//! Rust owner of the Native SDK host dispatch.

#![deny(unsafe_code)]

mod document;
mod protocol;
#[allow(unsafe_code)]
mod staticlib;

pub use protocol::{RefrainNativeRequest, RefrainNativeResponse};
