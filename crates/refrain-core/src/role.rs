//! Document roles (SPEC 2.1).
//!
//! A role is a fact about what a file is to the work, recorded in the project
//! database — never a directory name, and a translated string never touches a
//! path (SPEC 9.5).

use serde::{Deserialize, Serialize};
use specta::Type;

/// What a Markdown file is to the work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentRole {
    /// A standalone work opened on its own (single-file Root).
    Document,
    /// Part of a Project's manuscript sequence.
    Chapter,
    /// Reference material: enters the Context picker, never the manuscript
    /// order.
    Material,
}

impl DocumentRole {
    /// The wire and database spelling, in one place so the two cannot drift.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Chapter => "chapter",
            Self::Material => "material",
        }
    }

    /// Parses the database spelling back; unknown values are corruption, not
    /// an occasion to guess.
    #[must_use]
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "document" => Some(Self::Document),
            "chapter" => Some(Self::Chapter),
            "material" => Some(Self::Material),
            _ => None,
        }
    }
}
