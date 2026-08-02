//! The local Harness boundary.
//!
//! The renderer names a fixed candidate or an existing Config connection. It
//! never supplies an executable path. Discovery, identity checks, canonical
//! paths, and adapter selection stay together here.

use std::path::{Path, PathBuf};

use refrain_core::context_compiler::SkillStatus;
use refrain_host::Tier;
use refrain_host::adapters::{
    ClaudePrint, DispatchReceipt, DispatchSpec, HarnessAdapter, HarnessProbe, KimiPrint,
    ProducerOutcome,
};
use refrain_store::config::{AdapterKind, HarnessConnection};

pub const CLAUDE_CODE_CANDIDATE: &str = "claude-code";
pub const KIMI_CODE_CANDIDATE: &str = "kimi-code";

pub const SUPPORTED_CANDIDATES: [(&str, &str); 2] = [
    (CLAUDE_CODE_CANDIDATE, "Claude Code"),
    (KIMI_CODE_CANDIDATE, "Kimi Code"),
];

pub enum LocalHarness {
    Claude(ClaudePrint),
    Kimi(KimiPrint),
}

impl LocalHarness {
    pub fn detect(candidate_id: &str) -> Option<Self> {
        match candidate_id {
            CLAUDE_CODE_CANDIDATE => ClaudePrint::detect().map(Self::Claude),
            KIMI_CODE_CANDIDATE => KimiPrint::detect().map(Self::Kimi),
            _ => None,
        }
    }

    pub fn from_connection(connection: &HarnessConnection) -> Option<Self> {
        match connection.adapter {
            AdapterKind::ClaudeCode => {
                ClaudePrint::at_with_env(connection.executable.clone(), &connection.env_allow)
                    .map(Self::Claude)
            }
            AdapterKind::KimiCode => {
                KimiPrint::at_with_env(connection.executable.clone(), &connection.env_allow)
                    .map(Self::Kimi)
            }
            AdapterKind::L0 | AdapterKind::Codex | AdapterKind::Pi | AdapterKind::Hermes => None,
        }
    }

    pub const fn label(&self) -> &'static str {
        match self {
            Self::Claude(_) => "Claude Code",
            Self::Kimi(_) => "Kimi Code",
        }
    }

    pub const fn adapter_kind(&self) -> AdapterKind {
        match self {
            Self::Claude(_) => AdapterKind::ClaudeCode,
            Self::Kimi(_) => AdapterKind::KimiCode,
        }
    }

    pub fn program(&self) -> &Path {
        match self {
            Self::Claude(adapter) => adapter.program(),
            Self::Kimi(adapter) => adapter.program(),
        }
    }

    pub fn version(&self) -> &str {
        match self {
            Self::Claude(adapter) => adapter.version(),
            Self::Kimi(adapter) => adapter.version(),
        }
    }
}

impl HarnessAdapter for LocalHarness {
    fn tier(&self) -> Tier {
        match self {
            Self::Claude(adapter) => adapter.tier(),
            Self::Kimi(adapter) => adapter.tier(),
        }
    }

    fn probe(&self) -> Option<HarnessProbe> {
        match self {
            Self::Claude(adapter) => adapter.probe(),
            Self::Kimi(adapter) => adapter.probe(),
        }
    }

    fn dispatch(&self, spec: &DispatchSpec) -> std::io::Result<DispatchReceipt> {
        match self {
            Self::Claude(adapter) => adapter.dispatch(spec),
            Self::Kimi(adapter) => adapter.dispatch(spec),
        }
    }

    fn observe(&self, receipt: DispatchReceipt) -> std::io::Result<ProducerOutcome> {
        match self {
            Self::Claude(adapter) => adapter.observe(receipt),
            Self::Kimi(adapter) => adapter.observe(receipt),
        }
    }

    fn cancel(&self, receipt: DispatchReceipt) -> std::io::Result<ProducerOutcome> {
        match self {
            Self::Claude(adapter) => adapter.cancel(receipt),
            Self::Kimi(adapter) => adapter.cancel(receipt),
        }
    }
}

pub fn connection_from_detected(id: refrain_core::Id, harness: &LocalHarness) -> HarnessConnection {
    HarnessConnection {
        id,
        adapter: harness.adapter_kind(),
        executable: PathBuf::from(harness.program()),
        argv: Vec::new(),
        env_allow: detected_environment_names(),
        version: Some(harness.version().to_string()),
        // Re-linking keeps the install record when there is one; the caller
        // fills it from the prior row. Detection itself never installs.
        skill_digest: None,
    }
}

/// The machine's home directory, resolved the way the harness CLIs resolve
/// it: HOME first, then the Windows profile variable. Absent is a fact —
/// the skill surface reports nothing rather than guessing a path.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// The installed protocol's state for one adapter kind. `None` for kinds
/// with no skill convention is not an error: there is simply nothing to
/// install into, and the badge says "none".
pub fn skill_status(home: &Path, adapter: AdapterKind) -> SkillStatus {
    match adapter {
        AdapterKind::KimiCode => KimiPrint::skill_status(home),
        AdapterKind::ClaudeCode => ClaudePrint::skill_status(home),
        AdapterKind::L0 | AdapterKind::Codex | AdapterKind::Pi | AdapterKind::Hermes => {
            SkillStatus::None
        }
    }
}

/// The path the installed protocol lives at for one adapter kind, when the
/// kind has a skill convention at all.
pub fn skill_path(home: &Path, adapter: AdapterKind) -> Option<PathBuf> {
    match adapter {
        AdapterKind::KimiCode => Some(KimiPrint::skill_path(home)),
        AdapterKind::ClaudeCode => Some(ClaudePrint::skill_path(home)),
        AdapterKind::L0 | AdapterKind::Codex | AdapterKind::Pi | AdapterKind::Hermes => None,
    }
}

/// Install the protocol for one adapter kind: the harness's skill directory
/// convention decides where, `skill_doc()` decides what. Returns the path
/// and the BLAKE3 of the bytes written.
pub fn install_skill(
    home: &Path,
    adapter: AdapterKind,
) -> Option<std::io::Result<(PathBuf, String)>> {
    match adapter {
        AdapterKind::KimiCode => Some(KimiPrint::install_skill(home)),
        AdapterKind::ClaudeCode => Some(ClaudePrint::install_skill(home)),
        AdapterKind::L0 | AdapterKind::Codex | AdapterKind::Pi | AdapterKind::Hermes => None,
    }
}

/// What a stored connection resolves to when it is listed.
///
/// The re-probe exists because the stored path is a claim, not a fact: an
/// upgraded CLI may have moved (npm/nvm/WinGet put versions in their paths),
/// and a vanished binary must not report Connected. The three outcomes keep
/// those cases apart.
pub enum ConnectionResolution<H = LocalHarness> {
    /// The stored executable answered the version probe.
    Live(H),
    /// The stored path no longer answers, but the same candidate answers on
    /// PATH: the install moved, and the caller re-anchors the connection
    /// through the Config authority under the same id — no re-link.
    Moved(H),
    /// Neither the stored path nor PATH answers: previously worked, currently
    /// unreachable. The stored identity is intact; the last-known metadata
    /// the connection recorded is what the report shows.
    Unreachable,
}

/// Probe a stored connection: the saved executable first, and only when that
/// fails, the candidate's PATH detection — an install that moved must be told
/// apart from one that is genuinely gone, and the second probe is the only
/// difference between the two.
pub fn resolve_connection(connection: &HarnessConnection) -> ConnectionResolution {
    let stored = LocalHarness::from_connection(connection);
    let detected = match (&stored, candidate_for_adapter(connection.adapter)) {
        (Some(_), _) | (None, None) => None,
        (None, Some(candidate)) => LocalHarness::detect(candidate),
    };
    resolve_decision(stored, detected)
}

/// The decision, generic over the harness so both failure directions are
/// testable without a real binary.
fn resolve_decision<H>(stored: Option<H>, detected: Option<H>) -> ConnectionResolution<H> {
    match (stored, detected) {
        (Some(harness), _) => ConnectionResolution::Live(harness),
        (None, Some(harness)) => ConnectionResolution::Moved(harness),
        (None, None) => ConnectionResolution::Unreachable,
    }
}

/// Debug E2E can name credentials that a temporary, preconfigured CLI needs.
/// Release connections remain empty here: ordinary signed-in CLIs read their
/// own files beneath HOME, and the app never guesses secret-bearing names.
fn detected_environment_names() -> Vec<String> {
    #[cfg(debug_assertions)]
    {
        std::env::var("REFRAIN_HARNESS_ENV_ALLOW")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|name| {
                        !name.is_empty()
                            && name
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                    })
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }
    #[cfg(not(debug_assertions))]
    Vec::new()
}

pub const fn candidate_for_adapter(adapter: AdapterKind) -> Option<&'static str> {
    match adapter {
        AdapterKind::ClaudeCode => Some(CLAUDE_CODE_CANDIDATE),
        AdapterKind::KimiCode => Some(KIMI_CODE_CANDIDATE),
        AdapterKind::L0 | AdapterKind::Codex | AdapterKind::Pi | AdapterKind::Hermes => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_stable_supported_ids_can_trigger_detection() {
        assert!(LocalHarness::detect("/tmp/attacker").is_none());
        assert!(LocalHarness::detect("kimi --version").is_none());
        assert_eq!(SUPPORTED_CANDIDATES.len(), 2);
    }

    #[test]
    fn every_supported_adapter_has_one_candidate_id() {
        assert_eq!(
            candidate_for_adapter(AdapterKind::ClaudeCode),
            Some(CLAUDE_CODE_CANDIDATE)
        );
        assert_eq!(
            candidate_for_adapter(AdapterKind::KimiCode),
            Some(KIMI_CODE_CANDIDATE)
        );
        assert_eq!(candidate_for_adapter(AdapterKind::Codex), None);
    }

    #[test]
    fn a_dead_stored_path_fails_its_probe_without_touching_detection() {
        let connection = HarnessConnection {
            id: refrain_core::Id::new(),
            adapter: AdapterKind::KimiCode,
            executable: PathBuf::from(r"C:\definitely\absent\kimi-code.exe"),
            argv: Vec::new(),
            env_allow: Vec::new(),
            version: Some("1.2.3".to_string()),
            skill_digest: None,
        };
        // A genuinely gone binary answers None — no error, no hang.
        assert!(LocalHarness::from_connection(&connection).is_none());
        // With no candidate answering either, the resolution is the new state.
        assert!(matches!(
            resolve_decision(
                LocalHarness::from_connection(&connection),
                None::<LocalHarness>
            ),
            ConnectionResolution::Unreachable
        ));
    }

    #[test]
    fn the_resolution_decision_keeps_the_three_cases_apart() {
        // Live: the stored path answered — detection is never consulted.
        assert!(matches!(
            resolve_decision(Some("stored"), Some("detected")),
            ConnectionResolution::Live("stored")
        ));
        // Moved: only the candidate answered — the install went elsewhere.
        assert!(matches!(
            resolve_decision(None, Some("detected")),
            ConnectionResolution::Moved("detected")
        ));
        // Unreachable: nothing answered — previously worked, currently gone.
        assert!(matches!(
            resolve_decision::<&str>(None, None),
            ConnectionResolution::Unreachable
        ));
    }

    /// The skill surface follows the adapter kind: only kinds with a skill
    /// directory convention can hold an installed protocol, and the others
    /// say "none" rather than pretending.
    #[test]
    fn the_skill_surface_follows_the_adapter_kind() {
        let home = PathBuf::from("/fixture/home");
        assert_eq!(
            skill_path(&home, AdapterKind::KimiCode),
            Some(KimiPrint::skill_path(&home))
        );
        assert_eq!(
            skill_path(&home, AdapterKind::ClaudeCode),
            Some(ClaudePrint::skill_path(&home))
        );
        assert_eq!(skill_path(&home, AdapterKind::L0), None);
        assert_eq!(skill_status(&home, AdapterKind::L0), SkillStatus::None);
        assert!(install_skill(&home, AdapterKind::L0).is_none());
    }
}
