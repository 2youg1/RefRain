//! The single Config authority (SPEC 10.1, D18).
//!
//! Every user-adjustable setting and every Harness Connection parameter lives
//! in one human-readable `config.toml` in the application data directory.
//! `app.db`, localStorage, and second files hold no competing copies — the
//! `verify:config-authority` gate exists to keep that true.
//!
//! Three refusal rules, each worth the bytes it protects:
//!
//! - A damaged file is never overwritten with defaults. The author sees Safety
//!   naming the field and the recovery action; the original bytes stay put.
//! - A file written by a newer build (higher `version`) is refused, not
//!   downgraded — the same monotonic rule the database ladders enforce.
//! - Every write is an atomic replace (temp, fsync, rename) through
//!   [`crate::atomic`], so a crash mid-save never exposes half a Config.

use refrain_core::Id;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

use crate::atomic;

/// The schema version this build reads and writes. Monotonic: it only ever
/// increases, and only when the shape itself changes — never per edit.
pub const CONFIG_VERSION: u32 = 1;

pub const CONFIG_FILE_NAME: &str = "config.toml";

/// The complete effective Config. This is the only shape Settings and
/// Connections pages ever read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub kara: KaraConfig,
    #[serde(default)]
    pub appearance: AppearanceConfig,
    #[serde(default)]
    pub harness_connections: Vec<HarnessConnection>,
    /// The author's Agents: a name, a channel, an optional persona.
    #[serde(default)]
    pub agents: Vec<AgentProfile>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            kara: KaraConfig::default(),
            appearance: AppearanceConfig::default(),
            harness_connections: Vec::new(),
            agents: Vec::new(),
        }
    }
}

/// What the author sees (SPEC 9.8). Values extend the same schema; nothing
/// here may become a second authority for behaviour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AppearanceConfig {
    /// One of the themes the generator emitted; validated on apply, not on
    /// load, because the theme list is generated, not a hand copy.
    pub theme: String,
    #[serde(default)]
    pub fonts: FontConfig,
    /// The manuscript sheet's edge: none / hairline / paper.
    #[serde(default)]
    pub paper: PaperMode,
    /// Manuscript text size in px (SPEC 9.8: 排版可调,默认 17).
    #[serde(default = "default_text_size")]
    pub text_size: u16,
    /// Manuscript line height in percent (默认 190 = 1.9).
    #[serde(default = "default_line_height")]
    pub line_height: u16,
    /// The Universal Button icon, by content digest (SPEC 9.8). The asset
    /// named by this digest lives in the application data assets directory;
    /// the Config never stores the image itself.
    #[serde(default)]
    pub icon_digest: Option<String>,
}

fn default_text_size() -> u16 {
    17
}

fn default_line_height() -> u16 {
    190
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme: "tou".to_string(),
            fonts: FontConfig::default(),
            paper: PaperMode::default(),
            text_size: default_text_size(),
            line_height: default_line_height(),
            icon_digest: None,
        }
    }
}

/// The manuscript sheet's edge (SPEC 9.8): an edgeless Web-like column, a
/// hairline boundary, or a full sheet of paper for authors coming from Word.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PaperMode {
    None,
    #[default]
    Hairline,
    Paper,
}

/// The three face slots (SPEC 9.8). One CJK slot cannot serve both
/// traditions: 直, 骨 and 令 are drawn differently in each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum FontSlot {
    Latin,
    Chinese,
    Japanese,
}

impl FontSlot {
    pub const ALL: [Self; 3] = [Self::Latin, Self::Chinese, Self::Japanese];
}

/// The face per slot and the order the browser walks them. Order is the
/// whole mechanism: the first face carrying a glyph wins it, so priority
/// decides which tradition draws shared Han.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct FontConfig {
    pub latin: String,
    pub chinese: String,
    pub japanese: String,
    pub priority: [FontSlot; 3],
}

impl Default for FontConfig {
    fn default() -> Self {
        Self {
            latin: "Antic Didone".to_string(),
            chinese: "Chiron Sung HK".to_string(),
            japanese: "Shippori Mincho".to_string(),
            priority: FontSlot::ALL,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct KaraConfig {
    /// D18: consume the one automatic entry of a Project work session on the
    /// first manuscript document opened. `false` leaves KARA fully manual.
    pub auto_enter_on_first_manuscript: bool,
}

impl Default for KaraConfig {
    fn default() -> Self {
        Self {
            auto_enter_on_first_manuscript: true,
        }
    }
}

/// One Agent the author works with (KL9 2026-07-29): a name, the channel it
/// runs on (`None` = the L0 file channel), and an optional persona — one
/// Markdown identity injected right after the contract on every round.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct AgentProfile {
    pub id: Id,
    pub name: String,
    /// The connection this agent runs on; `None` is the L0 file channel.
    #[serde(default)]
    pub connection_id: Option<Id>,
    /// The identity text, injected into the request after the contract.
    #[serde(default)]
    pub persona: Option<String>,
}

/// A machine-level execution channel (SPEC 2.3). Capability probes and trust
/// evidence are machine facts and live in `app.db` — never here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct HarnessConnection {
    pub id: Id,
    pub adapter: AdapterKind,
    /// The exact executable; started with argv, never through a shell.
    pub executable: PathBuf,
    #[serde(default)]
    pub argv: Vec<String>,
    /// Names of environment variables the child may inherit. Credentials live
    /// in the author's own environment; RefRain stores no API keys.
    #[serde(default)]
    pub env_allow: Vec<String>,
}

/// The harness kinds with a defined adapter (SPEC 8.3a). `L0` is the file
/// channel any producer — including a human pasting into a web chat — can serve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum AdapterKind {
    L0,
    Codex,
    ClaudeCode,
    Pi,
    KimiCode,
    Hermes,
}

/// Every change the interface may apply, as an exhaustive enum: there is no
/// string key/value update path (SPEC 10.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigChange {
    KaraAutoEnter(bool),
    SetTheme(String),
    SetPaper(PaperMode),
    SetTextSize(u16),
    SetLineHeight(u16),
    SetFontFamily { slot: FontSlot, family: String },
    SetFontPriority([FontSlot; 3]),
    SetIconDigest(Option<String>),
    ResetVisual,
    ResetTypography,
    RestoreAppearance(AppearanceConfig),
    UpsertHarnessConnection(HarnessConnection),
    RemoveHarnessConnection(Id),
    UpsertAgent(AgentProfile),
    RemoveAgent(Id),
}

/// A load or write that could not honour the rules above.
#[derive(Debug, thiserror::Error)]
pub enum ConfigFailure {
    /// The file does not parse as the current shape. The original bytes are
    /// untouched; the interface enters Safety with the field detail.
    #[error("config at {path} is damaged: {detail}")]
    Damaged { path: PathBuf, detail: String },
    /// Written by a newer build. Refused, not rewritten.
    #[error("config version {found} is newer than this build's {supported}")]
    TooNew { found: u32, supported: u32 },
    #[error("config I/O at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// The effective Config plus anything the author must be told about the load
/// or write itself.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub config: Config,
    /// A divergent interrupted write preserved before this load or save
    /// proceeded (SPEC 11: evidence, not silence).
    pub recovery_evidence: Option<PathBuf>,
}

/// Reads and atomically replaces the one Config file.
#[derive(Debug)]
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    /// Loads the Config from `dir`. A missing file is a first run: the
    /// defaults are written atomically and returned. A damaged or newer file
    /// is a refusal with the original bytes left exactly where they were.
    pub fn load(dir: &Path) -> Result<(Self, ConfigSnapshot), ConfigFailure> {
        let store = Self {
            path: dir.join(CONFIG_FILE_NAME),
        };
        if !store
            .path
            .try_exists()
            .map_err(|source| ConfigFailure::Io {
                path: store.path.clone(),
                source,
            })?
        {
            let config = Config::default();
            let outcome = store.write(&config)?;
            return Ok((
                store,
                ConfigSnapshot {
                    config,
                    recovery_evidence: outcome.recovery_evidence,
                },
            ));
        }

        let bytes = std::fs::read(&store.path).map_err(|source| ConfigFailure::Io {
            path: store.path.clone(),
            source,
        })?;
        let text = String::from_utf8(bytes).map_err(|error| ConfigFailure::Damaged {
            path: store.path.clone(),
            detail: format!("not valid UTF-8: {error}"),
        })?;
        let config: Config = toml::from_str(&text).map_err(|error| ConfigFailure::Damaged {
            path: store.path.clone(),
            detail: error.to_string(),
        })?;
        if config.version > CONFIG_VERSION {
            return Err(ConfigFailure::TooNew {
                found: config.version,
                supported: CONFIG_VERSION,
            });
        }

        // A leftover residue from an interrupted save is resolved now, before
        // the next write could hide it.
        let outcome =
            atomic::recover_interrupted_write(&store.path).map_err(|source| ConfigFailure::Io {
                path: store.path.clone(),
                source,
            })?;
        Ok((
            store,
            ConfigSnapshot {
                config,
                recovery_evidence: outcome.recovery_evidence,
            },
        ))
    }

    /// The current effective Config, re-read from disk. The file is the
    /// authority; a snapshot that went stale between load and now is a bug
    /// the caller should not have to think about.
    pub fn snapshot(&self) -> Result<ConfigSnapshot, ConfigFailure> {
        Self::current(&self.path)
    }

    /// Applies one typed change and atomically replaces the file, returning
    /// the complete effective Config (SPEC 6.5: never a partial view).
    pub fn apply(&self, change: ConfigChange) -> Result<ConfigSnapshot, ConfigFailure> {
        let mut snapshot = Self::current(&self.path)?;
        match change {
            ConfigChange::KaraAutoEnter(value) => {
                snapshot.config.kara.auto_enter_on_first_manuscript = value;
            }
            ConfigChange::SetTheme(theme) => {
                snapshot.config.appearance.theme = theme;
            }
            ConfigChange::SetPaper(mode) => {
                snapshot.config.appearance.paper = mode;
            }
            ConfigChange::SetTextSize(px) => {
                snapshot.config.appearance.text_size = px;
            }
            ConfigChange::SetLineHeight(pct) => {
                snapshot.config.appearance.line_height = pct;
            }
            ConfigChange::SetFontFamily { slot, family } => {
                let fonts = &mut snapshot.config.appearance.fonts;
                match slot {
                    FontSlot::Latin => fonts.latin = family,
                    FontSlot::Chinese => fonts.chinese = family,
                    FontSlot::Japanese => fonts.japanese = family,
                }
            }
            ConfigChange::SetFontPriority(priority) => {
                snapshot.config.appearance.fonts.priority = priority;
            }
            ConfigChange::SetIconDigest(digest) => {
                snapshot.config.appearance.icon_digest = digest;
            }
            ConfigChange::ResetVisual => {
                let defaults = AppearanceConfig::default();
                snapshot.config.appearance.theme = defaults.theme;
                snapshot.config.appearance.paper = defaults.paper;
                snapshot.config.appearance.icon_digest = defaults.icon_digest;
            }
            ConfigChange::ResetTypography => {
                let defaults = AppearanceConfig::default();
                snapshot.config.appearance.fonts = defaults.fonts;
                snapshot.config.appearance.text_size = defaults.text_size;
                snapshot.config.appearance.line_height = defaults.line_height;
            }
            ConfigChange::RestoreAppearance(appearance) => {
                snapshot.config.appearance = appearance;
            }
            ConfigChange::UpsertHarnessConnection(connection) => {
                match snapshot
                    .config
                    .harness_connections
                    .iter_mut()
                    .find(|existing| existing.id == connection.id)
                {
                    Some(existing) => *existing = connection,
                    None => snapshot.config.harness_connections.push(connection),
                }
            }
            ConfigChange::RemoveHarnessConnection(id) => {
                snapshot
                    .config
                    .harness_connections
                    .retain(|existing| existing.id != id);
            }
            ConfigChange::UpsertAgent(profile) => {
                match snapshot
                    .config
                    .agents
                    .iter_mut()
                    .find(|existing| existing.id == profile.id)
                {
                    Some(existing) => *existing = profile,
                    None => snapshot.config.agents.push(profile),
                }
            }
            ConfigChange::RemoveAgent(id) => {
                snapshot.config.agents.retain(|existing| existing.id != id);
            }
        }
        let outcome = self.write(&snapshot.config)?;
        snapshot.recovery_evidence = outcome.recovery_evidence;
        Ok(snapshot)
    }

    /// Re-reads the file this store points at. `apply` goes through here so a
    /// Config edited on disk between load and save is not silently flattened:
    /// a damaged or newer on-disk file stops the apply, it is not "repaired".
    fn current(path: &Path) -> Result<ConfigSnapshot, ConfigFailure> {
        let bytes = std::fs::read(path).map_err(|source| ConfigFailure::Io {
            path: path.to_path_buf(),
            source,
        })?;
        let text = String::from_utf8(bytes).map_err(|error| ConfigFailure::Damaged {
            path: path.to_path_buf(),
            detail: format!("not valid UTF-8: {error}"),
        })?;
        let config: Config = toml::from_str(&text).map_err(|error| ConfigFailure::Damaged {
            path: path.to_path_buf(),
            detail: error.to_string(),
        })?;
        if config.version > CONFIG_VERSION {
            return Err(ConfigFailure::TooNew {
                found: config.version,
                supported: CONFIG_VERSION,
            });
        }
        Ok(ConfigSnapshot {
            config,
            recovery_evidence: None,
        })
    }

    fn write(&self, config: &Config) -> Result<atomic::AtomicOutcome, ConfigFailure> {
        let text = toml::to_string(config).map_err(|error| ConfigFailure::Damaged {
            path: self.path.clone(),
            detail: format!("the effective Config cannot be serialised: {error}"),
        })?;
        atomic::replace_file_atomically(&self.path, text.as_bytes(), |_| Ok(())).map_err(|source| {
            ConfigFailure::Io {
                path: self.path.clone(),
                source,
            }
        })
    }
}
