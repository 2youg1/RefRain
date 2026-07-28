//! The health report.
//!
//! R0 needs one command that crosses every layer of the generation chain: a
//! Rust type, a specta export, a typed TypeScript binding, a real window. It
//! reports what the process knows about itself and reaches nothing external —
//! no clock beyond the caller's, no disk, no network (INV-1).

use serde::{Deserialize, Serialize};
use specta::Type;

/// What the application can say about itself without touching anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// The workspace version, from Cargo at compile time.
    pub version: String,
    /// The commit this build was made from, or `None` for an unidentified build.
    /// Every internal installer displays it (SPEC section 12, R0).
    pub commit: Option<String>,
    /// Echoed back so a caller can prove the round trip carried its argument
    /// rather than a value the backend happened to hold already.
    pub echo: String,
}

/// Builds a health report. A pure function: same input, same output, always.
#[must_use]
pub fn health(echo: String, version: &str, commit: Option<&str>) -> HealthReport {
    HealthReport {
        version: version.to_owned(),
        commit: commit.map(ToOwned::to_owned),
        echo,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echoes_its_argument() {
        let report = health("ping".into(), "0.2.0", Some("abc1234"));
        assert_eq!(report.echo, "ping");
        assert_eq!(report.version, "0.2.0");
        assert_eq!(report.commit.as_deref(), Some("abc1234"));
    }

    /// An unidentified build says so. It does not invent a commit, and it does
    /// not report an empty string that reads like one.
    #[test]
    fn an_unidentified_build_reports_none() {
        let report = health(String::new(), "0.2.0", None);
        assert!(report.commit.is_none());
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"commit\":null"), "got {json}");
    }
}
