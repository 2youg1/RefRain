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
use std::process::{Child, Command, ExitStatus, Stdio};
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

/// How often `wait` checks whether the child has exited. The lock is taken and
/// released once per tick, so a cancel arriving mid-wait waits at most this long
/// — the same cadence `wait_timeout` already polls at.
const WAIT_POLL: std::time::Duration = std::time::Duration::from_millis(10);

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
    ///
    /// Both pipes drain concurrently, one reader thread each. Draining them in
    /// sequence deadlocks: a child that fills stderr before it speaks on stdout
    /// blocks on the full stderr pipe, while this side blocks on a stdout EOF
    /// that can never arrive. A harness logging progress to stderr while it
    /// computes has exactly that shape, and the Run then stalls in Dispatched
    /// with nothing left that can end it.
    pub fn wait(mut self) -> io::Result<ProcessOutcome> {
        let stdout = drain(self.stdout());
        let stderr = drain(self.stderr());
        let status = self.wait_without_holding_lock()?;
        Ok(ProcessOutcome {
            code: status.code(),
            stdout: collect(stdout)?,
            stderr: collect(stderr)?,
        })
    }

    /// Wait for exit without pinning the mutex for the child's whole lifetime.
    ///
    /// `Child::wait` blocks until the process exits. Called through the guard
    /// (`self.child()?.wait()`), the lock is therefore held for exactly as long
    /// as the child keeps running — and `cancel_tree` needs that same lock, so
    /// a cancel arriving during the wait blocks forever. Its five-second
    /// timeout and its retry both sit *after* the lock, so neither ever runs.
    ///
    /// The shape is reachable in production, not theoretical: an adapter drains
    /// stdout to EOF and then waits (`adapters.rs`), while a harness that has
    /// finished printing but is still cleaning up keeps the process alive. A
    /// reproduction with this exact lock order (`exec 1>&-; exec 2>&-; sleep 60`)
    /// confirmed the cancel never returns.
    ///
    /// `try_wait` polls instead: the lock is taken and released once per tick,
    /// so `cancel_tree` gets its turn between polls and its kill actually lands.
    fn wait_without_holding_lock(&self) -> io::Result<ExitStatus> {
        loop {
            if let Some(status) = self.child()?.try_wait()? {
                return Ok(status);
            }
            std::thread::sleep(WAIT_POLL);
        }
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

/// Start one reader thread for a pipe, so both pipes drain concurrently.
///
/// Returns `None` when the pipe was already taken by a streaming adapter, which
/// then owns that side's draining.
fn drain<R: Read + Send + 'static>(
    pipe: Option<R>,
) -> Option<std::thread::JoinHandle<io::Result<Vec<u8>>>> {
    pipe.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.read_to_end(&mut bytes)?;
            Ok(bytes)
        })
    })
}

/// Join one reader thread and decode its bytes.
///
/// A reader that panicked is an I/O failure, not a silent empty pipe: reporting
/// the output as empty would let a caller record a producer's result from
/// output that was never read.
fn collect(reader: Option<std::thread::JoinHandle<io::Result<Vec<u8>>>>) -> io::Result<String> {
    let Some(reader) = reader else {
        return Ok(String::new());
    };
    let bytes = reader
        .join()
        .map_err(|_| io::Error::other("the pipe reader thread panicked"))??;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
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

    /// Cancel must land on a child that has stopped talking but is still alive.
    ///
    /// The test above cannot catch this: its child keeps the pipes open, so the
    /// observer blocks inside `read_to_end` and never holds the mutex, and the
    /// cancel finds the lock free. The dangerous order only appears after EOF —
    /// the observer moves on to the wait, and a wait that holds the lock for the
    /// child's remaining lifetime makes `cancel_tree` unreachable. `cancel_tree`
    /// has a five-second timeout and a retry, but both sit after the lock, so
    /// neither runs; the cancel simply never returns.
    ///
    /// This is the shape a real harness has when it has printed its last line
    /// and is still cleaning up, and it is reachable from production: an adapter
    /// drains stdout to EOF and then waits, on a background thread.
    #[test]
    fn cancel_lands_after_the_child_closed_its_pipes_but_kept_running() {
        let handle = launch_fixture(&["--close-then-sleep", "60"]).unwrap();
        let cancel = handle.cancel_token();
        // Drain to EOF and enter the wait — exactly what `observe` does.
        let observer = std::thread::spawn(move || handle.wait());
        std::thread::sleep(std::time::Duration::from_millis(400));

        let (done, waiting) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(cancel.cancel_tree());
        });
        let landed = waiting.recv_timeout(std::time::Duration::from_secs(10));
        assert!(
            landed.is_ok(),
            "cancel_tree never returned: the wait is holding the lock for the child's lifetime",
        );
        let outcome = observer.join().unwrap().unwrap();
        assert_ne!(outcome.code, Some(0));
    }

    /// Both pipes must drain while the child runs, not one after the other.
    ///
    /// A child that fills stderr before it speaks on stdout deadlocks a parent
    /// that reads stdout to EOF first: the child blocks writing to a full
    /// stderr pipe and never reaches the stdout write, and the parent blocks
    /// waiting for a stdout EOF that can never arrive. Neither side can move.
    ///
    /// A harness that logs progress to stderr while computing its answer has
    /// this shape, so the Run stalls in Dispatched with no way for the author
    /// to end it — polling the UI cannot help, because nothing is coming.
    ///
    /// Injecting the sequential order (drain stdout to EOF, then stderr) makes
    /// this test hang until its timeout, which is the discriminating failure.
    #[test]
    fn both_pipes_drain_while_the_child_is_still_running() {
        let handle = launch_fixture(&["--flood-stderr"]).unwrap();
        let (done, waiting) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(handle.wait());
        });
        let landed = waiting
            .recv_timeout(std::time::Duration::from_secs(20))
            .expect("wait never returned: one pipe is drained only after the other reaches EOF");
        let outcome = landed.unwrap();
        assert_eq!(outcome.code, Some(0));
        assert_eq!(outcome.stdout, "done");
        assert_eq!(outcome.stderr.len(), 1024 * 1024);
    }
}
