//! M4 ConfigStore vectors: one authority, atomic writes, and the three
//! refusals — damaged, newer, and quietly-repaired. The failure each test
//! names: the author's choices flattened to defaults, or a newer build's
//! file rewritten by an older one.

use refrain_core::Id;
use refrain_store::config::{
    AdapterKind, Config, ConfigChange, ConfigFailure, ConfigStore, HarnessConnection,
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

#[test]
fn a_first_run_writes_the_defaults_atomically_and_returns_them() {
    let dir = scratch();

    let (_store, snapshot) = ConfigStore::load(&dir).unwrap();

    assert_eq!(snapshot.config, Config::default());
    assert!(snapshot.config.kara.auto_enter_on_first_manuscript);
    let on_disk = fs::read_to_string(dir.join("config.toml")).unwrap();
    assert!(on_disk.contains("auto_enter_on_first_manuscript = true"));
    assert_eq!(snapshot.config.version, 1);
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
                supported: 1
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
