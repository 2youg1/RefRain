//! 跨界请求的形状由 Rust 说了算。
//!
//! **接上哪个功能**：Zig 侧 `project_request.zig` 写出的每一条 `ProjectInput`。
//!
//! **在全局逻辑中负责什么**：证明手写的编码器与 serde 实际接受的形状逐字节
//! 相同。两边各写一份 JSON 是这次接线唯一的耦合面，而 serde 的口径并不统一：
//! `ProjectInput` 的字段是 camelCase，`HostCommand` 的字段却保持 Rust 拼写
//! （`run_id`），`Disclosure` 是 kebab-case。按同一种规律猜三处，其中两处会
//! 得到一条被 Rust 具名拒绝的请求——而界面上看到的只是「没反应」。
//!
//! **能复用什么**：新增一个入口就在这里加一行期望字符串。它同时是这些形状
//! 的可读清单，读它比读三处 `#[serde(...)]` 属性快。
//!
//! 注入验红：把任何一条期望改成看起来更「规律」的拼写（`runId`、
//! `outlineOnly`），这道门禁当场指名失败。

use refrain_app::{ProjectInput, RootKind, SearchPrecision};
use refrain_core::material_listing::Disclosure;
use refrain_core::{DocumentRole, Id};
use refrain_host::host::HostCommand;

/// 一条期望：`ProjectInput` 序列化之后必须逐字节等于它。
struct Expected {
    what: &'static str,
    input: ProjectInput,
    json: &'static str,
}

fn main() {
    // Run id 在 `hostCommand` 里是随机的，所以那一条单独比对字段名。
    let run_id = Id::new();
    let cases = vec![
        Expected {
            what: "chooseAndAdoptRoot",
            input: ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            },
            json: r#"{"kind":"chooseAndAdoptRoot","value":{"kind":"folder"}}"#,
        },
        Expected {
            what: "documentPage (first page)",
            input: ProjectInput::DocumentPage {
                root_id: "r1".into(),
                after: None,
            },
            json: r#"{"kind":"documentPage","value":{"rootId":"r1","after":null}}"#,
        },
        Expected {
            what: "openDocument",
            input: ProjectInput::OpenDocument {
                root_id: "r1".into(),
                path: "章.md".into(),
            },
            json: r#"{"kind":"openDocument","value":{"rootId":"r1","path":"章.md"}}"#,
        },
        Expected {
            what: "createDocument",
            input: ProjectInput::CreateDocument {
                root_id: "r1".into(),
                title: "章".into(),
                role: DocumentRole::Chapter,
            },
            json: r#"{"kind":"createDocument","value":{"rootId":"r1","title":"章","role":"chapter"}}"#,
        },
        Expected {
            what: "deleteDocument",
            input: ProjectInput::DeleteDocument {
                root_id: "r1".into(),
                path: "章.md".into(),
            },
            json: r#"{"kind":"deleteDocument","value":{"rootId":"r1","path":"章.md"}}"#,
        },
        Expected {
            what: "blockSearch",
            input: ProjectInput::BlockSearch {
                root_id: "r1".into(),
                query: "克制".into(),
                precision: SearchPrecision::Exact,
            },
            json: r#"{"kind":"blockSearch","value":{"rootId":"r1","query":"克制","precision":"exact"}}"#,
        },
        Expected {
            what: "documentSearch",
            input: ProjectInput::DocumentSearch {
                root_id: "r1".into(),
                query: "克制".into(),
                precision: SearchPrecision::Loose,
            },
            json: r#"{"kind":"documentSearch","value":{"rootId":"r1","query":"克制","precision":"loose"}}"#,
        },
        Expected {
            what: "setDisclosure (kebab-case, unlike its siblings)",
            input: ProjectInput::SetDisclosure {
                root_id: "r1".into(),
                path: "a.md".into(),
                disclosure: Disclosure::OutlineOnly,
            },
            json: r#"{"kind":"setDisclosure","value":{"rootId":"r1","path":"a.md","disclosure":"outline-only"}}"#,
        },
        Expected {
            what: "readConfig (no value at all)",
            input: ProjectInput::ReadConfig,
            json: r#"{"kind":"readConfig"}"#,
        },
        Expected {
            what: "readHost",
            input: ProjectInput::ReadHost {
                root_id: "r1".into(),
            },
            json: r#"{"kind":"readHost","value":{"rootId":"r1"}}"#,
        },
        Expected {
            what: "chooseAndImportManuscript",
            input: ProjectInput::ChooseAndImportManuscript {
                root_id: "r1".into(),
            },
            json: r#"{"kind":"chooseAndImportManuscript","value":{"rootId":"r1"}}"#,
        },
        Expected {
            what: "chooseAndImportMaterial",
            input: ProjectInput::ChooseAndImportMaterial {
                root_id: "r1".into(),
            },
            json: r#"{"kind":"chooseAndImportMaterial","value":{"rootId":"r1"}}"#,
        },
        Expected {
            what: "readProposals",
            input: ProjectInput::ReadProposals {
                root_id: "r1".into(),
                path: "章.md".into(),
            },
            json: r#"{"kind":"readProposals","value":{"rootId":"r1","path":"章.md"}}"#,
        },
        Expected {
            what: "stageVerdict (accept)",
            input: ProjectInput::StageVerdict {
                root_id: "r1".into(),
                path: "章.md".into(),
                proposal_id: "p1".into(),
                kind: refrain_store::ledger::VerdictKindName::Accept,
                final_text: None,
                reason: None,
            },
            json: r#"{"kind":"stageVerdict","value":{"rootId":"r1","path":"章.md","proposalId":"p1","kind":"accept","finalText":null,"reason":null}}"#,
        },
        Expected {
            what: "stageVerdict (accept-modified carries its final text)",
            input: ProjectInput::StageVerdict {
                root_id: "r1".into(),
                path: "章.md".into(),
                proposal_id: "p1".into(),
                kind: refrain_store::ledger::VerdictKindName::AcceptModified,
                final_text: Some("改后的一段。".into()),
                reason: Some("语气".into()),
            },
            json: r#"{"kind":"stageVerdict","value":{"rootId":"r1","path":"章.md","proposalId":"p1","kind":"accept-modified","finalText":"改后的一段。","reason":"语气"}}"#,
        },
        Expected {
            what: "commitVerdicts",
            input: ProjectInput::CommitVerdicts {
                root_id: "r1".into(),
                path: "章.md".into(),
            },
            json: r#"{"kind":"commitVerdicts","value":{"rootId":"r1","path":"章.md"}}"#,
        },
        Expected {
            what: "collectRun",
            input: ProjectInput::CollectRun {
                root_id: "r1".into(),
                run_id: "run-7".into(),
            },
            json: r#"{"kind":"collectRun","value":{"rootId":"r1","runId":"run-7"}}"#,
        },
        Expected {
            what: "karaStep (internally tagged event)",
            input: ProjectInput::KaraStep(refrain_core::kara::KaraEvent::ManualToggle),
            json: r#"{"kind":"karaStep","value":{"kind":"manualToggle"}}"#,
        },
    ];

    let mut failed = 0usize;
    for case in &cases {
        let actual = serde_json::to_string(&case.input).expect("a ProjectInput serialises");
        if actual != case.json {
            failed += 1;
            eprintln!("FAIL  verify:wire-shapes: {} does not match", case.what);
            eprintln!("      Zig writes  {}", case.json);
            eprintln!("      serde wants {actual}");
        }
    }

    // `hostCommand` 的字段保持 Rust 拼写：变体名被 rename 了，字段没有。
    // 这一条是本门禁存在的主要理由——它与相邻的 `rootId` 并排出现，
    // 所以「统一成 camelCase」是一个非常自然、而且必然错的改动。
    let host = ProjectInput::HostCommand {
        root_id: "r1".into(),
        command: Box::new(HostCommand::CancelRun { run_id, at: 7 }),
    };
    let actual = serde_json::to_string(&host).expect("a HostCommand serialises");
    let expected = format!(
        r#"{{"kind":"hostCommand","value":{{"rootId":"r1","command":{{"cancelRun":{{"run_id":"{run_id}","at":7}}}}}}}}"#
    );
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: hostCommand does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // `dispatch` 的形状：`ProjectInput` 是 camelCase，而 `DispatchRequest`
    // 自己也标了 camelCase——两层各标一次，猜「内层跟外层」或「内层是 Rust
    // 拼写」都会得到一个被静默拒绝的请求。
    let dispatch = ProjectInput::Dispatch {
        root_id: "r1".into(),
        request: Box::new(refrain_app::dispatch::DispatchRequest {
            document: "章一.md".into(),
            prompt: "改克制些。".into(),
            scopes: vec![refrain_app::dispatch::DispatchScope {
                label: "s1".into(),
                before: "剑一直握在他手里。".into(),
            }],
            agents: 2,
            orchestration: refrain_app::dispatch::Orchestration::Alternates,
            persona: None,
            channel: refrain_app::dispatch::DispatchChannel::Harness,
            result_path: "result.md".into(),
            max_bytes: 65536,
        }),
    };
    let actual = serde_json::to_string(&dispatch).expect("a Dispatch serialises");
    let expected = concat!(
        r#"{"kind":"dispatch","value":{"rootId":"r1","request":{"document":"章一.md","#,
        r#""prompt":"改克制些。","scopes":[{"label":"s1","before":"剑一直握在他手里。"}],"#,
        r#""agents":2,"orchestration":"alternates","persona":null,"channel":"harness","resultPath":"result.md","maxBytes":65536}}}"#,
    );
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: dispatch does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // 历史与批注都按文档取，形状与 `readProposals` 同族。并排验一次是
    // 因为「同族」是我的判断，而这道门禁只认实测。
    for (input, expected) in [
        (
            ProjectInput::ReadHistory {
                root_id: "r1".into(),
                path: "章一.md".into(),
            },
            r#"{"kind":"readHistory","value":{"rootId":"r1","path":"章一.md"}}"#,
        ),
        (
            ProjectInput::ReadAnnotations {
                root_id: "r1".into(),
                path: "章一.md".into(),
            },
            r#"{"kind":"readAnnotations","value":{"rootId":"r1","path":"章一.md"}}"#,
        ),
    ] {
        let actual = serde_json::to_string(&input).expect("a document read serialises");
        if actual != expected {
            failed += 1;
            eprintln!("FAIL  verify:wire-shapes: document read does not match");
            eprintln!("      Zig writes  {expected}");
            eprintln!("      serde wants {actual}");
        }
    }

    // KARA 的事件名：无字段变体只写 `kind`，而它的 camelCase 形态是
    // `manualToggle`——写成 `manual-toggle` 或 `ManualToggle` 都会被
    // 具名拒绝，而界面上表现为「按钮没反应」。
    let kara = ProjectInput::KaraStep(refrain_core::kara::KaraEvent::ManualToggle);
    let actual = serde_json::to_string(&kara).expect("a KaraStep serialises");
    let expected = r#"{"kind":"karaStep","value":{"kind":"manualToggle"}}"#;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: karaStep does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // 批注：`body` 是 `Option<String>`，高亮时必须是 `null` 而不是省略。
    // 省略那个键，serde 会拒绝整条请求，而界面上表现为「标不上」。
    let annotate = ProjectInput::Annotate {
        root_id: "r1".into(),
        path: "章一.md".into(),
        selected: "剑一直握在他手里。".into(),
        body: None,
    };
    let actual = serde_json::to_string(&annotate).expect("an Annotate serialises");
    let expected = concat!(
        r#"{"kind":"annotate","value":{"rootId":"r1","path":"章一.md","#,
        r#""selected":"剑一直握在他手里。","body":null}}"#,
    );
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: annotate does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // 排版微调：`ConfigChange` 的变体名是 camelCase，而它内部的字段
    // （`field`／`delta`）与 `TypographyField` 的变体名各有各的口径。
    // 三层嵌套，猜错任何一层都是一次静默拒绝。
    let adjust =
        ProjectInput::ChangeConfig(refrain_store::config::ConfigChange::AdjustTypography {
            field: refrain_store::config::TypographyField::TextSize,
            delta: 10,
        });
    let actual = serde_json::to_string(&adjust).expect("an AdjustTypography serialises");
    let expected =
        r#"{"kind":"changeConfig","value":{"adjustTypography":{"field":"textSize","delta":10}}}"#;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: adjustTypography does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // `readHarnesses` 没有字段：它问的是这台机器，不是某个项目。无字段的
    // 变体在 serde 里是一个裸字符串还是 `{"kind":...}`，猜错就静默失败。
    let harnesses = ProjectInput::ReadHarnesses;
    let actual = serde_json::to_string(&harnesses).expect("ReadHarnesses serialises");
    let expected = r#"{"kind":"readHarnesses"}"#;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: readHarnesses does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    if failed > 0 {
        eprintln!("      update apps/native/src/project_request.zig to match serde");
        std::process::exit(1);
    }
    println!(
        "PASS  verify:wire-shapes  ({} project inputs match serde byte for byte)",
        cases.len() + 1
    );
}
