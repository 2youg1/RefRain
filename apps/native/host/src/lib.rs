// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rust owner of the Native SDK host dispatch.

#![deny(unsafe_code)]

mod document;
mod project;
mod project_wire;
mod protocol;
// The one `unsafe` seam in the workspace (docs/ARCHITECTURE.md, L4). `#[expect]`
// rather than `#[allow]`: on the day this module holds no `unsafe`, the
// attribute reports itself instead of outliving its reason.
#[expect(
    unsafe_code,
    reason = "the C ABI entry points are this crate's one unsafe seam"
)]
mod staticlib;
mod wire;

pub use protocol::{RefrainNativeRequest, RefrainNativeResponse};
