//! Pure domain for RefRain.
//!
//! This crate names the concepts in SPEC section 2 and nothing else. It does not
//! reach a database, a filesystem path, a process, a window, or a harness; those
//! belong to `refrain-store` and `refrain-host`. The boundary is mechanical:
//! `verify:core-purity` fails the build when a forbidden dependency appears here.

#![forbid(unsafe_code)]

pub mod agent_protocol;
pub mod block_shape;
pub mod chinese_index;
pub mod context_compiler;
pub mod digest;
pub mod error;
pub mod health;
pub mod id;
pub mod kara;
pub mod manuscript;
pub mod material_ref;
pub mod role;
pub mod search_rank;
pub mod searchable_block;
pub mod source_layout;

pub use agent_protocol::{
    AgentComment, AgentMemo, AgentReplacement, ArtifactContract, ArtifactError, ArtifactErrorCode,
    MaterialDraft, VerifiedArtifact,
};
pub use context_compiler::{
    BeforeScope, ChangeEntry, ChangeKind, DispatchInput, DispatchPackage, ManifestEntry, Narration,
    Tokens, compile, narrate_artifact, narrate_changes, narrate_manifest, serialize_changes,
    short_contract,
};
pub use error::{ErrorCode, RecoveryStep, RefrainError};
pub use health::{HealthReport, health};
pub use id::Id;
pub use kara::{
    Activity, InterruptEvent, KaraAutoEntry, KaraEffect, KaraEvent, KaraMachine, KaraPolicy,
    KaraSession, KaraState, KaraTransition, QuietEvent, ReturnPoint,
};
pub use manuscript::{
    Block, BlockSequence, BytePatch, ChangeClass, DecisionBatch, Edit, EditKind, EditScope,
    EditorAction, EditorChange, Insertion, Lineage, Manuscript, Proposal, Replacement, ReviewSlice,
    ReviewSliceId, SliceKind, SourceSnapshot, TextAction, TextCommand, TextHead, TextRefusal,
    TextTransition, Verdict, VerdictKind, classify_change,
};
pub use role::DocumentRole;
pub use source_layout::{ByteSpan, SourceDrift, SourceLayout};
