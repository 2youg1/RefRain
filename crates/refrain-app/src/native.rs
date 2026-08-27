// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native-only use case shared by the Cargo crate and the fixed C ABI build.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeHealth {
    Ready,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeHealthError {
    ProtocolMismatch { requested: u16, supported: u16 },
}

pub const fn native_health(
    requested_protocol: u16,
    supported_protocol: u16,
) -> Result<NativeHealth, NativeHealthError> {
    if requested_protocol == supported_protocol {
        Ok(NativeHealth::Ready)
    } else {
        Err(NativeHealthError::ProtocolMismatch {
            requested: requested_protocol,
            supported: supported_protocol,
        })
    }
}
