//! RefRain's native file layer.
//!
//! Traversal, search, sort, move, link, and a delete that goes to the system
//! trash. The layer exists because these operations sit on the interaction
//! path: a writer scrolling a folder of two thousand chapters should never see
//! the list arrive.
//!
//! Rust rather than TypeScript for three reasons that are measurable, not
//! aesthetic: the traversal is parallel and JavaScript has one thread for it,
//! substring search compiles to SIMD, and a recoverable delete needs three
//! platform APIs that have no JavaScript binding.
//!
//! Everything here is exposed to the application through N-API. Electron is the
//! only runtime that matters at run time; `bun:ffi` would have meant two FFI
//! paths and two sets of failures.

pub mod guard;
pub mod index;
pub mod ops;
pub mod search;
pub mod sort;

#[cfg(feature = "napi-bindings")]
mod bindings;
