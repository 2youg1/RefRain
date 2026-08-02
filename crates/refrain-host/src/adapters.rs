//! The HarnessAdapter seam (SPEC 8.3) and the first L1 argv adapter.
//!
//! An adapter returns facts; it never writes a Run (INV-12). `dispatch`
//! launches the producer, `observe` drains its stream into a ProducerOutcome,
//! `cancel` stops the tree. The artifact the producer wrote is validated by
//! the host's collect path, never here — process exit is not completion.
//!
//! Detection follows one rule: probe is version-only and
//! never touches the model — `kimi --version` answers; no probe burns a turn.

use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use refrain_core::context_compiler::SkillStatus;
use refrain_core::{Id, digest::content_hex};
use serde::{Deserialize, Serialize};

use crate::Tier;
use crate::process::{self, LaunchSpec, ProcessHandle, ProcessOutcome};

/// argv on Windows holds about 32k characters; past that the frozen request
/// needs a channel with real input plumbing (Kimi's L2 web surface, C11.4).
const ARGV_PROMPT_LIMIT: usize = 30_000;

/// What one dispatch hands the producer.
#[derive(Debug, Clone)]
pub struct DispatchSpec {
    pub run_id: Id,
    /// The Run workspace; the frozen request.md is already inside.
    pub workspace: PathBuf,
    /// The frozen request, byte for byte (SPEC 8.3b: the same content in the
    /// same order on every channel).
    pub request_md: String,
    /// The connection's extra argv, declared on the Harness Connection.
    pub connection_argv: Vec<String>,
    /// The agent's own extra argv, validated at upsert. It lands after the
    /// connection's: the more specific statement wins a duplicated flag.
    pub agent_argv: Vec<String>,
}

/// A launch that happened. The receipt string is what the Run records.
#[derive(Debug)]
pub struct DispatchReceipt {
    pub receipt: String,
    pub handle: ProcessHandle,
}

/// What the producer's stream added up to. `reply_text` is the artifact
/// candidate; usage is three-stated because print channels do not meter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProducerOutcome {
    pub exit_code: Option<i32>,
    pub reply_text: String,
    pub session_hint: Option<String>,
    pub usage: ProducerUsage,
}

/// SPEC 8.5's four columns, unknown first-class (INV-3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum ProducerUsage {
    Unknown,
    Reported {
        input_other: u64,
        cache_read: u64,
        cache_creation: u64,
        output: u64,
    },
}

/// A detected harness binary: path and version, nothing more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessProbe {
    pub id: String,
    pub program: PathBuf,
    pub version: String,
    pub tier: Tier,
}

/// The seam every adapter implements.
pub trait HarnessAdapter {
    fn tier(&self) -> Tier;
    fn probe(&self) -> Option<HarnessProbe>;
    fn dispatch(&self, spec: &DispatchSpec) -> io::Result<DispatchReceipt>;
    fn observe(&self, receipt: DispatchReceipt) -> io::Result<ProducerOutcome>;
    fn cancel(&self, receipt: DispatchReceipt) -> io::Result<ProducerOutcome>;
}

/// Find an executable on PATH, PATHEXT-aware on Windows. The first match
/// wins, exactly as the OS would resolve it.
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .map(|raw| raw.split(';').map(|ext| ext.to_lowercase()).collect())
        .unwrap_or_else(|_| vec![".exe".to_string()]);
    for dir in std::env::split_paths(&paths) {
        for extension in &extensions {
            let candidate = dir.join(format!("{name}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        let bare = dir.join(name);
        if bare.is_file() {
            return Some(bare);
        }
    }
    None
}

fn is_version_number(value: &str) -> bool {
    let core = value
        .trim_start_matches('v')
        .split_once(['-', '+'])
        .map_or(value.trim_start_matches('v'), |(core, _)| core);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() >= 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validate_version(
    program: &std::path::Path,
    identity: &str,
    outcome: ProcessOutcome,
) -> io::Result<String> {
    if outcome.code != Some(0) {
        return Err(io::Error::other(format!(
            "{} --version exited {:?}: {}",
            program.display(),
            outcome.code,
            outcome.stderr.trim()
        )));
    }
    let version = if outcome.stdout.trim().is_empty() {
        outcome.stderr.trim()
    } else {
        outcome.stdout.trim()
    };
    if version.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} --version returned no identity", program.display()),
        ));
    }
    let name_matches = program
        .file_stem()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|name| name.eq_ignore_ascii_case(identity));
    if !version.to_lowercase().contains(identity) && !(name_matches && is_version_number(version)) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} did not identify itself as {identity}: {version}",
                program.display()
            ),
        ));
    }
    Ok(version.to_string())
}

fn version_of(program: &std::path::Path, identity: &str) -> io::Result<String> {
    let outcome = process::launch(&LaunchSpec {
        program: program.to_path_buf(),
        args: vec!["--version".to_string()],
        env: vec![],
        cwd: std::env::temp_dir(),
    })?
    // A version probe is one line of output; ten seconds is already generous.
    .wait_timeout(std::time::Duration::from_secs(10))?;
    validate_version(program, identity, outcome)
}

fn allowed_env(names: &[String]) -> Vec<(String, String)> {
    names
        .iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| (name.clone(), value)))
        .collect()
}

// ── The protocol installation surface (协议装载) ────────────────────────────
//
// Installing the protocol means registering it with the harness: each CLI
// auto-loads its skills directory, so the file's presence is the
// registration. Every adapter knows its own directory convention and
// frontmatter shape; the protocol text itself comes only from
// `refrain_core::agent_protocol::skill_doc()` — never a hand copy.
//
// This is the application's first write outside the Root. It therefore
// happens only inside an explicit command, never implicitly on dispatch.

/// Write the protocol file for one adapter, creating its skill directory.
/// Returns the path and the BLAKE3 of the bytes written — the digest the
/// Config records as provenance.
fn install_skill_at(path: &Path, bytes: &[u8]) -> io::Result<(PathBuf, String)> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)?;
    Ok((path.to_path_buf(), content_hex(bytes)))
}

/// The state of the installed copy, read from the file itself: the file is
/// the fact, the Config digest is only the record of what we wrote. A file
/// that hashes to the current generated protocol is `Current` whoever put it
/// there; a file that differs is `Stale`, and no file is `None`.
fn skill_status_at(path: &Path, expected: &[u8]) -> SkillStatus {
    match std::fs::read(path) {
        Ok(bytes) if content_hex(&bytes) == content_hex(expected) => SkillStatus::Current,
        Ok(_) => SkillStatus::Stale,
        Err(_) => SkillStatus::None,
    }
}

/// The protocol file as an adapter's skills directory expects it: its own
/// frontmatter, then the generated protocol, byte for byte.
fn skill_bytes(frontmatter: &str) -> Vec<u8> {
    format!(
        "{frontmatter}\n{}",
        refrain_core::agent_protocol::skill_doc()
    )
    .into_bytes()
}

// ── Extra argv (模型/思考强度就是 argv，不枚举) ─────────────────────────────
//
// The connection and the agent may each declare extra argv. Validation
// happens at upsert, so a refusal reaches the author while he is editing —
// never at launch, where it would surface as a run that died for no visible
// reason. The merge order is fixed here: connection first, agent after, so
// the more specific statement wins a duplicated flag.

/// Why one argv item was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArgvRefusal {
    /// `--dangerously-*` turns the harness loose on the author's machine;
    /// RefRain's whole shape is that an agent proposes and a human decides.
    #[error("argv item {item:?} starts with --dangerously-: flags that bypass review are refused")]
    DangerousFlag { item: String },
    /// A control character (newline, NUL) is how one argv item becomes two,
    /// or breaks the exec call outright.
    #[error("argv item {item:?} carries a control character")]
    ControlCharacter { item: String },
    #[error("an empty argv item carries no meaning")]
    Empty,
}

/// Check one agent's extra argv against the denylist. Called at upsert time.
pub fn check_agent_argv(argv: &[String]) -> Result<(), ArgvRefusal> {
    for item in argv {
        if item.is_empty() {
            return Err(ArgvRefusal::Empty);
        }
        if item.starts_with("--dangerously-") {
            return Err(ArgvRefusal::DangerousFlag { item: item.clone() });
        }
        if item.chars().any(char::is_control) {
            return Err(ArgvRefusal::ControlCharacter { item: item.clone() });
        }
    }
    Ok(())
}

/// One launch's full argv: the adapter's own flags, then the connection's,
/// then the agent's. Both print adapters share this shape.
fn merged_argv(base: &[String], spec: &DispatchSpec) -> Vec<String> {
    let mut args = base.to_vec();
    args.extend(spec.connection_argv.iter().cloned());
    args.extend(spec.agent_argv.iter().cloned());
    args
}

/// Kimi Code print mode (L1): `kimi -p <prompt> --output-format stream-json`.
/// The stream carries assistant content and a session resume hint; usage is
/// unknown on this channel and says so (r1-kc: print has no usage frames).
pub struct KimiPrint {
    program: PathBuf,
    version: String,
    env: Vec<(String, String)>,
}

impl KimiPrint {
    /// Detect the CLI and read its version. Absent is None, never an error.
    pub fn detect() -> Option<Self> {
        let program = find_on_path("kimi")?;
        Self::at(program)
    }

    /// The connection the author declared in Config: probe that exact
    /// executable, never a PATH lookup.
    pub fn at(program: PathBuf) -> Option<Self> {
        Self::at_with_env(program, &[])
    }

    pub fn at_with_env(program: PathBuf, env_allow: &[String]) -> Option<Self> {
        let version = version_of(&program, "kimi").ok()?;
        let program = program.canonicalize().ok()?;
        Some(Self {
            program,
            version,
            env: allowed_env(env_allow),
        })
    }

    #[must_use]
    pub fn program(&self) -> &PathBuf {
        &self.program
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Where Kimi Code auto-loads skills: `~/.kimi-code/skills/refrain/SKILL.md`.
    pub fn skill_path(home: &Path) -> PathBuf {
        home.join(".kimi-code")
            .join("skills")
            .join("refrain")
            .join("SKILL.md")
    }

    /// The protocol file bytes for this harness: Kimi's frontmatter, then the
    /// generated protocol. The text is `skill_doc()`, never a hand copy.
    pub fn skill_bytes() -> Vec<u8> {
        skill_bytes(
            "---\nname: refrain\ndescription: RefRain 写作台的代理协议：提案、评审与合并的规矩。为 RefRain 工作时先读本文件。\n---",
        )
    }

    /// Install the protocol into this harness's skill directory. Explicit
    /// user action only — the application's one write outside the Root.
    pub fn install_skill(home: &Path) -> io::Result<(PathBuf, String)> {
        install_skill_at(&Self::skill_path(home), &Self::skill_bytes())
    }

    /// Whether the installed copy still says what this build would say.
    pub fn skill_status(home: &Path) -> SkillStatus {
        skill_status_at(&Self::skill_path(home), &Self::skill_bytes())
    }
}

/// One parsed stream-json frame: assistant content or a meta hint.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Frame {
    Assistant(String),
    SessionHint(String),
    Other,
}

fn parse_frame(line: &str) -> Frame {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return Frame::Other;
    };
    match value.get("role").and_then(serde_json::Value::as_str) {
        Some("assistant") => value
            .get("content")
            .and_then(serde_json::Value::as_str)
            .map_or(Frame::Other, |text| Frame::Assistant(text.to_string())),
        Some("meta") => {
            if value.get("type").and_then(serde_json::Value::as_str) == Some("session.resume_hint")
            {
                value
                    .get("session_id")
                    .and_then(serde_json::Value::as_str)
                    .map_or(Frame::Other, |id| Frame::SessionHint(id.to_string()))
            } else {
                Frame::Other
            }
        }
        _ => Frame::Other,
    }
}

fn drain(stream: impl Read, reply: &mut String, session: &mut Option<String>) -> io::Result<()> {
    for line in BufReader::new(stream).lines() {
        match parse_frame(&line?) {
            Frame::Assistant(text) => reply.push_str(&text),
            Frame::SessionHint(id) => *session = Some(id),
            Frame::Other => {}
        }
    }
    Ok(())
}

impl HarnessAdapter for KimiPrint {
    fn tier(&self) -> Tier {
        Tier::L1
    }

    fn probe(&self) -> Option<HarnessProbe> {
        Some(HarnessProbe {
            id: "kimi-print".to_string(),
            program: self.program.clone(),
            version: self.version.clone(),
            tier: Tier::L1,
        })
    }

    fn dispatch(&self, spec: &DispatchSpec) -> io::Result<DispatchReceipt> {
        if spec.request_md.len() > ARGV_PROMPT_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "the frozen request is {} bytes; argv holds {} — this dispatch needs the L2 channel",
                    spec.request_md.len(),
                    ARGV_PROMPT_LIMIT
                ),
            ));
        }
        let handle = process::launch(&LaunchSpec {
            program: self.program.clone(),
            args: merged_argv(
                &[
                    "-p".to_string(),
                    spec.request_md.clone(),
                    "--output-format".to_string(),
                    "stream-json".to_string(),
                ],
                spec,
            ),
            env: self.env.clone(),
            cwd: spec.workspace.clone(),
        })?;
        let receipt = format!("kimi-l1:pid={}", handle.pid());
        Ok(DispatchReceipt { receipt, handle })
    }

    fn observe(&self, receipt: DispatchReceipt) -> io::Result<ProducerOutcome> {
        let DispatchReceipt { mut handle, .. } = receipt;
        let mut reply = String::new();
        let mut session = None;
        if let Some(stdout) = handle.stdout() {
            drain(stdout, &mut reply, &mut session)?;
        }
        let ProcessOutcome { code, .. } = handle.wait()?;
        Ok(ProducerOutcome {
            exit_code: code,
            reply_text: reply,
            session_hint: session,
            usage: ProducerUsage::Unknown,
        })
    }

    fn cancel(&self, receipt: DispatchReceipt) -> io::Result<ProducerOutcome> {
        let DispatchReceipt { mut handle, .. } = receipt;
        // Take the pipe first, then stop the tree: EOF arrives with the
        // producer dead, and whatever it already said drains freely (§8.2-4 —
        // a cancelled producer keeps its partial words).
        let stdout = handle.stdout();
        let ProcessOutcome { code, .. } = handle.cancel_tree()?;
        let mut reply = String::new();
        let mut session = None;
        if let Some(stream) = stdout {
            drain(stream, &mut reply, &mut session)?;
        }
        Ok(ProducerOutcome {
            exit_code: code,
            reply_text: reply,
            session_hint: session,
            usage: ProducerUsage::Unknown,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Contract tests run live only when explicitly requested and the CLI is
    /// on PATH. A developer's installed but logged-out CLI must not make the
    /// deterministic workspace suite depend on network or account state.
    fn kimi() -> Option<KimiPrint> {
        if std::env::var("REFRAIN_RUN_LIVE_HARNESS").as_deref() != Ok("1") {
            eprintln!("skipped: set REFRAIN_RUN_LIVE_HARNESS=1 for live Kimi contracts");
            return None;
        }
        let env_allow = std::env::var("REFRAIN_HARNESS_ENV_ALLOW")
            .ok()
            .map(|value| {
                value
                    .split(',')
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        find_on_path("kimi")
            .and_then(|program| KimiPrint::at_with_env(program, &env_allow))
            .or_else(|| {
                eprintln!("skipped: kimi CLI not on PATH");
                None
            })
    }

    fn spec(text: &str) -> DispatchSpec {
        DispatchSpec {
            run_id: Id::new(),
            workspace: std::env::temp_dir(),
            request_md: text.to_string(),
            connection_argv: Vec::new(),
            agent_argv: Vec::new(),
        }
    }

    #[test]
    fn connection_environment_is_explicitly_selected() {
        let names = vec![
            "PATH".to_string(),
            "REFRAIN_TEST_ENV_THAT_MUST_NOT_EXIST".to_string(),
        ];
        let selected = allowed_env(&names);
        assert!(selected.iter().any(|(name, _)| name == "PATH"));
        assert!(
            selected
                .iter()
                .all(|(name, _)| name != "REFRAIN_TEST_ENV_THAT_MUST_NOT_EXIST")
        );
    }

    #[test]
    fn version_checks_exit_output_and_adapter_identity() {
        let program = std::path::Path::new("/fixture/kimi");
        assert_eq!(
            validate_version(
                program,
                "kimi",
                ProcessOutcome {
                    code: Some(0),
                    stdout: "kimi, version 1.2.3\n".to_string(),
                    stderr: String::new(),
                },
            )
            .unwrap(),
            "kimi, version 1.2.3"
        );
        assert_eq!(
            validate_version(
                program,
                "kimi",
                ProcessOutcome {
                    code: Some(0),
                    stdout: "0.30.0\n".to_string(),
                    stderr: String::new(),
                },
            )
            .unwrap(),
            "0.30.0"
        );
        assert!(
            validate_version(
                std::path::Path::new("/fixture/not-kimi"),
                "kimi",
                ProcessOutcome {
                    code: Some(0),
                    stdout: "0.30.0".to_string(),
                    stderr: String::new(),
                },
            )
            .is_err()
        );
        for outcome in [
            ProcessOutcome {
                code: Some(7),
                stdout: "kimi 1.2.3".to_string(),
                stderr: "refused".to_string(),
            },
            ProcessOutcome {
                code: Some(0),
                stdout: String::new(),
                stderr: String::new(),
            },
            ProcessOutcome {
                code: Some(0),
                stdout: "not-the-requested-program 1.2.3".to_string(),
                stderr: String::new(),
            },
        ] {
            assert!(validate_version(program, "kimi", outcome).is_err());
        }
    }

    #[test]
    fn frames_parse_assistant_and_session_hint() {
        assert_eq!(
            parse_frame(r#"{"role":"assistant","content":"OK"}"#),
            Frame::Assistant("OK".to_string())
        );
        assert_eq!(
            parse_frame(
                r#"{"role":"meta","type":"session.resume_hint","session_id":"s1","content":"…"}"#
            ),
            Frame::SessionHint("s1".to_string())
        );
        assert_eq!(parse_frame("not json"), Frame::Other);
        assert_eq!(
            parse_frame(r#"{"role":"user","content":"x"}"#),
            Frame::Other
        );
    }

    #[test]
    fn contract_probe_reports_path_and_version() {
        let Some(kimi) = kimi() else { return };
        let probe = kimi.probe().unwrap();
        assert!(probe.program.is_file());
        assert!(!probe.version.is_empty());
    }

    #[test]
    fn contract_dispatch_and_observe_a_real_turn() {
        let Some(kimi) = kimi() else { return };
        let receipt = kimi
            .dispatch(&spec("Reply with exactly: REFRAIN-CONTRACT-1"))
            .unwrap();
        assert!(receipt.receipt.starts_with("kimi-l1:pid="));
        let outcome = kimi.observe(receipt).unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        assert!(
            outcome.reply_text.contains("REFRAIN-CONTRACT-1"),
            "{}",
            outcome.reply_text
        );
        assert!(outcome.session_hint.is_some());
        assert_eq!(outcome.usage, ProducerUsage::Unknown);
    }

    #[test]
    fn contract_argv_metacharacters_are_not_interpreted() {
        let Some(kimi) = kimi() else { return };
        // The whole prompt is one argv item; `&` and `>` must not execute.
        let receipt = kimi
            .dispatch(&spec("Reply with exactly: A & B > C"))
            .unwrap();
        let outcome = kimi.observe(receipt).unwrap();
        assert_eq!(outcome.exit_code, Some(0));
        assert!(
            outcome.reply_text.contains("A & B > C"),
            "{}",
            outcome.reply_text
        );
    }

    #[test]
    fn contract_an_oversized_prompt_is_refused_before_launch() {
        let Some(kimi) = kimi() else { return };
        let huge = "字".repeat(ARGV_PROMPT_LIMIT + 1);
        let error = kimi.dispatch(&spec(&huge)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn contract_cancel_stops_the_tree() {
        let Some(kimi) = kimi() else { return };
        let receipt = kimi
            .dispatch(&spec(
                "Count from 1 to 500, one number per sentence, slowly.",
            ))
            .unwrap();
        let started = std::time::Instant::now();
        let outcome = kimi.cancel(receipt).unwrap();
        assert!(started.elapsed().as_secs() < 30, "cancel took too long");
        assert_ne!(outcome.exit_code, Some(0));
    }

    #[test]
    fn contract_a_bad_flag_surfaces_an_error_not_a_hang() {
        let Some(kimi) = kimi() else { return };
        let handle = process::launch(&LaunchSpec {
            program: kimi.program().clone(),
            args: vec!["--definitely-not-a-flag".to_string()],
            env: vec![],
            cwd: std::env::temp_dir(),
        })
        .unwrap();
        let outcome = handle.wait().unwrap();
        assert_ne!(outcome.code, Some(0));
    }

    #[test]
    fn contract_the_producer_follows_the_reply_contract() {
        let Some(kimi) = kimi() else { return };
        let request = "# Request\n\nReply with exactly this element and nothing else:\n\n# Reply format\n\n<agent-result version=\"2\">\n  <memo>contract-ok</memo>\n</agent-result>\n";
        let receipt = kimi.dispatch(&spec(request)).unwrap();
        let outcome = kimi.observe(receipt).unwrap();
        assert!(
            outcome.reply_text.contains("<agent-result"),
            "{}",
            outcome.reply_text
        );
        let artifact = refrain_core::agent_protocol::parse(
            outcome.reply_text.as_bytes(),
            &refrain_core::agent_protocol::ArtifactContract {
                scopes: &[],
                basis: &[],
            },
        );
        assert!(artifact.is_ok(), "{:?}", artifact.err());
    }
}

// ── Claude Code print mode (L1) ─────────────────────────────────────────────
//
// `claude --bare -p <prompt> --output-format stream-json --verbose`
// (r1-cc, v2.1.220): frames are `system/init` → `user`/`assistant` → one
// closing `result`. Usage comes from `modelUsage` — `result.usage` excludes
// subagents, and `total_cost_usd` is a client-side estimate we never read
// (INV-3). Cancellation is SIGTERM to the tree (documented exit 143).

/// Claude Code print mode (L1). L2 needs the live contract tests against a
/// logged-in binary; the frame parsing is fixture-proven here either way.
pub struct ClaudePrint {
    program: PathBuf,
    version: String,
    env: Vec<(String, String)>,
}

impl ClaudePrint {
    pub fn detect() -> Option<Self> {
        let program = find_on_path("claude")?;
        Self::at(program)
    }

    pub fn at(program: PathBuf) -> Option<Self> {
        Self::at_with_env(program, &[])
    }

    pub fn at_with_env(program: PathBuf, env_allow: &[String]) -> Option<Self> {
        let version = version_of(&program, "claude").ok()?;
        let program = program.canonicalize().ok()?;
        Some(Self {
            program,
            version,
            env: allowed_env(env_allow),
        })
    }

    #[must_use]
    pub fn program(&self) -> &PathBuf {
        &self.program
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    /// Where Claude Code auto-loads skills: `~/.claude/skills/refrain/SKILL.md`.
    pub fn skill_path(home: &Path) -> PathBuf {
        home.join(".claude")
            .join("skills")
            .join("refrain")
            .join("SKILL.md")
    }

    /// The protocol file bytes for this harness: Claude's frontmatter, then
    /// the generated protocol. The text is `skill_doc()`, never a hand copy.
    pub fn skill_bytes() -> Vec<u8> {
        skill_bytes(
            "---\nname: refrain\ndescription: RefRain 写作台的代理协议：提案、评审与合并的规矩。为 RefRain 工作时先读本文件。\n---",
        )
    }

    /// Install the protocol into this harness's skill directory. Explicit
    /// user action only — the application's one write outside the Root.
    pub fn install_skill(home: &Path) -> io::Result<(PathBuf, String)> {
        install_skill_at(&Self::skill_path(home), &Self::skill_bytes())
    }

    /// Whether the installed copy still says what this build would say.
    pub fn skill_status(home: &Path) -> SkillStatus {
        skill_status_at(&Self::skill_path(home), &Self::skill_bytes())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ClaudeFrame {
    Assistant(String),
    Result { reply: String, usage: ProducerUsage },
    Refused(String),
    Other,
}

fn claude_frame(line: &str) -> ClaudeFrame {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return ClaudeFrame::Other;
    };
    match value.get("type").and_then(serde_json::Value::as_str) {
        Some("assistant") => {
            let texts = value
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(serde_json::Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter(|part| {
                            part.get("type").and_then(serde_json::Value::as_str) == Some("text")
                        })
                        .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            if texts.is_empty() {
                ClaudeFrame::Other
            } else {
                ClaudeFrame::Assistant(texts)
            }
        }
        Some("result") => {
            let subtype = value
                .get("subtype")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if subtype != "success" {
                let errors = value
                    .get("errors")
                    .and_then(serde_json::Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(serde_json::Value::as_str)
                            .collect::<Vec<_>>()
                            .join("; ")
                    })
                    .unwrap_or_default();
                return ClaudeFrame::Refused(format!("claude:{subtype}: {errors}"));
            }
            let reply = value
                .get("result")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string();
            // modelUsage is per-model; a dispatch may span models, so the
            // honest total is the column sum. total_cost_usd is never read.
            let usage = value
                .get("modelUsage")
                .and_then(serde_json::Value::as_object)
                .map(|per_model| {
                    per_model
                        .values()
                        .fold((0_u64, 0_u64, 0_u64, 0_u64), |acc, model| {
                            (
                                acc.0
                                    + model
                                        .get("inputTokens")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or(0),
                                acc.1
                                    + model
                                        .get("cacheReadInputTokens")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or(0),
                                acc.2
                                    + model
                                        .get("cacheCreationInputTokens")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or(0),
                                acc.3
                                    + model
                                        .get("outputTokens")
                                        .and_then(serde_json::Value::as_u64)
                                        .unwrap_or(0),
                            )
                        })
                });
            let usage = match usage {
                Some((input_other, cache_read, cache_creation, output)) => {
                    ProducerUsage::Reported {
                        input_other,
                        cache_read,
                        cache_creation,
                        output,
                    }
                }
                None => ProducerUsage::Unknown,
            };
            ClaudeFrame::Result { reply, usage }
        }
        _ => ClaudeFrame::Other,
    }
}

impl HarnessAdapter for ClaudePrint {
    fn tier(&self) -> Tier {
        Tier::L1
    }

    fn probe(&self) -> Option<HarnessProbe> {
        Some(HarnessProbe {
            id: "claude-print".to_string(),
            program: self.program.clone(),
            version: self.version.clone(),
            tier: Tier::L1,
        })
    }

    fn dispatch(&self, spec: &DispatchSpec) -> io::Result<DispatchReceipt> {
        if spec.request_md.len() > ARGV_PROMPT_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "the frozen request is {} bytes; argv holds {} — this dispatch needs the L2 channel",
                    spec.request_md.len(),
                    ARGV_PROMPT_LIMIT
                ),
            ));
        }
        let handle = process::launch(&LaunchSpec {
            program: self.program.clone(),
            args: merged_argv(
                &[
                    "--bare".to_string(),
                    "-p".to_string(),
                    spec.request_md.clone(),
                    "--output-format".to_string(),
                    "stream-json".to_string(),
                    "--verbose".to_string(),
                ],
                spec,
            ),
            env: self.env.clone(),
            cwd: spec.workspace.clone(),
        })?;
        let receipt = format!("claude-l1:pid={}", handle.pid());
        Ok(DispatchReceipt { receipt, handle })
    }

    fn observe(&self, receipt: DispatchReceipt) -> io::Result<ProducerOutcome> {
        let DispatchReceipt { mut handle, .. } = receipt;
        let mut reply = String::new();
        let mut final_result: Option<(String, ProducerUsage)> = None;
        if let Some(stdout) = handle.stdout() {
            for line in BufReader::new(stdout).lines() {
                match claude_frame(&line?) {
                    ClaudeFrame::Assistant(text) => reply.push_str(&text),
                    ClaudeFrame::Result { reply: text, usage } => {
                        final_result = Some((text, usage));
                    }
                    ClaudeFrame::Refused(reason) => {
                        return Err(io::Error::new(io::ErrorKind::InvalidData, reason));
                    }
                    ClaudeFrame::Other => {}
                }
            }
        }
        let ProcessOutcome { code, .. } = handle.wait()?;
        let (reply_text, usage) = match final_result {
            // The closing result carries the whole reply; assistant frames
            // are the same words streamed (r1-cc), so the result wins.
            Some((text, usage)) => (text, usage),
            None => (reply, ProducerUsage::Unknown),
        };
        Ok(ProducerOutcome {
            exit_code: code,
            reply_text,
            session_hint: None,
            usage,
        })
    }

    fn cancel(&self, receipt: DispatchReceipt) -> io::Result<ProducerOutcome> {
        let DispatchReceipt { mut handle, .. } = receipt;
        let stdout = handle.stdout();
        let ProcessOutcome { code, .. } = handle.cancel_tree()?;
        let mut reply = String::new();
        if let Some(stream) = stdout {
            for line in BufReader::new(stream).lines() {
                if let ClaudeFrame::Assistant(text) = claude_frame(&line?) {
                    reply.push_str(&text);
                }
            }
        }
        Ok(ProducerOutcome {
            exit_code: code,
            reply_text: reply,
            session_hint: None,
            usage: ProducerUsage::Unknown,
        })
    }
}

#[cfg(test)]
mod claude_tests {
    use super::*;

    #[test]
    fn the_result_frame_wins_and_usage_sums_models() {
        let frame = claude_frame(
            r#"{"type":"result","subtype":"success","uuid":"u","session_id":"s","is_error":false,"duration_ms":100,"duration_api_ms":90,"num_turns":1,"result":"<agent-result version=\"2\">ok</agent-result>","stop_reason":"end_turn","total_cost_usd":0.01,"usage":{},"modelUsage":{"claude-a":{"inputTokens":100,"outputTokens":10,"cacheReadInputTokens":40,"cacheCreationInputTokens":20},"claude-b":{"inputTokens":7,"outputTokens":3,"cacheReadInputTokens":0,"cacheCreationInputTokens":0}}}"#,
        );
        let ClaudeFrame::Result { reply, usage } = frame else {
            panic!("expected a result frame");
        };
        assert!(reply.contains("<agent-result"));
        assert_eq!(
            usage,
            ProducerUsage::Reported {
                input_other: 107,
                cache_read: 40,
                cache_creation: 20,
                output: 13,
            }
        );
    }

    #[test]
    fn assistant_texts_accumulate_and_the_cost_field_is_ignored() {
        let frame = claude_frame(
            r#"{"type":"assistant","uuid":"u","session_id":"s","message":{"id":"m","content":[{"type":"text","text":"克制。"},{"type":"thinking","thinking":"…"}],"model":"x","stop_reason":null},"parent_tool_use_id":null}"#,
        );
        assert_eq!(frame, ClaudeFrame::Assistant("克制。".to_string()));
    }

    #[test]
    fn an_error_result_is_a_typed_refusal() {
        let frame = claude_frame(
            r#"{"type":"result","subtype":"error_max_turns","is_error":true,"errors":["hit the turn cap"]}"#,
        );
        assert_eq!(
            frame,
            ClaudeFrame::Refused("claude:error_max_turns: hit the turn cap".to_string())
        );
    }

    #[test]
    fn contract_probe_reports_path_and_version() {
        let Some(claude) = ClaudePrint::detect() else {
            eprintln!("skipped: claude CLI not on PATH");
            return;
        };
        let probe = claude.probe().unwrap();
        assert!(probe.program.is_file());
        assert!(!probe.version.is_empty());
    }

    #[test]
    fn contract_dispatch_and_observe_a_real_turn() {
        let Some(claude) = ClaudePrint::detect() else {
            eprintln!("skipped: claude CLI not on PATH");
            return;
        };
        let receipt = claude
            .dispatch(&DispatchSpec {
                run_id: Id::new(),
                workspace: std::env::temp_dir(),
                request_md: "Reply with exactly: REFRAIN-CONTRACT-1".to_string(),
                connection_argv: Vec::new(),
                agent_argv: Vec::new(),
            })
            .unwrap();
        let outcome = claude.observe(receipt).unwrap();
        assert!(
            outcome.reply_text.contains("REFRAIN-CONTRACT-1"),
            "{}",
            outcome.reply_text
        );
    }
}

#[cfg(test)]
mod skill_tests {
    use super::*;

    fn home() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("refrain-skill-{}", Id::new()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 安装即注册：写进 harness 的 skill 目录，内容唯一来源是 skill_doc()。
    /// 两家 adapter 各自走一遍——目录约定与 frontmatter 是各家的知识，
    /// 只测一家等于把另一家当成猜测。
    #[test]
    fn install_writes_the_generated_protocol_under_each_convention() {
        for (install, relative) in [
            (
                KimiPrint::install_skill as fn(&Path) -> io::Result<(PathBuf, String)>,
                ".kimi-code/skills/refrain/SKILL.md",
            ),
            (
                ClaudePrint::install_skill,
                ".claude/skills/refrain/SKILL.md",
            ),
        ] {
            let home = home();
            let (path, digest) = install(&home).unwrap();
            assert_eq!(path, home.join(relative));
            let bytes = std::fs::read(&path).unwrap();
            // digest 记的就是落盘字节的 BLAKE3——Config 里的 provenance。
            assert_eq!(digest, content_hex(&bytes));
            let text = String::from_utf8(bytes).unwrap();
            assert!(text.starts_with("---\nname: refrain\n"), "{text}");
            assert!(
                text.contains(&refrain_core::agent_protocol::skill_doc()),
                "安装内容必须逐字来自 skill_doc()，不许手抄"
            );
        }
    }

    /// 状态三态：没装是 None，装上且未漂是 Current，字节变了是 Stale。
    /// Stale 必须能被一次真实改动触发——只断言 Current 的门禁，永远不知道
    /// Stale 还活着没有。
    #[test]
    fn status_reads_the_file_none_current_stale() {
        let home = home();
        assert_eq!(KimiPrint::skill_status(&home), SkillStatus::None);

        let (_path, _digest) = KimiPrint::install_skill(&home).unwrap();
        assert_eq!(KimiPrint::skill_status(&home), SkillStatus::Current);

        std::fs::write(
            KimiPrint::skill_path(&home),
            "an older protocol, or bytes someone else changed",
        )
        .unwrap();
        assert_eq!(KimiPrint::skill_status(&home), SkillStatus::Stale);
    }

    /// 合并规则：连接的 argv 在前，agent 的在后——重复旗标时更具体的
    /// 那句说了算。顺序是这条测试要钉住的全部。
    #[test]
    fn argv_merges_connection_first_then_agent() {
        let spec = DispatchSpec {
            run_id: Id::new(),
            workspace: std::env::temp_dir(),
            request_md: "prompt".to_string(),
            connection_argv: vec!["--model".to_string(), "a".to_string()],
            agent_argv: vec!["--model".to_string(), "b".to_string()],
        };
        let args = merged_argv(&["-p".to_string(), "prompt".to_string()], &spec);
        assert_eq!(
            args,
            vec!["-p", "prompt", "--model", "a", "--model", "b"],
            "connection argv 必须先于 agent argv"
        );
    }

    /// 危险旗标与控制字符在登记时被拒，不是在启动时炸成一团看不懂的失败。
    #[test]
    fn the_denylist_refuses_dangerous_flags_and_control_characters() {
        assert!(matches!(
            check_agent_argv(&["--dangerously-skip-permissions".to_string()]),
            Err(ArgvRefusal::DangerousFlag { .. })
        ));
        assert!(matches!(
            check_agent_argv(&["--model\n--output-format".to_string()]),
            Err(ArgvRefusal::ControlCharacter { .. })
        ));
        assert!(matches!(
            check_agent_argv(&[String::new()]),
            Err(ArgvRefusal::Empty)
        ));
        assert!(
            check_agent_argv(&["--model".to_string(), "k2".to_string()]).is_ok(),
            "普通旗标不该被误伤"
        );
    }
}
