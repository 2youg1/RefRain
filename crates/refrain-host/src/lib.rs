//! Orchestration authority for RefRain.
//!
//! The host is the sole writer of Connection, Agent, Session, Task, Run and
//! Authorization state (INV-12). An adapter returns facts; it never writes a
//! Run. R0 establishes the crate boundary only; the state machine arrives in R4.

#![forbid(unsafe_code)]

/// Adapter capability tier (SPEC 8.3).
///
/// Declared in R0 because the boundary it names is the one thing the host owes
/// the rest of the workspace before its state machine exists.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, specta::Type,
)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// A file channel: write a request, wait for a result. No launch, no cancel.
    L0,
    /// An argv launch with completion and cancellation.
    L1,
    /// Honest usage, effective model, compaction events.
    L2,
}

#[cfg(test)]
mod tests {
    use super::Tier;

    #[test]
    fn tiers_serialise_in_their_documented_spelling() {
        let wire: Vec<String> = [Tier::L0, Tier::L1, Tier::L2]
            .iter()
            .map(|t| serde_json::to_string(t).unwrap())
            .collect();
        assert_eq!(wire, vec!["\"l0\"", "\"l1\"", "\"l2\""]);
    }
}
