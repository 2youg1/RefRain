// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Persistence authority for RefRain.
//!
//! Every mutable disk path and both databases live behind this crate (SPEC 6.2).
//! C3 lands the atomic writer, the single Config authority, and the Project
//! store; indexing, search, and trash arrive with C4.

#![forbid(unsafe_code)]

pub mod annotations;
pub mod application;
pub mod atomic;
pub mod config;
pub(crate) mod files;
pub mod history;
pub mod icons;
pub mod ingest;
pub mod ledger;
pub mod mailbox;
pub mod materials;
pub mod orchestration;
pub mod project;
pub mod root;
pub mod schema;

pub use schema::{AppDb, Database, ProjectDb, SchemaVersion, open_in_memory};
