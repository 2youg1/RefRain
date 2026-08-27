// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
use refrain_core::persona::Persona;
use refrain_core::{DocumentRole, Id};
use refrain_host::host::HostCommand;
use refrain_store::config::{AgentProfile, ConfigChange};

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
            what: "readBlocks (first page)",
            input: ProjectInput::ReadBlocks {
                root_id: "r1".into(),
                path: "章.md".into(),
                after: None,
                count: 100,
            },
            json: r#"{"kind":"readBlocks","value":{"rootId":"r1","path":"章.md","after":null,"count":100}}"#,
        },
        Expected {
            what: "readBlocks (paged)",
            input: ProjectInput::ReadBlocks {
                root_id: "r1".into(),
                path: "章.md".into(),
                after: Some(41),
                count: 25,
            },
            json: r#"{"kind":"readBlocks","value":{"rootId":"r1","path":"章.md","after":41,"count":25}}"#,
        },
        Expected {
            what: "readMaterials",
            input: ProjectInput::ReadMaterials {
                root_id: "r1".into(),
            },
            json: r#"{"kind":"readMaterials","value":{"rootId":"r1"}}"#,
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
            what: "judgeVerdict (stage + commit in one shot)",
            input: ProjectInput::JudgeVerdict {
                root_id: "r1".into(),
                path: "章.md".into(),
                proposal_id: "p1".into(),
                kind: refrain_store::ledger::VerdictKindName::Accept,
                final_text: None,
                reason: None,
            },
            json: r#"{"kind":"judgeVerdict","value":{"rootId":"r1","path":"章.md","proposalId":"p1","kind":"accept","finalText":null,"reason":null}}"#,
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
            // run id 是 `Id`（serde transparent），写出来是裸 uuid 字符串；
            // Zig 的同名入口在 project_request.zig。
            what: "launchRun",
            input: ProjectInput::LaunchRun {
                root_id: "r1".into(),
                run_id: "00000000-0000-0000-0000-000000000007"
                    .parse()
                    .expect("a fixed uuid parses"),
            },
            json: r#"{"kind":"launchRun","value":{"rootId":"r1","runId":"00000000-0000-0000-0000-000000000007"}}"#,
        },
        Expected {
            what: "karaStep (internally tagged event)",
            input: ProjectInput::KaraStep(refrain_core::kara::KaraEvent::ManualToggle),
            json: r#"{"kind":"karaStep","value":{"kind":"manualToggle"}}"#,
        },
    ];

    let mut failed = 0usize;
    let mut checked = cases.len();
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
    checked += 1;
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
                blocks: None,
            }],
            agents: 2,
            orchestration: refrain_app::dispatch::Orchestration::Alternates,
            persona: None,
            channel: refrain_app::dispatch::DispatchChannel::Harness,
            result_path: "result.md".into(),
            max_bytes: 65536,
            // 新字段空着（carry 是默认的 None）时不落进 JSON：Zig 按旧形状
            // 写的请求因此逐字节成立，serde 读它靠 `default`，写它靠
            // `skip_serializing_if`。
            carry: refrain_app::dispatch::CarryMode::None,
            materials: Vec::new(),
            agent: None,
            expected_digest: None,
        }),
    };
    let actual = serde_json::to_string(&dispatch).expect("a Dispatch serialises");
    let expected = concat!(
        r#"{"kind":"dispatch","value":{"rootId":"r1","request":{"document":"章一.md","#,
        r#""prompt":"改克制些。","scopes":[{"label":"s1","before":"剑一直握在他手里。"}],"#,
        r#""agents":2,"orchestration":"alternates","persona":null,"channel":"harness","resultPath":"result.md","maxBytes":65536}}}"#,
    );
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: dispatch does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // 预览与送前核对：`previewDispatch` 不带 digest；送出时 `expectedDigest`
    // 在场（serde 的 skip 规则：None 省略，Some 写出来——两个方向都验）。
    let preview_request = refrain_app::dispatch::DispatchRequest {
        document: "章一.md".into(),
        prompt: "改克制些。".into(),
        scopes: vec![refrain_app::dispatch::DispatchScope {
            label: "s1".into(),
            before: "剑一直握在他手里。".into(),
            blocks: None,
        }],
        agents: 1,
        orchestration: refrain_app::dispatch::Orchestration::Alternates,
        persona: None,
        channel: refrain_app::dispatch::DispatchChannel::Harness,
        result_path: "result.md".into(),
        max_bytes: 65536,
        carry: refrain_app::dispatch::CarryMode::None,
        materials: Vec::new(),
        agent: None,
        expected_digest: None,
    };
    let preview = ProjectInput::PreviewDispatch {
        root_id: "r1".into(),
        request: Box::new(preview_request.clone()),
    };
    let actual = serde_json::to_string(&preview).expect("a PreviewDispatch serialises");
    let expected = concat!(
        r#"{"kind":"previewDispatch","value":{"rootId":"r1","request":{"document":"章一.md","#,
        r#""prompt":"改克制些。","scopes":[{"label":"s1","before":"剑一直握在他手里。"}],"#,
        r#""agents":1,"orchestration":"alternates","persona":null,"channel":"harness","resultPath":"result.md","maxBytes":65536}}}"#,
    );
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: previewDispatch does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    let mut checked_request = preview_request;
    checked_request.expected_digest = Some("abcdef012345".into());
    let with_digest = ProjectInput::Dispatch {
        root_id: "r1".into(),
        request: Box::new(checked_request),
    };
    let actual = serde_json::to_string(&with_digest).expect("a digest-checked Dispatch serialises");
    let expected = concat!(
        r#"{"kind":"dispatch","value":{"rootId":"r1","request":{"document":"章一.md","#,
        r#""prompt":"改克制些。","scopes":[{"label":"s1","before":"剑一直握在他手里。"}],"#,
        r#""agents":1,"orchestration":"alternates","persona":null,"channel":"harness","resultPath":"result.md","maxBytes":65536,"expectedDigest":"abcdef012345"}}}"#,
    );
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: digest-checked dispatch does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // 块段与带稿模式：`blocks` 在场时 `before` 送空串（以块为准），
    // `carry` 是 kebab-case 词。两个都是后加字段：None/默认态不落进 JSON
    // （上面三条照旧逐字节成立），在场时按这里的形状写。
    let by_blocks = ProjectInput::Dispatch {
        root_id: "r1".into(),
        request: Box::new(refrain_app::dispatch::DispatchRequest {
            document: "章一.md".into(),
            prompt: "改克制些。".into(),
            scopes: vec![refrain_app::dispatch::DispatchScope {
                label: "s1".into(),
                before: String::new(),
                blocks: Some(refrain_app::dispatch::ScopeSpan { from: 2, count: 3 }),
            }],
            agents: 1,
            orchestration: refrain_app::dispatch::Orchestration::Alternates,
            persona: None,
            channel: refrain_app::dispatch::DispatchChannel::Harness,
            result_path: "result.md".into(),
            max_bytes: 65536,
            carry: refrain_app::dispatch::CarryMode::Diff,
            materials: Vec::new(),
            agent: None,
            expected_digest: None,
        }),
    };
    let actual = serde_json::to_string(&by_blocks).expect("a block-span Dispatch serialises");
    let expected = concat!(
        r#"{"kind":"dispatch","value":{"rootId":"r1","request":{"document":"章一.md","#,
        r#""prompt":"改克制些。","scopes":[{"label":"s1","before":"","blocks":{"from":2,"count":3}}],"#,
        r#""agents":1,"orchestration":"alternates","persona":null,"channel":"harness","resultPath":"result.md","maxBytes":65536,"carry":"diff"}}}"#,
    );
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: block-span dispatch with carry does not match");
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
        checked += 1;
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
    checked += 1;
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
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: annotate does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // 全半角转换：`wholeDocument` 是 camelCase 字段，`direction` 是
    // kebab-case 词——猜成 `whole_document` 会得到一条被具名拒绝的请求。
    let convert = ProjectInput::ConvertWidth {
        root_id: "r1".into(),
        path: "章一.md".into(),
        selected: "abc".into(),
        whole_document: false,
        direction: "to-full".into(),
    };
    let actual = serde_json::to_string(&convert).expect("a ConvertWidth serialises");
    let expected = concat!(
        r#"{"kind":"convertWidth","value":{"rootId":"r1","path":"章一.md","#,
        r#""selected":"abc","wholeDocument":false,"direction":"to-full"}}"#,
    );
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: convertWidth does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // 伙伴编辑：UpsertAgent 是整份替换，persona 两层嵌套、argv 数组、
    // connectionId 恒 null（界面暂不把 Agent 绑到连接）。猜错任一层都会
    // 得到一条被具名拒绝的请求。
    let upsert = ProjectInput::ChangeConfig(ConfigChange::UpsertAgent(AgentProfile {
        id: "00000000-0000-0000-0000-00000000000a"
            .parse()
            .expect("a fixed uuid parses"),
        name: "编辑".into(),
        connection_id: None,
        persona: Some(Persona::Work {
            body: "改稿".into(),
        }),
        argv: vec!["--model".into(), "max".into()],
    }));
    let actual = serde_json::to_string(&upsert).expect("an UpsertAgent serialises");
    let expected = concat!(
        r#"{"kind":"changeConfig","value":{"upsertAgent":{"id":"00000000-0000-0000-0000-00000000000a","name":"编辑","#,
        r#""connection_id":null,"persona":{"work":{"body":"改稿"}},"argv":["--model","max"]}}}"#,
    );
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: upsertAgent does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // 信箱与冲销：四个安排动作返回刷新后的信箱，冲销返回裁决结局。
    // 格名是 kebab-case（`MailboxBoxName` 自己的口径），与相邻 camelCase
    // 的 `boxName` 键并排——猜「值也跟着 camel」会得到一条被具名拒绝的请求。
    for (input, expected) in [
        (
            ProjectInput::ReadMailbox {
                root_id: "r1".into(),
                discarded: false,
            },
            r#"{"kind":"readMailbox","value":{"rootId":"r1","discarded":false}}"#,
        ),
        (
            ProjectInput::MailboxPin {
                root_id: "r1".into(),
                entry_id: "p1".into(),
                box_name: refrain_store::mailbox::MailboxBoxName::Unread,
                pinned: true,
            },
            r#"{"kind":"mailboxPin","value":{"rootId":"r1","entryId":"p1","boxName":"unread","pinned":true}}"#,
        ),
        (
            ProjectInput::MailboxRank {
                root_id: "r1".into(),
                entry_id: "p1".into(),
                box_name: refrain_store::mailbox::MailboxBoxName::Unread,
                rank: 3,
            },
            r#"{"kind":"mailboxRank","value":{"rootId":"r1","entryId":"p1","boxName":"unread","rank":3}}"#,
        ),
        (
            ProjectInput::MailboxDiscard {
                root_id: "r1".into(),
                entry_id: "p1".into(),
                box_name: refrain_store::mailbox::MailboxBoxName::Unread,
            },
            r#"{"kind":"mailboxDiscard","value":{"rootId":"r1","entryId":"p1","boxName":"unread"}}"#,
        ),
        (
            ProjectInput::MailboxRestore {
                root_id: "r1".into(),
                entry_id: "p1".into(),
            },
            r#"{"kind":"mailboxRestore","value":{"rootId":"r1","entryId":"p1"}}"#,
        ),
        (
            ProjectInput::Countermand {
                root_id: "r1".into(),
                path: "章.md".into(),
                proposal_ids: vec!["p1".into(), "p2".into()],
            },
            r#"{"kind":"countermand","value":{"rootId":"r1","path":"章.md","proposalIds":["p1","p2"]}}"#,
        ),
    ] {
        let actual = serde_json::to_string(&input).expect("a mailbox input serialises");
        checked += 1;
        if actual != expected {
            failed += 1;
            eprintln!("FAIL  verify:wire-shapes: mailbox input does not match");
            eprintln!("      Zig writes  {expected}");
            eprintln!("      serde wants {actual}");
        }
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
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: adjustTypography does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // 角色二态：载荷是一个 Id，serde transparent 序列化成裸字符串。
    let toggle =
        ProjectInput::ChangeConfig(refrain_store::config::ConfigChange::ToggleAgentPersona(
            "00000000-0000-0000-0000-000000000001"
                .parse()
                .expect("a fixed uuid parses"),
        ));
    let actual = serde_json::to_string(&toggle).expect("a ToggleAgentPersona serialises");
    let expected = r#"{"kind":"changeConfig","value":{"toggleAgentPersona":"00000000-0000-0000-0000-000000000001"}}"#;
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: toggleAgentPersona does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // `readHarnesses` 问的是这台机器不是某个项目，但它带 `force`——serde 的
    // tag/content 结构要求带字段的变体有 `value` 包装，裸 `kind` 会被拒绝。
    // force=false 也写进 value：省略键与显式 false 在 serde 里不是一回事。
    let harnesses = ProjectInput::ReadHarnesses { force: false };
    let actual = serde_json::to_string(&harnesses).expect("ReadHarnesses serialises");
    let expected = r#"{"kind":"readHarnesses","value":{"force":false}}"#;
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: readHarnesses does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // 材料草稿：名录读与成稿/退回。`edited_body` 是 `Option`——None 的写法
    // 由 serde 定（null 还是省略），Zig 的写入端照这里对齐，不猜。
    let read_drafts = ProjectInput::ReadMaterialDrafts {
        root_id: "r1".into(),
    };
    let actual = serde_json::to_string(&read_drafts).expect("ReadMaterialDrafts serialises");
    let expected = r#"{"kind":"readMaterialDrafts","value":{"rootId":"r1"}}"#;
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: readMaterialDrafts does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    let commit_draft = ProjectInput::CommitMaterialDraft {
        root_id: "r1".into(),
        draft_id: "d1".into(),
        edited_body: None,
        dismiss: false,
        as_chapter: true,
    };
    let actual = serde_json::to_string(&commit_draft).expect("CommitMaterialDraft serialises");
    let expected = r#"{"kind":"commitMaterialDraft","value":{"rootId":"r1","draftId":"d1","editedBody":null,"dismiss":false,"asChapter":true}}"#;
    checked += 1;
    if actual != expected {
        failed += 1;
        eprintln!("FAIL  verify:wire-shapes: commitMaterialDraft does not match");
        eprintln!("      Zig writes  {expected}");
        eprintln!("      serde wants {actual}");
    }

    // ---- the reply direction is no longer serde's ------------------------
    //
    // Unit 11 replaced the opaque JSON reply with typed rows: Rust fills the
    // shapes generated from `protocol/host.json` and the surface reads the same
    // shapes, so a reply field name is not a string on either side any more.
    // The defect this half used to guard — the surface reading `"documentCount"`
    // out of a catalogue answer that never emitted it, so the file tree drew
    // zero rows in silence — cannot be written now: `OpenedHead` has no such
    // member, and asking for one does not compile.
    //
    // What still needs guarding lives above: the **request** direction is still
    // JSON (`project_request.zig` writes it, serde parses it), and serde's
    // spelling rules there are not uniform. That half stays.
    if failed > 0 {
        eprintln!("      update apps/native/src/project_request.zig to match serde");
        std::process::exit(1);
    }
    println!(
        "PASS  verify:wire-shapes  ({} project inputs match serde byte for byte)",
        checked
    );
}
