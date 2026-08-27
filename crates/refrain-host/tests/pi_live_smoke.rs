// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pi 真机冒烟：注册表里的 pi-print 通道走完整 dispatch → observe 链。
//! 需要 PATH 上有 `pi` 且有可用的模型额度；跳过不红（开发机没有 Pi
//! 不是缺陷）。设 REFRAIN_RUN_LIVE_HARNESS=1 才跑。

use refrain_core::Id;
use refrain_host::adapters::{DispatchSpec, HarnessAdapter, PrintAdapter, channel};

#[test]
fn pi_dispatch_and_observe_a_real_turn() {
    if std::env::var("REFRAIN_RUN_LIVE_HARNESS").as_deref() != Ok("1") {
        eprintln!("skipped: set REFRAIN_RUN_LIVE_HARNESS=1 for the live Pi contract");
        return;
    }
    let channel = channel("pi-print").expect("registered");
    let Some(pi) = PrintAdapter::detect(channel) else {
        eprintln!("skipped: pi CLI not on PATH");
        return;
    };
    let receipt = pi
        .dispatch(&DispatchSpec {
            run_id: Id::new(),
            workspace: std::env::temp_dir(),
            request_md: "Reply with exactly: REFRAIN-PI-SMOKE".to_string(),
            connection_argv: vec![],
            agent_argv: vec![],
        })
        .expect("dispatch launches");
    let outcome = pi.observe(receipt).expect("observe reads the stream");
    assert!(
        outcome.reply_text.contains("REFRAIN-PI-SMOKE"),
        "reply was: {}",
        outcome.reply_text
    );
    eprintln!("pi smoke reply: {}", outcome.reply_text);
}
