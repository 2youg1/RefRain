// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! Run cancellation rules for launching and detached processes.

use refrain_app::cancel::refuse_cancel_without_handle;
use refrain_core::ErrorCode;
use refrain_host::host::RunProgress;

#[test]
fn a_launching_run_cannot_be_cancelled_because_no_handle_exists_yet() {
    let refusal = refuse_cancel_without_handle(&RunProgress::Launching {
        request_digest: "abc".into(),
    })
    .expect_err("a launching producer has no handle to interrupt");

    assert_eq!(refusal.code, ErrorCode::StateUnavailable);
    assert!(
        refusal.subject.contains("launch settles"),
        "the author is told to wait, not that cancelling failed: {refusal:?}"
    );
}

#[test]
fn a_dispatched_run_without_a_handle_asks_for_recovery_not_a_fake_cancel() {
    // 这个 Run 在账本上是 Dispatched，但它不在活动表里——应用重启过。
    // 把它记成 Cancelled 是撒谎：那个进程可能还在跑。
    let refusal = refuse_cancel_without_handle(&RunProgress::Dispatched {
        receipt: "r-1".into(),
    })
    .expect_err("a dispatched run with no live handle cannot be truthfully cancelled");

    assert_eq!(refusal.code, ErrorCode::StateUnavailable);
    assert!(
        refusal.subject.contains("recovery"),
        "the author is pointed at recovery: {refusal:?}"
    );
}

#[test]
fn a_queued_run_can_be_cancelled_because_nothing_is_running() {
    refuse_cancel_without_handle(&RunProgress::Queued)
        .expect("nothing has started, so cancelling is honest");
}

#[test]
fn an_authorized_run_can_be_cancelled_before_it_launches() {
    refuse_cancel_without_handle(&RunProgress::Authorized {
        request_digest: "abc".into(),
    })
    .expect("authorized but not launched: no producer exists yet");
}

#[test]
fn terminal_runs_accept_cancel_so_the_command_stays_idempotent() {
    // 已完成/已失败/已取消的 Run 再次取消不该报错：作者点了两次取消按钮，
    // 第二次应当无事发生，而不是一条读起来像故障的拒绝。
    for progress in [
        RunProgress::Completed {
            artifact_digest: "d".into(),
        },
        RunProgress::Failed {
            failure: "boom".into(),
        },
        RunProgress::Cancelled,
    ] {
        refuse_cancel_without_handle(&progress)
            .unwrap_or_else(|refusal| panic!("a terminal run refused cancel: {refusal:?}"));
    }
}
