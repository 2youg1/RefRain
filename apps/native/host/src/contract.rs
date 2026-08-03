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
