//! Persistence authority for RefRain.
//!
//! Every mutable disk path and both databases live behind this crate (SPEC 6.2).
//! C3 lands the atomic writer, the single Config authority, and the Project
//! store; indexing, search, and trash arrive with C4.

#![forbid(unsafe_code)]

pub mod atomic;
pub mod config;
pub mod files;
pub mod ledger;
pub mod project;
pub mod root;
pub mod schema;

pub use schema::{AppDb, Database, ProjectDb, SchemaVersion, open_in_memory};
