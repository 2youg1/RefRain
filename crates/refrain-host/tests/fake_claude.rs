//! Claude 适配器的真进程冒烟：假 `claude`（examples/fake_claude.rs）走完整条
//! 版本探测 → dispatch → observe 链。frame 形状若与真 CLI 漂移，这里红。

use std::path::{Path, PathBuf};

use refrain_core::Id;
use refrain_host::adapters::{DispatchSpec, HarnessAdapter, PrintAdapter, ProducerUsage, channel};

/// 与 process.rs / edge_end_to_end.rs 同一套按需构建：`cargo test` 只把
/// example 包成 libtest，可执行文件要 `cargo build --example` 才有。
fn fake_claude_path() -> &'static Path {
    static BUILT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace = manifest.parent().and_then(Path::parent).unwrap();
        let built = workspace
            .join("target/debug/examples")
            .join(format!("fake_claude{}", std::env::consts::EXE_SUFFIX));
        if !built.exists() {
            let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
            let status = std::process::Command::new(cargo)
                .args([
                    "build",
                    "-p",
                    "refrain-host",
                    "--example",
                    "fake_claude",
                    "--offline",
                ])
                .status()
                .expect("build fake_claude");
            assert!(status.success());
        }
        built
    })
}

#[test]
fn claude_print_dispatches_and_reads_claude_frames() {
    // 版本身份校验要求文件名与 identity 匹配：假二进制必须改名上场。
    let dir = std::env::temp_dir().join(format!("refrain-fake-claude-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let program = dir.join(format!("claude{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(fake_claude_path(), &program).unwrap();

    let channel = channel("claude-print").expect("registered");
    let adapter = PrintAdapter::at(channel, program).expect("version probe accepts the fake");

    let workspace = dir.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let receipt = adapter
        .dispatch(&DispatchSpec {
            run_id: Id::new(),
            workspace,
            request_md: "# Before\n<!-- scope ch01:b3 -->\n原文。\n".to_string(),
            connection_argv: vec![],
            agent_argv: vec![],
        })
        .expect("dispatch launches");
    let outcome = adapter.observe(receipt).expect("observe reads the stream");

    assert_eq!(outcome.exit_code, Some(0));
    assert!(
        outcome
            .reply_text
            .contains("<replacement scope=\"ch01:b3\">"),
        "产出要带上请求里的 scope：{}",
        outcome.reply_text
    );
    assert_eq!(
        outcome.usage,
        ProducerUsage::Reported {
            input_other: 100,
            cache_read: 0,
            cache_creation: 0,
            output: 10,
        },
        "modelUsage 列和是 usage 的唯一权威"
    );
}
