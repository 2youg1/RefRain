use crate::protocol::{
    ACTION_APPLY_INPUT, ACTION_HEALTH, ACTION_OBTAIN_PROJECTION, ACTION_OPEN_MANUSCRIPT,
    ACTION_PROJECT, ANCHOR_RANGE_CAPACITY, API_VERSION, AnchorRangeWire, CAPABILITY_MASK,
    CARET_END, CARET_EXTEND_FLAG, CARET_NEXT, CARET_NEXT_WORD, CARET_PREVIOUS, CARET_PREVIOUS_WORD,
    CARET_START, DEFAULT_VIEWPORT_BLOCKS, ERROR_DOMAIN_REFUSAL, ERROR_HOST_FAILURE,
    ERROR_INVALID_REQUEST, ERROR_PROTOCOL_MISMATCH, ERROR_STALE_REVISION, ERROR_UNKNOWN_SESSION,
    INPUT_CANCEL_COMPOSITION, INPUT_CLEAR, INPUT_COMMIT_COMPOSITION, INPUT_DELETE_BACKWARD,
    INPUT_DELETE_FORWARD, INPUT_DELETE_WORD_BACKWARD, INPUT_DELETE_WORD_FORWARD, INPUT_INSERT_TEXT,
    INPUT_MOVE_CARET, INPUT_REVERT_TO, INPUT_SAVE, INPUT_SET_COMPOSITION, INPUT_SET_SELECTION,
    INPUT_UNDO, PROJECTION_BYTES, PROTOCOL_VERSION, RefrainNativeRequest, RefrainNativeResponse,
    VIRTUAL_BLOCK_HEIGHT,
};
use refrain_app::native_document::{
    AnchoredRange, ByteSelection, CaretDirection, DocumentAnchor, DocumentError, DocumentInput,
    DocumentOpen, DocumentProjection, DocumentSurface, DocumentViewport,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const DOCUMENT_PATH_ENV: &str = "REFRAIN_NATIVE_DOCUMENT_PATH";
const DOCUMENT_STATE_PATH_ENV: &str = "REFRAIN_NATIVE_DOCUMENT_STATE_PATH";
/// Opt in to the 100,000-block synthetic manuscript. Only the scale harness
/// sets it; production launches open a real file or refuse.
const SCALE_FIXTURE_ENV: &str = "REFRAIN_NATIVE_SCALE_FIXTURE";

/// One open document plus the projection bytes its last response lent out.
///
/// Keeping the bytes here is what lets a response carry a pointer instead of a
/// 40 KiB inline array: they stay valid until this session projects again.
struct Session {
    document: DocumentSurface,
    projection: String,
    /// CLREQ line starts for `projection`, kept alive for exactly as long as
    /// the text they index — the response borrows both, so they must be
    /// replaced together on every projection.
    line_starts: Vec<u32>,
    /// 锚定区间（窗口坐标）的后备存储：与 line_starts 同一条 lent 纪律——
    /// 响应借指针，所有权在会话，每次投影整批替换。
    anchor_ranges: Vec<AnchorRangeWire>,
    /// 这份文档属于哪个项目的哪一份（root_id + 相对路径）。只有从项目里
    /// 打开的文档有：保存后要把动作链同步进那个项目的 text_actions。
    project: Option<(String, String)>,
}

#[derive(Default)]
struct Sessions {
    next: u64,
    documents: HashMap<u64, Session>,
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

pub fn dispatch(request: RefrainNativeRequest, text: &[u8]) -> RefrainNativeResponse {
    dispatch_with(request, text, &HarnessOverrides::from_env())
}

/// `dispatch` 的身体，覆盖来源显式传入：生产从环境读，测试直接构造——
/// 「测试能不能打开夹具」因此不靠进程环境这种跨测试共享的状态。
fn dispatch_with(
    request: RefrainNativeRequest,
    text: &[u8],
    harness: &HarnessOverrides,
) -> RefrainNativeResponse {
    if request.protocol_version != PROTOCOL_VERSION {
        return RefrainNativeResponse::empty(ERROR_PROTOCOL_MISMATCH, request.action);
    }
    match request.action {
        ACTION_HEALTH => return RefrainNativeResponse::empty(0, request.action),
        ACTION_PROJECT => return crate::project::dispatch(&request, text),
        ACTION_OPEN_MANUSCRIPT | ACTION_APPLY_INPUT | ACTION_OBTAIN_PROJECTION => {}
        _ => return RefrainNativeResponse::empty(ERROR_INVALID_REQUEST, request.action),
    }

    let sessions = SESSIONS.get_or_init(|| Mutex::new(Sessions::default()));
    let Ok(mut sessions) = sessions.lock() else {
        return RefrainNativeResponse::empty(ERROR_HOST_FAILURE, request.action);
    };
    if request.action == ACTION_OPEN_MANUSCRIPT {
        return open_manuscript(&mut sessions, request, text, harness);
    }
    let Some(session) = sessions.documents.get_mut(&request.session) else {
        return RefrainNativeResponse::empty(ERROR_UNKNOWN_SESSION, request.action);
    };

    if request.action == ACTION_APPLY_INPUT {
        if request.revision != revision_of(&session.document) {
            return projection_response(
                request.session,
                request.action,
                session,
                &request,
                ERROR_STALE_REVISION,
            );
        }
        let result = input_of(&request, text)
            .and_then(|input| session.document.apply(input).map_err(Into::into));
        match result {
            Ok(()) => {
                // 保存成功才把动作链同步进项目的 text_actions：历史表是持久
                // 视图，与状态文件同一生灭。同步失败按 host 失败报——字节
                // 已落盘，下一次保存会修复视图（record/sync_chain 幂等）。
                if request.input == INPUT_SAVE
                    && let Some((root_id, relative)) = &session.project
                    && crate::project::native_saved(root_id, relative).is_err()
                {
                    return projection_response(
                        request.session,
                        request.action,
                        session,
                        &request,
                        ERROR_HOST_FAILURE,
                    );
                }
            }
            Err(DispatchError::Domain(DocumentError::Text(
                refrain_core::TextRefusal::NothingChanged,
            ))) => {}
            Err(DispatchError::InvalidRequest) => {
                return projection_response(
                    request.session,
                    request.action,
                    session,
                    &request,
                    ERROR_INVALID_REQUEST,
                );
            }
            Err(DispatchError::Domain(_)) => {
                return projection_response(
                    request.session,
                    request.action,
                    session,
                    &request,
                    ERROR_DOMAIN_REFUSAL,
                );
            }
        }
    }
    projection_response(request.session, request.action, session, &request, 0)
}

/// Open the document the author chose.
///
/// Request text carries `root_id` and the document's relative path on two
/// lines — the same borrowed pointer every other input uses, so this adds no
/// protocol field. The Root id comes from the `project` use case
/// (`ACTION_PROJECT`); the absolute path is resolved here by
/// `ProjectStore::document_file` and never crosses back out. Empty text keeps
/// the environment-variable path the performance and automation harnesses use.
fn open_manuscript(
    sessions: &mut Sessions,
    request: RefrainNativeRequest,
    text: &[u8],
    harness: &HarnessOverrides,
) -> RefrainNativeResponse {
    let (source, project) = match requested_document_open(text, harness) {
        Ok(resolved) => resolved,
        Err(status) => return RefrainNativeResponse::empty(status, request.action),
    };
    let Ok(document) = DocumentSurface::open(source) else {
        return RefrainNativeResponse::empty(ERROR_HOST_FAILURE, request.action);
    };
    let Some(session) = sessions.next.checked_add(1) else {
        return RefrainNativeResponse::empty(ERROR_HOST_FAILURE, request.action);
    };
    sessions.next = session;
    let entry = sessions.documents.entry(session).or_insert(Session {
        document,
        projection: String::new(),
        line_starts: Vec::new(),
        anchor_ranges: Vec::new(),
        project,
    });
    projection_response(session, request.action, entry, &request, 0)
}

fn input_of(request: &RefrainNativeRequest, bytes: &[u8]) -> Result<DocumentInput, DispatchError> {
    Ok(match request.input {
        INPUT_SET_SELECTION => DocumentInput::SetSelection(ByteSelection {
            anchor: global_offset(request.window_start, request.anchor)?,
            focus: global_offset(request.window_start, request.focus)?,
        }),
        INPUT_INSERT_TEXT => DocumentInput::InsertText(text(request, bytes)?.to_owned()),
        INPUT_DELETE_BACKWARD => DocumentInput::DeleteBackward,
        INPUT_DELETE_FORWARD => DocumentInput::DeleteForward,
        INPUT_DELETE_WORD_BACKWARD => DocumentInput::DeleteWordBackward,
        INPUT_DELETE_WORD_FORWARD => DocumentInput::DeleteWordForward,
        INPUT_CLEAR => DocumentInput::Clear,
        INPUT_MOVE_CARET => DocumentInput::MoveCaret {
            direction: match request.flags & !CARET_EXTEND_FLAG {
                CARET_PREVIOUS => CaretDirection::Previous,
                CARET_NEXT => CaretDirection::Next,
                CARET_PREVIOUS_WORD => CaretDirection::PreviousWord,
                CARET_NEXT_WORD => CaretDirection::NextWord,
                CARET_START => CaretDirection::Start,
                CARET_END => CaretDirection::End,
                _ => return Err(DispatchError::InvalidRequest),
            },
            extend: request.flags & CARET_EXTEND_FLAG != 0,
        },
        INPUT_SET_COMPOSITION => DocumentInput::SetComposition {
            text: text(request, bytes)?.to_owned(),
            cursor: to_usize(request.cursor)?,
        },
        INPUT_COMMIT_COMPOSITION => DocumentInput::CommitComposition,
        INPUT_CANCEL_COMPOSITION => DocumentInput::CancelComposition,
        INPUT_UNDO => DocumentInput::Undo,
        // 回档带的是历史面板那一行的动作 id：借已有的文本指针过河，不为它
        // 加协议字段。id 解析不出是请求形状错误，不是领域拒绝。
        INPUT_REVERT_TO => DocumentInput::RevertTo {
            action: text(request, bytes)?
                .parse()
                .map_err(|_| DispatchError::InvalidRequest)?,
        },
        INPUT_SAVE => DocumentInput::Save,
        _ => return Err(DispatchError::InvalidRequest),
    })
}

/// Resolve which manuscript an `openManuscript` request names.
///
/// Precedence is deliberate: a path in the request wins, because it is the
/// author's actual choice. `harness` carries the two environment overrides so
/// the rule stays testable without mutating process state; production passes
/// [`HarnessOverrides::from_env`]. The scale fixture is reachable only through
/// `REFRAIN_NATIVE_SCALE_FIXTURE`, so a production launch can no longer open
/// 100,000 synthetic blocks by default — it refuses instead.
fn requested_document_open(
    text: &[u8],
    harness: &HarnessOverrides,
) -> Result<(DocumentOpen, Option<(String, String)>), u32> {
    if !text.is_empty() {
        // `root_id\nrelative/path.md`. Two lines rather than a struct because
        // this is the only variable-length request payload the open action
        // carries, and the protocol already lends one text pointer.
        let payload = std::str::from_utf8(text).map_err(|_| ERROR_INVALID_REQUEST)?;
        let (root_id, relative) = payload.split_once('\n').ok_or(ERROR_INVALID_REQUEST)?;
        let path =
            crate::project::document_file(root_id, relative).map_err(|_| ERROR_DOMAIN_REFUSAL)?;
        let state_path = path.with_extension("refrain-state.json");
        let project = (root_id.to_owned(), relative.to_owned());
        return Ok((DocumentOpen::Persistent { path, state_path }, Some(project)));
    }
    if let Some(path) = harness.document_path.clone() {
        let state_path = harness
            .state_path
            .clone()
            .unwrap_or_else(|| path.with_extension("refrain-state.json"));
        return Ok((DocumentOpen::Persistent { path, state_path }, None));
    }
    if harness.scale_fixture {
        return Ok((DocumentOpen::ScaleFixture, None));
    }
    Err(ERROR_INVALID_REQUEST)
}

/// The three launch overrides the performance and automation harnesses use.
/// Production resolves them from the environment inside `dispatch`; tests
/// construct them directly so a fixture open never depends on process state
/// a sibling test could also see.
struct HarnessOverrides {
    document_path: Option<PathBuf>,
    state_path: Option<PathBuf>,
    scale_fixture: bool,
}

impl HarnessOverrides {
    fn from_env() -> Self {
        Self {
            document_path: std::env::var_os(DOCUMENT_PATH_ENV).map(PathBuf::from),
            state_path: std::env::var_os(DOCUMENT_STATE_PATH_ENV).map(PathBuf::from),
            scale_fixture: std::env::var_os(SCALE_FIXTURE_ENV).is_some(),
        }
    }
}

fn projection_response(
    session_id: u64,
    action: u16,
    session: &mut Session,
    request: &RefrainNativeRequest,
    status: u32,
) -> RefrainNativeResponse {
    // The action selects the anchor. Each request carries the last scroll
    // offset of the surface, thus an offset alone cannot decide: after one
    // scroll, that offset would have priority over each later caret, and the
    // caret could not bring the window back. An action that moves the caret
    // anchors on the caret. A view request anchors on the offset, or on the
    // block when there is no offset.
    let first_block = match to_usize(request.viewport_first_block) {
        Ok(value) => value,
        Err(_) => return RefrainNativeResponse::empty(ERROR_INVALID_REQUEST, action),
    };
    let anchor = if action == ACTION_APPLY_INPUT {
        DocumentAnchor::Caret {
            window_first_block: first_block,
        }
    } else if request.scroll_offset_y > 0.0 {
        DocumentAnchor::Scroll {
            offset: request.scroll_offset_y,
            block_height: VIRTUAL_BLOCK_HEIGHT,
        }
    } else {
        DocumentAnchor::Block(first_block)
    };
    let viewport = DocumentViewport {
        anchor,
        columns_em: request.columns_em as f32,
        block_count: usize::try_from(if request.viewport_block_count == 0 {
            DEFAULT_VIEWPORT_BLOCKS
        } else {
            request.viewport_block_count
        })
        .unwrap_or(usize::MAX),
        max_bytes: PROJECTION_BYTES,
    };
    let Ok(projection) = session.document.project(viewport) else {
        return RefrainNativeResponse::empty(ERROR_HOST_FAILURE, action);
    };
    let anchor_ranges = anchor_ranges_for(session, &projection);
    fill_projection(
        session_id,
        action,
        status,
        projection,
        anchor_ranges,
        session,
    )
}

/// 把这份文档的锚定来源解析成窗口坐标的区间表。
///
/// 来源在项目（批注、待裁决提案），解析在表面（块身份 → 当前字节）——
/// 桥只做这一手传递，两边都不必知道对方的内部结构。没有项目的会话
/// （夹具、裸字节）与取不到项目状态的时刻都回空表：印点是投影的修饰，
/// 不该让一次存储失败变成一次投影失败。
fn anchor_ranges_for(session: &Session, projection: &DocumentProjection) -> Vec<AnchorRangeWire> {
    let Some((root_id, relative)) = &session.project else {
        return Vec::new();
    };
    let Ok(application) = crate::project::application() else {
        return Vec::new();
    };
    let Ok(sources) = application.native_anchor_sources(root_id, relative) else {
        return Vec::new();
    };
    window_ranges(
        session.document.anchored_ranges(&sources),
        projection.window_start,
        projection.text.len(),
    )
}

/// 文档坐标 → 窗口坐标：相交的钳进窗口，不相交的丢弃。容量是协议上界
/// （`ANCHOR_RANGE_CAPACITY`），到它的路上先按窗口过滤，实践中到不了。
fn window_ranges(
    ranges: Vec<AnchoredRange>,
    window_start: usize,
    window_len: usize,
) -> Vec<AnchorRangeWire> {
    let window_end = window_start.saturating_add(window_len);
    let mut output = Vec::new();
    for range in ranges {
        let (start, end) = (range.start as usize, range.end as usize);
        if end <= window_start || start >= window_end {
            continue;
        }
        if output.len() == ANCHOR_RANGE_CAPACITY {
            break;
        }
        output.push(AnchorRangeWire {
            start: start.saturating_sub(window_start) as u32,
            end: end.min(window_end).saturating_sub(window_start) as u32,
            kind: range.kind as u32,
            id: range.id,
        });
    }
    output
}

/// Store the projected text and ranges in the session and answer with a
/// response that borrows them.
fn fill_projection(
    session_id: u64,
    action: u16,
    status: u32,
    projection: DocumentProjection,
    anchor_ranges: Vec<AnchorRangeWire>,
    session: &mut Session,
) -> RefrainNativeResponse {
    session.projection = projection.text;
    session.line_starts.clear();
    session
        .line_starts
        .extend(projection.line_starts.iter().map(|start| *start as u32));
    session.anchor_ranges = anchor_ranges;
    let mut response = RefrainNativeResponse::empty(status, action);
    response.api_version = API_VERSION;
    response.capabilities = CAPABILITY_MASK;
    response.session = session_id;
    response.revision = projection.revision;
    response.total_bytes = projection.total_bytes as u64;
    response.total_blocks = projection.total_blocks as u64;
    response.window_start = projection.window_start as u64;
    response.first_block = projection.first_block as u64;
    response.block_count = projection.block_count as u32;
    response.text_len = session.projection.len() as u32;
    response.text = session.projection.as_ptr();
    response.line_start_count = session.line_starts.len() as u32;
    response.line_starts = session.line_starts.as_ptr();
    response.anchor_range_count = session.anchor_ranges.len() as u32;
    response.anchor_ranges = session.anchor_ranges.as_ptr();
    response.document_format = projection.format.wire_code();
    response.selection_anchor = projection.selection.start as u64;
    response.selection_focus = projection.selection.end as u64;
    response.document_selection_start = projection.document_selection.start as u64;
    response.document_selection_end = projection.document_selection.end as u64;
    if let Some(composition) = projection.composition {
        response.composition_start = composition.start as u64;
        response.composition_end = composition.end as u64;
        response.composition_len = (composition.end - composition.start) as u32;
    }
    response
}

fn revision_of(document: &DocumentSurface) -> u64 {
    document
        .project(DocumentViewport {
            anchor: DocumentAnchor::Block(0),
            block_count: 0,
            max_bytes: 0,
            columns_em: 0.0,
        })
        .map_or(u64::MAX, |projection| projection.revision)
}

/// Decode the borrowed bytes as the UTF-8 text one input carries.
fn text<'a>(request: &RefrainNativeRequest, text: &'a [u8]) -> Result<&'a str, DispatchError> {
    let length = usize::try_from(request.text_len).map_err(|_| DispatchError::InvalidRequest)?;
    if length != text.len() {
        return Err(DispatchError::InvalidRequest);
    }
    std::str::from_utf8(text).map_err(|_| DispatchError::InvalidRequest)
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
    use crate::staticlib::borrow_response_text as response_text;
    use refrain_app::native_document::{DOCUMENT_FIXTURE_BLOCKS, DOCUMENT_FIXTURE_BYTES};

    fn request(action: u16) -> RefrainNativeRequest {
        RefrainNativeRequest {
            protocol_version: PROTOCOL_VERSION,
            action,
            input: 0,
            flags: 0,
            session: 0,
            revision: 0,
            window_start: 0,
            anchor: 0,
            focus: 0,
            cursor: 0,
            viewport_first_block: 0,
            scroll_offset_y: 0.0,
            columns_em: 0.0,
            viewport_block_count: 32,
            text_len: 0,
            text: std::ptr::null(),
        }
    }

    /// 测试的打开源是显式给的规模夹具，不走进程环境——环境是跨测试共享的
    /// 状态，靠它打开的文件会让「没有来源必须拒绝」那条测试的断言失效。
    fn fixture_harness() -> HarnessOverrides {
        HarnessOverrides {
            document_path: None,
            state_path: None,
            scale_fixture: true,
        }
    }

    /// Dispatch the way the C ABI entry point does: request plus its bytes.
    fn send(request: RefrainNativeRequest) -> RefrainNativeResponse {
        dispatch_with(request, &[], &fixture_harness())
    }

    /// Dispatch one request whose text is borrowed from `bytes`.
    fn send_text(mut request: RefrainNativeRequest, bytes: &[u8]) -> RefrainNativeResponse {
        request.text_len = bytes.len() as u32;
        request.text = bytes.as_ptr();
        dispatch_with(request, bytes, &fixture_harness())
    }

    fn apply(session: u64, revision: u64, input: u16) -> RefrainNativeRequest {
        let mut request = request(ACTION_APPLY_INPUT);
        request.session = session;
        request.revision = revision;
        request.input = input;
        request
    }

    #[test]
    fn save_is_one_exhaustive_document_input_without_a_path_payload() {
        let save = apply(1, 0, INPUT_SAVE);
        assert!(matches!(input_of(&save, &[]), Ok(DocumentInput::Save)));
        assert_eq!(save.text_len, 0);
        assert!(save.text.is_null());
    }

    /// Step 4: an open request names a Root, never a filesystem path.
    ///
    /// Guards the boundary that keeps a chosen absolute path inside Rust. A
    /// bare path has no `\n`, so it cannot be read as `root_id` + relative and
    /// is refused; a well-formed pair for a Root that is not open is refused by
    /// the project layer. With neither a request payload nor a harness
    /// variable the open refuses outright — that is what stops a production
    /// launch from silently opening 100,000 synthetic blocks.
    #[test]
    fn open_manuscript_names_a_root_and_refuses_a_bare_path_or_no_source() {
        let absolute = send_text(request(ACTION_OPEN_MANUSCRIPT), b"/tmp/chosen.md");
        assert_eq!(
            absolute.status, ERROR_INVALID_REQUEST,
            "a bare filesystem path is not a Root reference"
        );

        let unopened = send_text(
            request(ACTION_OPEN_MANUSCRIPT),
            "no-such-root\n章.md".as_bytes(),
        );
        assert_eq!(
            unopened.status, ERROR_DOMAIN_REFUSAL,
            "a Root that is not open cannot resolve a document"
        );

        // Refusal is asserted on the resolver with the overrides passed in, so
        // it cannot depend on process environment a sibling test also sets.
        let refused = requested_document_open(
            &[],
            &HarnessOverrides {
                document_path: None,
                state_path: None,
                scale_fixture: false,
            },
        );
        assert!(
            refused.is_err(),
            "an openManuscript with no Root reference and no harness variable must be refused"
        );
    }

    #[test]
    fn one_dispatch_opens_projects_edits_composes_and_undoes_one_rust_document() {
        let health = send(request(ACTION_HEALTH));
        assert_eq!(health.status, 0);
        assert_eq!(health.api_version, API_VERSION);

        let opened = send(request(ACTION_OPEN_MANUSCRIPT));
        assert_eq!(opened.status, 0);
        assert!(opened.session > 0);
        assert_eq!(opened.total_bytes, DOCUMENT_FIXTURE_BYTES as u64);
        assert_eq!(opened.total_blocks, DOCUMENT_FIXTURE_BLOCKS as u64);
        assert_eq!(opened.first_block, 0);
        assert_eq!(opened.block_count, 32);
        assert!((opened.text_len as usize) < PROJECTION_BYTES);
        assert_eq!(&response_text(&opened).as_bytes()[9..15], "中文".as_bytes());

        let mut selected = apply(opened.session, opened.revision, INPUT_SET_SELECTION);
        selected.anchor = 0;
        selected.focus = 6;
        let selected = send(selected);
        assert_eq!(selected.status, 0);

        let mut composition = apply(opened.session, selected.revision, INPUT_SET_COMPOSITION);
        let preedit = "入力".as_bytes();
        composition.cursor = preedit.len() as u64;
        let composition = send_text(composition, preedit);
        assert_eq!(composition.status, 0);
        assert_eq!(
            send(apply(
                opened.session,
                composition.revision,
                INPUT_COMMIT_COMPOSITION,
            ))
            .status,
            0
        );

        let mut project = request(ACTION_OBTAIN_PROJECTION);
        project.session = opened.session;
        let edited = send(project);
        assert_eq!(&response_text(&edited).as_bytes()[..preedit.len()], preedit);
        let undone = send(apply(opened.session, edited.revision, INPUT_UNDO));
        assert_eq!(undone.status, 0);
        assert_eq!(&response_text(&undone).as_bytes()[..6], b"000000");
    }

    #[test]
    fn viewport_and_revision_are_real_inputs_not_fixed_fixture_metadata() {
        let opened = send(request(ACTION_OPEN_MANUSCRIPT));
        let mut middle_request = request(ACTION_OBTAIN_PROJECTION);
        middle_request.session = opened.session;
        middle_request.viewport_first_block = 50_000;
        middle_request.viewport_block_count = 24;
        // A response's text is only valid until its session projects again, so
        // the opening window is copied before the next dispatch replaces it.
        let first_window = response_text(&opened).chars().take(8).collect::<String>();
        let middle = send(middle_request);
        assert_eq!(middle.status, 0);
        assert_eq!(middle.first_block, 50_000);
        assert_eq!(middle.block_count, 24);
        assert!(middle.window_start > opened.text_len as u64);
        assert_ne!(
            response_text(&middle).chars().take(8).collect::<String>(),
            first_window
        );

        let stale = send(apply(opened.session, opened.revision + 1, INPUT_UNDO));
        assert_eq!(stale.status, ERROR_STALE_REVISION);
        assert_eq!(stale.revision, opened.revision);
    }

    #[test]
    fn abi_layout_is_fixed_for_c_and_zig_consumers() {
        assert_eq!(std::mem::size_of::<RefrainNativeRequest>(), 96);
        assert_eq!(std::mem::align_of::<RefrainNativeRequest>(), 8);
        assert_eq!(std::mem::size_of::<RefrainNativeResponse>(), 168);
        assert_eq!(std::mem::align_of::<RefrainNativeResponse>(), 8);
        // 一条区间恰好 48 字节且无填充：坐标三元组 + 36 字节身份，
        // 线上的条目与它逐字节同形。
        assert_eq!(std::mem::size_of::<AnchorRangeWire>(), 48);
        assert_eq!(std::mem::align_of::<AnchorRangeWire>(), 4);
    }

    #[test]
    fn anchor_ranges_clamp_to_the_projection_window() {
        use refrain_app::native_document::AnchorKind;
        let id = |byte: u8| [byte; 36];
        let ranges = vec![
            // 窗口内：原样平移。
            AnchoredRange {
                start: 110,
                end: 120,
                kind: AnchorKind::Highlight,
                id: id(b'a'),
            },
            // 跨窗口左缘：钳到 0。
            AnchoredRange {
                start: 90,
                end: 105,
                kind: AnchorKind::Comment,
                id: id(b'b'),
            },
            // 跨窗口右缘：钳到窗口末尾。
            AnchoredRange {
                start: 195,
                end: 300,
                kind: AnchorKind::Proposal,
                id: id(b'c'),
            },
            // 不相交：丢弃。
            AnchoredRange {
                start: 400,
                end: 500,
                kind: AnchorKind::Highlight,
                id: id(b'd'),
            },
        ];
        let windowed = window_ranges(ranges, 100, 100);
        assert_eq!(windowed.len(), 3);
        assert_eq!(
            (
                windowed[0].start,
                windowed[0].end,
                windowed[0].kind,
                windowed[0].id
            ),
            (10, 20, 1, id(b'a'))
        );
        assert_eq!(
            (
                windowed[1].start,
                windowed[1].end,
                windowed[1].kind,
                windowed[1].id
            ),
            (0, 5, 2, id(b'b'))
        );
        assert_eq!(
            (
                windowed[2].start,
                windowed[2].end,
                windowed[2].kind,
                windowed[2].id
            ),
            (95, 100, 3, id(b'c'))
        );
    }
}
