// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! M4 ConfigStore vectors: one authority, atomic writes, and the three
//! refusals — damaged, newer, and quietly-repaired. The failure each test
//! names: the author's choices flattened to defaults, or a newer build's
//! file rewritten by an older one.

use refrain_core::Id;
use refrain_core::persona::Persona;
use refrain_store::config::{
    AdapterKind, AgentProfile, AppearanceConfig, Config, ConfigChange, ConfigFailure, ConfigStore,
    FontConfig, HarnessConnection, PanelWidth, PaperMode, TextAlignment, TypographyConfig,
    TypographyField, builtin_typography_presets,
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
        version: None,
        skill_digest: None,
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
fn the_default_measure_is_65em_and_the_presets_scale_with_it() {
    // The author's decision: the column defaults to 65 em, and the built-in
    // presets sit proportionally around it — CJK a little tighter, Latin a
    // little wider. A regression here silently narrows every new manuscript.
    assert_eq!(TypographyConfig::default().measure_tenths_em, 650);
    let presets = builtin_typography_presets();
    assert_eq!(presets[0].typography.measure_tenths_em, 600);
    assert_eq!(presets[1].typography.measure_tenths_em, 600);
    assert_eq!(presets[2].typography.measure_tenths_em, 680);
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
fn a_free_form_panel_width_round_trips_and_stays_absent_until_set() {
    let dir = scratch();
    let (store, defaults) = ConfigStore::load(&dir).unwrap();
    // Additive means the key does not exist until the author drags: the
    // defaults file carries no `panel_width_px` line and still loads.
    assert_eq!(defaults.config.appearance.panel_width_px, None);
    let on_disk = fs::read_to_string(dir.join("config.toml")).unwrap();
    assert!(!on_disk.contains("panel_width_px"));

    let snapshot = store
        .apply(ConfigChange::SetPanelWidthPx(Some(480)))
        .unwrap();
    assert_eq!(snapshot.config.appearance.panel_width_px, Some(480));

    let (_reopened, reloaded) = ConfigStore::load(&dir).unwrap();
    assert_eq!(reloaded.config.appearance.panel_width_px, Some(480));
    let on_disk = fs::read_to_string(dir.join("config.toml")).unwrap();
    assert!(on_disk.contains("panel_width_px = 480"));

    // None is a value too: clearing returns the panel to its preset.
    let cleared = store.apply(ConfigChange::SetPanelWidthPx(None)).unwrap();
    assert_eq!(cleared.config.appearance.panel_width_px, None);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_free_form_panel_width_outside_the_drag_limits_is_refused() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();

    for width in [299_u16, 721_u16] {
        let failure = store
            .apply(ConfigChange::SetPanelWidthPx(Some(width)))
            .unwrap_err();
        assert!(
            matches!(failure, ConfigFailure::Invalid { .. }),
            "{width} must refuse: {failure:?}"
        );
    }
    for width in [300_u16, 720_u16] {
        store
            .apply(ConfigChange::SetPanelWidthPx(Some(width)))
            .unwrap_or_else(|failure| {
                panic!("{width} is a drag limit, not a refusal: {failure:?}")
            });
    }
    // The refusals wrote nothing: the last accepted value stands.
    let (_reopened, reloaded) = ConfigStore::load(&dir).unwrap();
    assert_eq!(reloaded.config.appearance.panel_width_px, Some(720));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn choosing_a_panel_width_preset_clears_the_free_form_value() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    store
        .apply(ConfigChange::SetPanelWidthPx(Some(480)))
        .unwrap();

    let snapshot = store
        .apply(ConfigChange::SetPanelWidth(PanelWidth::Full))
        .unwrap();

    assert_eq!(snapshot.config.appearance.panel_width, PanelWidth::Full);
    assert_eq!(
        snapshot.config.appearance.panel_width_px, None,
        "the preset is the newer statement about panel width"
    );
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
fn upserting_an_agent_with_an_existing_id_edits_in_place() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    let id = Id::new();
    let agent = |name: &str, persona: Option<&str>| refrain_store::config::AgentProfile {
        id,
        name: name.to_string(),
        connection_id: None,
        persona: persona.map(|text| Persona::Work {
            body: text.to_string(),
        }),
        argv: Vec::new(),
    };
    store
        .apply(ConfigChange::UpsertAgent(agent("初稿", None)))
        .unwrap();

    // The edit path: the same id comes back with new values. The list must
    // not grow — an edit that mints a fresh id appends forever.
    let snapshot = store
        .apply(ConfigChange::UpsertAgent(agent("定稿", Some("审稿人"))))
        .unwrap();
    assert_eq!(snapshot.config.agents.len(), 1);
    assert_eq!(snapshot.config.agents[0].id, id);
    assert_eq!(snapshot.config.agents[0].name, "定稿");
    assert_eq!(
        snapshot.config.agents[0]
            .persona
            .as_ref()
            .map(Persona::body),
        Some("审稿人")
    );

    // The create path: a fresh id appends, so create and edit stay apart.
    let fresh = refrain_store::config::AgentProfile {
        id: Id::new(),
        ..agent("第二", None)
    };
    let snapshot = store.apply(ConfigChange::UpsertAgent(fresh)).unwrap();
    assert_eq!(snapshot.config.agents.len(), 2);

    let (_reopened, reloaded) = ConfigStore::load(&dir).unwrap();
    assert_eq!(reloaded.config.agents.len(), 2);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_connection_keeps_its_last_successful_version_across_reads() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    let first = HarnessConnection {
        version: Some("1.2.3".to_string()),
        ..connection(AdapterKind::KimiCode)
    };
    let id = first.id;
    store
        .apply(ConfigChange::UpsertHarnessConnection(first))
        .unwrap();

    // The re-probe at every listing must find the stored identity intact —
    // a read that dropped the row or its last-known facts is what turned
    // "previously worked" into "needs re-linking".
    for _ in 0..2 {
        let snapshot = store.snapshot().unwrap();
        let row = snapshot
            .config
            .harness_connections
            .iter()
            .find(|entry| entry.id == id)
            .expect("the stored connection survives every read");
        assert_eq!(row.version.as_deref(), Some("1.2.3"));
    }
    fs::remove_dir_all(dir).unwrap();
}

/// 老版本写出的文件没有 `skill_digest` 与 `argv` 两列：serde(default) 让
/// 它们以「未安装 / 空」载入，而不是整份文件被判成损坏。新值写进去再读
/// 出来必须逐字相同——这是安装记录与 agent argv 的落地处。
#[test]
fn the_new_optional_fields_load_absent_and_round_trip_present() {
    let dir = scratch();
    let connection_id = Id::new();
    let agent_id = Id::new();
    fs::write(
        dir.join("config.toml"),
        format!(
            "version = 2\n\
             [kara]\n\
             auto_enter_on_first_manuscript = true\n\
             [appearance]\n\
             theme = \"tou\"\n\
             [appearance.typography]\n\
             text_size_tenths_px = 170\n\
             font_weight = 400\n\
             line_height_percent = 190\n\
             letter_spacing_thousandths_em = 10\n\
             word_spacing_thousandths_em = 0\n\
             measure_tenths_em = 650\n\
             first_line_indent_tenths_em = 0\n\
             paragraph_spacing_percent = 100\n\
             alignment = \"left\"\n\
             page_top_padding_tenths_rem = 30\n\
             page_bottom_padding_tenths_vh = 500\n\
             baseline_grid_lines = 0\n\
             zoom_percent = 100\n\
             [appearance.typography.fonts]\n\
             latin = \"Jost\"\n\
             chinese = \"Noto Sans SC\"\n\
             japanese = \"Murecho\"\n\
             priority = [\"latin\", \"chinese\", \"japanese\"]\n\
             [[harness_connections]]\n\
             id = \"{connection_id}\"\n\
             adapter = \"kimi-code\"\n\
             executable = \"C:\\\\Tools\\\\kimi.exe\"\n\
             [[agents]]\n\
             id = \"{agent_id}\"\n\
             name = \"译审\"\n"
        ),
    )
    .unwrap();
    let (store, snapshot) = ConfigStore::load(&dir).unwrap();
    assert_eq!(snapshot.config.harness_connections[0].skill_digest, None);
    assert_eq!(snapshot.config.agents[0].argv, Vec::<String>::new());

    let mut connection = snapshot.config.harness_connections[0].clone();
    connection.skill_digest = Some("blake3-of-installed-bytes".to_string());
    store
        .apply(ConfigChange::UpsertHarnessConnection(connection))
        .unwrap();
    let mut agent = snapshot.config.agents[0].clone();
    agent.argv = vec!["--model".to_string(), "k2".to_string()];
    store.apply(ConfigChange::UpsertAgent(agent)).unwrap();

    let reloaded = store.snapshot().unwrap();
    assert_eq!(
        reloaded.config.harness_connections[0]
            .skill_digest
            .as_deref(),
        Some("blake3-of-installed-bytes")
    );
    assert_eq!(reloaded.config.agents[0].argv, ["--model", "k2"]);
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

#[test]
fn an_agents_persona_round_trips_through_create_and_update() {
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    let id = Id::new();

    // Create with a persona, as upsert_agent does.
    let created = store
        .apply(ConfigChange::UpsertAgent(
            refrain_store::config::AgentProfile {
                id,
                name: "译审".to_string(),
                connection_id: None,
                persona: Some(Persona::Work {
                    body: "以林译风格润色，保留异化句式。".to_string(),
                }),
                argv: Vec::new(),
            },
        ))
        .unwrap();
    let listed = created
        .config
        .agents
        .iter()
        .find(|agent| agent.id == id)
        .expect("the created agent is listed");
    assert_eq!(
        listed.persona.as_ref().map(Persona::body),
        Some("以林译风格润色，保留异化句式。")
    );

    // Update in place, as update_agent does: the persona the edit form
    // prefilled comes back verbatim, and a replacement lands whole.
    let updated = store
        .apply(ConfigChange::UpsertAgent(
            refrain_store::config::AgentProfile {
                id,
                name: "译审".to_string(),
                connection_id: None,
                persona: Some(Persona::Work {
                    body: "克制润色，只动标点。".to_string(),
                }),
                argv: Vec::new(),
            },
        ))
        .unwrap();
    let listed = updated
        .config
        .agents
        .iter()
        .find(|agent| agent.id == id)
        .expect("the updated agent is listed");
    assert_eq!(
        listed.persona.as_ref().map(Persona::body),
        Some("克制润色，只动标点。")
    );
    assert_eq!(updated.config.agents.len(), 1, "an update must not clone");

    // The value also survives the disk, not only the snapshot in hand.
    let (_reopened, reloaded) = ConfigStore::load(&dir).unwrap();
    let listed = reloaded
        .config
        .agents
        .iter()
        .find(|agent| agent.id == id)
        .expect("the agent survives a reload");
    assert_eq!(
        listed.persona.as_ref().map(Persona::body),
        Some("克制润色，只动标点。")
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn adjusting_one_typographic_field_leaves_the_other_thirteen_alone() {
    // 界面上作者调的是一项。让它送整份，就得先持有另外 13 项的当前值——
    // 而并发下那份值可能已经旧了：调字号的同时若有别处改过行高，整份
    // 替换会把行高改回界面读到的那个旧值。
    let dir = scratch();
    let (store, before) = ConfigStore::load(&dir).unwrap();
    let baseline = before.config.appearance.typography.clone();

    let after = store
        .apply(ConfigChange::AdjustTypography {
            field: TypographyField::TextSize,
            delta: 10,
        })
        .unwrap();
    let typography = &after.config.appearance.typography;

    assert_eq!(
        typography.text_size_tenths_px,
        baseline.text_size_tenths_px + 10
    );
    // 其余全部逐字相同。近失手：整份替换会让这几条中的某一条变成默认值，
    // 而作者不会立刻注意到——他正盯着字号。
    assert_eq!(typography.line_height_percent, baseline.line_height_percent);
    assert_eq!(typography.measure_tenths_em, baseline.measure_tenths_em);
    assert_eq!(typography.fonts, baseline.fonts);
    assert_eq!(typography.alignment, baseline.alignment);
    assert_eq!(typography.zoom_percent, baseline.zoom_percent);
}

#[test]
fn a_typographic_field_stops_at_its_bound_instead_of_wrapping() {
    // 撞到边界就停：绕回会让按住按钮的作者从最大跳到最小，而他看到的
    // 是正文突然缩成一团。上下界不是审美选择——10px 以下认不出汉字
    // 笔画，行长短于 20 个字身每行放不下一个完整句子。
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();

    let huge = store
        .apply(ConfigChange::AdjustTypography {
            field: TypographyField::TextSize,
            delta: 10_000,
        })
        .unwrap();
    assert_eq!(huge.config.appearance.typography.text_size_tenths_px, 400);

    let tiny = store
        .apply(ConfigChange::AdjustTypography {
            field: TypographyField::TextSize,
            delta: -10_000,
        })
        .unwrap();
    assert_eq!(tiny.config.appearance.typography.text_size_tenths_px, 100);
}

#[test]
fn each_adjustable_field_moves_only_itself() {
    // 三项各自独立。共用一个字段的写入点会让调行高把字号也改了，而
    // 两次读数都「变了」，界面上看不出是哪一项串了。
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    let mut previous = store.apply(ConfigChange::ResetTypography).unwrap();

    for (field, expected) in [
        (TypographyField::LineHeight, "line"),
        (TypographyField::Measure, "measure"),
    ] {
        let after = store
            .apply(ConfigChange::AdjustTypography { field, delta: 5 })
            .unwrap();
        let old = &previous.config.appearance.typography;
        let new = &after.config.appearance.typography;
        match expected {
            "line" => {
                assert_eq!(new.line_height_percent, old.line_height_percent + 5);
                assert_eq!(new.text_size_tenths_px, old.text_size_tenths_px);
                assert_eq!(new.measure_tenths_em, old.measure_tenths_em);
            }
            _ => {
                assert_eq!(new.measure_tenths_em, old.measure_tenths_em + 5);
                assert_eq!(new.text_size_tenths_px, old.text_size_tenths_px);
                assert_eq!(new.line_height_percent, old.line_height_percent);
            }
        }
        previous = after;
    }
}

#[test]
fn toggling_an_agent_persona_keeps_the_author_s_text() {
    // 作者试完扮演想切回干活，那段角色描述还在。丢掉它，他得重写——
    // 而「切换」这个词本身承诺了不会丢。
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    let body = "我是沈青，二十七岁，话很少。";
    let agent = AgentProfile {
        id: Id::new(),
        name: "沈青".to_string(),
        connection_id: None,
        persona: Some(Persona::Work {
            body: body.to_string(),
        }),
        argv: Vec::new(),
    };
    let agent_id = agent.id;
    store.apply(ConfigChange::UpsertAgent(agent)).unwrap();

    let after = store
        .apply(ConfigChange::ToggleAgentPersona(agent_id))
        .unwrap();
    let persona = after.config.agents[0].persona.as_ref().unwrap();
    assert!(persona.is_cosplay(), "the mode did not change");
    assert_eq!(persona.body(), body, "the author's text was lost");

    // 切回去要回到原样：一个只能单向切的开关不是开关。
    let back = store
        .apply(ConfigChange::ToggleAgentPersona(agent_id))
        .unwrap();
    let persona = back.config.agents[0].persona.as_ref().unwrap();
    assert!(!persona.is_cosplay());
    assert_eq!(persona.body(), body);
}

#[test]
fn toggling_an_agent_without_a_persona_creates_nothing() {
    // 近失手：没有身份就切换，会凭空造出一个空的 Cosplay 身份——而作者
    // 什么也没写。那个 Agent 于是带着一份只有演法预设的身份文件出发。
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    let agent = AgentProfile {
        id: Id::new(),
        name: "无名".to_string(),
        connection_id: None,
        persona: None,
        argv: Vec::new(),
    };
    let agent_id = agent.id;
    store.apply(ConfigChange::UpsertAgent(agent)).unwrap();

    let after = store
        .apply(ConfigChange::ToggleAgentPersona(agent_id))
        .unwrap();
    assert!(after.config.agents[0].persona.is_none());
}

#[test]
fn toggling_an_agent_that_does_not_exist_is_a_named_refusal() {
    // 无声通过会让界面以为切换成功，而作者按下去什么也没变。
    let dir = scratch();
    let (store, _) = ConfigStore::load(&dir).unwrap();
    let error = store
        .apply(ConfigChange::ToggleAgentPersona(Id::new()))
        .unwrap_err();
    assert!(error.to_string().contains("does not exist"), "{error}");
}

#[test]
fn the_cosplay_preset_is_one_global_setting() {
    // 全局一份，不做每 Agent 覆盖：两份配置会让「现在到底发了哪段」
    // 重新分裂，而那正是 Persona 这个类型要消除的。
    let dir = scratch();
    let (store, before) = ConfigStore::load(&dir).unwrap();
    assert!(
        !before.config.appearance.cosplay_preset.is_empty(),
        "a fresh config has no default preset"
    );
    let after = store
        .apply(ConfigChange::SetCosplayPreset("只写对白。".to_string()))
        .unwrap();
    assert_eq!(after.config.appearance.cosplay_preset, "只写对白。");
}
