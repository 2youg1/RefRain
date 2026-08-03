//! Document lifecycle owned by the application layer.
//!
//! Opening, continuity hydration, journal replay, material creation, and save
//! confirmation all cross both the domain and store. Keeping that sequence here
//! prevents Desktop and Native adapters from becoming competing authorities.

use crate::application::ProjectEntry;
use crate::journal::{into_domain, into_domain_store, parse_id};
use refrain_core::{
    BlockScan, DocumentFormat, EditorAction, EditorChange, ErrorCode, Id, Insertion, Lineage,
    Manuscript, RefrainError, Replacement, SourceSnapshot, TextCommand, TextTransition,
};
use refrain_store::history::HYDRATION_DEPTH;
use refrain_store::project::{
    DocumentCommit, DocumentRow, FileStamp, OpenDocument, ProjectFailure,
};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenDocumentDto {
    pub document: DocumentRow,
    pub format: DocumentFormat,
    pub revision: String,
    pub blocks: Vec<BlockDto>,
    pub stamp: FileStamp,
    pub replayed: u32,
    pub stale_journal: Vec<String>,
    pub kara: Option<refrain_core::KaraTransition>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlockDto {
    pub id: String,
    pub text: String,
    pub width_units: u32,
    pub hard_lines: u32,
    pub max_line_units: u32,
    pub is_fence: bool,
}

impl BlockDto {
    pub fn of(block: &refrain_core::manuscript::Block, scan: BlockScan) -> Self {
        let text = block.text();
        let shape = refrain_core::block_shape::BlockShape::of(text);
        let is_fence = matches!(scan, BlockScan::Markdown)
            && shape.kind == refrain_core::block_shape::BlockKind::Fence;
        Self {
            id: block.id().to_string(),
            text: text.to_owned(),
            width_units: shape.width_units,
            hard_lines: shape.hard_lines,
            max_line_units: shape.max_line_units,
            is_fence,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorActionDto {
    pub base: String,
    pub changes: Vec<EditorChangeDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum EditorChangeDto {
    Replace {
        blocks: Vec<String>,
        text: Option<String>,
    },
    Insert {
        before: Option<String>,
        texts: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextTransitionDto {
    pub revision: String,
    pub action_id: String,
    pub touched_blocks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum SaveOutcomeDto {
    Saved {
        stamp: FileStamp,
        #[serde(rename = "recoveryEvidence")]
        recovery_evidence: Option<String>,
    },
    ChangedUnderneath {
        #[serde(rename = "onDisk")]
        on_disk: String,
        stamp: FileStamp,
    },
}

pub(crate) struct ImportedFrom<'a> {
    pub digest: &'a str,
    pub format: &'a str,
}

pub(crate) fn open_in_entry(
    entry: &mut ProjectEntry,
    path: &str,
    opened: OpenDocument,
    kara: Option<refrain_core::KaraTransition>,
) -> Result<OpenDocumentDto, RefrainError> {
    let scan = DocumentFormat::of_path(path).block_scan();
    let snapshot =
        SourceSnapshot::read_checked_with(opened.bytes.clone(), scan).map_err(|error| {
            RefrainError::new(ErrorCode::UnsupportedFormat, "open a document", path)
                .with_detail(format!("not UTF-8 text: {error}"))
        })?;
    let block_count = snapshot.block_count();
    let continuity = match (
        &opened.row.current_head,
        &opened.row.head_block_ids,
        &opened.row.digest,
    ) {
        (Some(head), Some(ids), Some(digest)) if digest == &opened.stamp.digest => {
            let ids: Vec<Id> = serde_json::from_str(ids).unwrap_or_default();
            if ids.len() == block_count {
                parse_id(head, "current head")
                    .ok()
                    .map(|head| (head, Lineage::from_ids(ids)))
            } else {
                None
            }
        }
        _ => None,
    };
    let history = match &continuity {
        Some((head, _)) => entry
            .store
            .action_history()
            .chain(path, *head, HYDRATION_DEPTH)
            .map_err(into_domain_store)?,
        None => Vec::new(),
    };
    let (mut manuscript, continuity_ok) = match continuity {
        Some((head, lineage)) => (
            Manuscript::open_at(snapshot, lineage, head, history).map_err(|error| {
                RefrainError::new(ErrorCode::Io, "resume a manuscript", path)
                    .with_detail(error.to_string())
            })?,
            true,
        ),
        None => (
            Manuscript::open(snapshot, Lineage::fresh(block_count)).map_err(|error| {
                RefrainError::new(ErrorCode::Io, "open a manuscript", path)
                    .with_detail(error.to_string())
            })?,
            false,
        ),
    };

    let mut replayed = 0_u32;
    let mut stale_journal = Vec::new();
    for (journal_id, action_json) in entry.store.journal_take(path).map_err(into_domain)? {
        if !continuity_ok {
            stale_journal.push(action_json);
            continue;
        }
        let input: EditorActionDto = match serde_json::from_str(&action_json) {
            Ok(input) => input,
            Err(_) => {
                stale_journal.push(action_json);
                continue;
            }
        };
        match to_domain_action(input, scan) {
            Ok(action) => match manuscript.execute(TextCommand::Editor(action)) {
                Ok(transition) => {
                    record_text_action(&entry.store, path, &transition)?;
                    entry
                        .store
                        .journal_remove(journal_id)
                        .map_err(into_domain)?;
                    replayed += 1;
                }
                Err(_) => stale_journal.push(action_json),
            },
            Err(_) => stale_journal.push(action_json),
        }
    }

    let revision = manuscript.head().id().to_string();
    let blocks = manuscript
        .head()
        .blocks()
        .iter()
        .map(|block| BlockDto::of(block, scan))
        .collect();
    entry.manuscripts.insert(path.to_string(), manuscript);
    Ok(OpenDocumentDto {
        document: opened.row,
        format: DocumentFormat::of_path(path),
        revision,
        blocks,
        stamp: opened.stamp,
        replayed,
        stale_journal,
        kara,
    })
}

pub(crate) fn create_with_body(
    entry: &mut ProjectEntry,
    title: &str,
    body: &str,
    role: refrain_core::DocumentRole,
    imported_from: Option<ImportedFrom<'_>>,
    kara: Option<refrain_core::KaraTransition>,
) -> Result<(DocumentRow, OpenDocumentDto), RefrainError> {
    let created = entry
        .store
        .create(&refrain_store::project::CreateDocument {
            title: title.to_string(),
            role,
        })
        .map_err(into_domain)?;
    let path = created.row.path.clone();
    let opened = open_in_entry(entry, &path, created, kara)?;
    let paragraphs: Vec<String> = body
        .split("\n\n")
        .map(str::trim)
        .filter(|paragraph| !paragraph.is_empty())
        .map(str::to_string)
        .collect();
    if !paragraphs.is_empty() {
        let base = entry
            .manuscripts
            .get(&path)
            .map(|manuscript| manuscript.head().id().to_string())
            .ok_or_else(|| not_open("write a document that is not open", &path))?;
        let input = EditorActionDto {
            base,
            changes: vec![EditorChangeDto::Insert {
                before: None,
                texts: paragraphs,
            }],
        };
        let action_json = serde_json::to_string(&input).map_err(|error| {
            RefrainError::new(ErrorCode::Io, "serialise an imported body", &path)
                .with_detail(error.to_string())
        })?;
        let journal_id = entry
            .store
            .journal_append(&path, &action_json)
            .map_err(into_domain)?;
        let action = to_domain_action(input, DocumentFormat::of_path(&path).block_scan())?;
        let transition = entry
            .manuscripts
            .get_mut(&path)
            .ok_or_else(|| not_open("write a document that is not open", &path))?
            .execute(TextCommand::Editor(action))
            .map_err(|refusal| {
                RefrainError::new(ErrorCode::Io, "write an imported body", &path)
                    .with_detail(refusal.to_string())
            })?;
        record_text_action(&entry.store, &path, &transition)?;
        entry
            .store
            .journal_remove(journal_id)
            .map_err(into_domain)?;
    }
    match persist_in_entry(entry, &path, None)? {
        SaveOutcomeDto::Saved { .. } => {}
        SaveOutcomeDto::ChangedUnderneath { .. } => {
            return Err(RefrainError::new(
                ErrorCode::Io,
                "confirm an imported document",
                "the file moved underneath",
            ));
        }
    }
    let row = if let Some(source) = imported_from {
        let row = DocumentRow {
            source_digest: Some(source.digest.to_string()),
            source_format: Some(source.format.to_string()),
            ..opened.document.clone()
        };
        entry
            .store
            .record_imported_source(&row.path, source.digest, source.format)
            .map_err(into_domain)?;
        row
    } else {
        opened.document.clone()
    };
    let opened = refresh_open_view(entry, opened)?;
    Ok((row, opened))
}

fn refresh_open_view(
    entry: &ProjectEntry,
    mut opened: OpenDocumentDto,
) -> Result<OpenDocumentDto, RefrainError> {
    let manuscript = entry
        .manuscripts
        .get(&opened.document.path)
        .ok_or_else(|| not_open("project an open document", &opened.document.path))?;
    opened.revision = manuscript.head().id().to_string();
    opened.blocks = manuscript
        .head()
        .blocks()
        .iter()
        .map(|block| BlockDto::of(block, manuscript.scan()))
        .collect();
    Ok(opened)
}

pub(crate) fn persist_in_entry(
    entry: &mut ProjectEntry,
    path: &str,
    expected: Option<FileStamp>,
) -> Result<SaveOutcomeDto, RefrainError> {
    let (bytes, lineage, head, live) = {
        let manuscript = entry
            .manuscripts
            .get(path)
            .ok_or_else(|| not_open("save a document that is not open", path))?;
        let bytes = manuscript.materialize().map_err(|error| {
            RefrainError::new(ErrorCode::Io, "materialise a manuscript", path)
                .with_detail(error.to_string())
        })?;
        let live = manuscript
            .actions()
            .iter()
            .map(refrain_core::TextAction::id)
            .collect::<Vec<_>>();
        (
            bytes,
            manuscript.lineage_ids(),
            manuscript.head().id(),
            live,
        )
    };
    let committed = match entry.store.commit(&DocumentCommit {
        path: path.to_string(),
        bytes,
        expected,
    }) {
        Ok(outcome) => outcome,
        Err(ProjectFailure::ChangedUnderneath(conflict)) => {
            return Ok(SaveOutcomeDto::ChangedUnderneath {
                on_disk: String::from_utf8_lossy(&conflict.on_disk).into_owned(),
                stamp: conflict.stamp,
            });
        }
        Err(other) => return Err(into_domain(other)),
    };
    entry
        .store
        .save_continuity(
            path,
            &head.to_string(),
            &serde_json::to_string(&lineage).map_err(|error| {
                RefrainError::new(ErrorCode::Io, "serialise a lineage", path)
                    .with_detail(error.to_string())
            })?,
        )
        .map_err(into_domain)?;
    entry
        .store
        .action_history()
        .sync_chain(path, &live)
        .map_err(into_domain_store)?;
    Ok(SaveOutcomeDto::Saved {
        stamp: committed.stamp,
        recovery_evidence: committed
            .recovery_evidence
            .map(|path| path.display().to_string()),
    })
}

pub fn to_domain_action(
    input: EditorActionDto,
    scan: BlockScan,
) -> Result<EditorAction, RefrainError> {
    let base = parse_id(&input.base, "action base")?;
    let changes = input
        .changes
        .into_iter()
        .map(|change| match change {
            EditorChangeDto::Replace { blocks, text } => {
                let blocks = blocks
                    .iter()
                    .map(|raw| parse_id(raw, "replacement block"))
                    .collect::<Result<Vec<_>, _>>()?;
                Replacement::new(blocks, text)
                    .map(EditorChange::Replace)
                    .map_err(|error| {
                        RefrainError::new(ErrorCode::Io, "build a replacement", "")
                            .with_detail(error.to_string())
                    })
            }
            EditorChangeDto::Insert { before, texts } => {
                let before = before
                    .as_deref()
                    .map(|raw| parse_id(raw, "insertion boundary"))
                    .transpose()?;
                Insertion::new(before, texts, scan)
                    .map(EditorChange::Insert)
                    .map_err(|error| {
                        RefrainError::new(ErrorCode::Io, "build an insertion", "")
                            .with_detail(error.to_string())
                    })
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(EditorAction::new(base, changes, "author edit"))
}

pub fn transition_dto(transition: &TextTransition) -> TextTransitionDto {
    TextTransitionDto {
        revision: transition.head().id().to_string(),
        action_id: transition.action().id().to_string(),
        touched_blocks: transition
            .action()
            .touched_blocks()
            .iter()
            .map(Id::to_string)
            .collect(),
    }
}

pub(crate) fn record_text_action(
    store: &refrain_store::project::ProjectStore,
    path: &str,
    transition: &TextTransition,
) -> Result<(), RefrainError> {
    store
        .action_history()
        .record(path, transition.action(), transition.head().id())
        .map_err(into_domain_store)
}

fn not_open(action: &'static str, path: &str) -> RefrainError {
    RefrainError::new(ErrorCode::StateUnavailable, action, path.to_string())
}
