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
use std::sync::{Arc, Mutex, MutexGuard};

#[cfg(unix)]
use std::os::unix::process::CommandExt as _;

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
    child: Arc<Mutex<Child>>,
}

/// A cloneable authority to stop one process tree while its observer retains
/// the handle that drains output and waits for exit.
#[derive(Debug, Clone)]
pub struct ProcessCancel {
    child: Arc<Mutex<Child>>,
}

impl ProcessHandle {
    fn child(&self) -> io::Result<MutexGuard<'_, Child>> {
        self.child
            .lock()
            .map_err(|_| io::Error::other("the process handle lock is poisoned"))
    }

    /// The OS process id, for diagnostics and the tree kill.
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.child().map_or(0, |child| child.id())
    }

    #[must_use]
    pub fn cancel_token(&self) -> ProcessCancel {
        ProcessCancel {
            child: Arc::clone(&self.child),
        }
    }

    /// Take the stdout pipe for streaming readers (C11 adapters).
    pub fn stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.child().ok()?.stdout.take()
    }

    /// Take the stderr pipe for streaming readers (C11 adapters).
    pub fn stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.child().ok()?.stderr.take()
    }

    /// Block until exit and drain whatever pipes remain. Output is decoded
    /// lossily: a harness emitting non-UTF-8 is reported, not crashed.
    pub fn wait(mut self) -> io::Result<ProcessOutcome> {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        if let Some(mut pipe) = self.stdout() {
            pipe.read_to_end(&mut stdout)?;
        }
        if let Some(mut pipe) = self.stderr() {
            pipe.read_to_end(&mut stderr)?;
        }
        let status = self.child()?.wait()?;
        Ok(ProcessOutcome {
            code: status.code(),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }

    /// Block until exit, or kill the child and fail once `timeout` has passed.
    ///
    /// For bounded probes like `--version`, whose whole answer is a line: a
    /// child that has not replied in time is hung (a slow antivirus scan, a
    /// shim waiting on input), and the caller must not wait forever — this
    /// used to freeze the entire window when it ran on the UI thread.
    pub fn wait_timeout(mut self, timeout: std::time::Duration) -> io::Result<ProcessOutcome> {
        let deadline = std::time::Instant::now() + timeout;
        let status = loop {
            if let Some(status) = self.child()?.try_wait()? {
                break status;
            }
            if std::time::Instant::now() >= deadline {
                self.child()?.kill()?;
                // Reap so no zombie is left behind, then report the timeout.
                let _ = self.child()?.wait();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "the process did not answer within {}ms",
                        timeout.as_millis()
                    ),
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        // The child has exited; drain what it already wrote (bounded for a
        // probe) without taking the pipes through `wait`.
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        if let Some(mut pipe) = self.stdout() {
            pipe.read_to_end(&mut stdout)?;
        }
        if let Some(mut pipe) = self.stderr() {
            pipe.read_to_end(&mut stderr)?;
        }
        Ok(ProcessOutcome {
            code: status.code(),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }

    /// Cancel the whole tree and then reap the direct child.
    pub fn cancel_tree(self) -> io::Result<ProcessOutcome> {
        self.cancel_token().cancel_tree()?;
        self.wait()
    }
}

impl ProcessCancel {
    /// Stop the process tree. Failure is returned even after a best-effort
    /// direct-child kill, because callers must not record `Cancelled` without
    /// a confirmed tree-level operation.
    pub fn cancel_tree(&self) -> io::Result<()> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| io::Error::other("the process handle lock is poisoned"))?;
        let pid = child.id();
        #[cfg(windows)]
        {
            let status = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if !matches!(status, Ok(status) if status.success()) {
                let _ = child.kill();
                return Err(io::Error::other(format!(
                    "taskkill did not confirm termination of process tree {pid}"
                )));
            }
        }
        #[cfg(unix)]
        {
            // `spawn` may return before the child has completed the
            // pre-exec `setpgid`. Cancellation is allowed immediately after
            // launch, so retry ESRCH while the direct child is still alive.
            // `nix` calls the kernel without requiring a shell or an external
            // `kill` binary, which minimal desktop environments may omit.
            let group = i32::try_from(pid).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("process id {pid} cannot address a Unix process group"),
                )
            })?;
            let signal_deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
            loop {
                match nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(-group),
                    nix::sys::signal::Signal::SIGTERM,
                ) {
                    Ok(()) => break,
                    Err(nix::errno::Errno::ESRCH) => {
                        if child.try_wait()?.is_some() {
                            return Ok(());
                        }
                        if std::time::Instant::now() < signal_deadline {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                            continue;
                        }
                    }
                    Err(error) => {
                        let _ = child.kill();
                        return Err(io::Error::other(format!(
                            "signal process group {pid}: {error}"
                        )));
                    }
                }
                let _ = child.kill();
                return Err(io::Error::other(format!(
                    "process group {pid} did not appear before cancellation"
                )));
            }
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if child.try_wait()?.is_some() {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("process tree {pid} did not exit after cancellation"),
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

/// Launch exactly, with a whitelisted environment.
pub fn launch(spec: &LaunchSpec) -> io::Result<ProcessHandle> {
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear();
    #[cfg(unix)]
    command.process_group(0);
    for name in ENV_WHITELIST {
        if let Ok(value) = std::env::var(name) {
            command.env(name, value);
        }
    }
    for (name, value) in &spec.env {
        command.env(name, value);
    }
    command.spawn().map(|child| ProcessHandle {
        child: Arc::new(Mutex::new(child)),
    })
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

    #[test]
    fn a_cloned_token_stops_the_tree_while_an_observer_owns_the_handle() {
        let handle = launch_fixture(&["--sleep", "60"]).unwrap();
        let cancel = handle.cancel_token();
        let observer = std::thread::spawn(move || handle.wait());
        let started = std::time::Instant::now();
        cancel.cancel_tree().unwrap();
        let outcome = observer.join().unwrap().unwrap();
        assert!(started.elapsed().as_secs() < 15, "cancel took too long");
        assert_ne!(outcome.code, Some(0));
    }
}
