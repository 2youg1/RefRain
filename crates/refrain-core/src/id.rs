// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

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

    /// Derive one identifier of a document's initial lineage from its seed.
    ///
    /// The birth rule of this module (INV-9) still holds: `new()` remains the
    /// only place an id is minted, and the seed is minted there. Every block
    /// id of an opening manuscript is then a bijective image of the seed, so
    /// the whole lineage costs one mint plus O(1) per id instead of one mint
    /// per id — a 200k-block manuscript measured 59 ms of UUID v7 mints, the
    /// entire open budget for v0.3.0.
    ///
    /// Why this does not break INV-9's intent: v7's time ordering exists for
    /// the database index, and the initial lineage never enters the database
    /// — it lives in the state file and in memory. Predictability is kept by
    /// the random seed; uniqueness within a document is kept by bijectivity
    /// (`derive` is invertible), and the open path still refuses a repeated
    /// `Listed` lineage from a restored state.
    #[must_use]
    pub fn derive(seed: Self, index: usize) -> Self {
        // splitmix64 is a bijection over u64; composing two of them with
        // distinct constants is a bijection over u128. XOR with the seed
        // preserves bijectivity, so distinct indexes always yield distinct
        // ids.
        let mixed = mix128(index as u64, (index as u128 >> 64) as u64);
        Self(Uuid::from_u128(seed.0.as_u128() ^ mixed))
    }

    /// Invert [`Id::derive`]: the lineage index an id was derived from, if
    /// it is a derived id of this seed at all.
    ///
    /// `count` bounds the search space: a v7 id minted in the same
    /// millisecond as the seed shares its timestamp, so its high lane can
    /// unmix to the family marker zero — only the index range then
    /// separates a foreign id from a derived one. Edited blocks mint long
    /// after the seed, so their lanes unmix to garbage and the range check
    /// never sees them.
    #[must_use]
    pub fn invert(seed: Self, id: Self, count: usize) -> Option<usize> {
        let mixed = seed.0.as_u128() ^ id.0.as_u128();
        let (low, high) = unmix128(mixed);
        if high != 0 {
            return None;
        }
        usize::try_from(low).ok().filter(|index| *index < count)
    }

    /// The seed a derived lineage uses. Derived ids share it; `Listed`
    /// lineages carry their ids verbatim and have none.
    #[must_use]
    pub const fn from_uuid(uuid: Uuid) -> Self {
        Self(uuid)
    }

    #[must_use]
    pub const fn as_uuid(&self) -> &Uuid {
        &self.0
    }
}

/// A bijection over u128 built from two splitmix64 steps.
///
/// splitmix64's mixing is invertible; the two halves mix distinct bits, so
/// the pair is a bijection over the full 128-bit space.
fn mix128(low: u64, high: u64) -> u128 {
    let mixed_low = splitmix64(low);
    let mixed_high = splitmix64(high.wrapping_add(0x9e37_79b9_7f4a_7c15));
    (mixed_low as u128) | ((mixed_high as u128) << 64)
}

fn unmix128(mixed: u128) -> (u64, u64) {
    // mix128 fed the high lane through `wrapping_add(const)` before mixing,
    // so its inverse must subtract that constant back out; splitmix64_inverse
    // itself already undoes the add inside splitmix64. The low lane was fed
    // raw and needs nothing.
    let low = splitmix64_inverse(mixed as u64);
    let high = splitmix64_inverse((mixed >> 64) as u64).wrapping_sub(0x9e37_79b9_7f4a_7c15);
    (low, high)
}

/// splitmix64 forward mix.
fn splitmix64(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// splitmix64 inverse: undo the three xor-shift-multiply steps in reverse.
///
/// Each xor-shift needs its full inverse series — `x ^ (x >> k)` un-does as
/// `y ^ (y >> k) ^ (y >> 2k) …` until the shift runs out of the word — which
/// is two terms for 27/30/31 in a 64-bit word.
fn splitmix64_inverse(mut z: u64) -> u64 {
    z ^= z >> 31;
    z ^= z >> 62;
    z = z.wrapping_mul(0x3196_42b2_d24d_8ec3); // inverse of 0x94d0_49bb_1331_11eb — the last multiply undoes first
    z ^= z >> 27;
    z ^= z >> 54;
    z = z.wrapping_mul(0x96de_1b17_3f11_9089); // inverse of 0xbf58_476d_1ce4_e5b9
    z ^= z >> 30;
    z ^= z >> 60;
    z.wrapping_sub(0x9e37_79b9_7f4a_7c15)
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

#[cfg(test)]
mod derived_tests {
    use super::*;

    #[test]
    fn derived_ids_are_distinct_within_a_lineage() {
        let seed = Id::new();
        let ids: std::collections::HashSet<Id> =
            (0..200_000).map(|index| Id::derive(seed, index)).collect();
        assert_eq!(ids.len(), 200_000, "derive must be injective per seed");
    }

    #[test]
    fn derived_ids_differ_across_seeds() {
        let a = Id::derive(Id::new(), 7);
        let b = Id::derive(Id::new(), 7);
        assert_ne!(a, b);
    }

    #[test]
    fn invert_recovers_the_index_and_only_it() {
        let seed = Id::new();
        for index in [0usize, 1, 42, 65_535, 199_999] {
            let id = Id::derive(seed, index);
            assert_eq!(Id::invert(seed, id, 200_000), Some(index));
        }
        // A foreign id (minted, not derived) inverts to nothing.
        assert_eq!(Id::invert(seed, Id::new(), 200_000), None);
        // The same derived id under a different seed inverts to nothing.
        assert_eq!(Id::invert(Id::new(), Id::derive(seed, 3), 200_000), None);
    }

    #[test]
    fn derivation_is_free_of_mints() {
        // This is a behaviour pin, not a benchmark: a derived lineage must
        // not mint per id, or the open budget regresses. 200k derivations
        // measure ~1 ms in release and ~10 ms in the debug suite; 200k
        // mints measure 60+ ms in release and far more in debug. The
        // generous 100 ms ceiling still separates the two by an order of
        // magnitude.
        let seed = Id::new();
        let started = std::time::Instant::now();
        for index in 0..200_000 {
            std::hint::black_box(Id::derive(seed, index));
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(100),
            "deriving 200k ids took {elapsed:?} — a mint crept back in"
        );
    }
}
