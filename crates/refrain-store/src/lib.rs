//! Persistence authority for RefRain.
//!
//! Every mutable disk path and both databases live behind this crate (SPEC 6.2).
//! R0 establishes the schema frames only; the tables themselves arrive in R1.

#![forbid(unsafe_code)]

pub mod schema;

pub use schema::{AppDb, Database, ProjectDb, SchemaVersion, open_in_memory};
