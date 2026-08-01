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
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};

use crate::atomic;

/// The schema version this build reads and writes. Monotonic: it only ever
/// increases, and only when the shape itself changes — never per edit.
pub const CONFIG_VERSION: u32 = 2;

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
    pub typography: TypographyConfig,
    /// Named snapshots of complete typography values. The active value above
    /// remains authoritative; a preset changes nothing until the author applies it.
    #[serde(default)]
    pub typography_presets: Vec<TypographyPreset>,
    /// The manuscript sheet's edge: none / hairline / paper.
    #[serde(default)]
    pub paper: PaperMode,
    /// What panels are made of. Solid by default: it costs nothing to draw.
    #[serde(default)]
    pub panel_material: PanelMaterial,
    /// The author's chosen code colouring, or None to follow the interface
    /// theme. None is not a missing value: it is "keep matching the theme",
    /// and it must survive a theme change, which a resolved default cannot.
    #[serde(default)]
    pub code_theme: Option<String>,
    /// The night lamp, so the light has a source instead of the glyphs
    /// appearing to emit it themselves.
    #[serde(default)]
    pub night_lamp: NightLamp,

    /// How wide a panel opens.
    #[serde(default)]
    pub panel_width: PanelWidth,
    /// How wide the document rail sits.
    #[serde(default)]
    pub rail_width: RailWidth,
    /// Which side panels open from. Left by default.
    #[serde(default)]
    pub panel_side: PanelSide,
    /// Whether panels animate open. Off shortens the motion to 1ms rather than
    /// taking a separate, untravelled code path.
    #[serde(default = "yes")]
    pub panel_animation: bool,
    /// The writing-entry icon, by content digest. The asset named by this
    /// digest lives in the application data assets directory.
    #[serde(default)]
    pub icon_digest: Option<String>,
    /// How opaque the small floating surfaces are — the context menu and the
    /// stale-proposal panel that stand beside the manuscript.
    ///
    /// The author sometimes wants to see what is underneath them rather than
    /// the surface itself. Percent, because a persisted `0.75` reads as a
    /// ratio of something unnamed while `75` next to the field name does not.
    /// Default 100: a translucent default reads as a rendering fault to
    /// someone opening the application for the first time.
    #[serde(default = "full_opacity")]
    pub bento_opacity_percent: u16,
}

/// The default for a surface nobody has asked to fade.
const fn full_opacity() -> u16 {
    100
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme: "tou".to_string(),
            typography: TypographyConfig::default(),
            typography_presets: Vec::new(),
            paper: PaperMode::default(),
            panel_material: PanelMaterial::default(),
            code_theme: None,
            panel_width: PanelWidth::default(),
            rail_width: RailWidth::default(),
            night_lamp: NightLamp::default(),
            panel_side: PanelSide::default(),
            panel_animation: true,
            icon_digest: None,
            bento_opacity_percent: full_opacity(),
        }
    }
}

/// Every typographic material that changes the manuscript surface. Units live
/// in field names so persisted numbers remain readable without UI context.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TypographyConfig {
    pub fonts: FontConfig,
    pub text_size_tenths_px: u16,
    pub font_weight: u16,
    pub line_height_percent: u16,
    pub letter_spacing_thousandths_em: i16,
    pub word_spacing_thousandths_em: i16,
    pub measure_tenths_em: u16,
    pub first_line_indent_tenths_em: u16,
    pub paragraph_spacing_percent: u16,
    pub alignment: TextAlignment,
    pub page_top_padding_tenths_rem: u16,
    pub page_bottom_padding_tenths_vh: u16,
    /// Zero disables the grid; 1–6 draws one rule every N line boxes.
    pub baseline_grid_lines: u8,
    pub zoom_percent: u16,
}

impl Default for TypographyConfig {
    fn default() -> Self {
        Self {
            fonts: FontConfig::default(),
            text_size_tenths_px: 170,
            font_weight: 400,
            line_height_percent: 190,
            letter_spacing_thousandths_em: 10,
            word_spacing_thousandths_em: 0,
            measure_tenths_em: 346,
            first_line_indent_tenths_em: 0,
            paragraph_spacing_percent: 100,
            alignment: TextAlignment::Left,
            page_top_padding_tenths_rem: 30,
            page_bottom_padding_tenths_vh: 500,
            baseline_grid_lines: 0,
            zoom_percent: 100,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum TextAlignment {
    #[default]
    Left,
    Justify,
}

/// One author-named snapshot. IDs make rename and overwrite unambiguous.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct TypographyPreset {
    pub id: Id,
    pub name: String,
    pub typography: TypographyConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct BuiltinTypographyPreset {
    pub id: String,
    pub typography: TypographyConfig,
}

pub fn builtin_typography_presets() -> Vec<BuiltinTypographyPreset> {
    let chinese = TypographyConfig {
        first_line_indent_tenths_em: 20,
        paragraph_spacing_percent: 50,
        measure_tenths_em: 320,
        ..TypographyConfig::default()
    };
    let japanese = TypographyConfig {
        fonts: FontConfig {
            priority: [FontSlot::Latin, FontSlot::Japanese, FontSlot::Chinese],
            ..FontConfig::default()
        },
        first_line_indent_tenths_em: 10,
        paragraph_spacing_percent: 50,
        measure_tenths_em: 320,
        letter_spacing_thousandths_em: 0,
        ..TypographyConfig::default()
    };
    let english = TypographyConfig {
        line_height_percent: 170,
        letter_spacing_thousandths_em: 0,
        word_spacing_thousandths_em: 50,
        measure_tenths_em: 360,
        paragraph_spacing_percent: 75,
        ..TypographyConfig::default()
    };
    vec![
        BuiltinTypographyPreset {
            id: "chinese-prose".to_string(),
            typography: chinese,
        },
        BuiltinTypographyPreset {
            id: "japanese-prose".to_string(),
            typography: japanese,
        },
        BuiltinTypographyPreset {
            id: "english-prose".to_string(),
            typography: english,
        },
    ]
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

/// What a panel is made of: opaque, frosted, or glass with thickness.
///
/// Three densities of one thing — how much light passes through — not three
/// skins. The numbers live in the renderer; this only records the choice.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PanelMaterial {
    #[default]
    Solid,
    Acrylic,
    Liquid,
}

/// `#[serde(default)]` on a bool yields false; panels animate unless the author
/// turned that off, so the default needs saying out loud.
fn yes() -> bool {
    true
}

/// Where the night lamp hangs.
///
/// `Side` puts it beside the panels, so the light crosses the stage and the
/// panels themselves stand in its path — which is where their translucency
/// gets its reason. `Overhead` hangs it above: a soft wash falling from the
/// top, with no side to it. `Off` is no lamp at all.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum NightLamp {
    #[default]
    Off,
    Side,
    Overhead,
}

/// How wide a panel opens. `Full` gives it the whole stage: finding material or
/// writing an instruction for an agent is the work at that moment, and there is
/// no reason to crowd it beside a manuscript nobody is reading.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PanelWidth {
    Narrow,
    #[default]
    Regular,
    Full,
}

/// How wide the document rail sits. It carries file names, so it is narrower
/// than a panel.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum RailWidth {
    #[default]
    Narrow,
    Regular,
    Wide,
}

/// Which side the panel stack grows from.
///
/// The stack is one-directional by construction: panels open outward from this
/// side and nothing ever appears opposite them. Flipping this mirrors the same
/// stack; it does not introduce a second layout.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PanelSide {
    #[default]
    Left,
    Right,
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
            // The bundled faces, so the first launch looks the way RefRain was
            // designed to look on every platform rather than inheriting
            // whatever the machine happens to have. The author can name any
            // face they have installed — `list_fonts` enumerates the machine's
            // library and the stack honours the choice — and the bundled pair
            // stays at the end of the stack as the fallback, so a face that is
            // missing or carries no Han still cannot produce tofu.
            chinese: "Noto Sans SC".to_string(),
            japanese: "Zen Kaku Gothic New".to_string(),
            priority: FontSlot::ALL,
        }
    }
}

impl TypographyConfig {
    fn validate(&self) -> Result<(), String> {
        let numeric = [
            (
                "text_size_tenths_px",
                i32::from(self.text_size_tenths_px),
                100,
                480,
            ),
            ("font_weight", i32::from(self.font_weight), 100, 900),
            (
                "line_height_percent",
                i32::from(self.line_height_percent),
                100,
                400,
            ),
            (
                "letter_spacing_thousandths_em",
                i32::from(self.letter_spacing_thousandths_em),
                -100,
                500,
            ),
            (
                "word_spacing_thousandths_em",
                i32::from(self.word_spacing_thousandths_em),
                -200,
                2000,
            ),
            (
                "measure_tenths_em",
                i32::from(self.measure_tenths_em),
                140,
                800,
            ),
            (
                "first_line_indent_tenths_em",
                i32::from(self.first_line_indent_tenths_em),
                0,
                80,
            ),
            (
                "paragraph_spacing_percent",
                i32::from(self.paragraph_spacing_percent),
                0,
                400,
            ),
            (
                "page_top_padding_tenths_rem",
                i32::from(self.page_top_padding_tenths_rem),
                0,
                300,
            ),
            (
                "page_bottom_padding_tenths_vh",
                i32::from(self.page_bottom_padding_tenths_vh),
                0,
                1000,
            ),
            (
                "baseline_grid_lines",
                i32::from(self.baseline_grid_lines),
                0,
                6,
            ),
            ("zoom_percent", i32::from(self.zoom_percent), 50, 200),
        ];
        for (field, value, min, max) in numeric {
            if !(min..=max).contains(&value) {
                return Err(format!(
                    "{field} must be between {min} and {max}; got {value}"
                ));
            }
        }

        for (slot, family) in [
            ("latin", &self.fonts.latin),
            ("chinese", &self.fonts.chinese),
            ("japanese", &self.fonts.japanese),
        ] {
            let invalid = family.trim().is_empty()
                || family.chars().count() > 128
                || family.chars().any(char::is_control)
                || family.contains(['"', '\'', '\\', ';']);
            if invalid {
                return Err(format!("{slot} font family is not a safe family name"));
            }
        }
        if FontSlot::ALL.iter().any(|slot| {
            self.fonts
                .priority
                .iter()
                .filter(|entry| *entry == slot)
                .count()
                != 1
        }) {
            return Err("font priority must contain each slot exactly once".to_string());
        }
        Ok(())
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

/// One Agent the author works with: a name, the channel it
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
    SetPanelSide(PanelSide),
    SetPanelMaterial(PanelMaterial),
    SetNightLamp(NightLamp),
    /// None restores "follow the interface theme".
    SetCodeTheme(Option<String>),
    SetPanelWidth(PanelWidth),
    SetRailWidth(RailWidth),
    SetPanelAnimation(bool),
    SetTypography(TypographyConfig),
    SaveTypographyPreset(String),
    RemoveTypographyPreset(Id),
    SetIconDigest(Option<String>),
    ResetVisual,
    ResetTypography,
    RestoreAppearance(AppearanceConfig),
    UpsertHarnessConnection(HarnessConnection),
    RemoveHarnessConnection(Id),
    UpsertAgent(AgentProfile),
    RemoveAgent(Id),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigV1 {
    version: u32,
    kara: KaraConfig,
    #[serde(default)]
    appearance: AppearanceConfigV1,
    #[serde(default)]
    harness_connections: Vec<HarnessConnection>,
    #[serde(default)]
    agents: Vec<AgentProfile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AppearanceConfigV1 {
    theme: String,
    #[serde(default)]
    fonts: FontConfig,
    #[serde(default)]
    paper: PaperMode,
    #[serde(default = "v1_default_text_size")]
    text_size: u16,
    #[serde(default = "v1_default_line_height")]
    line_height: u16,
    #[serde(default)]
    icon_digest: Option<String>,
}

impl Default for AppearanceConfigV1 {
    fn default() -> Self {
        Self {
            theme: "tou".to_string(),
            fonts: FontConfig::default(),
            paper: PaperMode::default(),
            text_size: v1_default_text_size(),
            line_height: v1_default_line_height(),
            icon_digest: None,
        }
    }
}

const fn v1_default_text_size() -> u16 {
    17
}

const fn v1_default_line_height() -> u16 {
    190
}

impl ConfigV1 {
    fn migrate(self) -> Config {
        debug_assert_eq!(self.version, 1);
        let typography = TypographyConfig {
            fonts: self.appearance.fonts,
            text_size_tenths_px: self.appearance.text_size.saturating_mul(10),
            line_height_percent: self.appearance.line_height,
            ..TypographyConfig::default()
        };
        Config {
            version: CONFIG_VERSION,
            kara: self.kara,
            appearance: AppearanceConfig {
                theme: self.appearance.theme,
                typography,
                typography_presets: Vec::new(),
                paper: self.appearance.paper,
                // v1 没有面板栈，迁移过来的配置落在默认值上：左侧、有动画、
                // 实心面板、不点灯。
                panel_side: PanelSide::default(),
                panel_animation: true,
                panel_material: PanelMaterial::default(),
                night_lamp: NightLamp::default(),
                code_theme: None,
                panel_width: PanelWidth::default(),
                rail_width: RailWidth::default(),
                icon_digest: self.appearance.icon_digest,
                // v1 的小窗口不能调透明度，所以迁移过来的配置是不透明的
                // ——那是它一直以来的样子，不是一个新选择。
                bento_opacity_percent: full_opacity(),
            },
            harness_connections: self.harness_connections,
            agents: self.agents,
        }
    }
}

#[derive(Deserialize)]
struct VersionProbe {
    version: u32,
}

/// A load or write that could not honour the rules above.
#[derive(Debug, thiserror::Error)]
pub enum ConfigFailure {
    /// The file does not parse as the current shape. The original bytes are
    /// untouched; the interface enters Safety with the field detail.
    #[error("config at {path} is damaged: {detail}")]
    Damaged { path: PathBuf, detail: String },
    /// A typed change was outside the schema's admitted domain.
    #[error("invalid Config value: {detail}")]
    Invalid { detail: String },
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

impl Config {
    fn validate(&self) -> Result<(), String> {
        if self.version != CONFIG_VERSION {
            return Err(format!(
                "version must be {CONFIG_VERSION} after migration; got {}",
                self.version
            ));
        }
        self.appearance.typography.validate()?;

        let mut ids = HashSet::new();
        let mut names = HashSet::new();
        for preset in &self.appearance.typography_presets {
            let name = preset.name.trim();
            if name.is_empty() || name.chars().count() > 40 || name.chars().any(char::is_control) {
                return Err(
                    "typography preset names must contain 1–40 visible characters".to_string(),
                );
            }
            if !ids.insert(preset.id) {
                return Err(format!("duplicate typography preset id {}", preset.id));
            }
            if !names.insert(name.to_lowercase()) {
                return Err(format!("duplicate typography preset name {name}"));
            }
            preset.typography.validate()?;
        }
        Ok(())
    }
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

        let text = Self::read_text(&store.path)?;
        let (config, migrated) = Self::decode(&store.path, &text)?;

        // Resolve interrupted evidence before a migration writes the v2 shape.
        let recovered =
            atomic::recover_interrupted_write(&store.path).map_err(|source| ConfigFailure::Io {
                path: store.path.clone(),
                source,
            })?;
        let migration = migrated.then(|| store.write(&config)).transpose()?;
        Ok((
            store,
            ConfigSnapshot {
                config,
                recovery_evidence: recovered
                    .recovery_evidence
                    .or_else(|| migration.and_then(|outcome| outcome.recovery_evidence)),
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
            ConfigChange::SetPanelSide(side) => {
                snapshot.config.appearance.panel_side = side;
            }
            ConfigChange::SetPanelMaterial(material) => {
                snapshot.config.appearance.panel_material = material;
            }
            ConfigChange::SetNightLamp(lamp) => {
                snapshot.config.appearance.night_lamp = lamp;
            }
            ConfigChange::SetCodeTheme(theme) => {
                snapshot.config.appearance.code_theme = theme;
            }
            ConfigChange::SetPanelWidth(width) => {
                snapshot.config.appearance.panel_width = width;
            }
            ConfigChange::SetRailWidth(width) => {
                snapshot.config.appearance.rail_width = width;
            }
            ConfigChange::SetPanelAnimation(animated) => {
                snapshot.config.appearance.panel_animation = animated;
            }
            ConfigChange::SetTypography(typography) => {
                snapshot.config.appearance.typography = typography;
            }
            ConfigChange::SaveTypographyPreset(name) => {
                let name = name.trim().to_string();
                let typography = snapshot.config.appearance.typography.clone();
                match snapshot
                    .config
                    .appearance
                    .typography_presets
                    .iter_mut()
                    .find(|existing| existing.name.eq_ignore_ascii_case(&name))
                {
                    Some(existing) => {
                        existing.name = name;
                        existing.typography = typography;
                    }
                    None => snapshot
                        .config
                        .appearance
                        .typography_presets
                        .push(TypographyPreset {
                            id: Id::new(),
                            name,
                            typography,
                        }),
                }
            }
            ConfigChange::RemoveTypographyPreset(id) => {
                snapshot
                    .config
                    .appearance
                    .typography_presets
                    .retain(|preset| preset.id != id);
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
                snapshot.config.appearance.typography = TypographyConfig::default();
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
        snapshot.config.version = CONFIG_VERSION;
        snapshot
            .config
            .validate()
            .map_err(|detail| ConfigFailure::Invalid { detail })?;
        let outcome = self.write(&snapshot.config)?;
        snapshot.recovery_evidence = outcome.recovery_evidence;
        Ok(snapshot)
    }

    /// Re-reads the file this store points at. `apply` goes through here so a
    /// Config edited on disk between load and save is not silently flattened:
    /// a damaged or newer on-disk file stops the apply, it is not "repaired".
    fn current(path: &Path) -> Result<ConfigSnapshot, ConfigFailure> {
        let text = Self::read_text(path)?;
        let (config, _) = Self::decode(path, &text)?;
        Ok(ConfigSnapshot {
            config,
            recovery_evidence: None,
        })
    }

    fn read_text(path: &Path) -> Result<String, ConfigFailure> {
        let bytes = std::fs::read(path).map_err(|source| ConfigFailure::Io {
            path: path.to_path_buf(),
            source,
        })?;
        String::from_utf8(bytes).map_err(|error| ConfigFailure::Damaged {
            path: path.to_path_buf(),
            detail: format!("not valid UTF-8: {error}"),
        })
    }

    fn decode(path: &Path, text: &str) -> Result<(Config, bool), ConfigFailure> {
        let probe: VersionProbe = toml::from_str(text).map_err(|error| ConfigFailure::Damaged {
            path: path.to_path_buf(),
            detail: error.to_string(),
        })?;
        if probe.version > CONFIG_VERSION {
            return Err(ConfigFailure::TooNew {
                found: probe.version,
                supported: CONFIG_VERSION,
            });
        }

        let (config, migrated) = match probe.version {
            1 => (
                toml::from_str::<ConfigV1>(text)
                    .map_err(|error| ConfigFailure::Damaged {
                        path: path.to_path_buf(),
                        detail: error.to_string(),
                    })?
                    .migrate(),
                true,
            ),
            CONFIG_VERSION => (
                toml::from_str::<Config>(text).map_err(|error| ConfigFailure::Damaged {
                    path: path.to_path_buf(),
                    detail: error.to_string(),
                })?,
                false,
            ),
            version => {
                return Err(ConfigFailure::Damaged {
                    path: path.to_path_buf(),
                    detail: format!("unsupported Config version {version}"),
                });
            }
        };
        config.validate().map_err(|detail| ConfigFailure::Damaged {
            path: path.to_path_buf(),
            detail,
        })?;
        Ok((config, migrated))
    }

    fn write(&self, config: &Config) -> Result<atomic::AtomicOutcome, ConfigFailure> {
        config
            .validate()
            .map_err(|detail| ConfigFailure::Invalid { detail })?;
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
