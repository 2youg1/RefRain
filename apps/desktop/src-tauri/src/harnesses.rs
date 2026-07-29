//! The local Harness boundary.
//!
//! The renderer names a fixed candidate or an existing Config connection. It
//! never supplies an executable path. Discovery, identity checks, canonical
//! paths, and adapter selection stay together here.

use std::path::{Path, PathBuf};

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
}
