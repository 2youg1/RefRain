// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! The host-private staging directory and the Run workspaces (SPEC 8.2, 6.3).
//!
//! `refrain-host` writes exactly two places (§6.2-3): its private staging and
//! the Run workspace. Both live under the project's `.refrain/`:
//!
//! ```text
//! .refrain/
//! ├─ dispatch/staging/
//! │  ├─ manifests/<digest>.json   # the immutable snapshot the author read
//! │  └─ requests/<run-id>.md      # one frozen request per Run
//! └─ agents/<agent-id>/
//!    ├─ AGENTS.md                 # generated identity: persona + protocol pointer
//!    ├─ Memo.md                   # the agent's own memory, kept by the agent
//!    └─ runs/<run-id>/
//!       ├─ request.md             # promoted at launch, producer-visible
//!       └─ context-manifest.json  # the snapshot, promoted with it
//! ```
//!
//! The agent level exists because a harness CLI discovers AGENTS.md by
//! walking up from its working directory: the harness's cwd is the Run
//! workspace, so identity at `agents/<agent-id>/AGENTS.md` loads itself with
//! zero request bytes. Per-run directories below it keep alternates isolated
//! — one Run never names another Run's path.
//!
//! Runs dispatched before this layout keep their recorded `runs/<run-id>`
//! workspace string in the journal, and every read path resolves the stored
//! string — old workspaces stay readable with no adapter and no migration.
//!
//! Staging writes are plain write+fsync: a crash mid-stage leaves a partial
//! file whose hash fails `staged_request_matches`, which blocks the launch
//! (§8.2-5) — the producer never sees staging either way. The promotion
//! itself is a rename inside one volume, atomic on every target OS. The
//! fsync idioms mirror refrain-store's atomic writer (directory flushes are
//! a Unix no-op here for the same reason); the crate boundary forbids
//! sharing the code, so the ten lines are re-stated, not imported.

use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use refrain_core::context_compiler::{DispatchPackage, ManifestEntry};
use refrain_core::persona::Persona;
use refrain_core::{Id, digest::content_hex};
use serde::{Deserialize, Serialize};

use crate::host::{FrozenContext, StagedDispatch};

/// The snapshot as it lands on disk: what the author read, plus the
/// canonical request with its run-id placeholder intact.
///
/// `scopes` carries the block identities each Edit Scope was cut from. The
/// request file itself only shows the agent a readable position label
/// (`ch01:b3`), which is a fine thing to copy back and a useless thing to
/// locate with — insert a paragraph above it and the label points elsewhere.
/// Collection reads the identities from here instead, so a scope is found by
/// what it *is* rather than by what it *said* (审计 F-02).
#[derive(Serialize)]
struct ManifestSnapshot<'a> {
    digest: &'a str,
    manifest: &'a [ManifestEntry],
    request: &'a str,
    scopes: Vec<ScopeIdentity>,
}

/// The same snapshot read back. Writing borrows and reading owns, so the two
/// shapes cannot be one type; the field names are the contract between them,
/// and `read_back_carries_the_scope_identities` is what keeps them honest.
#[derive(Deserialize)]
struct OwnedManifestSnapshot {
    #[serde(default)]
    scopes: Vec<ScopeIdentity>,
}

/// One Edit Scope's durable identity, as the manifest records it.
///
/// Separate from `BeforeScope` because this is the on-disk shape and it must
/// stay readable by a build that wrote it before: the frozen text is not
/// repeated here — the request file already holds it, and two copies of the
/// same bytes would eventually disagree.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ScopeIdentity {
    /// The label the agent sees and returns.
    pub scope: String,
    /// The blocks it was cut from, in document order.
    pub blocks: Vec<Id>,
}

/// A `FrozenContext` over real directories. Construct with the project's
/// state directory (`.refrain/`); every path it touches stays underneath.
pub struct DirectoryContext {
    state_dir: PathBuf,
}

/// The Run workspace as the journal records it, relative to `.refrain/`.
///
/// The agent level is the layout's point: a harness CLI discovers AGENTS.md
/// by walking up from its working directory, so nesting the run under
/// `agents/<agent-id>/` loads the agent's identity with zero request bytes,
/// while the per-run directory below it keeps alternates isolated. This is
/// the layout's only authority — the bridge and the tests name workspaces
/// through here, never with a `format!` of their own.
#[must_use]
pub fn run_workspace(agent_id: Id, run_id: Id) -> String {
    format!("agents/{agent_id}/runs/{run_id}")
}

/// The version stamped into a generated AGENTS.md. A format change bumps it,
/// and an old stamp reads as "regenerate" — the rewrite is content-compared,
/// so a persona edit and a format bump take the same path.
pub const AGENT_FILE_VERSION: &str = "v1";

/// The AGENTS.md for one agent: the author's own bytes, and nothing the
/// author did not write.
///
/// **作者原文逐字节进入文件（D13）。** 早先这里 `trim()` 了它，加了「# 身份」
/// 标题，还写进一段协议指针——三处都是应用替作者说话。后果具体：一句
/// 「你是一位资深编辑」后面被补上一段协议说明，那个 Agent 会把说明也当成
/// 身份的一部分；而首尾空白可能是作者有意排的版。
///
/// 协议不进这个文件：它每轮随 `request.md` 走（`# Reply format` 一节）。
/// 写进身份文件，协议改一次就要重写每个 Agent 的身份文件。
///
/// Cosplay 的演法预设由 `Persona::agent_file` 追加在原文之后——这里不判
/// 模式，那是那个类型自己的性质。
#[must_use]
pub fn agent_file(persona: Option<&Persona>, cosplay_preset: &str) -> String {
    match persona {
        Some(persona) => persona.agent_file(cosplay_preset),
        // 没有配置身份时写一个空文件而不是一句「（作者未配置身份。）」——
        // 那句话本身会被 Agent 读成身份的一部分。
        None => String::new(),
    }
}

impl DirectoryContext {
    pub fn new(state_dir: PathBuf) -> Self {
        Self { state_dir }
    }

    fn manifests_dir(&self) -> PathBuf {
        self.state_dir
            .join("dispatch")
            .join("staging")
            .join("manifests")
    }

    fn requests_dir(&self) -> PathBuf {
        self.state_dir
            .join("dispatch")
            .join("staging")
            .join("requests")
    }

    fn staged_request(&self, run_id: Id) -> PathBuf {
        self.requests_dir().join(format!("{run_id}.md"))
    }

    /// One agent's persistent directory under `.refrain/agents/`.
    fn agent_dir(&self, agent_id: Id) -> PathBuf {
        self.state_dir.join("agents").join(agent_id.to_string())
    }

    /// Write the agent's AGENTS.md when it is missing or out of date.
    ///
    /// Content-compared rather than timestamped: a persona edit changes the
    /// content and rewrites the file; a launch that changes nothing writes
    /// nothing, so dispatching stays free of disk chatter.
    pub fn ensure_agent_files(
        &self,
        agent_id: Id,
        persona: Option<&Persona>,
        cosplay_preset: &str,
    ) -> io::Result<PathBuf> {
        let dir = self.agent_dir(agent_id);
        fs::create_dir_all(&dir)?;
        let file = dir.join("AGENTS.md");
        let wanted = agent_file(persona, cosplay_preset);
        let current = match fs::read_to_string(&file) {
            Ok(text) => Some(text),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        if current.as_deref() != Some(wanted.as_str()) {
            fs::write(&file, wanted)?;
            sync_file(&file)?;
        }
        Ok(file)
    }

    /// Whether the agent's workspace already holds a Memo.md — the fact a
    /// resumed round is built from. The app never reads or writes the memo
    /// itself; it is the agent's own memory.
    #[must_use]
    pub fn has_agent_memo(&self, agent_id: Id) -> bool {
        self.agent_dir(agent_id).join("Memo.md").is_file()
    }

    /// The promoted request as the producer sees it (L0 collect reads the
    /// scope ids back out of it: the frozen bytes are the authority, not
    /// anyone's memory of the dispatch).
    pub fn read_workspace_request(&self, workspace: &str) -> io::Result<Option<String>> {
        match fs::read_to_string(self.state_dir.join(workspace).join("request.md")) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// The Edit Scope identities this Run's request was frozen with.
    ///
    /// `None` when the workspace has no manifest, and an empty vector when the
    /// manifest predates identity-carrying (`serde(default)`). Both mean the
    /// same thing to a caller — no identities to locate by — but they are kept
    /// distinct because "no manifest" is a broken workspace while "an older
    /// manifest" is a Run dispatched by an earlier build, and only the first
    /// is worth investigating.
    pub fn read_workspace_scopes(&self, workspace: &str) -> io::Result<Option<Vec<ScopeIdentity>>> {
        let path = self.state_dir.join(workspace).join("context-manifest.json");
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let snapshot: OwnedManifestSnapshot =
            serde_json::from_str(&text).map_err(io::Error::other)?;
        Ok(Some(snapshot.scopes))
    }

    /// Overwrite the promoted request (feeding an upstream section at launch).
    /// The frozen staged bytes are untouched — the freeze check already ran
    /// against them before promotion.
    pub fn write_workspace_request(&self, workspace: &str, contents: &str) -> io::Result<()> {
        fs::write(self.state_dir.join(workspace).join("request.md"), contents)
    }

    /// Land an argv producer's reply as the attempt's result (L1/L2): the
    /// bytes arrive whole or not at all — a collect that races the landing
    /// sees "waiting", never a half file.
    pub fn land_result(&self, workspace: &str, run_id: Id, bytes: &[u8]) -> io::Result<()> {
        let dir = self
            .state_dir
            .join(workspace)
            .join("attempts")
            .join(run_id.to_string());
        fs::create_dir_all(&dir)?;
        let temporary = dir.join("result.md.landing");
        fs::write(&temporary, bytes)?;
        sync_file(&temporary)?;
        fs::rename(&temporary, dir.join("result.md"))?;
        sync_directory(&dir)
    }
}

impl FrozenContext for DirectoryContext {
    type Error = io::Error;

    fn stage(
        &mut self,
        package: &DispatchPackage,
        requests: &[(Id, String)],
    ) -> Result<StagedDispatch, io::Error> {
        let manifests = self.manifests_dir();
        let requests_dir = self.requests_dir();
        fs::create_dir_all(&manifests)?;
        fs::create_dir_all(&requests_dir)?;

        let snapshot = serde_json::to_string_pretty(&ManifestSnapshot {
            digest: &package.digest,
            manifest: &package.manifest,
            request: &package.request_md,
            scopes: package
                .scopes
                .iter()
                .map(|scope| ScopeIdentity {
                    scope: scope.scope.clone(),
                    blocks: scope.blocks.clone(),
                })
                .collect(),
        })
        .map_err(io::Error::other)?;
        let manifest_file = manifests.join(format!("{}.json", package.digest));
        fs::write(&manifest_file, &snapshot)?;
        sync_file(&manifest_file)?;

        let mut digests = Vec::with_capacity(requests.len());
        for (run_id, request) in requests {
            let file = self.staged_request(*run_id);
            fs::write(&file, request)?;
            sync_file(&file)?;
            digests.push((*run_id, content_hex(request.as_bytes())));
        }
        sync_directory(&requests_dir)?;

        Ok(StagedDispatch {
            manifest_path: format!("dispatch/staging/manifests/{}.json", package.digest),
            request_digests: digests,
        })
    }

    fn promote_request(
        &mut self,
        run_id: Id,
        workspace: &str,
        manifest_digest: &str,
    ) -> Result<(), io::Error> {
        let staged = self.staged_request(run_id);
        let workspace_dir = self.state_dir.join(workspace);
        fs::create_dir_all(&workspace_dir)?;
        // The attempt directory exists before the producer is told the path:
        // writing a result must never mean inventing directory structure.
        fs::create_dir_all(workspace_dir.join("attempts").join(run_id.to_string()))?;

        // The target never exists in-protocol: Launching persists before the
        // promotion, and a crash beside it is recovered as recovery-required,
        // not by re-promoting. If it does exist, the rename's error is the
        // honest answer (Windows refuses to replace, and so do we).
        let request = workspace_dir.join("request.md");
        fs::rename(&staged, &request)?;

        let manifest = workspace_dir.join("context-manifest.json");
        fs::copy(
            self.manifests_dir().join(format!("{manifest_digest}.json")),
            &manifest,
        )?;
        sync_file(&manifest)?;
        sync_file(&request)?;
        sync_directory(&workspace_dir)
    }

    fn staged_request_matches(&self, run_id: Id, digest: &str) -> Result<bool, io::Error> {
        match fs::read(self.staged_request(run_id)) {
            Ok(bytes) => Ok(content_hex(&bytes) == digest),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// One attempt per Run in v0.2: a retry is a new Run with a new attempt.
    fn read_result(&self, workspace: &str, run_id: Id) -> Result<Option<Vec<u8>>, io::Error> {
        let path = self
            .state_dir
            .join(workspace)
            .join("attempts")
            .join(run_id.to_string())
            .join("result.md");
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
}

/// Directory durability is a Unix concern; Windows has no user-space
/// directory handle to flush.
fn sync_directory(_path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::File::open(_path)?.sync_all()?;
    Ok(())
}

/// Windows refuses to flush a handle without write access, so even a file
/// that will never be written again is opened read-write for its own fsync.
fn sync_file(path: &Path) -> io::Result<()> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use refrain_core::context_compiler::Tokens;
    use refrain_core::persona::DEFAULT_COSPLAY_PRESET;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("refrain-staging-{}", Id::new()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn package() -> DispatchPackage {
        let request_md =
            "# Request\n改克制。\n\n# Reply format\n写进 runs/<run-id>/result.md。\n".to_string();
        DispatchPackage {
            scopes: Vec::new(),
            prefix_bytes: 0,
            digest: content_hex(request_md.as_bytes()),
            request_md,
            manifest: vec![ManifestEntry {
                section: "Request".to_string(),
                source: "author".to_string(),
                digest: "d".to_string(),
                bytes: 6,
                tokens: Tokens::Estimated(10),
            }],
        }
    }

    #[test]
    fn a_staged_request_verifies_and_a_tampered_one_does_not() {
        let dir = scratch();
        let mut context = DirectoryContext::new(dir.clone());
        let run_id = Id::new();
        let staged = context
            .stage(&package(), &[(run_id, "frozen request".to_string())])
            .unwrap();
        let digest = &staged.request_digests[0].1;
        assert!(context.staged_request_matches(run_id, digest).unwrap());

        fs::write(
            dir.join("dispatch/staging/requests")
                .join(format!("{run_id}.md")),
            "tampered",
        )
        .unwrap();
        assert!(!context.staged_request_matches(run_id, digest).unwrap());

        // Simulated loss without a permanent delete (INV-6 scans tests too):
        // renaming away is the same absence from the verifier's chair.
        fs::rename(
            dir.join("dispatch/staging/requests")
                .join(format!("{run_id}.md")),
            dir.join("dispatch/staging/requests")
                .join(format!("{run_id}.md.gone")),
        )
        .unwrap();
        assert!(!context.staged_request_matches(run_id, digest).unwrap());
    }

    #[test]
    fn promotion_moves_request_and_manifest_into_the_workspace() {
        let dir = scratch();
        let mut context = DirectoryContext::new(dir.clone());
        let package = package();
        let run_id = Id::new();
        let staged = context
            .stage(&package, &[(run_id, "frozen request".to_string())])
            .unwrap();
        assert_eq!(
            staged.manifest_path,
            format!("dispatch/staging/manifests/{}.json", package.digest)
        );

        context
            .promote_request(run_id, &format!("runs/{run_id}"), &package.digest)
            .unwrap();
        let workspace = dir.join("runs").join(run_id.to_string());
        assert_eq!(
            fs::read_to_string(workspace.join("request.md")).unwrap(),
            "frozen request"
        );
        let manifest = fs::read_to_string(workspace.join("context-manifest.json")).unwrap();
        assert!(manifest.contains(&package.digest));
        // The staged copy is gone: promotion is a move, not a leak.
        assert!(
            !dir.join("dispatch/staging/requests")
                .join(format!("{run_id}.md"))
                .exists()
        );
    }

    /// 布局的形状：run 工作区嵌在 agent 目录下，两个 run（哪怕同一 agent）
    /// 各有自己的目录——并列隔离的结构半句话都在这条路径里。
    #[test]
    fn run_workspaces_nest_under_their_agent_and_stay_apart() {
        let agent = Id::new();
        let first = run_workspace(agent, Id::new());
        let second = run_workspace(agent, Id::new());
        assert!(first.starts_with(&format!("agents/{agent}/runs/")));
        assert!(second.starts_with(&format!("agents/{agent}/runs/")));
        assert_ne!(first, second, "同一 agent 的两个 run 不许共用目录");
        // 两个 agent 之间亦然。
        let other = run_workspace(Id::new(), Id::new());
        assert!(!other.starts_with(&format!("agents/{agent}/")));
    }

    /// AGENTS.md 从 persona 生成，带版本行；persona 变更时内容比对重写，
    /// 作者原文逐字节进文件；没变更就不写。
    ///
    /// 这条测试此前断言的是被 D13 推翻的行为——版本头、「# 身份」标题、
    /// 一段协议指针。三处都是应用替作者说话：Agent 会把那段协议说明也
    /// 读成身份的一部分。
    #[test]
    fn the_agent_file_is_the_author_s_bytes_and_regenerates_on_change() {
        let dir = scratch();
        let context = DirectoryContext::new(dir.clone());
        let agent = Id::new();
        let editor = Persona::Work {
            // 首尾空白是作者排的版，不该被 trim 掉。
            body: "  你是一位克制的编辑。\n".to_string(),
        };

        let file = context
            .ensure_agent_files(agent, Some(&editor), DEFAULT_COSPLAY_PRESET)
            .unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert_eq!(text, editor.body(), "the author's bytes changed");

        // 同内容重写是无操作——派发不该带来磁盘噪音。
        let written = fs::metadata(&file).unwrap().modified().unwrap();
        context
            .ensure_agent_files(agent, Some(&editor), DEFAULT_COSPLAY_PRESET)
            .unwrap();
        assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), written);

        // persona 变了，文件跟着变。
        let proofreader = Persona::Work {
            body: "你是一位严格的校对。".to_string(),
        };
        context
            .ensure_agent_files(agent, Some(&proofreader), DEFAULT_COSPLAY_PRESET)
            .unwrap();
        let updated = fs::read_to_string(&file).unwrap();
        assert_eq!(updated, proofreader.body());
        assert!(!updated.contains("克制的编辑"));
    }

    /// 换模式改变文件，而两态的前 body.len() 字节相同。
    #[test]
    fn switching_to_cosplay_appends_the_preset_after_the_author_s_bytes() {
        let dir = scratch();
        let context = DirectoryContext::new(dir.clone());
        let agent = Id::new();
        let body = "我是沈青，二十七岁，话很少。".to_string();

        let work = Persona::Work { body: body.clone() };
        let file = context
            .ensure_agent_files(agent, Some(&work), DEFAULT_COSPLAY_PRESET)
            .unwrap();
        let work_text = fs::read_to_string(&file).unwrap();

        let cosplay = work.toggled();
        context
            .ensure_agent_files(agent, Some(&cosplay), DEFAULT_COSPLAY_PRESET)
            .unwrap();
        let cosplay_text = fs::read_to_string(&file).unwrap();

        // 两态必须真的不同，否则「切换模式」是个什么也不做的按钮。
        assert_ne!(work_text, cosplay_text);
        // 而作者的字在两态下逐字节相同。
        assert_eq!(&cosplay_text[..body.len()], body);
        assert!(cosplay_text.contains("第一人称"), "the preset is missing");
    }

    /// 没有身份就写空文件，而不是写一句会被读成身份的话。
    #[test]
    fn no_persona_writes_nothing_rather_than_a_sentence_about_having_none() {
        let dir = scratch();
        let context = DirectoryContext::new(dir);
        let blank = context
            .ensure_agent_files(Id::new(), None, DEFAULT_COSPLAY_PRESET)
            .unwrap();
        // 近失手：写「（作者未配置身份。）」，Agent 会把那句话当成身份。
        assert_eq!(fs::read_to_string(blank).unwrap(), "");
    }

    /// Memo.md 是接续轮的事实来源：它一出现，has_agent_memo 就为真。
    /// 应用自己不写 Memo.md——那是 agent 的地盘。
    #[test]
    fn a_memo_marks_the_workspace_as_resumable() {
        let dir = scratch();
        let context = DirectoryContext::new(dir.clone());
        let agent = Id::new();
        assert!(!context.has_agent_memo(agent));

        context
            .ensure_agent_files(agent, None, DEFAULT_COSPLAY_PRESET)
            .unwrap();
        assert!(
            !context.has_agent_memo(agent),
            "AGENTS.md 不是 Memo.md：生成身份不等于有记忆"
        );

        let memo = dir.join("agents").join(agent.to_string()).join("Memo.md");
        fs::write(memo, "上一轮：作者不接受设问句结尾。").unwrap();
        assert!(context.has_agent_memo(agent));
    }

    /// 旧布局（runs/<run-id>）的 run 在 journal 里存着旧工作区串；读取路径
    /// 只认存下来的那串，所以旧现场不需要适配器也能读。
    #[test]
    fn an_old_layout_workspace_still_reads_back() {
        let dir = scratch();
        let context = DirectoryContext::new(dir.clone());
        let run_id = Id::new();
        let legacy = format!("runs/{run_id}");
        let attempt = dir.join(&legacy).join("attempts").join(run_id.to_string());
        fs::create_dir_all(&attempt).unwrap();
        fs::write(attempt.join("result.md"), "旧布局的产出").unwrap();

        let bytes = context.read_result(&legacy, run_id).unwrap().unwrap();
        assert_eq!(bytes, "旧布局的产出".as_bytes());

        // 新布局走同一条读路径。
        let current = run_workspace(Id::new(), run_id);
        let attempt = dir.join(&current).join("attempts").join(run_id.to_string());
        fs::create_dir_all(&attempt).unwrap();
        fs::write(attempt.join("result.md"), "新布局的产出").unwrap();
        let bytes = context.read_result(&current, run_id).unwrap().unwrap();
        assert_eq!(bytes, "新布局的产出".as_bytes());
    }
}
