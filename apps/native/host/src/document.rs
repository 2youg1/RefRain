use crate::protocol::{
    API_VERSION, CAPABILITY_MASK, DEFAULT_VIEWPORT_BLOCKS, ERROR_DOMAIN_REFUSAL,
    ERROR_HOST_FAILURE, ERROR_INVALID_REQUEST, ERROR_PROTOCOL_MISMATCH, ERROR_STALE_REVISION,
    ERROR_UNKNOWN_SESSION, EVENT_TEXT_BYTES, PROJECTION_BYTES, PROTOCOL_VERSION,
    RefrainNativeRequest, RefrainNativeResponse,
};
use refrain_app::native_document::{
    ByteSelection, CaretDirection, DocumentError, DocumentInput, DocumentOpen, DocumentProjection,
    DocumentSurface, DocumentViewport,
};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[repr(u16)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DispatchAction {
    Health = 1,
    OpenManuscript = 2,
    ApplyInput = 3,
    Project = 4,
}

impl TryFrom<u16> for DispatchAction {
    type Error = ();

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Health),
            2 => Ok(Self::OpenManuscript),
            3 => Ok(Self::ApplyInput),
            4 => Ok(Self::Project),
            _ => Err(()),
        }
    }
}

#[repr(u16)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InputKind {
    SetSelection = 1,
    InsertText = 2,
    DeleteBackward = 3,
    DeleteForward = 4,
    DeleteWordBackward = 5,
    DeleteWordForward = 6,
    Clear = 7,
    MoveCaret = 8,
    SetComposition = 9,
    CommitComposition = 10,
    CancelComposition = 11,
    Undo = 12,
}

impl TryFrom<u16> for InputKind {
    type Error = ();

    fn try_from(value: u16) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::SetSelection),
            2 => Ok(Self::InsertText),
            3 => Ok(Self::DeleteBackward),
            4 => Ok(Self::DeleteForward),
            5 => Ok(Self::DeleteWordBackward),
            6 => Ok(Self::DeleteWordForward),
            7 => Ok(Self::Clear),
            8 => Ok(Self::MoveCaret),
            9 => Ok(Self::SetComposition),
            10 => Ok(Self::CommitComposition),
            11 => Ok(Self::CancelComposition),
            12 => Ok(Self::Undo),
            _ => Err(()),
        }
    }
}

#[derive(Default)]
struct Sessions {
    next: u64,
    documents: HashMap<u64, DocumentSurface>,
}

static SESSIONS: OnceLock<Mutex<Sessions>> = OnceLock::new();

enum DispatchError {
    InvalidRequest,
    Domain(DocumentError),
}

impl From<DocumentError> for DispatchError {
    fn from(error: DocumentError) -> Self {
        Self::Domain(error)
    }
}

pub fn dispatch(request: RefrainNativeRequest) -> RefrainNativeResponse {
    if request.protocol_version != PROTOCOL_VERSION {
        return RefrainNativeResponse::empty(ERROR_PROTOCOL_MISMATCH, request.action);
    }
    let Ok(action) = DispatchAction::try_from(request.action) else {
        return RefrainNativeResponse::empty(ERROR_INVALID_REQUEST, request.action);
    };
    if action == DispatchAction::Health {
        return RefrainNativeResponse::empty(0, request.action);
    }

    let sessions = SESSIONS.get_or_init(|| Mutex::new(Sessions::default()));
    let Ok(mut sessions) = sessions.lock() else {
        return RefrainNativeResponse::empty(ERROR_HOST_FAILURE, request.action);
    };
    if action == DispatchAction::OpenManuscript {
        return open_manuscript(&mut sessions, request);
    }
    let Some(document) = sessions.documents.get_mut(&request.session) else {
        return RefrainNativeResponse::empty(ERROR_UNKNOWN_SESSION, request.action);
    };

    if action == DispatchAction::ApplyInput && request.revision != revision_of(document) {
        return projection_response(
            request.session,
            request.action,
            document,
            &request,
            ERROR_STALE_REVISION,
        );
    }
    if action == DispatchAction::ApplyInput {
        let result = input_of(&request).and_then(|input| document.apply(input).map_err(Into::into));
        match result {
            Ok(())
            | Err(DispatchError::Domain(DocumentError::Text(
                refrain_core::TextRefusal::NothingChanged,
            ))) => {}
            Err(DispatchError::InvalidRequest) => {
                return projection_response(
                    request.session,
                    request.action,
                    document,
                    &request,
                    ERROR_INVALID_REQUEST,
                );
            }
            Err(DispatchError::Domain(_)) => {
                return projection_response(
                    request.session,
                    request.action,
                    document,
                    &request,
                    ERROR_DOMAIN_REFUSAL,
                );
            }
        }
    }
    projection_response(request.session, request.action, document, &request, 0)
}

fn open_manuscript(
    sessions: &mut Sessions,
    request: RefrainNativeRequest,
) -> RefrainNativeResponse {
    let Ok(document) = DocumentSurface::open(DocumentOpen::ScaleFixture) else {
        return RefrainNativeResponse::empty(ERROR_HOST_FAILURE, request.action);
    };
    let Some(session) = sessions.next.checked_add(1) else {
        return RefrainNativeResponse::empty(ERROR_HOST_FAILURE, request.action);
    };
    sessions.next = session;
    let response = projection_response(session, request.action, &document, &request, 0);
    sessions.documents.insert(session, document);
    response
}

fn input_of(request: &RefrainNativeRequest) -> Result<DocumentInput, DispatchError> {
    let input = InputKind::try_from(request.input).map_err(|_| DispatchError::InvalidRequest)?;
    Ok(match input {
        InputKind::SetSelection => DocumentInput::SetSelection(ByteSelection {
            anchor: global_offset(request.window_start, request.anchor)?,
            focus: global_offset(request.window_start, request.focus)?,
        }),
        InputKind::InsertText => DocumentInput::InsertText(text(request)?.to_owned()),
        InputKind::DeleteBackward => DocumentInput::DeleteBackward,
        InputKind::DeleteForward => DocumentInput::DeleteForward,
        InputKind::DeleteWordBackward => DocumentInput::DeleteWordBackward,
        InputKind::DeleteWordForward => DocumentInput::DeleteWordForward,
        InputKind::Clear => DocumentInput::Clear,
        InputKind::MoveCaret => DocumentInput::MoveCaret {
            direction: match request.flags & 0xff {
                1 => CaretDirection::Previous,
                2 => CaretDirection::Next,
                3 => CaretDirection::PreviousWord,
                4 => CaretDirection::NextWord,
                5 => CaretDirection::Start,
                6 => CaretDirection::End,
                _ => return Err(DispatchError::InvalidRequest),
            },
            extend: request.flags & 0x100 != 0,
        },
        InputKind::SetComposition => DocumentInput::SetComposition {
            text: text(request)?.to_owned(),
            cursor: to_usize(request.cursor)?,
        },
        InputKind::CommitComposition => DocumentInput::CommitComposition,
        InputKind::CancelComposition => DocumentInput::CancelComposition,
        InputKind::Undo => DocumentInput::Undo,
    })
}

fn projection_response(
    session: u64,
    action: u16,
    document: &DocumentSurface,
    request: &RefrainNativeRequest,
    status: u32,
) -> RefrainNativeResponse {
    let viewport = DocumentViewport {
        first_block: match to_usize(request.viewport_first_block) {
            Ok(value) => value,
            Err(_) => return RefrainNativeResponse::empty(ERROR_INVALID_REQUEST, action),
        },
        block_count: usize::try_from(if request.viewport_block_count == 0 {
            DEFAULT_VIEWPORT_BLOCKS
        } else {
            request.viewport_block_count
        })
        .unwrap_or(usize::MAX),
        max_bytes: PROJECTION_BYTES,
    };
    let Ok(projection) = document.project(viewport) else {
        return RefrainNativeResponse::empty(ERROR_HOST_FAILURE, action);
    };
    fill_projection(session, action, status, projection)
}

fn fill_projection(
    session: u64,
    action: u16,
    status: u32,
    projection: DocumentProjection,
) -> RefrainNativeResponse {
    let mut response = RefrainNativeResponse::empty(status, action);
    response.api_version = API_VERSION;
    response.capabilities = CAPABILITY_MASK;
    response.session = session;
    response.revision = projection.revision;
    response.total_bytes = projection.total_bytes as u64;
    response.total_blocks = projection.total_blocks as u64;
    response.window_start = projection.window_start as u64;
    response.first_block = projection.first_block as u64;
    response.block_count = projection.block_count as u32;
    response.text_len = projection.text.len() as u32;
    response.text[..projection.text.len()].copy_from_slice(projection.text.as_bytes());
    response.selection_anchor = projection.selection.anchor as u64;
    response.selection_focus = projection.selection.focus as u64;
    if let Some(composition) = projection.composition {
        response.composition_start = composition.range.start as u64;
        response.composition_end = composition.range.end as u64;
        response.composition_cursor = composition.cursor as u64;
        response.composition_len = composition.text.len() as u32;
        response.composition[..composition.text.len()].copy_from_slice(composition.text.as_bytes());
    }
    response
}

fn revision_of(document: &DocumentSurface) -> u64 {
    document
        .project(DocumentViewport {
            first_block: 0,
            block_count: 0,
            max_bytes: 0,
        })
        .map_or(u64::MAX, |projection| projection.revision)
}

fn text(request: &RefrainNativeRequest) -> Result<&str, DispatchError> {
    let length = usize::try_from(request.text_len).map_err(|_| DispatchError::InvalidRequest)?;
    if length > EVENT_TEXT_BYTES {
        return Err(DispatchError::InvalidRequest);
    }
    std::str::from_utf8(&request.text[..length]).map_err(|_| DispatchError::InvalidRequest)
}

fn global_offset(window_start: u64, local: u64) -> Result<usize, DispatchError> {
    to_usize(
        window_start
            .checked_add(local)
            .ok_or(DispatchError::InvalidRequest)?,
    )
}

fn to_usize(value: u64) -> Result<usize, DispatchError> {
    usize::try_from(value).map_err(|_| DispatchError::InvalidRequest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use refrain_app::native_document::{DOCUMENT_FIXTURE_BLOCKS, DOCUMENT_FIXTURE_BYTES};

    fn request(action: DispatchAction) -> RefrainNativeRequest {
        RefrainNativeRequest {
            protocol_version: PROTOCOL_VERSION,
            action: action as u16,
            input: 0,
            flags: 0,
            session: 0,
            revision: 0,
            window_start: 0,
            anchor: 0,
            focus: 0,
            cursor: 0,
            viewport_first_block: 0,
            viewport_block_count: 32,
            text_len: 0,
            text: [0; EVENT_TEXT_BYTES],
        }
    }

    fn apply(session: u64, revision: u64, input: InputKind) -> RefrainNativeRequest {
        let mut request = request(DispatchAction::ApplyInput);
        request.session = session;
        request.revision = revision;
        request.input = input as u16;
        request
    }

    #[test]
    fn one_dispatch_opens_projects_edits_composes_and_undoes_one_rust_document() {
        let health = dispatch(request(DispatchAction::Health));
        assert_eq!(health.status, 0);
        assert_eq!(health.api_version, API_VERSION);

        let opened = dispatch(request(DispatchAction::OpenManuscript));
        assert_eq!(opened.status, 0);
        assert!(opened.session > 0);
        assert_eq!(opened.total_bytes, DOCUMENT_FIXTURE_BYTES as u64);
        assert_eq!(opened.total_blocks, DOCUMENT_FIXTURE_BLOCKS as u64);
        assert_eq!(opened.first_block, 0);
        assert_eq!(opened.block_count, 32);
        assert!((opened.text_len as usize) < PROJECTION_BYTES);
        assert_eq!(&opened.text[9..15], "中文".as_bytes());

        let mut selected = apply(opened.session, opened.revision, InputKind::SetSelection);
        selected.anchor = 0;
        selected.focus = 6;
        let selected = dispatch(selected);
        assert_eq!(selected.status, 0);

        let mut composition = apply(opened.session, selected.revision, InputKind::SetComposition);
        let preedit = "入力".as_bytes();
        composition.text_len = preedit.len() as u32;
        composition.cursor = preedit.len() as u64;
        composition.text[..preedit.len()].copy_from_slice(preedit);
        let composition = dispatch(composition);
        assert_eq!(composition.status, 0);
        assert_eq!(
            dispatch(apply(
                opened.session,
                composition.revision,
                InputKind::CommitComposition,
            ))
            .status,
            0
        );

        let mut project = request(DispatchAction::Project);
        project.session = opened.session;
        let edited = dispatch(project);
        assert_eq!(&edited.text[..preedit.len()], preedit);
        let undone = dispatch(apply(opened.session, edited.revision, InputKind::Undo));
        assert_eq!(undone.status, 0);
        assert_eq!(&undone.text[..6], b"000000");
    }

    #[test]
    fn viewport_and_revision_are_real_inputs_not_fixed_fixture_metadata() {
        let opened = dispatch(request(DispatchAction::OpenManuscript));
        let mut middle_request = request(DispatchAction::Project);
        middle_request.session = opened.session;
        middle_request.viewport_first_block = 50_000;
        middle_request.viewport_block_count = 24;
        let middle = dispatch(middle_request);
        assert_eq!(middle.status, 0);
        assert_eq!(middle.first_block, 50_000);
        assert_eq!(middle.block_count, 24);
        assert!(middle.window_start > opened.text_len as u64);
        assert_ne!(&middle.text[..16], &opened.text[..16]);

        let stale = dispatch(apply(opened.session, opened.revision + 1, InputKind::Undo));
        assert_eq!(stale.status, ERROR_STALE_REVISION);
        assert_eq!(stale.revision, opened.revision);
    }

    #[test]
    fn abi_layout_is_fixed_for_c_and_zig_consumers() {
        assert_eq!(std::mem::size_of::<RefrainNativeRequest>(), 12_072);
        assert_eq!(std::mem::align_of::<RefrainNativeRequest>(), 8);
        assert_eq!(std::mem::size_of::<RefrainNativeResponse>(), 53_080);
        assert_eq!(std::mem::align_of::<RefrainNativeResponse>(), 8);
    }
}
