//! Rust owner of the Native SDK host dispatch.

#![deny(unsafe_code)]

mod document;
mod project;
mod project_wire;
mod protocol;
#[allow(unsafe_code)]
mod staticlib;
mod wire;

pub use protocol::{RefrainNativeRequest, RefrainNativeResponse};
