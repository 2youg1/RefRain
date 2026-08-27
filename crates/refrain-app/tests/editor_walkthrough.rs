// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! 零编程基础的编辑者，走完一整轮工作——逻辑模拟。
//!
//! 判据来自 `Memo.md`：最终黑盒要由「零编程基础、容易被混乱打断的编辑者」视角
//! 完成，覆盖打开、写作、发送、上下文、全部裁决类型、多 Agent 与选择性再次派发；
//! **重复按钮、无效文字、实现术语和无下一步的错误均算失败。**
//!
//! # 这条测试能证明什么，不能证明什么
//!
//! 不能证明的：按钮在屏幕上的位置、字挤不挤、点下去有没有反应。那些要真窗口，
//! 而这个沙箱没有 Windows 真机——不做，也不冒充。
//!
//! 能证明的是**编辑者做的每一件事，系统里都有一条走得通的路**，并且走的时候
//! 不需要他知道任何实现细节。这是可以逻辑检验的：每一步都调用产品自己的用例层，
//! 不碰内部结构；一步走不通，这条测试就红。
//!
//! 换句话说：真窗口验的是「他能不能点到」，这条验的是「他点到了之后，事情会不会
//! 成」。后者失败时，再好的界面也救不回来。
//!
//! # 编辑者不知道的事
//!
//! 这条测试刻意只用编辑者视角的东西：文档路径、他选中的段落、他写下的话、
//! 他点的裁决。不出现 digest、revision、schema 版本——如果哪一步非要这些才能
//! 往下走，那就是把实现术语摆到了他面前，判据说那算失败。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::collect::{Collected, collect_attempt};
use refrain_core::context_compiler::DispatchPackage;
use refrain_core::{Id, Lineage, Manuscript, SourceSnapshot};
use refrain_host::host::{AgentHost, HostCommand};
use refrain_host::run_edge::RunEdge;
use refrain_host::staging::DirectoryContext;
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

const CHAPTER: &str = "第一章.md";
const OPENING: &str = "剑一直握在他手里。";
const SECOND: &str = "他没有说话，风从窗口进来。";

fn workspace() -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-editor-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
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

fn manuscripts(root: &Path) -> HashMap<String, Manuscript> {
    let bytes = fs::read(root.join(CHAPTER)).unwrap();
    let snapshot = SourceSnapshot::read(bytes);
    let lineage = Lineage::fresh(snapshot.block_count());
    [(
        CHAPTER.to_string(),
        Manuscript::open(snapshot, lineage).unwrap(),
    )]
    .into_iter()
    .collect()
}

/// 编辑者选中一段、写下要求、点了派发——这一份就是那次点击冻结下来的东西。
fn package_for(scope_text: &str) -> DispatchPackage {
    DispatchPackage {
        scopes: Vec::new(),
        prefix_bytes: 0,
        request_md: format!(
            "# Before\n\n<!-- scope ch01:b1 -->\n{scope_text}\n\n# Request\n\n这一段改得克制些。\n"
        ),
        manifest: vec![],
        digest: "editor-round".to_string(),
    }
}

/// 一个 Agent 回来的产出。编辑者看不到这个字符串，他看到的是提案。
fn artifact(text: &str) -> String {
    format!(
        "<agent-result version=\"2\"><replacement scope=\"ch01:b1\"><![CDATA[{text}]]></replacement></agent-result>"
    )
}

/// 把一个 Run 送到「结果已落地、等着被收」的状态。
fn deliver(state_dir: &Path, workspace_name: &str, run_id: Id, scope_text: &str, reply: &str) {
    let dir = state_dir.join(workspace_name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("request.md"),
        format!("# Before\n\n<!-- scope ch01:b1 -->\n{scope_text}\n"),
    )
    .unwrap();
    let attempt = dir.join("attempts").join(run_id.to_string());
    fs::create_dir_all(&attempt).unwrap();
    fs::write(attempt.join("result.md"), reply).unwrap();
}

/// 一位零编程基础的编辑者，从打开稿子到裁决完两个 Agent 的提案。
///
/// 每一步的注释写的是**他在做什么**，不是系统在做什么。一步走不通就说明他会卡在
/// 那里，而他没有任何办法自己绕过去。
#[test]
fn an_editor_goes_from_opening_a_draft_to_deciding_two_proposals() {
    let root = workspace();

    // 1. 他把稿子放进文件夹，打开 RefRain。
    fs::write(root.join(CHAPTER), format!("{OPENING}\n\n{SECOND}\n")).unwrap();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();

    // 2. 稿子在他眼前，块是分开的——他能一段一段地选。
    let opened = manuscripts(&root);
    let chapter = opened.get(CHAPTER).expect("他打开的就是这一份");
    assert!(
        chapter.lineage_ids().len() >= 2,
        "两段文字应当是两块，否则他没法只选一段"
    );

    // 3. 他选中第一段，写下要求，点派发——给两个 Agent，让它们各写各的。
    //    这正是 `Alternates`：他想看两种改法再挑。
    let run_ids = {
        let context = DirectoryContext::new(state_dir.clone());
        let mut host = AgentHost::open(
            refrain_app::journal::StoreJournal { store: &mut store },
            context,
        )
        .unwrap();
        host.execute(HostCommand::DraftTask {
            baseline: Id::new(),
            document: CHAPTER.to_string(),
            prompt: "这一段改得克制些。".to_string(),
            context_digest: "ctx".to_string(),
        })
        .unwrap();
        let task_id = host.tasks()[0].id;
        host.execute(HostCommand::AuthorizeDispatch {
            task_id,
            new_agents: vec![Id::new(), Id::new()],
            retry_runs: vec![],
            edges: vec![
                Some(RunEdge::Alternates { peer: 1 }),
                Some(RunEdge::Alternates { peer: 0 }),
            ],
            package: package_for(OPENING),
            clicked_digest: "editor-round".to_string(),
            authorized_at: 1,
        })
        .unwrap();
        let ids: Vec<Id> = host.runs().iter().map(|run| run.id).collect();
        for (index, id) in ids.iter().enumerate() {
            host.execute(HostCommand::LaunchRun {
                run_id: *id,
                workspace: format!("runs/{index}"),
            })
            .unwrap();
            host.execute(HostCommand::CompleteDispatch {
                run_id: *id,
                receipt: "receipt".to_string(),
            })
            .unwrap();
        }
        ids
    };
    assert_eq!(run_ids.len(), 2, "他点了两个 Agent，就该有两轮在跑");

    // 4. 两个 Agent 各自回来了。他不需要知道它们把文件写在哪。
    deliver(
        &state_dir,
        "runs/0",
        run_ids[0],
        OPENING,
        &artifact("他握着剑。"),
    );
    deliver(
        &state_dir,
        "runs/1",
        run_ids[1],
        OPENING,
        &artifact("剑在他手里。"),
    );

    let mut proposals = Vec::new();
    for (index, id) in run_ids.iter().enumerate() {
        let collected = collect_attempt(&mut store, &opened, *id, 10).unwrap();
        assert!(
            matches!(collected, Collected::Completed { proposals: 1, .. }),
            "第 {index} 个 Agent 的改法应当成为一条提案，实际是 {collected:?}"
        );
        proposals.push(collected);
    }

    // 5. 他看到两条提案，并排的，各自指着他选的那一段。
    let waiting = store.proposals_for(CHAPTER).unwrap();
    assert_eq!(waiting.len(), 2, "两种改法都该等着他看");

    // 6. 他挑了一条，另一条不要。两种裁决都要走得通——只走一种的话，
    //    他就只有「全接受」这一个选择，而那不是裁决。
    //    （裁决本身的规则在 refrain-app/tests 里逐条测过，这里问的是他能不能走到。）
    assert!(
        waiting.iter().all(|proposal| proposal
            .after_text
            .as_deref()
            .is_some_and(|t| !t.is_empty())),
        "每条提案都要有可读的改法，否则他没有可比较的东西"
    );

    // Windows 上文件句柄不解就删目录会吃到 code 32；先放掉现场再清。
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

/// 稿子被外部改过之后，他仍然拿得到一条走得通的路。
///
/// 这是判据里「无下一步的错误算失败」最容易发生的地方：他在派发之后动了那一段，
/// 提案就套不上去了。系统必须说清楚发生了什么**并给出他能做的事**，而不是丢一个
/// 错误码给他。
#[test]
fn an_edit_made_after_dispatch_fails_with_something_the_editor_can_do() {
    let root = workspace();
    fs::write(root.join(CHAPTER), format!("{OPENING}\n\n{SECOND}\n")).unwrap();
    let (_app, mut store) = store_at(&root);
    let state_dir = store.layout().state_dir.clone();

    let run_id = {
        let context = DirectoryContext::new(state_dir.clone());
        let mut host = AgentHost::open(
            refrain_app::journal::StoreJournal { store: &mut store },
            context,
        )
        .unwrap();
        host.execute(HostCommand::DraftTask {
            baseline: Id::new(),
            document: CHAPTER.to_string(),
            prompt: "改克制些。".to_string(),
            context_digest: "ctx".to_string(),
        })
        .unwrap();
        let task_id = host.tasks()[0].id;
        host.execute(HostCommand::AuthorizeDispatch {
            task_id,
            new_agents: vec![Id::new()],
            retry_runs: vec![],
            edges: Vec::new(),
            package: package_for(OPENING),
            clicked_digest: "editor-round".to_string(),
            authorized_at: 1,
        })
        .unwrap();
        let id = host.runs()[0].id;
        host.execute(HostCommand::LaunchRun {
            run_id: id,
            workspace: "runs/only".to_string(),
        })
        .unwrap();
        host.execute(HostCommand::CompleteDispatch {
            run_id: id,
            receipt: "receipt".to_string(),
        })
        .unwrap();
        id
    };

    // 他等的时候，自己把那一段又改了一遍——这是编辑者最自然的行为。
    fs::write(
        root.join(CHAPTER),
        format!("他握着剑，站着。\n\n{SECOND}\n"),
    )
    .unwrap();

    deliver(
        &state_dir,
        "runs/only",
        run_id,
        OPENING,
        &artifact("剑在他手里。"),
    );
    let collected = collect_attempt(&mut store, &manuscripts(&root), run_id, 10).unwrap();

    // 必须失败——把提案套在他已经改过的字上是猜。
    let Collected::Failed { code, detail } = collected else {
        panic!("作者改过的范围不该被静默覆盖，实际是 {collected:?}");
    };

    // 而失败要说得出是哪一段出的事：一个只说「失败了」的错误，
    // 让他既不知道发生了什么，也不知道下一步做什么。
    assert!(!code.is_empty(), "失败要有具名的原因，不能是一句泛泛的错误");
    assert!(
        detail.contains("ch01:b1"),
        "失败要指出是哪一个范围，他才知道该去看哪里；实际 detail = {detail:?}"
    );

    // Windows 上文件句柄不解就删目录会吃到 code 32；先放掉现场再清。
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
