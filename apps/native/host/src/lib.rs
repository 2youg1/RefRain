//! Rust-side tests for the generated Native host contract.

#![forbid(unsafe_code)]

mod contract;
mod protocol;

pub(crate) use ::refrain_app;
pub use contract::{health, health_result};
pub use protocol::{RefrainNativeHealth, RefrainNativeHealthResult};
pub use refrain_app::NativeHealthError;

#[cfg(test)]
mod tests {
    use super::{NativeHealthError, health, health_result};

    #[test]
    fn health_delegates_to_the_app_use_case_and_reports_the_generated_contract() {
        let report = health(1).expect("matching protocol must be ready");
        assert_eq!(report.protocol_version, 1);
        assert_eq!(report.api_version, 1);
        assert_eq!(report.capabilities, 1);
        assert_eq!(
            health(2),
            Err(NativeHealthError::ProtocolMismatch {
                requested: 2,
                supported: 1,
            })
        );

        let ready = health_result(1);
        assert_eq!(ready.status, 0);
        assert_eq!(ready.protocol_version, 1);
        assert_eq!(ready.api_version, 1);
        assert_eq!(ready.capabilities, 1);

        let mismatch = health_result(2);
        assert_eq!(mismatch.status, 1);
        assert_eq!(mismatch.protocol_version, 1);
        assert_eq!(mismatch.api_version, 0);
        assert_eq!(mismatch.capabilities, 0);
    }
}
