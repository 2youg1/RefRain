//! Cross-boundary errors.
//!
//! An error leaving the domain carries a code, the action that failed, the
//! subject it failed on, and what the author can do next (SPEC 6.5). Vue never
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
                | ErrorCode::Io => {}
            }
        }
        assert_eq!(ErrorCode::ALL.len(), 9);
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
