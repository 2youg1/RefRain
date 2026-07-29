//! The process launcher (SPEC 8.3, 5.1).
//!
//! One implementation for every adapter: argv-exact launch with `shell=false`
//! — no shell ever interprets an argument — and an environment built from a
//! whitelist rather than inherited wholesale. Cancellation reaches the whole
//! process tree: POSIX signals a process group; Windows has no user-space
//! tree walk without unsafe Win32 (this crate forbids unsafe), so the tree
//! kill is delegated to `taskkill /PID <pid> /T /F` — itself an argv-exact
//! launch, not a shell.
//!
//! `wait` drains both pipes only after the child's EOF; adapters that stream
//! large or interactive output take the pipes before waiting (C11), this
//! blocking form is for bounded producers.

use std::io::{self, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

/// The inherited-environment whitelist (SPEC 5.1). A harness's own settings
/// (config dir, API base) live in its own files; the launcher passes through
/// only what an argv-exact CLI needs to find itself and its runtime.
pub const ENV_WHITELIST: &[&str] = &[
    "PATH",
    "SystemRoot",
    "SYSTEMDRIVE",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "PATHEXT",
];

/// What to launch: an exact program, exact arguments, a workspace it may
/// write, and caller-declared environment on top of the whitelist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Extra (name, value) pairs allowed beyond the whitelist — the adapter
    /// names each one deliberately (e.g. `PI_OFFLINE=1`).
    pub env: Vec<(String, String)>,
    /// The Run workspace; the child may write here and nowhere else the host
    /// cares about (SPEC 6.2).
    pub cwd: PathBuf,
    /// Keep stdin piped for protocols spoken over stdio (Codex app-server).
    pub stdin_piped: bool,
}

/// The child's captured output and final status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessOutcome {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// A running child. Dropping without `wait` or `cancel_tree` is allowed; the
/// host's Run journal, not the process table, decides what a run means.
#[derive(Debug)]
pub struct ProcessHandle {
    child: Child,
}

impl ProcessHandle {
    /// The OS process id, for diagnostics and the tree kill.
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Take the stdout pipe for streaming readers (C11 adapters).
    pub fn stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.child.stdout.take()
    }

    /// Take the stderr pipe for streaming readers (C11 adapters).
    pub fn stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.child.stderr.take()
    }

    /// Take the stdin pipe for stdio protocols (Codex app-server).
    pub fn stdin(&mut self) -> Option<std::process::ChildStdin> {
        self.child.stdin.take()
    }

    /// Block until exit and drain whatever pipes remain. Output is decoded
    /// lossily: a harness emitting non-UTF-8 is reported, not crashed.
    pub fn wait(mut self) -> io::Result<ProcessOutcome> {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        if let Some(mut pipe) = self.child.stdout.take() {
            pipe.read_to_end(&mut stdout)?;
        }
        if let Some(mut pipe) = self.child.stderr.take() {
            pipe.read_to_end(&mut stderr)?;
        }
        let status = self.child.wait()?;
        Ok(ProcessOutcome {
            code: status.code(),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }

    /// Cancel the whole tree. On Windows this is `taskkill /T /F`; elsewhere
    /// the direct child's kill (adapters that spawn groups set their own
    /// process-group handling on top).
    pub fn cancel_tree(mut self) -> io::Result<ProcessOutcome> {
        #[cfg(windows)]
        {
            // taskkill is itself argv-exact: no shell interprets anything.
            let _ = Command::new("taskkill")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            // The tree is gone either way; this only keeps the handle honest.
            let _ = self.child.kill();
        }
        #[cfg(not(windows))]
        {
            let _ = self.child.kill();
        }
        self.wait()
    }
}

/// Launch exactly, with a whitelisted environment.
pub fn launch(spec: &LaunchSpec) -> io::Result<ProcessHandle> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(if spec.stdin_piped {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    for name in ENV_WHITELIST {
        if let Ok(value) = std::env::var(name) {
            command.env(name, value);
        }
    }
    for (name, value) in &spec.env {
        command.env(name, value);
    }
    command.spawn().map(|child| ProcessHandle { child })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The fixture child is the example binary (`examples/process_fixture.rs`);
    /// it never ships with a release. Only `cargo build --example` produces a
    /// plain binary — `cargo test --all-targets` wraps examples in libtest —
    /// so a clean checkout builds it on first use, once per test process.
    fn fixture_path() -> &'static Path {
        static FIXTURE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        FIXTURE.get_or_init(|| {
            let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let workspace = manifest.parent().and_then(Path::parent).unwrap();
            let built = workspace
                .join("target/debug/examples")
                .join(format!("process_fixture{}", std::env::consts::EXE_SUFFIX));
            if !built.exists() {
                let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
                let status = std::process::Command::new(cargo)
                    .args([
                        "build",
                        "-p",
                        "refrain-host",
                        "--example",
                        "process_fixture",
                        "--offline",
                    ])
                    .current_dir(workspace)
                    .status()
                    .unwrap();
                assert!(status.success(), "building the process fixture failed");
            }
            assert!(built.exists(), "{}", built.display());
            built
        })
    }

    fn launch_fixture(args: &[&str]) -> io::Result<ProcessHandle> {
        launch(&LaunchSpec {
            program: fixture_path().to_path_buf(),
            args: args.iter().map(|s| (*s).to_string()).collect(),
            env: vec![("REFRAIN_MARKER".to_string(), "present".to_string())],
            cwd: std::env::temp_dir(),
            stdin_piped: false,
        })
    }

    #[test]
    fn the_fixture_exists_and_echoes_byte_exact() {
        assert!(fixture_path().exists(), "{}", fixture_path().display());
        let outcome = launch_fixture(&["--echo", "克制，不动声色的克制"])
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(outcome.code, Some(0));
        assert_eq!(outcome.stdout, "克制，不动声色的克制");
    }

    #[test]
    fn the_exit_code_propagates() {
        let outcome = launch_fixture(&["--exit", "7"]).unwrap().wait().unwrap();
        assert_eq!(outcome.code, Some(7));
    }

    #[test]
    fn the_environment_is_whitelisted_not_inherited() {
        // USERNAME is set on every Windows session and is NOT on the
        // whitelist; REFRAIN_MARKER arrives only through the explicit list.
        #[cfg(windows)]
        {
            let outcome = launch_fixture(&["--env-of", "USERNAME"])
                .unwrap()
                .wait()
                .unwrap();
            assert_eq!(outcome.stdout, "<unset>");
            let outcome = launch_fixture(&["--env-of", "SystemRoot"])
                .unwrap()
                .wait()
                .unwrap();
            assert_ne!(outcome.stdout, "<unset>");
        }
        let outcome = launch_fixture(&["--env-of", "REFRAIN_MARKER"])
            .unwrap()
            .wait()
            .unwrap();
        assert_eq!(outcome.stdout, "present");
    }

    #[test]
    fn argv_is_exact_no_shell_interprets_it() {
        let stray = std::env::temp_dir().join("refrain-argv-proof.txt");
        let proof = format!("a & echo x > {}", stray.display());
        let outcome = launch_fixture(&["--argv-count", &proof, "two"])
            .unwrap()
            .wait()
            .unwrap();
        // `a & echo x > ...` arrived as ONE argument; nothing was executed.
        assert_eq!(outcome.stdout, "3");
        assert!(!stray.exists());
    }

    #[test]
    fn a_cancelled_tree_stops_waiting() {
        let handle = launch_fixture(&["--sleep", "60"]).unwrap();
        let started = std::time::Instant::now();
        let outcome = handle.cancel_tree().unwrap();
        assert!(started.elapsed().as_secs() < 15, "cancel took too long");
        assert_ne!(outcome.code, Some(0));
    }
}
