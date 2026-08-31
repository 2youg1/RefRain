// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 实测：一轮之间有多少字节的公共前缀存活。
//!
//! D14 要求请求按「稳定在前、每轮变的在后」编译，因为 provider 的 prompt cache
//! 按 exact prefix match 命中。当前 `compile()` 把 `# Before`（每轮都变的正文）
//! 放在第一节，所以这个探针量的是：改一段正文之后，前缀从第几个字节开始分叉。
//!
//! 跑法：cargo run -p refrain-core --example prefix_probe

use refrain_core::context_compiler::{
    BeforeScope, ChangeEntry, ChangeKind, ContractMode, DispatchInput, compile,
};

fn scope(id: &str, text: &str) -> BeforeScope {
    BeforeScope {
        scope: id.to_string(),
        blocks: Vec::new(),
        text: text.to_string(),
    }
}

fn input(body: &str) -> DispatchInput {
    DispatchInput {
        // P0：身份，全程不变。
        persona: Some("你是一位克制的编辑。".to_string()),
        installed_skill: None,
        resumed: false,
        manuscript: None,
        changes: vec![ChangeEntry {
            reference: "p7.s2".to_string(),
            kind: ChangeKind::Reject,
            reason: Some("不要用设问句结尾".to_string()),
            final_text: None,
        }],
        materials: vec![],
        upstream: Vec::new(),
        request: "把这两段的语气改得更克制。".to_string(),
        // S0：每轮都变的那一层。
        scopes: vec![scope("ch01:b3", body)],
        result_path: ".refrain/runs/r1/attempts/a1/result.md".to_string(),
        max_bytes: 65_536,
        contract_mode: ContractMode::Short,
    }
}

fn common_prefix(a: &str, b: &str) -> usize {
    a.as_bytes()
        .iter()
        .zip(b.as_bytes())
        .take_while(|(x, y)| x == y)
        .count()
}

fn main() {
    let first = compile(&input(
        "原来的那一段正文，作者这一轮改了它。".repeat(20).as_str(),
    ));
    let second = compile(&input(
        "改过之后的那一段正文，只动了几个字。".repeat(20).as_str(),
    ));

    let a = &first.request_md;
    let b = &second.request_md;
    let shared = common_prefix(a, b);

    println!("请求一 {} 字节", a.len());
    println!("请求二 {} 字节", b.len());
    println!("公共前缀 {shared} 字节");
    println!(
        "存活比例 {:.1}%",
        100.0 * shared as f64 / a.len().min(b.len()) as f64
    );
    println!();
    println!("前 120 字节：{}", &a[..120.min(a.len())]);
}
