//! M4 ConfigStore vectors: one authority, atomic writes, and the three
//! refusals — damaged, newer, and quietly-repaired. The failure each test
//! names: the author's choices flattened to defaults, or a newer build's
//! file rewritten by an older one.

use refrain_core::Id;
use refrain_store::config::{
    AdapterKind, AppearanceConfig, Config, ConfigChange, ConfigFailure, ConfigStore, FontConfig,
    HarnessConnection, PaperMode, TextAlignment, TypographyConfig, builtin_typography_presets,
};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let unique = format!(
        "refrain-config-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let dir = std::env::temp_dir().join(unique);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn connection(adapter: AdapterKind) -> HarnessConnection {
    HarnessConnection {
        id: Id::new(),
        adapter,
        executable: PathBuf::from(r"C:\Tools\harness.exe"),
        argv: vec!["--stdio".to_string()],
        env_allow: vec!["PATH".to_string()],
    }
}

fn complete_typography() -> TypographyConfig {
    TypographyConfig {
        fonts: FontConfig {
            latin: "Jost".to_string(),
            chinese: "Noto Sans SC".to_string(),
            japanese: "Murecho".to_string(),
            priority: [
                refrain_store::config::FontSlot::Japanese,
                refrain_store::config::FontSlot::Chinese,
                refrain_store::config::FontSlot::Latin,
            ],
        },
        text_size_tenths_px: 215,
        font_weight: 520,
        line_height_percent: 225,
        letter_spacing_thousandths_em: 25,
        word_spacing_thousandths_em: 100,
        measure_tenths_em: 420,
        first_line_indent_tenths_em: 20,
        paragraph_spacing_percent: 125,
        alignment: TextAlignment::Justify,
        page_top_padding_tenths_rem: 45,
        page_bottom_padding_tenths_vh: 350,
        baseline_grid_lines: 2,
        zoom_percent: 115,
    }
}

#[test]
fn a_first_run_writes_the_defaults_atomically_and_returns_them() {
    let dir = scratch();

    let (_store, snapshot) = ConfigStore::load(&dir).unwrap();

    assert_eq!(snapshot.config, Config::default());
    assert!(snapshot.config.kara.auto_enter_on_first_manuscript);
    let on_disk = fs::read_to_string(dir.join("config.toml")).unwrap();
    assert!(on_disk.contains("auto_enter_on_first_manuscript = true"));
    assert_eq!(snapshot.config.version, 2);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_v1_flat_appearance_migrates_once_to_the_v2_typography_owner() {
    let dir = scratch();
    let path = dir.join("config.toml");
    fs::write(
        &path,
        r#"version = 1

[kara]
auto_enter_on_first_manuscript = false

[appearance]
theme = "sumi"
paper = "paper"
text_size = 21
line_height = 225
icon_digest = "legacy-icon"

[appearance.fonts]
latin = "Jost"
chinese = "Noto Sans SC"
japanese = "Murecho"
priority = ["japanese", "chinese", "latin"]
"#,
    )
    .unwrap();

    let (_store, migrated) = ConfigStore::load(&dir).unwrap();

    assert_eq!(migrated.config.version, 2);
    assert_eq!(migrated.config.appearance.theme, "sumi");
    assert_eq!(migrated.config.appearance.paper, PaperMode::Paper);
    assert_eq!(
        migrated.config.appearance.typography.fonts,
        complete_typography().fonts
    );
    assert_eq!(
        migrated.config.appearance.typography.text_size_tenths_px,
        210
    );
    assert_eq!(
        migrated.config.appearance.typography.line_height_percent,
        225
    );
    let on_disk = fs::read_to_string(&path).unwrap();
    assert!(on_disk.contains("version = 2"));
    assert!(on_disk.contains("[appearance.typography]"));
    assert!(on_disk.contains("text_size_tenths_px = 210"));
    for _ in 0..2 {
        let (_reopened, snapshot) = ConfigStore::load(&dir).unwrap();
        assert_eq!(snapshot.config.version, 2);
        assert_eq!(fs::read_to_string(&path).unwrap(), on_disk);
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unsafe_font_names_and_duplicate_priority_are_refused_without_rewriting_config() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    let path = dir.join("config.toml");
    let original = fs::read(&path).unwrap();

    for family in [
        "",
        "Bad;Family",
        "Bad\"Family",
        "Bad\\Family",
        "Bad\nFamily",
    ] {
        let mut typography = TypographyConfig::default();
        typography.fonts.latin = family.to_string();
        let error = store
            .apply(ConfigChange::SetTypography(typography))
            .unwrap_err();
        assert!(error.to_string().contains("safe family name"));
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    let mut typography = TypographyConfig::default();
    typography.fonts.priority = [
        refrain_store::config::FontSlot::Latin,
        refrain_store::config::FontSlot::Latin,
        refrain_store::config::FontSlot::Japanese,
    ];
    let error = store
        .apply(ConfigChange::SetTypography(typography))
        .unwrap_err();
    assert!(error.to_string().contains("each slot exactly once"));
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn complete_typography_round_trips_as_one_typed_value() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    let typography = complete_typography();

    let changed = store
        .apply(ConfigChange::SetTypography(typography.clone()))
        .unwrap();
    assert_eq!(changed.config.appearance.typography, typography);

    let (_reopened, reloaded) = ConfigStore::load(&dir).unwrap();
    assert_eq!(reloaded.config.appearance.typography, typography);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn every_value_admitted_by_the_typography_controls_crosses_the_config_boundary() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    let mut typography = TypographyConfig {
        letter_spacing_thousandths_em: -100,
        page_bottom_padding_tenths_vh: 0,
        ..TypographyConfig::default()
    };

    store
        .apply(ConfigChange::SetTypography(typography.clone()))
        .unwrap();
    typography.page_bottom_padding_tenths_vh = 1000;
    store
        .apply(ConfigChange::SetTypography(typography))
        .unwrap();
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn builtin_typography_presets_are_complete_distinct_and_valid() {
    let presets = builtin_typography_presets();

    assert_eq!(presets.len(), 3);
    assert_eq!(presets[0].id, "chinese-prose");
    assert_eq!(presets[1].id, "japanese-prose");
    assert_eq!(presets[2].id, "english-prose");
    assert!(
        presets
            .windows(2)
            .all(|pair| pair[0].typography != pair[1].typography)
    );
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    for preset in presets {
        store
            .apply(ConfigChange::SetTypography(preset.typography))
            .unwrap();
    }
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_user_typography_preset_overwrites_by_name_keeps_its_id_and_deletes_durably() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    store
        .apply(ConfigChange::SetTypography(complete_typography()))
        .unwrap();
    let first = store
        .apply(ConfigChange::SaveTypographyPreset("Interview".to_string()))
        .unwrap();
    let id = first.config.appearance.typography_presets[0].id;

    let mut replacement = complete_typography();
    replacement.measure_tenths_em = 500;
    store
        .apply(ConfigChange::SetTypography(replacement.clone()))
        .unwrap();
    let overwritten = store
        .apply(ConfigChange::SaveTypographyPreset("interVIEW".to_string()))
        .unwrap();
    assert_eq!(overwritten.config.appearance.typography_presets.len(), 1);
    assert_eq!(overwritten.config.appearance.typography_presets[0].id, id);
    assert_eq!(
        overwritten.config.appearance.typography_presets[0].typography,
        replacement
    );

    store
        .apply(ConfigChange::RemoveTypographyPreset(id))
        .unwrap();
    let (_reopened, reloaded) = ConfigStore::load(&dir).unwrap();
    assert!(reloaded.config.appearance.typography_presets.is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_typed_change_round_trips_through_disk() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();

    let snapshot = store.apply(ConfigChange::KaraAutoEnter(false)).unwrap();
    assert!(!snapshot.config.kara.auto_enter_on_first_manuscript);

    let (_reopened, reloaded) = ConfigStore::load(&dir).unwrap();
    assert!(!reloaded.config.kara.auto_enter_on_first_manuscript);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn settings_reset_each_page_without_touching_the_other_and_can_restore_the_entry_snapshot() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    let entered = AppearanceConfig {
        theme: "sumi".to_string(),
        typography: complete_typography(),
        typography_presets: Vec::new(),
        paper: PaperMode::Paper,
        icon_digest: Some("original-icon".to_string()),
        // This test is about reset and restore, not about every appearance
        // field. Spreading the defaults keeps it that way: a new field does
        // not drag an unrelated test into its change.
        ..AppearanceConfig::default()
    };
    store
        .apply(ConfigChange::RestoreAppearance(entered.clone()))
        .unwrap();

    let visual_reset = store.apply(ConfigChange::ResetVisual).unwrap();
    let defaults = AppearanceConfig::default();
    assert_eq!(visual_reset.config.appearance.theme, defaults.theme);
    assert_eq!(visual_reset.config.appearance.paper, defaults.paper);
    assert_eq!(
        visual_reset.config.appearance.icon_digest,
        defaults.icon_digest
    );
    assert_eq!(
        visual_reset.config.appearance.typography,
        entered.typography
    );

    let typography_reset = store.apply(ConfigChange::ResetTypography).unwrap();
    assert_eq!(
        typography_reset.config.appearance.typography,
        defaults.typography
    );
    assert_eq!(typography_reset.config.appearance.theme, defaults.theme);
    assert_eq!(typography_reset.config.appearance.paper, defaults.paper);

    store
        .apply(ConfigChange::RestoreAppearance(entered.clone()))
        .unwrap();
    let (_reopened, reloaded) = ConfigStore::load(&dir).unwrap();
    assert_eq!(reloaded.config.appearance, entered);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn upserting_a_connection_replaces_rather_than_duplicates() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();

    let first = connection(AdapterKind::Codex);
    let id = first.id;
    store
        .apply(ConfigChange::UpsertHarnessConnection(first))
        .unwrap();
    let updated = HarnessConnection {
        argv: vec!["--full-auto".to_string()],
        ..connection(AdapterKind::Codex)
    };
    let updated = HarnessConnection { id, ..updated };
    let snapshot = store
        .apply(ConfigChange::UpsertHarnessConnection(updated))
        .unwrap();

    assert_eq!(snapshot.config.harness_connections.len(), 1);
    assert_eq!(snapshot.config.harness_connections[0].argv, ["--full-auto"]);

    let snapshot = store
        .apply(ConfigChange::RemoveHarnessConnection(id))
        .unwrap();
    assert!(snapshot.config.harness_connections.is_empty());

    let (_reopened, reloaded) = ConfigStore::load(&dir).unwrap();
    assert!(reloaded.config.harness_connections.is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_damaged_file_is_refused_and_never_overwritten_with_defaults() {
    let dir = scratch();
    let path = dir.join("config.toml");
    fs::write(&path, "this is [ not toml\n").unwrap();

    let failure = ConfigStore::load(&dir).unwrap_err();
    assert!(
        matches!(failure, ConfigFailure::Damaged { .. }),
        "got {failure:?}"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "this is [ not toml\n");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_unknown_field_is_damage_not_a_hint_to_drop_it() {
    let dir = scratch();
    let path = dir.join("config.toml");
    fs::write(
        &path,
        "version = 1\nmystery = true\n[kara]\nauto_enter_on_first_manuscript = true\n",
    )
    .unwrap();

    let failure = ConfigStore::load(&dir).unwrap_err();
    assert!(
        matches!(failure, ConfigFailure::Damaged { .. }),
        "got {failure:?}"
    );
    assert!(fs::read_to_string(&path).unwrap().contains("mystery"));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_newer_version_is_refused_and_left_untouched() {
    let dir = scratch();
    let path = dir.join("config.toml");
    let original = "version = 999\n[kara]\nauto_enter_on_first_manuscript = false\n";
    fs::write(&path, original).unwrap();

    let failure = ConfigStore::load(&dir).unwrap_err();
    assert!(
        matches!(
            failure,
            ConfigFailure::TooNew {
                found: 999,
                supported: 2
            }
        ),
        "got {failure:?}"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_interrupted_save_is_recovered_before_the_next_load_continues() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    fs::write(dir.join("config.toml.writing"), "interrupted candidate\n").unwrap();

    let (_reopened, snapshot) = ConfigStore::load(&dir).unwrap();

    let evidence = snapshot
        .recovery_evidence
        .expect("the divergent residue is preserved");
    assert_eq!(fs::read(&evidence).unwrap(), b"interrupted candidate\n");
    assert!(!dir.join("config.toml.writing").try_exists().unwrap());

    // And the store still works afterwards.
    store.apply(ConfigChange::KaraAutoEnter(false)).unwrap();
    let (_again, reloaded) = ConfigStore::load(&dir).unwrap();
    assert!(!reloaded.config.kara.auto_enter_on_first_manuscript);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_apply_after_the_file_was_damaged_on_disk_stops_instead_of_repairing() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    fs::write(dir.join("config.toml"), "broken = [ \n").unwrap();

    let failure = store.apply(ConfigChange::KaraAutoEnter(false)).unwrap_err();
    assert!(
        matches!(failure, ConfigFailure::Damaged { .. }),
        "got {failure:?}"
    );
    fs::remove_dir_all(dir).unwrap();
}
