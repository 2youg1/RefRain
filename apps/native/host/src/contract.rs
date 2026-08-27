// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One mapping from the RefRain health use case to the generated Native host contract.

use crate::{protocol, refrain_app};
use refrain_app::NativeHealthError;

pub fn health(requested_protocol: u16) -> Result<protocol::RefrainNativeHealth, NativeHealthError> {
    refrain_app::native_health(requested_protocol, protocol::PROTOCOL_VERSION)
        .map(|_| protocol::health())
}

pub fn health_result(requested_protocol: u16) -> protocol::RefrainNativeHealthResult {
    let status = match health(requested_protocol) {
        Ok(_) => 0,
        Err(NativeHealthError::ProtocolMismatch { .. }) => protocol::HEALTH_ERROR_PROTOCOL_MISMATCH,
    };
    protocol::health_result(status)
}
