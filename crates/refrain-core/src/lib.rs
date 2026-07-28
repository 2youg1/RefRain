//! Pure domain for RefRain.
//!
//! This crate names the concepts in SPEC section 2 and nothing else. It does not
//! reach a database, a filesystem path, a process, a window, or a harness; those
//! belong to `refrain-store` and `refrain-host`. The boundary is mechanical:
//! `verify:core-purity` fails the build when a forbidden dependency appears here.

#![forbid(unsafe_code)]

pub mod error;
pub mod health;
pub mod id;

pub use error::{ErrorCode, RecoveryStep, RefrainError};
pub use health::{HealthReport, health};
pub use id::Id;
