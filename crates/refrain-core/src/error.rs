// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cross-boundary errors.
//!
//! An error leaving the domain carries a code, the action that failed, the
//! subject it failed on, and what the author can do next (SPEC 6.5). The shell never
//! parses an English message to decide behaviour, and the domain never writes
//! interface copy: the code is the fact, the wording is a projection (INV-15).

use serde::{Deserialize, Serialize};
use specta::Type;
use std::fmt;

/// The single authority for error kinds. `verify:docs-current` enumerates this
/// type and fails when a document explains fewer codes than it declares.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    PermissionDenied,
    IllegalName,
    Occupied,
    OutsideRoot,
    SourceBackup,
    NotADirectory,
    UnsupportedFormat,
    StateUnavailable,
    Io,
    /// The manuscript moved underneath a Proposal.
    ///
    /// The Agent froze the text it was reading; the author has since changed
    /// it. Applying the proposal anyway would overwrite words the Agent never
    /// saw, and discarding it silently would throw away the Agent's work —
    /// neither is ours to decide, so this reaches the author as its own fact
    /// rather than as a generic I/O failure.
    StaleProposal,
    /// The request named something outside the request's own vocabulary.
    ///
    /// The interface only ever sends known words (its wire shapes are pinned
    /// by tests), so a miss means the two sides have drifted — surfacing it
    /// as its own fact keeps the drift visible instead of folding it into
    /// an I/O failure.
    InvalidInput,
}

impl ErrorCode {
    /// Every variant, in declaration order. Completeness assertions read the
    /// domain from here rather than from a list someone typed from memory.
    pub const ALL: &'static [Self] = &[
        Self::PermissionDenied,
        Self::IllegalName,
        Self::Occupied,
        Self::OutsideRoot,
        Self::SourceBackup,
        Self::NotADirectory,
        Self::UnsupportedFormat,
        Self::StateUnavailable,
        Self::Io,
        Self::StaleProposal,
        Self::InvalidInput,
    ];

    /// The wire spelling, identical to what serde emits.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PermissionDenied => "permission-denied",
            Self::IllegalName => "illegal-name",
            Self::Occupied => "occupied",
            Self::OutsideRoot => "outside-root",
            Self::SourceBackup => "source-backup",
            Self::NotADirectory => "not-a-directory",
            Self::UnsupportedFormat => "unsupported-format",
            Self::StateUnavailable => "state-unavailable",
            Self::Io => "io",
            Self::StaleProposal => "stale-proposal",
            Self::InvalidInput => "invalid-input",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One thing the author can do about a failure. A step is a domain fact, not a
/// sentence: the interface renders it, so changing wording never touches here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryStep {
    Retry,
    ChooseAnotherLocation,
    ChooseAnotherName,
    GrantPermission,
    OpenSettings,
    ReportDefect,
    /// Read what the Agent was looking at, then decide.
    ///
    /// The only honest step when a proposal has gone stale: the author is the
    /// one who changed the text, and only they know whether the Agent's
    /// suggestion still applies to what is there now.
    CompareWithFrozenText,
    /// Ask the Agent again, against the text as it stands.
    SendAgain,
}

/// A failure crossing the bridge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RefrainError {
    pub code: ErrorCode,
    /// The use case that failed, e.g. `create_project`.
    pub action: String,
    /// What it failed on: an opaque id, or a name the author supplied.
    pub subject: String,
    /// Operator-facing specifics. Never shown as the primary message.
    pub detail: Option<String>,
    pub recovery: Vec<RecoveryStep>,
}

impl RefrainError {
    #[must_use]
    pub fn new(code: ErrorCode, action: impl Into<String>, subject: impl Into<String>) -> Self {
        Self {
            code,
            action: action.into(),
            subject: subject.into(),
            detail: None,
            recovery: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    #[must_use]
    pub fn with_recovery(mut self, recovery: Vec<RecoveryStep>) -> Self {
        self.recovery = recovery;
        self
    }
}

impl fmt::Display for RefrainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} on {} ({})", self.action, self.subject, self.code)
    }
}

impl std::error::Error for RefrainError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ALL` is the domain other assertions read. If a variant is added without
    /// listing it, every completeness gate built on `ALL` silently narrows.
    #[test]
    fn all_lists_every_variant() {
        let mut seen: Vec<&str> = ErrorCode::ALL.iter().map(|c| c.as_str()).collect();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), ErrorCode::ALL.len(), "ALL repeats a variant");

        // The exhaustive match below fails to compile when a variant is added,
        // which is what forces someone to come back and extend ALL.
        for code in ErrorCode::ALL {
            match code {
                ErrorCode::PermissionDenied
                | ErrorCode::IllegalName
                | ErrorCode::Occupied
                | ErrorCode::OutsideRoot
                | ErrorCode::SourceBackup
                | ErrorCode::NotADirectory
                | ErrorCode::UnsupportedFormat
                | ErrorCode::StateUnavailable
                | ErrorCode::Io
                | ErrorCode::StaleProposal
                | ErrorCode::InvalidInput => {}
            }
        }
        assert_eq!(ErrorCode::ALL.len(), 11);
    }

    /// `as_str` is what documentation gates quote. Serde is what the bridge
    /// sends. A drift between them makes a document that describes no reality.
    #[test]
    fn wire_spelling_matches_as_str() {
        for code in ErrorCode::ALL {
            let json = serde_json::to_string(code).unwrap();
            assert_eq!(json, format!("\"{}\"", code.as_str()));
        }
    }

    #[test]
    fn an_error_carries_its_recovery_steps() {
        let error = RefrainError::new(ErrorCode::Occupied, "create_project", "Drafts")
            .with_detail("a directory of that name already exists")
            .with_recovery(vec![RecoveryStep::ChooseAnotherName]);
        assert_eq!(error.recovery, vec![RecoveryStep::ChooseAnotherName]);
        assert_eq!(error.to_string(), "create_project on Drafts (occupied)");
    }
}
