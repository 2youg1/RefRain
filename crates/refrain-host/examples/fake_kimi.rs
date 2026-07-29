//! A fake `kimi` CLI for e2e: speaks print-mode stream-json, answers with a
//! canned <agent-result> against whatever scope id the prompt carries, and
//! never touches a network. The e2e renames it `kimi.exe` and puts its
//! directory first on PATH.

use std::io::Write as _;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version") {
        println!("9.9.9-fake");
        return;
    }
    let prompt = args
        .windows(2)
        .find(|pair| pair[0] == "-p")
        .map(|pair| pair[1].clone())
        .unwrap_or_default();
    let scope = prompt
        .split("<!-- scope ")
        .nth(1)
        .and_then(|rest| rest.split(" -->").next())
        .unwrap_or("unknown:scope")
        .to_string();
    let reply = format!(
        "<agent-result version=\"2\">\n  <replacement scope=\"{scope}\">伪 Agent 改写。</replacement>\n</agent-result>"
    );
    let out = std::io::stdout();
    let mut out = out.lock();
    let frame = serde_json::json!({ "role": "assistant", "content": reply });
    writeln!(out, "{frame}").unwrap();
    let hint = serde_json::json!({
        "role": "meta",
        "type": "session.resume_hint",
        "session_id": "fake-session-0000",
        "content": "fake",
    });
    writeln!(out, "{hint}").unwrap();
}
