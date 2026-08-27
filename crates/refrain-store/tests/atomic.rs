// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Crash-boundary and recovery vectors for the atomic writer, ported from
//! legacy `atomic-file.test.ts` and `external-edit.test.ts`. Each test says
//! what the world looks like when it fails: a truncated chapter on disk, or a
//! lost candidate that only existed in memory.

use refrain_store::atomic::{
    AtomicWriteFailure, Checkpoint, owns_interrupted_write, recover_interrupted_write_observed,
    replace_file_atomically, replace_state_file_atomically,
};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch() -> PathBuf {
    let unique = format!(
        "refrain-atomic-{}-{}-{}",
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

fn evidence_paths(root: &Path, target: &Path) -> Vec<PathBuf> {
    let prefix = format!("{}.writing.", target.file_name().unwrap().to_string_lossy());
    let mut found: Vec<PathBuf> = fs::read_dir(root)
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            (name.starts_with(&prefix) && !name.ends_with(".refrain-owner"))
                .then(|| root.join(name))
        })
        .collect();
    found.sort();
    found
}

fn stop_at(checkpoint: Checkpoint) -> impl FnMut(Checkpoint) -> io::Result<()> {
    move |reached| {
        if reached == checkpoint {
            Err(io::Error::other(format!("stopped after {checkpoint:?}")))
        } else {
            Ok(())
        }
    }
}

fn typed_failure(error: io::Error) -> AtomicWriteFailure {
    error
        .into_inner()
        .and_then(|inner| inner.downcast::<AtomicWriteFailure>().ok())
        .map(|boxed| *boxed)
        .expect("the failure carries typed recovery evidence")
}

#[test]
fn a_residue_identical_to_the_canonical_target_is_safely_cleared() {
    let root = scratch();
    let target = root.join("chapter.md");
    fs::write(&target, "canonical\n").unwrap();
    fs::write(root.join("chapter.md.writing"), "canonical\n").unwrap();

    let outcome = replace_file_atomically(&target, b"next\n", |_| Ok(())).unwrap();

    assert_eq!(outcome.recovery_evidence, None);
    assert_eq!(fs::read(&target).unwrap(), b"next\n");
    assert!(!root.join("chapter.md.writing").try_exists().unwrap());
    assert_eq!(evidence_paths(&root, &target), Vec::<PathBuf>::new());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_differing_residue_is_preserved_and_its_location_returned() {
    let root = scratch();
    let target = root.join("chapter.md");
    fs::write(&target, "canonical\n").unwrap();
    fs::write(root.join("chapter.md.writing"), "interrupted candidate\n").unwrap();

    let outcome = replace_file_atomically(&target, b"next\n", |_| Ok(())).unwrap();

    let evidence = evidence_paths(&root, &target);
    assert_eq!(evidence.len(), 1);
    assert_eq!(outcome.recovery_evidence, Some(evidence[0].clone()));
    assert_eq!(fs::read(&evidence[0]).unwrap(), b"interrupted candidate\n");
    assert_eq!(fs::read(&target).unwrap(), b"next\n");
    assert!(!root.join("chapter.md.writing").try_exists().unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_residue_is_preserved_when_the_canonical_target_does_not_exist() {
    let root = scratch();
    let target = root.join("new-chapter.md");
    fs::write(
        root.join("new-chapter.md.writing"),
        "only copy left by the crash\n",
    )
    .unwrap();

    let outcome = replace_file_atomically(&target, b"new canonical\n", |_| Ok(())).unwrap();

    let evidence = evidence_paths(&root, &target);
    assert_eq!(evidence.len(), 1);
    assert_eq!(outcome.recovery_evidence, Some(evidence[0].clone()));
    assert_eq!(
        fs::read(&evidence[0]).unwrap(),
        b"only copy left by the crash\n"
    );
    assert_eq!(fs::read(&target).unwrap(), b"new canonical\n");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_crash_during_preservation_leaves_a_durable_name_for_the_candidate() {
    for checkpoint in [
        Checkpoint::RecoveryLinked,
        Checkpoint::RecoveryDirectorySynced,
        Checkpoint::RecoveryUnlinked,
    ] {
        let root = scratch();
        let target = root.join("chapter.md");
        let temporary = root.join("chapter.md.writing");
        fs::write(&target, "canonical\n").unwrap();
        fs::write(&temporary, "interrupted candidate\n").unwrap();

        let failure = typed_failure(
            recover_interrupted_write_observed(&target, stop_at(checkpoint)).unwrap_err(),
        );

        assert_eq!(
            fs::read(&failure.recovery_evidence).unwrap(),
            b"interrupted candidate\n"
        );
        assert_eq!(
            temporary.try_exists().unwrap(),
            checkpoint != Checkpoint::RecoveryUnlinked
        );
        if temporary.try_exists().unwrap() {
            assert_eq!(fs::read(&temporary).unwrap(), b"interrupted candidate\n");
        }
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn a_state_writer_stops_after_preserving_residue_it_has_no_notice_channel_for() {
    let root = scratch();
    let target = root.join("host.json");
    fs::write(&target, "canonical\n").unwrap();
    fs::write(root.join("host.json.writing"), "interrupted state\n").unwrap();

    let failure = typed_failure(replace_state_file_atomically(&target, b"next\n").unwrap_err());

    assert_eq!(fs::read(&target).unwrap(), b"canonical\n");
    assert!(!root.join("host.json.writing").try_exists().unwrap());
    assert_eq!(
        fs::read(&failure.recovery_evidence).unwrap(),
        b"interrupted state\n"
    );

    replace_state_file_atomically(&target, b"next\n").unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"next\n");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_second_recovery_keeps_both_pieces_of_evidence_and_the_old_or_new_guarantee() {
    let root = scratch();
    let target = root.join("chapter.md");
    fs::write(&target, "canonical\n").unwrap();
    fs::write(
        root.join("chapter.md.writing"),
        "first interrupted candidate\n",
    )
    .unwrap();

    let stopped = replace_file_atomically(
        &target,
        b"second interrupted candidate\n",
        stop_at(Checkpoint::Written),
    );
    assert!(stopped.is_err());

    assert!(owns_interrupted_write(&target));
    assert_eq!(fs::read(&target).unwrap(), b"canonical\n");
    assert_eq!(
        fs::read(root.join("chapter.md.writing")).unwrap(),
        b"second interrupted candidate\n"
    );
    let first_evidence = evidence_paths(&root, &target);
    assert_eq!(first_evidence.len(), 1);
    assert_eq!(
        fs::read(&first_evidence[0]).unwrap(),
        b"first interrupted candidate\n"
    );

    let outcome = replace_file_atomically(&target, b"final\n", |_| Ok(())).unwrap();
    let all_evidence = evidence_paths(&root, &target);
    assert_eq!(all_evidence.len(), 2);
    let contents: std::collections::BTreeSet<Vec<u8>> = all_evidence
        .iter()
        .map(fs::read)
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        contents,
        [
            b"first interrupted candidate\n".to_vec(),
            b"second interrupted candidate\n".to_vec()
        ]
        .into_iter()
        .collect()
    );
    let new_evidence = all_evidence
        .iter()
        .find(|path| !first_evidence.contains(path))
        .cloned();
    assert_eq!(outcome.recovery_evidence, new_evidence);
    assert_eq!(fs::read(&target).unwrap(), b"final\n");
    assert!(!root.join("chapter.md.writing").try_exists().unwrap());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn stopping_after_each_checkpoint_leaves_one_complete_canonical_version() {
    for checkpoint in [
        Checkpoint::Written,
        Checkpoint::FileSynced,
        Checkpoint::Renamed,
    ] {
        let root = scratch();
        let target = root.join("chapter.md");
        let temporary = root.join("chapter.md.writing");
        fs::write(&target, "完整旧版。\n").unwrap();

        let stopped =
            replace_file_atomically(&target, "完整新版。\n".as_bytes(), stop_at(checkpoint));
        assert!(stopped.is_err());

        let expected: &[u8] = if checkpoint == Checkpoint::Renamed {
            "完整新版。\n".as_bytes()
        } else {
            "完整旧版。\n".as_bytes()
        };
        assert_eq!(fs::read(&target).unwrap(), expected);
        assert_eq!(
            temporary.try_exists().unwrap(),
            checkpoint != Checkpoint::Renamed
        );
        if temporary.try_exists().unwrap() {
            assert_eq!(fs::read(&temporary).unwrap(), "完整新版。\n".as_bytes());
        }
        fs::remove_dir_all(root).unwrap();
    }
}

/// The same old-or-new guarantee must hold when the process dies for real,
/// not just when an observer returns an error. This child entry point aborts
/// mid-write; the parent asserts on what the filesystem kept.
#[test]
fn atomic_write_child_aborts_at_checkpoint() {
    let (target, checkpoint) = match (
        std::env::var("REFRAIN_TEST_CHILD_TARGET"),
        std::env::var("REFRAIN_TEST_CHILD_CHECKPOINT"),
    ) {
        (Ok(target), Ok(checkpoint)) => (target, checkpoint),
        _ => return,
    };
    let stop_at_checkpoint = match checkpoint.as_str() {
        "written" => Checkpoint::Written,
        "file-synced" => Checkpoint::FileSynced,
        "renamed" => Checkpoint::Renamed,
        other => panic!("unknown checkpoint {other}"),
    };
    let _ = replace_file_atomically(
        Path::new(&target),
        "完整新版。\n".as_bytes(),
        |reached| {
            if reached == stop_at_checkpoint {
                std::process::abort();
            }
            Ok(())
        },
    );
}

#[test]
fn process_death_at_each_checkpoint_leaves_the_same_old_or_new_guarantee() {
    for checkpoint in ["written", "file-synced", "renamed"] {
        let root = scratch();
        let target = root.join(format!("{checkpoint}.md"));
        let temporary = root.join(format!("{checkpoint}.md.writing"));
        fs::write(&target, "完整旧版。\n").unwrap();

        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "atomic_write_child_aborts_at_checkpoint",
                "--exact",
                "--nocapture",
            ])
            .env("REFRAIN_TEST_CHILD_TARGET", &target)
            .env("REFRAIN_TEST_CHILD_CHECKPOINT", checkpoint)
            .status()
            .unwrap();
        assert!(!status.success());

        let expected: &[u8] = if checkpoint == "renamed" {
            "完整新版。\n".as_bytes()
        } else {
            "完整旧版。\n".as_bytes()
        };
        assert_eq!(fs::read(&target).unwrap(), expected);
        assert_eq!(temporary.try_exists().unwrap(), checkpoint != "renamed");
        fs::remove_dir_all(root).unwrap();
    }
}
