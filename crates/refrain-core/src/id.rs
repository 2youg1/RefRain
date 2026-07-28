//! Identifiers.
//!
//! One authority mints every new persistent id, and it mints UUIDv7 (INV-9).
//! Time-ordered so a database index stays local, opaque so no layer can read
//! meaning out of it. Rows migrated from v0.1.x keep their old value in a
//! separate `legacy_id` column; history is never rewritten.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::fmt;
use std::str::FromStr;
use uuid::Uuid;

/// An opaque, time-ordered identifier for a persistent entity.
///
/// The type parameter is absent on purpose: a phantom-typed id would multiply
/// generated TypeScript types without preventing a single real confusion, since
/// every id crosses the bridge as a string anyway.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type,
)]
#[serde(transparent)]
pub struct Id(Uuid);

impl Id {
    /// Mints a new identifier. This is the only place a persistent id is born.
    #[must_use]
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }

    #[must_use]
    pub const fn from_uuid(uuid: Uuid) -> Self {
        Self(uuid)
    }

    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

impl Default for Id {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for Id {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl FromStr for Id {
    type Err = uuid::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Uuid::from_str(s).map(Self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_ids_are_version_7() {
        assert_eq!(Id::new().as_uuid().get_version_num(), 7);
    }

    #[test]
    fn minted_ids_are_distinct() {
        let ids: std::collections::HashSet<Id> = (0..10_000).map(|_| Id::new()).collect();
        assert_eq!(ids.len(), 10_000);
    }

    /// v7 sorts by mint time, which is why a database index over these stays
    /// local. A v4 id would pass every other test in this file.
    #[test]
    fn minted_ids_sort_by_mint_order() {
        let mut minted: Vec<Id> = Vec::new();
        for _ in 0..256 {
            minted.push(Id::new());
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        let mut sorted = minted.clone();
        sorted.sort();
        assert_eq!(minted, sorted);
    }

    #[test]
    fn round_trips_through_its_string_form() {
        let id = Id::new();
        assert_eq!(id.to_string().parse::<Id>().unwrap(), id);
    }

    /// The bridge carries an id as a bare string, not as `{ "0": "..." }`.
    #[test]
    fn serialises_as_a_bare_string() {
        let id = Id::new();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{id}\""));
    }
}
