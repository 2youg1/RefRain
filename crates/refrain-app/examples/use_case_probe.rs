// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Probe: wall-clock cost of each project use case on this machine.
//! The v0.3.0 budget is ≤1 ms per case. Run in release.
//! Run: cargo run --release -p refrain-app --example use_case_probe

use refrain_app::{
    Application, ProjectImport, ProjectInput, ProjectOutput, ProjectPlatform, SearchPrecision,
};
use refrain_core::RefrainError;
use refrain_store::root::RootKind;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

static SEQUENCE: AtomicU32 = AtomicU32::new(0);

fn scratch(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "refrain-usecase-probe-{label}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed),
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

struct Chosen(PathBuf);

impl ProjectPlatform for Chosen {
    fn choose_root(&self, _kind: RootKind) -> Result<Option<PathBuf>, RefrainError> {
        Ok(Some(self.0.clone()))
    }
    fn choose_project_parent(&self) -> Result<Option<PathBuf>, RefrainError> {
        self.choose_root(RootKind::Folder)
    }
    fn choose_import(&self, _kind: ProjectImport) -> Result<Option<PathBuf>, RefrainError> {
        self.choose_root(RootKind::Folder)
    }
}

fn main() {
    let data = scratch("data");
    let root = scratch("root");
    // A manuscript with enough blocks to make scanning matter, and enough
    // documents to make the mailbox and search cases real.
    let mut body = String::new();
    for i in 0..5_000 {
        body.push_str(&format!("第{i}章。陆沉舟站在窗前，想起营销那件事。\n\n"));
    }
    for d in 0..20 {
        fs::write(root.join(format!("章节{d}.md")), &body).unwrap();
    }
    let application = Application::open(&data).unwrap();
    let platform = Chosen(root.clone());
    let ProjectOutput::Opened(opened) = application
        .project(
            &platform,
            ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
        )
        .unwrap()
    else {
        panic!("adopt failed");
    };
    let root_id = opened.root_id;
    let path = "章节0.md".to_string();

    let cases: Vec<(&str, ProjectInput)> = vec![
        ("ReadConfig", ProjectInput::ReadConfig),
        (
            "DocumentSearch",
            ProjectInput::DocumentSearch {
                root_id: root_id.clone(),
                query: "陆沉舟".to_string(),
                precision: SearchPrecision::Exact,
            },
        ),
        (
            "BlockSearch",
            ProjectInput::BlockSearch {
                root_id: root_id.clone(),
                query: "营销".to_string(),
                precision: SearchPrecision::Exact,
            },
        ),
        (
            "ReadMailbox",
            ProjectInput::ReadMailbox {
                root_id: root_id.clone(),
                discarded: false,
            },
        ),
        (
            "ReadHost",
            ProjectInput::ReadHost {
                root_id: root_id.clone(),
            },
        ),
        (
            "ReadHarnesses",
            ProjectInput::ReadHarnesses { force: false },
        ),
        (
            "ReadHistory",
            ProjectInput::ReadHistory {
                root_id: root_id.clone(),
                path: path.clone(),
            },
        ),
        (
            "ReadAnnotations",
            ProjectInput::ReadAnnotations {
                root_id: root_id.clone(),
                path: path.clone(),
            },
        ),
        (
            "ReadProposals",
            ProjectInput::ReadProposals {
                root_id: root_id.clone(),
                path: path.clone(),
            },
        ),
        (
            "DocumentPage",
            ProjectInput::DocumentPage {
                root_id: root_id.clone(),
                after: None,
            },
        ),
    ];

    // 单点验证：同一 store 实例的第二次搜索是否复用索引。
    let t0 = Instant::now();
    application
        .project(
            &platform,
            ProjectInput::BlockSearch {
                root_id: root_id.clone(),
                query: "陆沉舟".to_string(),
                precision: SearchPrecision::Exact,
            },
        )
        .expect("search must succeed");
    let t1 = Instant::now();
    application
        .project(
            &platform,
            ProjectInput::BlockSearch {
                root_id: root_id.clone(),
                query: "陆沉舟".to_string(),
                precision: SearchPrecision::Exact,
            },
        )
        .expect("search must succeed");
    let t2 = Instant::now();
    println!(
        "BlockSearch first {:.3} ms | second {:.3} ms (same store)",
        (t1 - t0).as_secs_f64() * 1000.0,
        (t2 - t1).as_secs_f64() * 1000.0
    );

    let mut worst = 0.0f64;
    let mut worst_name = "";
    for (name, input) in &cases {
        let mut samples = Vec::new();
        for _ in 0..5 {
            let started = Instant::now();
            application
                .project(&platform, input.clone())
                .expect("case must succeed");
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p95 = samples[(samples.len() as f64 * 0.95).ceil() as usize - 1];
        if p95 > worst {
            worst = p95;
            worst_name = name;
        }
        if name.contains("Search") || name.contains("Harness") {
            println!("{name:<20} raw {samples:?}");
        }
        println!("{name:<20} p95 {p95:8.3} ms");
    }
    println!("WORST {worst_name} {worst:.3} ms (budget 1 ms)");
}
