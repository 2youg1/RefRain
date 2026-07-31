//! Generate the repository's `SKILL.md` from the protocol itself.
//!
//! # Why this is generated rather than written
//!
//! `SKILL.md` ships in the repository so an agent can be pointed at it before
//! it ever sees a request. That makes it a machine-facing artifact: whoever
//! reads it acts on it and cannot check it against anything.
//!
//! A hand-written copy drifts, and this one had. Measured against the code at
//! the time of writing, the committed `SKILL.md` told agents to reply with
//! `version="1"` — the parser requires `"2"`, so an agent following the
//! document faithfully would have every run rejected — and it never mentioned
//! `<material-draft>` at all. Both are the failure mode of prose that
//! restates a fact the code already owns: it stays plausible while becoming
//! wrong.
//!
//! So the file is produced from `skill_doc()`, the same function the request
//! compiler uses for `ContractMode::Full`. The two cannot disagree, because
//! there is only one of them.
//!
//! Run: `cargo run -p refrain-core --example generate_skill_doc -- <path>`

fn main() {
    let target = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: generate_skill_doc <path/to/SKILL.md>");
        std::process::exit(2);
    });

    let body = format!(
        "---\n\
         name: refrain\n\
         description: RefRain 写作工作台的 agent 协议。当你收到一份含 \"# Before / # Context / # Request / # Reply format / # Agent reply\" 的请求文件时，加载本 skill。\n\
         ---\n\n\
         <!-- 由 `cargo run -p refrain-core --example generate_skill_doc` 生成。\n\
         \x20    不要手改：协议的权威是 `agent_protocol::skill_doc()`，\n\
         \x20    手写副本漂移过一次——它教 agent 写 version=\"1\" 而解析器要 \"2\"。 -->\n\n\
         {}\n\
         ---\n\n\
         {}\n",
        refrain_core::agent_protocol::skill_doc(),
        refrain_core::agent_protocol::error_reference(),
    );

    std::fs::write(&target, body).unwrap_or_else(|error| {
        eprintln!("cannot write {target}: {error}");
        std::process::exit(1);
    });
    println!("wrote {target}");
}
