//! Agent 视角的信息充分性与 token 经济（判据：黑盒检验第二项）。
//!
//! 问的是两件事，都从**真实的 `compile` 输出**上量，不从公式估算：
//!
//! 1. **token 经济**——一轮请求里，每一段各占多少字节，谁在增长。
//! 2. **信息充分性**——Agent 拿到这一份请求，够不够它开始工作：它知不知道
//!    自己能做什么动作、材料在哪、怎么取回一段原文、产出往哪写。
//!
//! 第 2 点无法由一个断言回答，所以这里逐项列出「Agent 要回答的问题」与
//! 「请求里回答它的那一段」，缺一项就报出来——把充分性变成一张可失败的清单，
//! 而不是一句「看起来够了」。
//!
//! 跑法：`cargo run -p refrain-core --example agent_view_probe`

use refrain_core::context_compiler::{BeforeScope, ContractMode, DispatchInput, compile};
use refrain_core::material_listing::{Disclosure, MaterialListing};
use refrain_core::role::DocumentRole;

/// 一份真实规模的材料：十万字节的中文正文，带作者自己写的标题。
fn a_material(path: &str, headings: usize, body_bytes: usize) -> MaterialListing {
    let mut text = String::new();
    for index in 0..headings {
        text.push_str(&format!("## 第{index}节 陆沉舟的营销手记\n\n"));
        while text.len() < body_bytes / headings * (index + 1) {
            text.push_str("他四十二岁那年把公司卖了，剩下的时间用来写这本书。\n");
        }
    }
    MaterialListing::describe(
        path,
        "资料",
        DocumentRole::Material,
        "digest-probe",
        &text,
        Disclosure::Retrievable,
    )
}

fn main() {
    let materials = vec![
        a_material("资料/人物志.md", 12, 100_000),
        a_material("资料/年表.md", 8, 100_000),
        a_material("资料/访谈.md", 15, 100_000),
    ];
    let material_bytes: usize = materials
        .iter()
        .map(|material| material.to_contract_element().len())
        .sum();

    let input = DispatchInput {
        persona: Some("你是一位克制的编辑，只在必要时改动。".to_string()),
        manuscript: None,
        changes: Vec::new(),
        materials,
        result_path: "runs/probe/attempts/probe/result.md".to_string(),
        max_bytes: 65_536,
        scopes: vec![BeforeScope {
            scope: "ch01:b1".to_string(),
            text: "剑一直握在他手里。".to_string(),
        }],
        request: "把这一段改得更克制。".to_string(),
        contract_mode: ContractMode::Short,
    };

    let package = compile(&input);
    let whole = &package.request_md;

    println!("=== 一轮请求的构成（真实 compile 输出，字节）===");
    let mut sections: Vec<(&str, usize)> = Vec::new();
    for (name, marker) in [
        ("Before（作者选的范围原文）", "# Before"),
        ("Context（人设 + 材料目录）", "# Context"),
        ("Request（作者的话）", "# Request"),
        ("Reply format（契约）", "# Reply format"),
        ("Agent reply（占位）", "# Agent reply"),
    ] {
        let start = whole.find(marker);
        let size = match start {
            Some(at) => {
                let rest = &whole[at + marker.len()..];
                let next = rest.find("\n# ").map_or(rest.len(), |offset| offset);
                marker.len() + next
            }
            None => 0,
        };
        sections.push((name, size));
    }
    let total = whole.len();
    for (name, size) in &sections {
        let share = *size as f64 / total as f64 * 100.0;
        println!("  {name:<28} {size:>7} 字节  {share:>5.1}%");
    }
    println!("  {:<28} {total:>7} 字节", "合计");

    println!();
    println!("=== 材料的代价：目录 vs 整篇 ===");
    let whole_text = 300_000usize; // 三份各十万字节
    println!("  整篇塞入（改造前）  {whole_text:>7} 字节");
    println!("  目录（现在）        {material_bytes:>7} 字节");
    println!(
        "  比值                {:>7.2}%（省下 {} 字节）",
        material_bytes as f64 / whole_text as f64 * 100.0,
        whole_text - material_bytes
    );

    println!();
    println!("=== 信息充分性：Agent 要回答的问题，请求里答不答得上 ===");
    // 每一项是「Agent 必须知道的一件事」与「请求里回答它的证据」。
    // 缺一项就说明这一轮它得靠猜，或者得多花一轮来问。
    let questions: Vec<(&str, bool)> = vec![
        (
            "我能改哪一段？（范围有没有逐字给出）",
            whole.contains("<!-- scope ch01:b1 -->") && whole.contains("剑一直握在他手里。"),
        ),
        (
            "我要做什么？（作者的话在不在）",
            whole.contains("把这一段改得更克制。"),
        ),
        (
            "我是谁？（人设有没有随轮传来）",
            whole.contains("你是一位克制的编辑"),
        ),
        (
            "有哪些材料？（路径 + 标题 + 大小 + 摘要）",
            whole.contains("<material path=") && whole.contains("<title>"),
        ),
        (
            "材料我能看到什么程度？（范围写没写在目录上）",
            whole.contains("access="),
        ),
        (
            "材料有多大？（不必取回就能判断值不值得）",
            whole.contains("bytes=") && whole.contains("blocks="),
        ),
        (
            "怎么取回一段原文？（动作名出现在契约里）",
            whole.contains("fetch") || whole.contains("read"),
        ),
        (
            "怎么检索材料？（动作名出现在契约里）",
            whole.contains("search"),
        ),
        (
            "产出写成什么形状？（元素名 + 版本）",
            whole.contains("<agent-result") && whole.contains("version="),
        ),
        (
            "改写怎么写？（元素名在契约里）",
            whole.contains("replacement"),
        ),
        ("批注怎么写？（元素名在契约里）", whole.contains("memo")),
        (
            "产出写到哪里？（路径给了没有）",
            whole.contains("result.md"),
        ),
    ];

    let mut missing = 0;
    for (question, answered) in &questions {
        println!(
            "  [{}] {question}",
            if *answered { "答得上" } else { "答不上" }
        );
        if !answered {
            missing += 1;
        }
    }

    println!();
    if missing == 0 {
        println!(
            "充分性：{} 项全部答得上。Agent 不必靠猜，也不必多花一轮来问。",
            questions.len()
        );
    } else {
        println!("充分性：{missing} 项答不上——这些是 Agent 得靠猜或多问一轮的地方。");
    }
}
