// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! A fake `claude` CLI for e2e: speaks print-mode stream-json in Claude's
//! frame shapes (assistant → result), answers with a canned <agent-result>
//! against whatever scope id the prompt carries, and never touches a network.
//! The e2e renames it `claude.exe` and puts its directory first on PATH.

use std::io::Write as _;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--version") {
        // version_of 的身份校验要的是裸版本号（对照：带程序名前缀会被拒）。
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
    // Claude 的帧形：system/init → assistant（message.content[] 的 text 片）→
    // 收尾 result（subtype success + modelUsage）。少一帧都是另一种协议。
    let init = serde_json::json!({ "type": "system", "subtype": "init", "session_id": "fake-session-0000" });
    writeln!(out, "{init}").unwrap();
    let assistant = serde_json::json!({
        "type": "assistant",
        "message": { "content": [ { "type": "text", "text": reply } ] },
    });
    writeln!(out, "{assistant}").unwrap();
    let result = serde_json::json!({
        "type": "result",
        "subtype": "success",
        "result": reply,
        "modelUsage": {
            "fake-model": {
                "inputTokens": 100,
                "cacheReadInputTokens": 0,
                "cacheCreationInputTokens": 0,
                "outputTokens": 10,
            }
        },
    });
    writeln!(out, "{result}").unwrap();
}
