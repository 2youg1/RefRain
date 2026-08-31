// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

use super::align::{common_table, segment};
use super::{Id, TextRefusal};
use std::collections::HashSet;
use std::sync::Arc;

/// A non-empty manuscript slot one Proposal may replace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditScope {
    blocks: Box<[Id]>,
}

impl EditScope {
    pub fn new(blocks: Vec<Id>) -> Result<Self, TextRefusal> {
        if blocks.is_empty() {
            return Err(TextRefusal::EmptyScope);
        }
        let mut seen = HashSet::with_capacity(blocks.len());
        if let Some(block) = blocks.iter().find(|block| !seen.insert(**block)) {
            return Err(TextRefusal::DuplicateScopeBlock { block: *block });
        }
        Ok(Self {
            blocks: blocks.into_boxed_slice(),
        })
    }

    pub(crate) fn blocks(&self) -> &[Id] {
        &self.blocks
    }
}

/// Which Review Slice this is: the Proposal it came from, and its position
/// within that Proposal's sentence diff.
///
/// The ordinal here counts slices inside one Proposal. A block's ordinal
/// (`searchable_block`) counts blocks inside one document. Same word, two
/// scopes — they are never compared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ReviewSliceId {
    proposal: Id,
    ordinal: u32,
}

impl ReviewSliceId {
    /// Construct directly: verdicts cross the bridge as "<proposal>:<ordinal>"
    /// and the commit path rebuilds them exactly.
    #[must_use]
    pub fn new(proposal: Id, ordinal: u32) -> Self {
        Self { proposal, ordinal }
    }

    #[must_use]
    pub fn ordinal(self) -> u32 {
        self.ordinal
    }

    pub(crate) fn proposal(self) -> Id {
        self.proposal
    }
}

/// The role one sentence has in a Proposal diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SliceKind {
    Same,
    Delete,
    Insert,
}

impl SliceKind {
    #[must_use]
    pub fn is_changed(self) -> bool {
        self != Self::Same
    }

    #[must_use]
    pub fn is_insertion(self) -> bool {
        self == Self::Insert
    }
}

/// One sentence the author can judge without losing its whitespace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewSlice {
    id: ReviewSliceId,
    kind: SliceKind,
    text: String,
    lead: String,
    trail: String,
}

impl ReviewSlice {
    #[must_use]
    pub fn id(&self) -> ReviewSliceId {
        self.id
    }

    #[must_use]
    pub fn kind(&self) -> SliceKind {
        self.kind
    }

    #[must_use]
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The whitespace before the sentence (SPEC 7.4: it is the author's,
    /// not ours to normalise).
    #[must_use]
    pub fn lead(&self) -> &str {
        &self.lead
    }

    /// The whitespace after it.
    #[must_use]
    pub fn trail(&self) -> &str {
        &self.trail
    }
}

/// An immutable candidate frozen against one Text Head and Edit Scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    id: Id,
    run: Id,
    baseline: Id,
    scope: EditScope,
    before: String,
    after: Option<String>,
    slices: Arc<[ReviewSlice]>,
}

impl Proposal {
    #[must_use]
    pub fn new(
        run: Id,
        baseline: Id,
        scope: EditScope,
        before: String,
        after: Option<String>,
    ) -> Self {
        Self::with_id(Id::new(), run, baseline, scope, before, after)
    }

    /// A Proposal restored with its persisted id. Slices are deterministic,
    /// so the id is all a verdict needs to find its slice again after a
    /// restart (SPEC 9.7: the ledger row and the candidate re-meet exactly).
    #[must_use]
    pub fn with_id(
        id: Id,
        run: Id,
        baseline: Id,
        scope: EditScope,
        before: String,
        after: Option<String>,
    ) -> Self {
        let slices = review_slices(id, &before, after.as_deref().unwrap_or_default()).into();
        Self {
            id,
            run,
            baseline,
            scope,
            before,
            after,
            slices,
        }
    }

    #[must_use]
    pub fn id(&self) -> Id {
        self.id
    }

    #[must_use]
    pub fn run(&self) -> Id {
        self.run
    }

    #[must_use]
    pub fn after(&self) -> Option<&str> {
        self.after.as_deref()
    }

    #[must_use]
    pub fn slices(&self) -> &[ReviewSlice] {
        &self.slices
    }

    #[must_use]
    pub fn change_class(&self) -> ChangeClass {
        classify_slices(&self.slices)
    }

    /// The Text Head this candidate froze against (Q27).
    #[must_use]
    pub fn baseline(&self) -> Id {
        self.baseline
    }

    pub(crate) fn scope(&self) -> &EditScope {
        &self.scope
    }

    /// The manuscript text in scope, exactly as frozen.
    #[must_use]
    pub fn before(&self) -> &str {
        &self.before
    }
}

#[derive(Debug, Clone)]
struct Sentence {
    text: String,
    lead: String,
    trail: String,
}

fn sentences(text: &str) -> Vec<Sentence> {
    let mut found = Vec::new();
    let mut raw_start = 0;
    let mut content_cursor = 0;

    while raw_start < text.len() {
        let mut raw_end = text.len();
        for (offset, character) in text[raw_start..].char_indices() {
            if !is_terminator(character) {
                continue;
            }
            raw_end = raw_start + offset + character.len_utf8();
            for following in text[raw_end..].chars() {
                if !is_terminator(following) && !is_closer(following) {
                    break;
                }
                raw_end += following.len_utf8();
            }
            break;
        }

        let raw = &text[raw_start..raw_end];
        if let Some((trim_start, trim_end)) = trim_bounds(raw) {
            let absolute_start = raw_start + trim_start;
            let absolute_end = raw_start + trim_end;
            found.push(Sentence {
                text: text[absolute_start..absolute_end].to_owned(),
                lead: text[content_cursor..absolute_start].to_owned(),
                trail: String::new(),
            });
            content_cursor = absolute_end;
        }
        if raw_end == text.len() {
            break;
        }
        raw_start = raw_end;
    }

    if let Some(last) = found.last_mut() {
        last.trail = text[content_cursor..].to_owned();
    }
    found
}

fn trim_bounds(text: &str) -> Option<(usize, usize)> {
    let start = text
        .char_indices()
        .find(|(_, character)| !character.is_whitespace())?
        .0;
    let (end, character) = text
        .char_indices()
        .rev()
        .find(|(_, character)| !character.is_whitespace())?;
    Some((start, end + character.len_utf8()))
}

fn is_terminator(character: char) -> bool {
    matches!(character, '。' | '！' | '？' | '…' | '!' | '?' | '.')
}

fn is_closer(character: char) -> bool {
    matches!(character, '"' | '\'' | '”' | '’' | ')' | '）' | '」' | '』')
}

fn review_slices(proposal: Id, before: &str, after: &str) -> Vec<ReviewSlice> {
    let before = sentences(before);
    let after = sentences(after);
    let before_keys = before
        .iter()
        .map(|sentence| sentence.text.as_str())
        .collect::<Vec<_>>();
    let after_keys = after
        .iter()
        .map(|sentence| sentence.text.as_str())
        .collect::<Vec<_>>();
    let mut slices = Vec::new();

    for region in segment(&before_keys, &after_keys) {
        if region.anchor {
            for sentence in &before[region.before] {
                emit(&mut slices, proposal, SliceKind::Same, sentence);
            }
        } else {
            align_region(
                &before[region.before],
                &after[region.after],
                proposal,
                &mut slices,
            );
        }
    }
    slices
}

fn align_region(
    before: &[Sentence],
    after: &[Sentence],
    proposal: Id,
    slices: &mut Vec<ReviewSlice>,
) {
    let before_keys = before
        .iter()
        .map(|sentence| sentence.text.as_str())
        .collect::<Vec<_>>();
    let after_keys = after
        .iter()
        .map(|sentence| sentence.text.as_str())
        .collect::<Vec<_>>();
    let Some(common) = common_table(&before_keys, &after_keys) else {
        for sentence in before {
            emit(slices, proposal, SliceKind::Delete, sentence);
        }
        for sentence in after {
            emit(slices, proposal, SliceKind::Insert, sentence);
        }
        return;
    };

    let mut left = 0;
    let mut right = 0;
    while left < before.len() && right < after.len() {
        if before[left].text == after[right].text {
            emit(slices, proposal, SliceKind::Same, &before[left]);
            left += 1;
            right += 1;
        } else if common.get(left + 1, right) >= common.get(left, right + 1) {
            emit(slices, proposal, SliceKind::Delete, &before[left]);
            left += 1;
        } else {
            emit(slices, proposal, SliceKind::Insert, &after[right]);
            right += 1;
        }
    }
    for sentence in &before[left..] {
        emit(slices, proposal, SliceKind::Delete, sentence);
    }
    for sentence in &after[right..] {
        emit(slices, proposal, SliceKind::Insert, sentence);
    }
}

fn emit(slices: &mut Vec<ReviewSlice>, proposal: Id, kind: SliceKind, sentence: &Sentence) {
    slices.push(ReviewSlice {
        id: ReviewSliceId {
            proposal,
            ordinal: slices.len() as u32,
        },
        kind,
        text: sentence.text.clone(),
        lead: sentence.lead.clone(),
        trail: sentence.trail.clone(),
    });
}

/// Whether a change can enter the formatting-only bulk path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeClass {
    Formatting,
    Semantic,
}

#[must_use]
pub fn classify_change(before: &str, after: &str) -> ChangeClass {
    if skeleton(before) == skeleton(after) && punctuation_shape(before) == punctuation_shape(after)
    {
        ChangeClass::Formatting
    } else {
        ChangeClass::Semantic
    }
}

fn classify_slices(slices: &[ReviewSlice]) -> ChangeClass {
    let removed = slices
        .iter()
        .enumerate()
        .filter(|(_, slice)| slice.kind == SliceKind::Delete)
        .collect::<Vec<_>>();
    let added = slices
        .iter()
        .enumerate()
        .filter(|(_, slice)| slice.kind == SliceKind::Insert)
        .collect::<Vec<_>>();
    if removed.len() != added.len() {
        return ChangeClass::Semantic;
    }
    for ((removed_at, removed), (added_at, added)) in removed.into_iter().zip(added) {
        let between = if removed_at < added_at {
            removed_at + 1..added_at
        } else {
            added_at + 1..removed_at
        };
        if slices[between]
            .iter()
            .any(|slice| slice.kind == SliceKind::Same)
            || classify_change(&removed.text, &added.text) != ChangeClass::Formatting
        {
            return ChangeClass::Semantic;
        }
    }
    ChangeClass::Formatting
}

fn skeleton(text: &str) -> String {
    text.chars()
        .filter(|character| !is_cosmetic(*character))
        .collect()
}

fn punctuation_shape(text: &str) -> String {
    let mut shape = Vec::new();
    let mut semantic_position = 0;
    for character in normalised_punctuation(text) {
        if is_spacing(character) {
            continue;
        }
        if is_punctuation(character) {
            shape.push(format!(
                "{semantic_position}:{}",
                punctuation_class(character)
            ));
        } else {
            semantic_position += 1;
        }
    }
    shape.join("|")
}

fn normalised_punctuation(text: &str) -> Vec<char> {
    let characters = text.chars().collect::<Vec<_>>();
    let mut output = Vec::new();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character == '…' {
            output.push('…');
            while characters.get(index + 1) == Some(&'…') {
                index += 1;
            }
        } else if character == '.' && characters.get(index + 1) == Some(&'.') {
            output.push('…');
            while characters.get(index + 1) == Some(&'.') {
                index += 1;
            }
        } else {
            output.push(character);
        }
        index += 1;
    }
    output
}

fn is_spacing(character: char) -> bool {
    character.is_whitespace() || matches!(character, '\u{200b}' | '\u{feff}')
}

fn is_cosmetic(character: char) -> bool {
    is_spacing(character) || is_punctuation(character)
}

fn is_punctuation(character: char) -> bool {
    ",.;:!?'\"()[]{}-–—…、。，；：！？「」『』（）《》〈〉·・".contains(character)
}

fn punctuation_class(character: char) -> &'static str {
    if ",，、".contains(character) {
        "comma"
    } else if ".。".contains(character) {
        "stop"
    } else if ";；".contains(character) {
        "semicolon"
    } else if ":：".contains(character) {
        "colon"
    } else if "!！".contains(character) {
        "exclamation"
    } else if "?？".contains(character) {
        "question"
    } else if "\"“”「」".contains(character) {
        "double-quote"
    } else if "'‘’『』".contains(character) {
        "single-quote"
    } else if "(（[【{《〈".contains(character) {
        "open"
    } else if ")）]】}》〉".contains(character) {
        "close"
    } else if "-–—".contains(character) {
        "dash"
    } else if "·・".contains(character) {
        "middle-dot"
    } else {
        "ellipsis"
    }
}
