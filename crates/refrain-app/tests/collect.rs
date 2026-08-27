// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Collection rules for contract identity, stale source text, and ordered writes.

use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::collect::{Collected, collect_attempt};
use refrain_core::context_compiler::DispatchPackage;
use refrain_core::{Id, Lineage, Manuscript, SourceSnapshot};
use refrain_host::host::{AgentHost, HostCommand, Run, RunProgress, TaskProgress};
use refrain_host::run_edge::RunEdge;
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

const CHAPTER: &str = "章一.md";
const FIRST: &str = "剑没有松。";
const SECOND: &str = "他久久没有说话。";

fn scratch() -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-collect-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(CHAPTER), format!("{FIRST}\n\n{SECOND}\n")).unwrap();
    root
}

fn store_at(root: &Path) -> (Connection, ProjectStore) {
    let mut app = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.to_path_buf(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    (app, store)
}

fn manuscript_of(root: &Path) -> Manuscript {
    let bytes = fs::read(root.join(CHAPTER)).unwrap();
    let snapshot = SourceSnapshot::read(bytes);
    let lineage = Lineage::fresh(snapshot.block_count());
    Manuscript::open(snapshot, lineage).unwrap()
}

/// 铺出一次派发留下的现场：冻结的请求，以及生产者回来的结果。
///
/// 不走完整的派发链路。那条链路自己有测试，而这里要问的是收取——把它需要的
/// 目录结构直接铺出来，测试就只会因为收取的逻辑而失败。
fn stage(state_dir: &Path, workspace: &str, run_id: Id, before: &str, reply: &str) {
    stage_with_identity(state_dir, workspace, run_id, before, reply, None);
}

/// 同上，但另写一份 context-manifest.json，把这个 scope 当初绑定的块 id 带上。
///
/// 派发的真实路径会写这份文件（`DirectoryContext::stage` + `promote_request`），
/// 而这些测试直接铺目录。`None` 造出的是「更早的构建派发的 Run」——没有身份，
/// 收取回落到按原文定位。
fn stage_with_identity(
    state_dir: &Path,
    workspace: &str,
    run_id: Id,
    before: &str,
    reply: &str,
    blocks: Option<&[Id]>,
) {
    let dir = state_dir.join(workspace);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("request.md"),
        format!("# Before\n\n<!-- scope ch01:b1 -->\n{before}\n"),
    )
    .unwrap();
    if let Some(blocks) = blocks {
        let ids: Vec<String> = blocks.iter().map(ToString::to_string).collect();
        fs::write(
            dir.join("context-manifest.json"),
            format!(
                r#"{{"digest":"d","manifest":[],"request":"","scopes":[{{"scope":"ch01:b1","blocks":[{}]}}]}}"#,
                ids.iter()
                    .map(|id| format!("\"{id}\""))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
        )
        .unwrap();
    }
    let attempt = dir.join("attempts").join(run_id.to_string());
    fs::create_dir_all(&attempt).unwrap();
    fs::write(attempt.join("result.md"), reply).unwrap();
}

fn replacement(text: &str) -> String {
    format!(
        "<agent-result version=\"2\"><replacement scope=\"ch01:b1\"><![CDATA[{text}]]></replacement></agent-result>"
    )
}

/// 在 host 里造出一个已经发出去、正在等结果的 Run。
fn dispatched_run(store: &mut ProjectStore, workspace: &str) -> Id {
    dispatched_run_with_edge(store, workspace, None)
}

/// 同上，但这个 Run 与同 Task 的第一个 Run 之间带一条边。
///
/// 边在授权时才解析成 id（那是 id 存在的时刻），所以这里必须授权两个 agent
/// 再把边挂到第二个上——不能凭空造一个 `ResolvedEdge`，那样测的就是夹具而不是
/// host 真正会写下的东西。
fn dispatched_run_with_edge(
    store: &mut ProjectStore,
    workspace: &str,
    edge: Option<RunEdge>,
) -> Id {
    let context = refrain_host::staging::DirectoryContext::new(store.layout().state_dir.clone());
    let state_dir = store.layout().state_dir.clone();
    let mut host = AgentHost::open(refrain_app::journal::StoreJournal { store }, context).unwrap();
    let baseline = Id::new();
    host.execute(HostCommand::DraftTask {
        baseline,
        document: CHAPTER.to_string(),
        prompt: "看看这一段。".to_string(),
        context_digest: "digest".to_string(),
    })
    .unwrap();
    let task_id = host.tasks()[0].id;
    let agent = Id::new();
    // 有边时要两个 Run：边指向的对象必须真实存在，否则解析不出 id。
    let (new_agents, edges) = match &edge {
        None => (vec![agent], Vec::new()),
        Some(edge) => (vec![Id::new(), agent], vec![None, Some(*edge)]),
    };
    host.execute(HostCommand::AuthorizeDispatch {
        task_id,
        new_agents,
        retry_runs: vec![],
        edges,
        package: DispatchPackage {
            scopes: Vec::new(),
            prefix_bytes: 0,
            request_md: String::new(),
            manifest: vec![],
            digest: "package".to_string(),
        },
        // 点下去的必须就是被授权的那一份：host 会比对这两个 digest。
        clicked_digest: "package".to_string(),
        authorized_at: 1,
    })
    .unwrap();
    // 有边时，上游必须先走到终态：`Verifies` 需要有东西可验，`Follows` 需要上游的
    // 产出。host 会拒绝在此之前启动（`UpstreamNotTerminal`）——那条约束正是判据
    // 2-5 的前半，这里顺着它走，而不是绕过它。
    if edge.is_some() {
        let upstream = host.runs()[0].id;
        let upstream_workspace = format!("{workspace}-upstream");
        host.execute(HostCommand::LaunchRun {
            run_id: upstream,
            workspace: upstream_workspace.clone(),
        })
        .unwrap();
        host.execute(HostCommand::CompleteDispatch {
            run_id: upstream,
            receipt: "upstream-receipt".to_string(),
        })
        .unwrap();
        // 顺序不是内容：终态之外，下游还要求上游真的留下了产出。夹具因此
        // 把结果写进上游的 attempt 目录，与真实生产者落盘的位置相同——
        // 少了它 host 会具名拒绝启动（`UpstreamWithoutArtifact`）。
        let attempt = state_dir
            .join(&upstream_workspace)
            .join("attempts")
            .join(upstream.to_string());
        std::fs::create_dir_all(&attempt).unwrap();
        std::fs::write(
            attempt.join("result.md"),
            "<agent-result version=\"2\"><memo topic=\"上游\">读过了。</memo></agent-result>",
        )
        .unwrap();
        host.execute(HostCommand::FailRun {
            run_id: upstream,
            failure: "upstream finished for the fixture".to_string(),
            at: 1,
        })
        .unwrap();
    }
    let run_id = host.runs().last().unwrap().id;
    host.execute(HostCommand::LaunchRun {
        run_id,
        workspace: workspace.to_string(),
    })
    .unwrap();
    // 只有真正发出去的 Run 才谈得上收取，所以夹具要走到 Dispatched。
    host.execute(HostCommand::CompleteDispatch {
        run_id,
        receipt: "receipt".to_string(),
    })
    .unwrap();
    run_id
}

#[test]
fn a_result_that_has_not_landed_moves_nothing() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let run_id = dispatched_run(&mut store, "runs/one");
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert_eq!(collected, Collected::Waiting);
}

#[test]
fn narration_around_a_single_root_is_trimmed_not_trusted() {
    // 打印通道的 CLI 爱在产出前叙述一句。叙述可以被裁掉，但元素本身仍要过
    // 全部校验——这条用例证明：裁剪成立时提案照常冻结。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        FIRST,
        &format!("我先读协议。{}\n以上。", replacement("剑一直握着。")),
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert_eq!(
        collected,
        Collected::Completed {
            proposals: 1,
            memos: 0,
            drafts: 0,
        }
    );
    assert_eq!(store.proposals_for(CHAPTER).unwrap().len(), 1);
}

#[test]
fn two_root_elements_are_not_salvaged() {
    // 两个根元素说明产出的形状已经坏了——不猜哪一个是真的，保持具名拒绝。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    let doubled = format!("{}{}", replacement("甲"), replacement("乙"));
    stage(&state_dir, "runs/one", run_id, FIRST, &doubled);
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert!(matches!(collected, Collected::Failed { .. }));
}

#[test]
fn a_replacement_whose_scope_text_still_matches_becomes_a_proposal() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        FIRST,
        &replacement("剑一直握着。"),
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert_eq!(
        collected,
        Collected::Completed {
            proposals: 1,
            memos: 0,
            drafts: 0,
        }
    );
    assert_eq!(store.proposals_for(CHAPTER).unwrap().len(), 1);
}

#[test]
fn a_scope_the_author_has_since_edited_fails_rather_than_guesses() {
    // 派发时冻结的原文，与现在稿子里的字不再逐字相同。此时把提案套在任何一段
    // 上都是猜——这一路必须失败，并说出是哪个范围。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        "作者后来改掉了的一段原文。",
        &replacement("无处安放的替换。"),
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert_eq!(
        collected,
        Collected::Failed {
            code: "scope-text-moved".to_string(),
            detail: "ch01:b1".to_string(),
        }
    );
    assert!(store.proposals_for(CHAPTER).unwrap().is_empty());
}

#[test]
fn a_scope_whose_text_repeats_is_refused_with_every_candidate() {
    // 冻结原文在稿子里逐字出现两次。从前这里默认取第一处（审计 F-02 实测
    // 复现：冲销改错了段），现在必须整个拒绝，并把两处候选都交出来——只有作者
    // 知道他当初框的是哪一段。
    //
    // 这与「作者改过」是两件事，所以用两个错误码：那一条说文字不在了，这一条
    // 说文字在，但不止一处。压成同一个码，作者会照着一条不适用的指引去找。
    let root = scratch();
    // 副歌就是重复段落——这个产品叫 RefRain，重复文本是它的命名级用例。
    fs::write(
        root.join(CHAPTER),
        format!("{FIRST}\n\n{SECOND}\n\n{FIRST}\n"),
    )
    .unwrap();

    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        FIRST,
        &replacement("改写后的一段。"),
    );
    let manuscript = manuscript_of(&root);
    let manuscripts = [(CHAPTER.to_string(), manuscript.clone())]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    let Collected::Failed { code, detail } = collected else {
        panic!("a repeated scope must not become a proposal");
    };
    assert_eq!(code, "scope-text-ambiguous");
    // 说清是几处，并交出候选块 id：只说「有歧义」，作者无从下手。
    assert!(
        detail.contains("matches 2 places"),
        "the detail must say how many places matched, got {detail:?}"
    );
    // 断言用的必须是**送进去的那一份**稿子的块 id。再调一次 `manuscript_of`
    // 会新读一遍文件、生成另一批 id，于是断言比对的是两个无关的世界——
    // 第一版就是这样写的，红的是断言不是产品。
    let ids = manuscript.head().blocks();
    assert!(
        detail.contains(&ids[0].id().to_string()) && detail.contains(&ids[2].id().to_string()),
        "both candidates must be named, got {detail:?}"
    );
    // 一个提案都不能落地：不确定改哪一处时写入，比不写入坏得多。
    assert!(store.proposals_for(CHAPTER).unwrap().is_empty());
}

#[test]
fn identity_lands_a_repeated_scope_on_the_block_the_author_actually_chose() {
    // A 的判据。两段逐字相同时，按原文定位只能拒绝（B 已经做到不改错段），
    // 但作者本来就有权得到结果——他当初选的是**哪一个**块，这个事实在派发那一刻
    // 就存在，只是从前没被带过来。带上之后，重复不再是障碍。
    //
    // 这条钉住的是「落在正确那一处」，不只是「没有失败」：提案的 scope 必须是
    // 第三个块，而不是文字相同的第一个块。
    let root = scratch();
    fs::write(
        root.join(CHAPTER),
        format!("{FIRST}\n\n{SECOND}\n\n{FIRST}\n"),
    )
    .unwrap();

    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");

    let manuscript = manuscript_of(&root);
    let blocks = manuscript.head().blocks();
    // 作者选的是**第三块**——与第一块逐字相同的那一个。
    let chosen = blocks[2].id();

    stage_with_identity(
        &state_dir,
        "runs/one",
        run_id,
        FIRST,
        &replacement("改写后的一段。"),
        Some(&[chosen]),
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript.clone())]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert_eq!(
        collected,
        Collected::Completed {
            proposals: 1,
            memos: 0,
            drafts: 0,
        }
    );
    let proposals = store.proposals_for(CHAPTER).unwrap();
    assert_eq!(proposals.len(), 1);
    // 决定性的一条：提案绑在作者选的那一块上，不是文字相同的第一块。
    // `scope` 存的是块 id 的 JSON 数组（见 collect.rs 的 `json_of`）。
    let scope = &proposals[0].scope;
    assert_eq!(
        *scope,
        format!("[\"{chosen}\"]"),
        "the proposal must bind the block the author chose"
    );
    assert!(
        !scope.contains(&blocks[0].id().to_string()),
        "the identical first block must not be touched: {scope}"
    );
}

#[test]
fn an_identified_scope_whose_bytes_changed_still_fails_rather_than_overwrites() {
    // 身份让定位不再依赖文本，但**不能**让它不再核对文本。块还在、字节变了，
    // 说明作者自己改了这一段：Agent 读到的已经不是现在的正文，照套上去就是
    // 覆盖他没让改的字。身份回答「是哪一段」，字节回答「还能不能用」，
    // 两个问题都要问。
    //
    // 没有这条测试，「身份命中后跳过字节比较」这个缺陷是全绿的——
    // 既有的那条 stale 测试不带身份，走的是另一条分支。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");

    let manuscript = manuscript_of(&root);
    let chosen = manuscript.head().blocks()[0].id();

    // 冻结的是作者后来改掉的文字：块 id 仍然指向那一块，但字节已经不同。
    stage_with_identity(
        &state_dir,
        "runs/one",
        run_id,
        "派发时的原文，作者后来改掉了。",
        &replacement("基于旧文本的改写。"),
        Some(&[chosen]),
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript)].into_iter().collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert_eq!(
        collected,
        Collected::Failed {
            code: "scope-text-moved".to_string(),
            detail: "ch01:b1".to_string(),
        }
    );
    assert!(store.proposals_for(CHAPTER).unwrap().is_empty());
}

#[test]
fn a_scope_the_frozen_request_never_carried_is_refused() {
    // 契约来自冻结的请求，不来自结果自己的声称（SPEC 8.4）：结果指名一个请求
    // 里没有的范围时，不能因为它这么说就接受。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    let reply = "<agent-result version=\"2\"><replacement scope=\"ch01:b9\"><![CDATA[凭空一段。]]></replacement></agent-result>";
    stage(&state_dir, "runs/one", run_id, FIRST, reply);
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    match collected {
        Collected::Failed { code, .. } => assert_ne!(code, "scope-text-moved"),
        other => panic!("a scope outside the contract was accepted: {other:?}"),
    }
    assert!(store.proposals_for(CHAPTER).unwrap().is_empty());
}

#[test]
fn collecting_into_a_document_that_is_not_open_refuses() {
    // 块 id 只存在于打开着的那份稿子里。没有它就无法把原文对回具体的块，
    // 此时应当说明情况，而不是写一份指向不存在的块的提案。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        FIRST,
        &replacement("剑一直握着。"),
    );
    let manuscripts = std::collections::HashMap::new();

    let error = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap_err();

    assert!(
        error.to_string().contains(CHAPTER),
        "the refusal should name the document: {error}"
    );
}

#[test]
fn a_run_this_project_does_not_have_refuses() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let stranger = Id::new();
    let error = collect_attempt(&mut store, &manuscripts, stranger, 10).unwrap_err();

    assert!(
        error.to_string().contains(&stranger.to_string()),
        "the refusal should name the run: {error}"
    );
}

#[test]
fn a_failed_collect_is_written_to_the_run_not_only_returned() {
    // 失败是产品要展示的事实：Run 的历史里必须留下这一次，否则作者只在一次
    // 调用的返回值里见过它。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        "作者后来改掉了的一段原文。",
        &replacement("无处安放的替换。"),
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    let context = refrain_host::staging::DirectoryContext::new(state_dir);
    let host = AgentHost::open(
        refrain_app::journal::StoreJournal { store: &mut store },
        context,
    )
    .unwrap();
    let run: &Run = host.runs().iter().find(|run| run.id == run_id).unwrap();
    assert!(
        matches!(run.progress, RunProgress::Failed { .. }),
        "the run should carry the failure, found {:?}",
        run.progress
    );
    assert!(matches!(
        host.tasks()[0].progress,
        TaskProgress::Open { .. } | TaskProgress::Draft
    ));
}

/// 判据 2-3：验证者出了改写，整份产出被拒。
///
/// `Verifies` 的全部意思是「这一轮读另一份产出并报告」。一个给了改写的验证者
/// 做的是作者没有授权的那件事。
///
/// 三条测试合起来才说清这条规则，单独任何一条都不够：
///
/// 1. 这一条——验证者出改写 → 失败；
/// 2. 下一条——**同样的产出**换成没有边的 Run → 成功。没有它，一个「永远拒绝
///    改写」的实现会全绿，而规则就退化成了「改写一律不许」；
/// 3. 第三条——被拒时批注也没有留下。丢掉改写、留下批注等于替作者裁掉了他会
///    想看到的东西，也让下一轮的验证者以为越界是可以的。
#[test]
fn a_verifier_that_proposes_an_edit_is_refused_whole() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run_with_edge(
        &mut store,
        "runs/one",
        Some(RunEdge::Verifies { subject: 0 }),
    );
    stage(
        &state_dir,
        "runs/one",
        run_id,
        FIRST,
        &replacement("验证者不该给的改写。"),
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    // 改写没有落进提案：被拒的是整份产出。
    assert_eq!(store.proposals_for(CHAPTER).unwrap().len(), 0);

    let context = refrain_host::staging::DirectoryContext::new(state_dir);
    let host = AgentHost::open(
        refrain_app::journal::StoreJournal { store: &mut store },
        context,
    )
    .unwrap();
    let run: &Run = host.runs().iter().find(|run| run.id == run_id).unwrap();
    match &run.progress {
        RunProgress::Failed { failure } => {
            assert_eq!(
                failure, "verifier-proposed-edit",
                "失败要说出是越界，不是别的"
            );
        }
        other => panic!("越界的验证者应当失败，实际是 {other:?}"),
    }
}

/// 同一份产出，换成没有边的 Run —— 必须成功。
///
/// 这是上一条的反向。没有这一条，「改写一律拒绝」也能让上一条全绿，而那不是
/// 规则说的事：规则限制的是**验证者**，不是改写本身。
#[test]
fn the_same_edit_from_a_run_without_an_edge_is_accepted() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        FIRST,
        &replacement("验证者不该给的改写。"),
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert_eq!(
        collected,
        Collected::Completed {
            proposals: 1,
            memos: 0,
            drafts: 0,
        },
        "同样的改写，没有 Verifies 边时应当照常成为提案"
    );
}

/// 越界时批注也不留下。
///
/// 产出是一份整体：作者授权的是「读并报告」，而这一份既报告又改写。把改写丢掉、
/// 把批注留下，等于替作者做了他没有做的裁决。
#[test]
fn a_refused_verifier_leaves_no_memo_either() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run_with_edge(
        &mut store,
        "runs/one",
        Some(RunEdge::Verifies { subject: 0 }),
    );
    let both = "<agent-result version=\"2\"><memo scope=\"ch01:b1\"><![CDATA[这里的时序有问题。]]></memo>\
         <replacement scope=\"ch01:b1\"><![CDATA[越界的改写。]]></replacement></agent-result>";
    stage(&state_dir, "runs/one", run_id, FIRST, both);
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    // 返回值直接说清「一份都没收下」：不是批注 1 改写 0，而是整份被拒。
    match collected {
        Collected::Failed { code, .. } => assert_eq!(code, "verifier-proposed-edit"),
        other => panic!("越界应当整份被拒，实际是 {other:?}"),
    }
    assert_eq!(
        store.proposals_for(CHAPTER).unwrap().len(),
        0,
        "改写不该留下"
    );
}

/// M9：批注不再被解析后丢弃——它落在与手写批注同一个面上。
///
/// 「只留话、不改正文」是验证者的全部工作方式（也是任何 Run 的合法产出）。
/// 此前 `AgentComment` 解析出来就进了计数器，作者永远读不到。现在它成为
/// annotations 表的一行：锚在目标 scope 的块上，quote 是冻结的原文——
/// agent 当初读到的那段字，与手写批注存选中文同一条理由。
#[test]
fn comments_land_as_annotations_instead_of_being_dropped() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        FIRST,
        "<agent-result version=\"2\"><comments><comment target=\"ch01:b1\"><![CDATA[这段的节奏偏慢。]]></comment></comments></agent-result>",
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert!(
        matches!(collected, Collected::Completed { .. }),
        "{collected:?}"
    );
    let annotations = store.annotations(CHAPTER).unwrap();
    assert_eq!(annotations.len(), 1, "{annotations:?}");
    assert_eq!(annotations[0].body.as_deref(), Some("这段的节奏偏慢。"));
    assert_eq!(annotations[0].quote, FIRST);
}

/// 目标对不上本轮 scope 的批注也一条不丢：锚在文稿首块，目标词写进正文——
/// 锚错了位置要看得出来，而不是悄悄消失。
#[test]
fn a_comment_naming_an_unknown_scope_is_kept_where_it_can_be_seen() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();
    let run_id = dispatched_run(&mut store, "runs/one");
    stage(
        &state_dir,
        "runs/one",
        run_id,
        FIRST,
        "<agent-result version=\"2\"><comments><comment target=\"ch99:nope\"><![CDATA[指错了地方。]]></comment></comments></agent-result>",
    );
    let manuscripts = [(CHAPTER.to_string(), manuscript_of(&root))]
        .into_iter()
        .collect();

    let collected = collect_attempt(&mut store, &manuscripts, run_id, 10).unwrap();

    assert!(
        matches!(collected, Collected::Completed { .. }),
        "{collected:?}"
    );
    let annotations = store.annotations(CHAPTER).unwrap();
    assert_eq!(annotations.len(), 1, "{annotations:?}");
    assert_eq!(
        annotations[0].body.as_deref(),
        Some("[ch99:nope] 指错了地方。")
    );
}
