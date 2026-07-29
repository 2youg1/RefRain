//! The KARA state machine (SPEC 9.3, D10, D18).
//!
//! Six states as a discriminated union, one transition function, and named
//! effects — Vue projects, it never re-derives (INV-10). The rules the tests
//! below pin down:
//!
//! - KARA is never the default. Application start, opening a Project, and
//!   opening a Material stay `Off`, and none of them consumes the one
//!   automatic entry a Project work session gets.
//! - That one entry fires on the first manuscript (`document | chapter`)
//!   opened in the session, and only when the Config policy allows it. A
//!   manual exit never re-arms it within the session.
//! - `Ctrl+Enter` toggles both ways; `Escape` never exits.
//! - Events come in two classes: quiet ones (save succeeded, agent finished,
//!   proposal arrived, index refreshed) queue for the leaving debrief;
//!   interrupting ones (save failed, disk unwritable, identity changed,
//!   external conflict) surface immediately.
//! - No clock, no rest reminders, no focus statistics (Q17).

use serde::{Deserialize, Serialize};
use specta::Type;

/// What the author is doing when KARA engages: where it must be able to
/// return to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum Activity {
    Writing,
    Reviewing,
}

/// The spot KARA must give back when it ends: a block and a caret offset,
/// plus the end of the sentence before it (Q: "你停在这里").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReturnPoint {
    pub block_id: String,
    pub offset: u32,
    pub sentence_tail: String,
}

/// An open KARA session. It holds the return point and nothing else — no
/// timestamps for statistics, because there are no statistics (Q17).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KaraSession {
    pub activity: Activity,
    pub return_point: ReturnPoint,
}

/// The six states.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum KaraState {
    Off,
    Entering {
        activity: Activity,
        return_point: ReturnPoint,
    },
    Writing {
        session: KaraSession,
    },
    Reviewing {
        session: KaraSession,
    },
    Away {
        session: KaraSession,
    },
    Leaving {
        session: KaraSession,
    },
}

/// The one automatic entry a Project work session gets (D18). It belongs to
/// the session, never persists to the next one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum KaraAutoEntry {
    Pending,
    Consumed,
}

/// What the Config says about the automatic entry (SPEC 10.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KaraPolicy {
    pub auto_enter_on_first_manuscript: bool,
}

/// Everything that can move the machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum KaraEvent {
    /// A manuscript (`document | chapter`) opened. The event carries whether
    /// this is the first manuscript of the current Project work session;
    /// the composition layer owns work-session boundaries, the machine owns
    /// what an entry costs.
    FirstManuscriptOpened(KaraAutoEntry),
    /// A Project, a Material, the welcome screen, or a management page
    /// opened: explicitly *not* a manuscript.
    NonManuscriptOpened,
    /// `Ctrl+Enter`: the only toggle (D10). During an IME composition the
    /// composition layer registers the request and fires this at
    /// `compositionend`; the machine does not model compositions.
    ManualToggle,
    /// Entering finished its transition.
    Entered,
    /// The author stepped into Review while in KARA.
    EnterReview,
    /// Review ended, back to the text.
    ExitReview,
    /// Focus lost for 8s, sleep, or minimize.
    GoneAway,
    /// The author is back.
    Returned,
    /// Leaving's debrief finished (12s or any input).
    LeaveFinished,
    /// The composition layer reports where the author's caret is, so Away can
    /// mark it and Returning can show it. Facts in; decisions out.
    SetReturnPoint(ReturnPoint),
    /// A quiet event: queued for the leaving debrief, never an interruption.
    Quiet(QuietEvent),
    /// An interrupting event: surfaces immediately.
    Interrupt(InterruptEvent),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum QuietEvent {
    SaveSucceeded,
    AgentCompleted,
    ProposalArrived,
    IndexRefreshed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum InterruptEvent {
    SaveFailed,
    DiskUnwritable,
    RootIdentityChanged,
    ExternalConflict,
}

/// A named effect the composition layer must perform. The machine decides
/// *what*, never *how* (INV-15: the words are projected from these).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum KaraEffect {
    Engage { activity: Activity },
    Disengage { to: ReturnPoint },
    ConsumeAutoEntry,
    MarkAway { point: ReturnPoint },
    ShowReturnCard { point: ReturnPoint },
    QueueForDebrief(QuietEvent),
    InterruptNow(InterruptEvent),
    ShowDebrief { queued: Vec<QuietEvent> },
}

/// The full machine state: the six-state union, the auto-entry token, and
/// the quiet queue. All three travel together; a forgotten queue is how a
/// debrief silently loses events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KaraMachine {
    pub state: KaraState,
    pub auto_entry: KaraAutoEntry,
    pub queued: Vec<QuietEvent>,
}

/// What one step produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KaraTransition {
    pub machine: KaraMachine,
    pub effects: Vec<KaraEffect>,
}

impl KaraMachine {
    #[must_use]
    pub fn new() -> Self {
        Self {
            state: KaraState::Off,
            auto_entry: KaraAutoEntry::Pending,
            queued: Vec::new(),
        }
    }

    /// One step. The state, the auto-entry token, and the quiet queue move
    /// as one; effects are named for the composition layer to perform.
    #[must_use]
    pub fn step(&self, event: KaraEvent, policy: KaraPolicy) -> KaraTransition {
        let mut machine = self.clone();
        let mut effects = Vec::new();

        match event {
            KaraEvent::Quiet(quiet) => {
                machine.queued.push(quiet);
                effects.push(KaraEffect::QueueForDebrief(quiet));
            }
            KaraEvent::Interrupt(interrupt) => {
                effects.push(KaraEffect::InterruptNow(interrupt));
            }
            KaraEvent::SetReturnPoint(point) => {
                let update = |session: &mut KaraSession| session.return_point = point.clone();
                match &mut machine.state {
                    KaraState::Entering { return_point, .. } => *return_point = point,
                    KaraState::Writing { session }
                    | KaraState::Reviewing { session }
                    | KaraState::Away { session }
                    | KaraState::Leaving { session } => update(session),
                    KaraState::Off => {}
                }
            }
            KaraEvent::NonManuscriptOpened => {
                // Explicitly nothing: Projects, Materials, welcome, and
                // management pages neither enter nor consume (D18).
            }
            KaraEvent::FirstManuscriptOpened(auto_entry) => {
                machine.auto_entry = auto_entry;
                if machine.auto_entry == KaraAutoEntry::Pending
                    && machine.state == KaraState::Off
                    && policy.auto_enter_on_first_manuscript
                {
                    let point = ReturnPoint {
                        block_id: String::new(),
                        offset: 0,
                        sentence_tail: String::new(),
                    };
                    machine.state = KaraState::Entering {
                        activity: Activity::Writing,
                        return_point: point.clone(),
                    };
                    machine.auto_entry = KaraAutoEntry::Consumed;
                    effects.push(KaraEffect::ConsumeAutoEntry);
                    effects.push(KaraEffect::Engage {
                        activity: Activity::Writing,
                    });
                } else if machine.auto_entry == KaraAutoEntry::Pending {
                    // The policy says manual only: the token is still spent,
                    // so it cannot fire later in the same session.
                    machine.auto_entry = KaraAutoEntry::Consumed;
                    effects.push(KaraEffect::ConsumeAutoEntry);
                }
            }
            KaraEvent::ManualToggle => match &machine.state {
                KaraState::Off => {
                    let point = ReturnPoint {
                        block_id: String::new(),
                        offset: 0,
                        sentence_tail: String::new(),
                    };
                    machine.state = KaraState::Entering {
                        activity: Activity::Writing,
                        return_point: point,
                    };
                    effects.push(KaraEffect::Engage {
                        activity: Activity::Writing,
                    });
                }
                KaraState::Writing { session } | KaraState::Reviewing { session } => {
                    let point = session.return_point.clone();
                    machine.state = KaraState::Leaving {
                        session: session.clone(),
                    };
                    effects.push(KaraEffect::ShowDebrief {
                        queued: machine.queued.clone(),
                    });
                    machine.queued.clear();
                    effects.push(KaraEffect::Disengage { to: point });
                }
                KaraState::Entering { .. } => {
                    machine.state = KaraState::Off;
                }
                KaraState::Away { session } => {
                    let point = session.return_point.clone();
                    machine.state = KaraState::Leaving {
                        session: session.clone(),
                    };
                    effects.push(KaraEffect::ShowDebrief {
                        queued: machine.queued.clone(),
                    });
                    machine.queued.clear();
                    effects.push(KaraEffect::Disengage { to: point });
                }
                KaraState::Leaving { .. } => {}
            },
            KaraEvent::Entered => {
                if let KaraState::Entering {
                    activity,
                    return_point,
                } = &machine.state
                {
                    let session = KaraSession {
                        activity: *activity,
                        return_point: return_point.clone(),
                    };
                    machine.state = match activity {
                        Activity::Writing => KaraState::Writing { session },
                        Activity::Reviewing => KaraState::Reviewing { session },
                    };
                }
            }
            KaraEvent::EnterReview => {
                if let KaraState::Writing { session } = &machine.state {
                    machine.state = KaraState::Reviewing {
                        session: session.clone(),
                    };
                }
            }
            KaraEvent::ExitReview => {
                if let KaraState::Reviewing { session } = &machine.state {
                    machine.state = KaraState::Writing {
                        session: session.clone(),
                    };
                }
            }
            KaraEvent::GoneAway => match &machine.state {
                KaraState::Writing { session } | KaraState::Reviewing { session } => {
                    let point = session.return_point.clone();
                    machine.state = KaraState::Away {
                        session: session.clone(),
                    };
                    effects.push(KaraEffect::MarkAway { point });
                }
                _ => {}
            },
            KaraEvent::Returned => {
                if let KaraState::Away { session } = &machine.state {
                    let point = session.return_point.clone();
                    let session = session.clone();
                    machine.state = match session.activity {
                        Activity::Writing => KaraState::Writing { session },
                        Activity::Reviewing => KaraState::Reviewing { session },
                    };
                    effects.push(KaraEffect::ShowReturnCard { point });
                }
            }
            KaraEvent::LeaveFinished => {
                if matches!(machine.state, KaraState::Leaving { .. }) {
                    machine.state = KaraState::Off;
                }
            }
        }

        KaraTransition { machine, effects }
    }
}

impl Default for KaraMachine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUTO: KaraPolicy = KaraPolicy {
        auto_enter_on_first_manuscript: true,
    };
    const MANUAL: KaraPolicy = KaraPolicy {
        auto_enter_on_first_manuscript: false,
    };

    fn writing() -> KaraMachine {
        KaraMachine {
            state: KaraState::Writing {
                session: KaraSession {
                    activity: Activity::Writing,
                    return_point: ReturnPoint {
                        block_id: "b1".to_string(),
                        offset: 4,
                        sentence_tail: "前一句的尾巴".to_string(),
                    },
                },
            },
            auto_entry: KaraAutoEntry::Consumed,
            queued: Vec::new(),
        }
    }

    #[test]
    fn application_start_project_and_material_never_enter_nor_consume() {
        for _ in 0..3 {
            let next = KaraMachine::new().step(KaraEvent::NonManuscriptOpened, AUTO);
            assert_eq!(next.machine.state, KaraState::Off);
            assert_eq!(next.machine.auto_entry, KaraAutoEntry::Pending);
            assert!(next.effects.is_empty());
        }
    }

    #[test]
    fn the_first_manuscript_enters_once_when_the_policy_allows() {
        let machine = KaraMachine::new();
        let entered = machine.step(
            KaraEvent::FirstManuscriptOpened(KaraAutoEntry::Pending),
            AUTO,
        );
        assert!(matches!(entered.machine.state, KaraState::Entering { .. }));
        assert_eq!(entered.machine.auto_entry, KaraAutoEntry::Consumed);

        // A second manuscript in the same session: no second Engage.
        let again = entered.machine.step(
            KaraEvent::FirstManuscriptOpened(KaraAutoEntry::Consumed),
            AUTO,
        );
        assert!(
            !again
                .effects
                .iter()
                .any(|effect| matches!(effect, KaraEffect::Engage { .. }))
        );
    }

    #[test]
    fn the_policy_off_spends_the_token_without_entering() {
        let machine = KaraMachine::new();
        let next = machine.step(
            KaraEvent::FirstManuscriptOpened(KaraAutoEntry::Pending),
            MANUAL,
        );
        assert_eq!(next.machine.state, KaraState::Off);
        assert_eq!(next.machine.auto_entry, KaraAutoEntry::Consumed);
        assert!(
            next.effects
                .iter()
                .any(|effect| matches!(effect, KaraEffect::ConsumeAutoEntry))
        );
        assert!(
            !next
                .effects
                .iter()
                .any(|effect| matches!(effect, KaraEffect::Engage { .. }))
        );
    }

    #[test]
    fn a_manual_exit_never_rearms_the_automatic_entry() {
        let machine = KaraMachine::new()
            .step(
                KaraEvent::FirstManuscriptOpened(KaraAutoEntry::Pending),
                AUTO,
            )
            .machine
            .step(KaraEvent::Entered, AUTO)
            .machine;
        // Manual exit.
        let leaving = machine.step(KaraEvent::ManualToggle, AUTO).machine;
        let off = leaving.step(KaraEvent::LeaveFinished, AUTO).machine;
        assert_eq!(off.state, KaraState::Off);
        // Switching documents must not auto-enter again.
        let after = off.step(
            KaraEvent::FirstManuscriptOpened(KaraAutoEntry::Consumed),
            AUTO,
        );
        assert_eq!(after.machine.state, KaraState::Off);
        assert!(
            !after
                .effects
                .iter()
                .any(|effect| matches!(effect, KaraEffect::Engage { .. }))
        );
    }

    #[test]
    fn ctrl_enter_toggles_both_ways_and_drains_the_quiet_queue() {
        let machine = writing();
        let machine = machine
            .step(KaraEvent::Quiet(QuietEvent::SaveSucceeded), AUTO)
            .machine
            .step(KaraEvent::Quiet(QuietEvent::ProposalArrived), AUTO)
            .machine;
        let leaving = machine.step(KaraEvent::ManualToggle, AUTO);
        assert!(matches!(leaving.machine.state, KaraState::Leaving { .. }));
        let debrief = leaving.effects.iter().find_map(|effect| match effect {
            KaraEffect::ShowDebrief { queued } => Some(queued.clone()),
            _ => None,
        });
        assert_eq!(
            debrief,
            Some(vec![QuietEvent::SaveSucceeded, QuietEvent::ProposalArrived])
        );
        assert!(leaving.machine.queued.is_empty());
    }

    #[test]
    fn away_marks_the_point_and_return_shows_the_card() {
        let machine = writing();
        let away = machine.step(KaraEvent::GoneAway, AUTO);
        assert!(matches!(away.machine.state, KaraState::Away { .. }));
        assert!(
            away.effects
                .iter()
                .any(|effect| matches!(effect, KaraEffect::MarkAway { .. }))
        );

        let back = away.machine.step(KaraEvent::Returned, AUTO);
        assert!(matches!(back.machine.state, KaraState::Writing { .. }));
        let card = back.effects.iter().find_map(|effect| match effect {
            KaraEffect::ShowReturnCard { point } => Some(point.clone()),
            _ => None,
        });
        assert_eq!(
            card.map(|point| point.sentence_tail),
            Some("前一句的尾巴".to_string())
        );
    }

    #[test]
    fn review_is_a_state_not_an_exit() {
        let machine = writing();
        let reviewing = machine.step(KaraEvent::EnterReview, AUTO).machine;
        assert!(matches!(reviewing.state, KaraState::Reviewing { .. }));
        let back = reviewing.step(KaraEvent::ExitReview, AUTO);
        assert!(matches!(back.machine.state, KaraState::Writing { .. }));
    }

    #[test]
    fn the_return_point_is_a_fact_the_machine_only_keeps() {
        let machine = writing().step(
            KaraEvent::SetReturnPoint(ReturnPoint {
                block_id: "b7".to_string(),
                offset: 11,
                sentence_tail: "新位置".to_string(),
            }),
            AUTO,
        );
        let away = machine.machine.step(KaraEvent::GoneAway, AUTO);
        let point = away.effects.iter().find_map(|effect| match effect {
            KaraEffect::MarkAway { point } => Some(point.clone()),
            _ => None,
        });
        assert_eq!(point.map(|p| p.block_id), Some("b7".to_string()));
    }

    #[test]
    fn quiet_events_never_interrupt_and_interrupts_surface_now() {
        let machine = writing();
        let quiet = machine.step(KaraEvent::Quiet(QuietEvent::IndexRefreshed), AUTO);
        assert!(
            !quiet
                .effects
                .iter()
                .any(|effect| matches!(effect, KaraEffect::InterruptNow(_)))
        );

        let hit = machine.step(KaraEvent::Interrupt(InterruptEvent::SaveFailed), AUTO);
        assert!(
            hit.effects.iter().any(|effect| matches!(
                effect,
                KaraEffect::InterruptNow(InterruptEvent::SaveFailed)
            ))
        );
        // An interruption does not open, close, or move the session.
        assert!(matches!(hit.machine.state, KaraState::Writing { .. }));
    }

    #[test]
    fn escape_is_not_an_event_this_machine_knows() {
        // D10: Escape never exits. The machine has no Escape event at all —
        // the composition layer routes it to IME, registers, find, overview,
        // or nothing, and KARA only ever hears ManualToggle.
        let machine = writing();
        let toggled = machine.step(KaraEvent::ManualToggle, AUTO);
        assert!(matches!(toggled.machine.state, KaraState::Leaving { .. }));
    }
}
