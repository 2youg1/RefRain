//! The fixture child for `refrain_host::process` tests. Cargo builds examples
//! for `cargo test`; this binary never ships with a release.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--echo") => print!("{}", args.get(1).map(String::as_str).unwrap_or("")),
        Some("--exit") => {
            std::process::exit(args.get(1).and_then(|n| n.parse().ok()).unwrap_or(1));
        }
        Some("--env-of") => print!(
            "{}",
            std::env::var(args.get(1).map(String::as_str).unwrap_or(""))
                .unwrap_or_else(|_| "<unset>".to_string())
        ),
        Some("--sleep") => std::thread::sleep(std::time::Duration::from_secs(
            args.get(1).and_then(|n| n.parse().ok()).unwrap_or(60),
        )),
        // Finish talking, then keep working — a harness that has printed its
        // last line but is still cleaning up.
        //
        // This mode exists because the ordinary `--sleep` child cannot expose
        // the wait/cancel lock order at all: its pipes stay open, so a reader
        // blocks in `read_to_end` *before* the mutex is taken, and a cancel
        // arriving then finds the lock free. Only after EOF does the observer
        // reach the wait — and a wait holding the lock for the child's whole
        // remaining lifetime is what makes cancel unreachable.
        //
        // The shell owns the closing because Rust's `Stdout` is a handle to the
        // descriptor, not the descriptor: dropping it leaves fd 1 open, so the
        // parent never sees EOF (measured — the reader blocked until timeout).
        Some("--close-then-sleep") => {
            let seconds = args.get(1).map(String::as_str).unwrap_or("60").to_string();
            let shell = if cfg!(windows) { "cmd" } else { "sh" };
            let flag = if cfg!(windows) { "/C" } else { "-c" };
            let script = if cfg!(windows) {
                format!("timeout /T {seconds} >NUL")
            } else {
                format!("exec 1>&-; exec 2>&-; sleep {seconds}")
            };
            // `exec` so the shell *replaces* this process: spawning it as a
            // child leaves our own fd 1 open, and the parent then never sees
            // EOF (measured — the reader blocked until the timeout).
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                let error = std::process::Command::new(shell)
                    .args([flag, &script])
                    .exec();
                panic!("exec failed: {error}");
            }
            #[cfg(not(unix))]
            {
                let status = std::process::Command::new(shell)
                    .args([flag, &script])
                    .status()
                    .expect("the shell that closes our pipes and keeps running");
                std::process::exit(status.code().unwrap_or(0));
            }
        }
        Some("--argv-count") => print!("{}", args.len()),
        // Act as a producer: read the promoted request, write an artifact.
        //
        // This is what makes an end-to-end edge test end-to-end. The Run's
        // workspace is the process's cwd (the host sets it), the request is
        // there because launch promoted it, and the artifact goes where the
        // contract says. Nothing here is mocked: a real process reads real
        // bytes off disk and writes a real reply that the real parser will
        // then have to accept or refuse.
        //
        //   --produce <run-id> <mode>
        //
        // Modes:
        //   edit     one <replacement> for the first scope in the request
        //   memo     one <comment>, no edit — what a verifier may return
        //   verdict  a comment naming a defect, for the verifier-of-verifier
        //            case: the fixture reports what it was asked to look for
        Some("--produce") => {
            let run_id = args.get(1).map(String::as_str).unwrap_or("");
            let mode = args.get(2).map(String::as_str).unwrap_or("edit");
            let cwd = std::env::current_dir().expect("a producer runs in its Run workspace");
            let request = std::fs::read_to_string(cwd.join("request.md"))
                .expect("launch promotes request.md before the producer starts");

            // The scope id is read out of the frozen request, never invented:
            // a producer that guesses a scope is exactly what the parser must
            // refuse, so the fixture must not accidentally do it.
            let scope = request
                .lines()
                .find_map(|line| {
                    line.trim()
                        .strip_prefix("<!-- scope ")
                        .and_then(|rest| rest.strip_suffix(" -->"))
                        .map(str::to_string)
                })
                .expect("the request carries at least one scope marker");

            let body = match mode {
                // `<memo>` 与 `<comment>` 不是一回事：comment 挂在一个 scope 上，
                // memo 是这一轮想留给下一轮的话。收取的返回值里 `memos` 数的是
                // 后者，所以一个「只报告不改写」的产出用 memo 表达。
                "memo" => "<memo topic=\"读后\">读过了，时序没有问题。</memo>".to_string(),
                "verdict" => format!(
                    "<memo topic=\"缺陷\">上游把「剑」写成了「刀」，与前文不一致。</memo>\
                     <comments><comment target=\"{scope}\">这一处与前文不一致。</comment></comments>"
                ),
                _ => format!(
                    "<replacement scope=\"{scope}\"><![CDATA[他握着剑，没有说话。]]></replacement>"
                ),
            };

            let attempt = cwd.join("attempts").join(run_id);
            std::fs::create_dir_all(&attempt).expect("the attempt directory is the producer's own");
            std::fs::write(
                attempt.join("result.md"),
                format!("<agent-result version=\"2\">{body}</agent-result>"),
            )
            .expect("write the artifact where the contract says");
        }
        _ => std::process::exit(2),
    }
}
