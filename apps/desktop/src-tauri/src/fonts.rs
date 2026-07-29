use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use refrain_store::config::FontSlot;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FontFamilyDto {
    pub family: String,
    pub weights: Vec<u16>,
    pub bundled_slot: Option<FontSlot>,
}

#[derive(Debug, Default)]
pub struct FontCatalog {
    cached: OnceLock<Vec<FontFamilyDto>>,
}

impl FontCatalog {
    pub fn list(&self) -> Vec<FontFamilyDto> {
        self.list_with(scan_system_fonts)
    }

    fn list_with(&self, scan: impl FnOnce() -> Vec<FontFamilyDto>) -> Vec<FontFamilyDto> {
        self.cached.get_or_init(scan).clone()
    }
}

fn scan_system_fonts() -> Vec<FontFamilyDto> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    catalog_from_faces(database.faces().flat_map(|face| {
        let weight = face.weight.0;
        face.families
            .iter()
            .map(move |(family, _language)| (family.clone(), weight))
    }))
}

fn catalog_from_faces(faces: impl IntoIterator<Item = (String, u16)>) -> Vec<FontFamilyDto> {
    let mut families: BTreeMap<String, (BTreeSet<u16>, Option<FontSlot>)> = BTreeMap::new();
    for (family, weight) in faces {
        if family.trim().is_empty()
            || family.chars().any(char::is_control)
            || family.contains(['"', '\'', '\\', ';'])
        {
            continue;
        }
        families.entry(family).or_default().0.insert(weight);
    }
    for (family, slot, weights) in bundled_faces() {
        let entry = families.entry(family.to_string()).or_default();
        entry.0.extend(weights);
        entry.1 = Some(slot);
    }

    let mut catalog: Vec<_> = families
        .into_iter()
        .map(|(family, (weights, bundled_slot))| FontFamilyDto {
            family,
            weights: weights.into_iter().collect(),
            bundled_slot,
        })
        .collect();
    catalog.sort_by(|left, right| {
        left.family
            .to_lowercase()
            .cmp(&right.family.to_lowercase())
            .then_with(|| left.family.cmp(&right.family))
    });
    catalog
}

fn bundled_faces() -> [(&'static str, FontSlot, Vec<u16>); 8] {
    let variable = |min: u16, max: u16| (min..=max).step_by(100).collect();
    [
        ("Antic Didone", FontSlot::Latin, vec![400]),
        ("Jost", FontSlot::Latin, variable(100, 900)),
        ("Courier Prime", FontSlot::Latin, vec![400]),
        ("Chiron Sung HK", FontSlot::Chinese, variable(200, 900)),
        ("Noto Sans SC", FontSlot::Chinese, vec![400]),
        ("Shippori Mincho", FontSlot::Japanese, vec![400]),
        ("Zen Kaku Gothic New", FontSlot::Japanese, vec![400]),
        ("Murecho", FontSlot::Japanese, variable(100, 900)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn font_catalog_deduplicates_families_collects_real_weights_and_adds_bundled_faces() {
        let catalog = catalog_from_faces([
            ("Baskerville".to_string(), 400),
            ("Baskerville".to_string(), 700),
            ("Arial".to_string(), 400),
            ("".to_string(), 400),
        ]);

        assert_eq!(catalog[0].family, "Antic Didone");
        let baskerville = catalog
            .iter()
            .find(|entry| entry.family == "Baskerville")
            .unwrap();
        assert_eq!(baskerville.weights, [400, 700]);
        assert!(baskerville.bundled_slot.is_none());
        assert_eq!(
            catalog
                .iter()
                .filter(|entry| entry.bundled_slot.is_some())
                .count(),
            8
        );
        assert!(catalog.windows(2).all(|pair| {
            pair[0]
                .family
                .to_lowercase()
                .cmp(&pair[1].family.to_lowercase())
                .is_le()
        }));
    }

    #[test]
    fn font_catalog_scans_only_once_for_the_application_session() {
        let catalog = FontCatalog::default();
        let scans = AtomicUsize::new(0);

        let first = catalog.list_with(|| {
            scans.fetch_add(1, Ordering::Relaxed);
            catalog_from_faces([("First".to_string(), 400)])
        });
        let second = catalog.list_with(|| {
            scans.fetch_add(1, Ordering::Relaxed);
            catalog_from_faces([("Second".to_string(), 400)])
        });

        assert_eq!(scans.load(Ordering::Relaxed), 1);
        assert_eq!(first, second);
        assert!(first.iter().any(|entry| entry.family == "First"));
        assert!(!second.iter().any(|entry| entry.family == "Second"));
    }
}
