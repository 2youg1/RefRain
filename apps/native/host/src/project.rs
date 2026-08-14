use crate::protocol::{
    ERROR_DOMAIN_REFUSAL, ERROR_HOST_FAILURE, ERROR_INVALID_REQUEST, EVENT_TEXT_BYTES,
    PROJECTION_BYTES, RefrainNativeRequest, RefrainNativeResponse,
};
use directories::ProjectDirs;
use refrain_app::{
    Application, ProjectImport, ProjectInput, ProjectOutput, ProjectPlatform, RootKind,
};
use refrain_core::{DocumentFormat, ErrorCode, RefrainError};
use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::OnceLock;

pub const ACTION_PROJECT: u16 = 5;

struct NativeProjectPlatform {
    /// 自动化通道：非空时所有选择器直接返回它。
    ///
    /// rfd 的系统对话框在自动化会话（automation 构建 + 命令脚本）下无法点击，
    /// 而 e2e 仿真要真实拉起应用走完整条作者流程——这是产品级的验证通道，
    /// 不是测试后门：发布回归与人工使用走同一条 `ChooseAndAdoptRoot`，
    /// 只有「选哪个路径」这一步由 `REFRAIN_AUTOMATION_ROOT` 替作者回答。
    /// 构造时读一次 env（进程启动后不变），测试直接给值——`deny(unsafe_code)`
    /// 下测试进程改不了 env，注入点在这里。
    automation_root: Option<PathBuf>,
}

impl NativeProjectPlatform {
    fn production() -> Self {
        Self {
            automation_root: std::env::var_os("REFRAIN_AUTOMATION_ROOT").map(PathBuf::from),
        }
    }
}

impl ProjectPlatform for NativeProjectPlatform {
    fn choose_root(&self, kind: RootKind) -> Result<Option<PathBuf>, RefrainError> {
        if let Some(path) = &self.automation_root {
            return Ok(Some(path.clone()));
        }
        let dialog = rfd::FileDialog::new().set_title(match kind {
            RootKind::Folder => "选择项目文件夹",
            RootKind::File => "选择一份手稿",
        });
        Ok(match kind {
            RootKind::Folder => dialog.pick_folder(),
            RootKind::File => dialog
                .add_filter("Manuscript", &DocumentFormat::extensions())
                .pick_file(),
        })
    }

    fn choose_project_parent(&self) -> Result<Option<PathBuf>, RefrainError> {
        if let Some(path) = &self.automation_root {
            return Ok(Some(path.clone()));
        }
        Ok(rfd::FileDialog::new()
            .set_title("选择项目的父目录")
            .pick_folder())
    }

    fn choose_import(&self, kind: ProjectImport) -> Result<Option<PathBuf>, RefrainError> {
        if let Some(path) = &self.automation_root {
            return Ok(Some(path.clone()));
        }
        let dialog = rfd::FileDialog::new();
        Ok(match kind {
            ProjectImport::Material => dialog
                .set_title("选择资料")
                .add_filter(
                    "Sources",
                    &["pdf", "epub", "html", "htm", "docx", "pptx", "xlsx"],
                )
                .pick_file(),
            ProjectImport::Manuscript => dialog
                .set_title("导入为原稿")
                .add_filter("Manuscript", &DocumentFormat::extensions())
                .pick_file(),
        })
    }
}

pub fn dispatch(request: &RefrainNativeRequest, text: &[u8]) -> RefrainNativeResponse {
    let application = match application() {
        Ok(application) => application,
        Err(error) => return failure(ERROR_HOST_FAILURE, &error),
    };
    dispatch_with(
        application,
        &NativeProjectPlatform::production(),
        request,
        text,
    )
}

fn dispatch_with(
    application: &Application,
    platform: &impl ProjectPlatform,
    request: &RefrainNativeRequest,
    text: &[u8],
) -> RefrainNativeResponse {
    let input = match request_text(request, text)
        .and_then(|text| serde_json::from_str::<ProjectInput>(text).map_err(invalid_json))
    {
        Ok(input) => input,
        Err(error) => {
            return failure(ERROR_INVALID_REQUEST, &error);
        }
    };
    match application.project(platform, input) {
        Ok(output) => success(&output),
        Err(error) => failure(ERROR_DOMAIN_REFUSAL, &refusal_json(&error)),
    }
}

/// 领域拒绝跨界的形状：code/action/subject/recovery 是领域事实（SPEC 6.5），
/// 界面按码行动、按步骤出恢复文案。
///
/// **`detail` 的边界纪律**：它默认是运维细节，可能带着磁盘路径——「不泄露
/// 选定路径」的测试守着这条线。唯一的例外是过期提案：它的 detail 是 Agent
/// 当时读到的冻结原文，作者要拿它对照现在的文字（SPEC 7.4），不出界作者
/// 就只剩一句读不懂的拒绝。
fn refusal_json(error: &RefrainError) -> String {
    let mut boundary = error.clone();
    if boundary.code != ErrorCode::StaleProposal {
        boundary.detail = None;
    }
    serde_json::to_string(&boundary)
        .unwrap_or_else(|_| "Rust refused the project input.".to_owned())
}

/// Decode the project group's opaque input from the borrowed payload slice.
fn request_text<'a>(request: &RefrainNativeRequest, bytes: &'a [u8]) -> Result<&'a str, String> {
    let length = usize::try_from(request.text_len).map_err(|error| error.to_string())?;
    if length > EVENT_TEXT_BYTES {
        return Err(format!(
            "project input is {length} bytes; the ABI bound is {EVENT_TEXT_BYTES}"
        ));
    }
    if length != bytes.len() {
        return Err("project input length does not match the payload".to_owned());
    }
    std::str::from_utf8(bytes).map_err(|error| error.to_string())
}

fn invalid_json(error: serde_json::Error) -> String {
    format!("decode the project input: {error}")
}

// The bytes the most recent project response lent to its caller.
//
// The project group has no session, so its reply buffer lives here and stays
// valid until the same thread's next project dispatch replaces it. One buffer
// per thread: the ABI caller reads the lent bytes on the dispatching thread,
// and a process-wide buffer let parallel test dispatches rewrite each other's
// replies (single-threaded runs went 10/10 green while parallel runs raced).
thread_local! {
    static REPLY: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Store `bytes` as the current reply and point `response` at them.
fn lend_reply(response: &mut RefrainNativeResponse, bytes: &[u8]) {
    REPLY.with(|reply| {
        let mut reply = reply.borrow_mut();
        reply.clear();
        reply.push_str(&String::from_utf8_lossy(bytes));
        response.text_len = reply.len() as u32;
        response.text = reply.as_ptr();
    });
}

fn success(output: &ProjectOutput) -> RefrainNativeResponse {
    let mut bounded = output.clone();
    loop {
        match serde_json::to_vec(&bounded) {
            Ok(bytes) if bytes.len() <= PROJECTION_BYTES => {
                let mut response = RefrainNativeResponse::empty(0, ACTION_PROJECT);
                lend_reply(&mut response, &bytes);
                return response;
            }
            Ok(bytes) if truncate_output(&mut bounded) => {
                debug_assert!(bytes.len() > PROJECTION_BYTES);
            }
            Ok(bytes) => {
                return failure(
                    ERROR_HOST_FAILURE,
                    &format!(
                        "project output is {} bytes; the ABI bound is {PROJECTION_BYTES}",
                        bytes.len()
                    ),
                );
            }
            Err(error) => return failure(ERROR_HOST_FAILURE, &error.to_string()),
        }
    }
}

fn truncate_output(output: &mut ProjectOutput) -> bool {
    match output {
        ProjectOutput::Opened(opened) => {
            if opened.documents.pop().is_none() {
                return false;
            }
            opened.document_cursor = opened
                .documents
                .last()
                .map(|document| document.path.clone());
            true
        }
        ProjectOutput::Page(page) => {
            if page.documents.pop().is_none() {
                return false;
            }
            page.document_cursor = page.documents.last().map(|document| document.path.clone());
            true
        }
        ProjectOutput::Documents(documents) => {
            if documents.documents.pop().is_none() {
                return false;
            }
            documents.truncated = true;
            true
        }
        ProjectOutput::Blocks(blocks) => {
            if blocks.blocks.pop().is_none() {
                return false;
            }
            blocks.truncated = true;
            true
        }
        // 块清单同理：丢最后一行并把翻页游标收回到剩下的末行——下一页
        // 从那里再起，丢掉的行因此还能读到。
        ProjectOutput::DocumentBlocks(listing) => {
            if listing.blocks.pop().is_none() {
                return false;
            }
            listing.next = listing.blocks.last().map(|row| row.ordinal + 1);
            true
        }
        ProjectOutput::DocumentOpened(document) => document.blocks.pop().is_some(),
        // 编排快照会随 Run 增长而越界。丢最旧的一条 Run 而不是整体拒绝：
        // 界面要的是「现在有哪些在跑」，最新的那些才是它渲染的。
        ProjectOutput::Host(snapshot) => {
            !snapshot.runs.is_empty() && {
                snapshot.runs.remove(0);
                true
            }
        }
        // 提案列表会随 Agent 产出增长而越界。丢最后一条而不是整体拒绝：
        // 作者从上往下逐条判，先到的那些才是他正在处理的。
        ProjectOutput::Proposals(listing) => listing.proposals.pop().is_some(),
        // 历史与批注同理：最近的排在前面，作者要的是那些。丢最旧的一条
        // 好过整份读不出来——一份读不出来的历史等于没有历史。
        ProjectOutput::History(entries) => entries.pop().is_some(),
        ProjectOutput::Annotations(rows) => rows.pop().is_some(),
        // 信箱同提案：排过的在前，作者从上往下处理，丢最后的（没人碰过
        // 的那些）好过整份读不出来。
        ProjectOutput::Mailbox(entries) => entries.pop().is_some(),
        // 材料草稿名录同理：成稿从上往下，丢最后一条好过整份读不出来。
        ProjectOutput::MaterialDrafts(drafts) => drafts.pop().is_some(),
        // 资料名录同理，并把截断事实立起来——界面据此说「还有没列出的」。
        ProjectOutput::Materials(listing) => {
            if listing.materials.pop().is_none() {
                return false;
            }
            listing.truncated = true;
            true
        }
        // 这些输出没有可丢的尾巴：设置与 KARA 是定长快照，裁决与收取的结局
        // 是一个判别式，派发预览的请求原文不能截半（半截请求会被读成完整
        // 请求），其余是单行。放不下就该报错而不是残缺送出——一份被截断的
        // 设置会被读成作者改过它，一个被截断的裁决结局无法解释。
        ProjectOutput::Cancelled
        | ProjectOutput::Imported(_)
        | ProjectOutput::DispatchPreview(_)
        | ProjectOutput::Deleted(_)
        | ProjectOutput::DisclosureSet(_)
        | ProjectOutput::Config(_)
        | ProjectOutput::Decided(_)
        | ProjectOutput::Collected(_)
        // 派发结果是「刚才铸出了哪几个 Run」。丢掉其中一个，作者就会以为
        // 少派了一个 agent，而那个 Run 仍在跑——比整体失败更难归因。
        | ProjectOutput::Dispatched(_)
        // Harness 名单是定长的：这台机器认识几个适配器就是几行。丢一行，
        // 作者会以为自己没装那个，而他多半装了。
        | ProjectOutput::Harnesses(_)
        | ProjectOutput::Kara(_) => false,
    }
}

fn failure(status: u32, detail: &str) -> RefrainNativeResponse {
    let mut response = RefrainNativeResponse::empty(status, ACTION_PROJECT);
    let bytes = detail.as_bytes();
    lend_reply(&mut response, &bytes[..bytes.len().min(PROJECTION_BYTES)]);
    response
}

/// The absolute path of one document inside an open Root.
///
/// The document surface calls this to turn the view's `root_id` + relative
/// path into a file it can open and save. Resolution stays in
/// `ProjectStore::document_file`, which owns the containment and INV-4 checks;
/// this only reaches the right Root through the shared `Application`.
pub fn document_file(root_id: &str, relative: &str) -> Result<PathBuf, RefrainError> {
    application()
        .map_err(|error| {
            RefrainError::new(
                refrain_core::ErrorCode::StateUnavailable,
                "open the application store",
                error,
            )
        })?
        .with_project(root_id, |entry| {
            entry
                .store
                .document_file(relative)
                .map_err(refrain_app::journal::into_domain)
        })
}

/// 原生文档保存之后同步历史。走 `ProjectInput` 而不是直插 store：把动作链
/// reconcile 进 text_actions 是项目用例的一步，不是桥自己的事。
pub fn native_saved(root_id: &str, relative: &str) -> Result<(), RefrainError> {
    application()
        .map_err(|error| {
            RefrainError::new(
                refrain_core::ErrorCode::StateUnavailable,
                "open the application store",
                error,
            )
        })?
        .project(
            &NativeProjectPlatform::production(),
            ProjectInput::NativeSaved {
                root_id: root_id.to_owned(),
                path: relative.to_owned(),
            },
        )
        .map(|_| ())
}

pub(crate) fn application() -> Result<&'static Application, String> {
    static APPLICATION: OnceLock<Result<Application, String>> = OnceLock::new();
    APPLICATION
        .get_or_init(|| {
            Application::open(&application_data_dir()?).map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn application_data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("REFRAIN_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    ProjectDirs::from("app", "refrain", "RefRain")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .ok_or_else(|| String::from("resolve the RefRain application data directory"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::staticlib::borrow_response_text as response_text;
    use std::fs;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQUENCE: AtomicU32 = AtomicU32::new(0);

    fn scratch(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "refrain-native-project-{label}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    struct Selected(Mutex<Option<PathBuf>>);

    impl ProjectPlatform for Selected {
        fn choose_root(&self, _kind: RootKind) -> Result<Option<PathBuf>, RefrainError> {
            Ok(self.0.lock().unwrap().take())
        }

        fn choose_project_parent(&self) -> Result<Option<PathBuf>, RefrainError> {
            Ok(self.0.lock().unwrap().take())
        }

        fn choose_import(&self, _kind: ProjectImport) -> Result<Option<PathBuf>, RefrainError> {
            Ok(self.0.lock().unwrap().take())
        }
    }

    /// Encode one project input. The caller owns the bytes and lends them to
    /// `request`, mirroring how the bridge lends its payload buffer.
    fn encode(input: &ProjectInput) -> Vec<u8> {
        serde_json::to_vec(input).unwrap()
    }

    fn request(bytes: &[u8]) -> RefrainNativeRequest {
        RefrainNativeRequest {
            protocol_version: crate::protocol::PROTOCOL_VERSION,
            action: ACTION_PROJECT,
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
            viewport_block_count: 0,
            text_len: bytes.len() as u32,
            text: bytes.as_ptr(),
        }
    }

    #[test]
    fn settings_cross_the_same_opaque_channel_and_persist_to_the_one_writer() {
        // 设置不另开一条 action：它与项目共用那条 opaque JSON 通道，
        // 所以这条同时证明「读」「改」「重开后仍在」三件事。
        let data = scratch("config");
        let application = Application::open(&data).unwrap();
        let platform = Selected(Mutex::new(None));

        let read = encode(&ProjectInput::ReadConfig);
        let before = dispatch_with(&application, &platform, &request(&read), &read);
        assert_eq!(before.status, 0);
        let json: serde_json::Value = serde_json::from_str(response_text(&before)).unwrap();
        assert_eq!(json["kind"], "config");
        assert_eq!(json["value"]["appearance"]["theme"], "tou");

        let change = encode(&ProjectInput::ChangeConfig(
            refrain_app::ConfigChange::SetTheme("sumi".to_owned()),
        ));
        let after = dispatch_with(&application, &platform, &request(&change), &change);
        assert_eq!(after.status, 0);
        let json: serde_json::Value = serde_json::from_str(response_text(&after)).unwrap();
        assert_eq!(json["value"]["appearance"]["theme"], "sumi");

        // 近失手：只更新内存那一份，重开就回到 tou。这一句抓的正是它。
        drop(application);
        let reopened = Application::open(&data).unwrap();
        let again = dispatch_with(&reopened, &platform, &request(&read), &read);
        let json: serde_json::Value = serde_json::from_str(response_text(&again)).unwrap();
        assert_eq!(json["value"]["appearance"]["theme"], "sumi");

        drop(reopened);
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn orchestration_state_crosses_the_same_channel_and_needs_an_open_root() {
        // 步骤 7 的审阅、信箱、派发都读这一条。它同时证明两件事：
        // 快照能跨界，且没打开的 Root 是一次有名的拒绝而不是空快照——
        // 空快照会被界面读成「这个项目没有任何 Run」。
        let data = scratch("host");
        let root = scratch("host-root");
        fs::write(root.join("正文.md"), "one\n").unwrap();
        let application = Application::open(&data).unwrap();

        let unopened = encode(&ProjectInput::ReadHost {
            root_id: "no-such-root".to_owned(),
        });
        let refused = dispatch_with(
            &application,
            &Selected(Mutex::new(None)),
            &request(&unopened),
            &unopened,
        );
        assert_ne!(
            refused.status, 0,
            "an unopened Root must refuse, not answer empty"
        );

        let adopt = encode(&ProjectInput::ChooseAndAdoptRoot {
            kind: RootKind::Folder,
        });
        let opened = dispatch_with(
            &application,
            &Selected(Mutex::new(Some(root.clone()))),
            &request(&adopt),
            &adopt,
        );
        let json: serde_json::Value = serde_json::from_str(response_text(&opened)).unwrap();
        let root_id = json["value"]["rootId"].as_str().unwrap().to_owned();

        let read = encode(&ProjectInput::ReadHost { root_id });
        let snapshot = dispatch_with(
            &application,
            &Selected(Mutex::new(None)),
            &request(&read),
            &read,
        );
        assert_eq!(snapshot.status, 0);
        let json: serde_json::Value = serde_json::from_str(response_text(&snapshot)).unwrap();
        assert_eq!(json["kind"], "host");
        // 新 Root 上四个列表都空，但它们必须存在——缺字段与空列表在界面上
        // 是两回事。
        for field in ["tasks", "runs", "authorizations", "runsAwaitingLaunch"] {
            assert!(json["value"][field].is_array(), "{field} must be an array");
        }
        // 名录的真实条数由快照自己带，不由界面数 `runs.len()`：越界时
        // `truncate_output` 丢最旧的 Run，数出来的是「装得下的那些」。
        // 新 Root 上两者相等，这条守的是它们此后不许漂开。
        assert_eq!(
            json["value"]["runTotal"], 0,
            "the snapshot must state how many Runs exist, including any dropped to fit the ABI"
        );

        drop(application);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn one_native_project_action_adopts_without_returning_a_path() {
        let data = scratch("data");
        let root = scratch("root");
        fs::write(root.join("正文.md"), "Rust owns this path.\n").unwrap();
        let application = Application::open(&data).unwrap();
        let bytes = encode(&ProjectInput::ChooseAndAdoptRoot {
            kind: RootKind::Folder,
        });
        let response = dispatch_with(
            &application,
            &Selected(Mutex::new(Some(root.clone()))),
            &request(&bytes),
            &bytes,
        );

        assert_eq!(response.status, 0);
        assert_eq!(response.action, ACTION_PROJECT);
        let json: serde_json::Value = serde_json::from_str(response_text(&response)).unwrap();
        assert_eq!(json["kind"], "opened");
        assert!(json.to_string().contains("正文.md"));
        assert!(
            !json
                .to_string()
                .contains(&root.to_string_lossy().to_string())
        );

        drop(application);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    /// 自动化通道：`REFRAIN_AUTOMATION_ROOT` 让生产平台（`NativeProjectPlatform`）
    /// 直接回答选择器——e2e 仿真不点系统对话框，却走与真人完全相同的
    /// `ChooseAndAdoptRoot` 路径。删掉 env 通道，这条测试红。
    #[test]
    fn the_automation_root_env_answers_the_production_platform() {
        let data = scratch("data-auto");
        let root = scratch("root-auto");
        fs::write(
            root.join("正文.md"),
            "one
",
        )
        .unwrap();
        let application = Application::open(&data).unwrap();
        let bytes = encode(&ProjectInput::ChooseAndAdoptRoot {
            kind: RootKind::Folder,
        });
        let response = dispatch_with(
            &application,
            &NativeProjectPlatform {
                automation_root: Some(root.clone()),
            },
            &request(&bytes),
            &bytes,
        );

        assert_eq!(response.status, 0);
        assert_eq!(response.action, ACTION_PROJECT);
        let json: serde_json::Value = serde_json::from_str(response_text(&response)).unwrap();
        assert_eq!(json["kind"], "opened");
        assert!(json.to_string().contains("正文.md"));

        drop(application);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn maximum_project_catalog_page_fits_the_fixed_native_payload() {
        let data = scratch("data");
        let root = scratch("max-page-root");
        for index in 0..256 {
            fs::write(root.join(format!("{index:03}.md")), "bounded\n").unwrap();
        }
        let application = Application::open(&data).unwrap();
        let bytes = encode(&ProjectInput::ChooseAndAdoptRoot {
            kind: RootKind::Folder,
        });
        let response = dispatch_with(
            &application,
            &Selected(Mutex::new(Some(root.clone()))),
            &request(&bytes),
            &bytes,
        );

        assert_eq!(response.status, 0, "{}", response_text(&response));
        assert!((response.text_len as usize) <= PROJECTION_BYTES);
        let output: serde_json::Value = serde_json::from_str(response_text(&response)).unwrap();
        assert_eq!(output["kind"], "opened");
        let documents = output["value"]["documents"].as_array().unwrap();
        assert!(!documents.is_empty());
        assert!(documents.len() < 256);
        assert_eq!(output["value"]["documentTotal"], 256);
        assert_eq!(
            output["value"]["documentCursor"],
            documents.last().unwrap()["path"]
        );

        drop(application);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refusal_json_keeps_the_frozen_text_only_for_a_stale_proposal() {
        let stale = RefrainError::new(ErrorCode::StaleProposal, "commit a decision batch", "章.md")
            .with_detail("Agent 当时读到的原文。".to_owned());
        let json: serde_json::Value = serde_json::from_str(&refusal_json(&stale)).unwrap();
        assert_eq!(json["code"], "stale-proposal");
        assert_eq!(json["detail"], "Agent 当时读到的原文。");

        // 其余码的 detail 是运维细节（可能带路径），按边界纪律不出界。
        let io = RefrainError::new(ErrorCode::Io, "save", "章.md")
            .with_detail("C:\\secret\\path".to_owned());
        let json: serde_json::Value = serde_json::from_str(&refusal_json(&io)).unwrap();
        assert_eq!(json["code"], "io");
        assert!(json["detail"].is_null());
    }

    #[test]
    fn project_refusals_do_not_leak_selected_paths_across_the_native_boundary() {
        let data = scratch("data");
        let selected = scratch("selected-secret").join("missing-root");
        let application = Application::open(&data).unwrap();
        let bytes = encode(&ProjectInput::ChooseAndAdoptRoot {
            kind: RootKind::Folder,
        });
        let response = dispatch_with(
            &application,
            &Selected(Mutex::new(Some(selected.clone()))),
            &request(&bytes),
            &bytes,
        );

        assert_eq!(response.status, ERROR_DOMAIN_REFUSAL);
        let detail = response_text(&response);
        let refusal: serde_json::Value = serde_json::from_str(detail).unwrap();
        // 码与恢复步骤过界，界面按它们出文案；运维细节（可能带路径）不出界。
        assert!(refusal["code"].is_string());
        assert!(refusal["recovery"].is_array());
        assert!(refusal["detail"].is_null());
        assert!(!detail.contains(&selected.to_string_lossy().to_string()));

        drop(application);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(selected.parent().unwrap()).unwrap();
    }

    #[test]
    fn oversized_or_malformed_project_inputs_are_refused_before_use_case_execution() {
        let data = scratch("data");
        let application = Application::open(&data).unwrap();
        // Bytes that are not a project input at all.
        let malformed = b"nope".to_vec();
        let response = dispatch_with(
            &application,
            &Selected(Mutex::new(None)),
            &request(&malformed),
            &malformed,
        );
        assert_eq!(response.status, ERROR_INVALID_REQUEST);

        // A declared length beyond the ABI bound is refused before any read.
        let mut oversized = request(&malformed);
        oversized.text_len = (EVENT_TEXT_BYTES + 1) as u32;
        let response = dispatch_with(
            &application,
            &Selected(Mutex::new(None)),
            &oversized,
            &malformed,
        );
        assert_eq!(response.status, ERROR_INVALID_REQUEST);

        drop(application);
        fs::remove_dir_all(data).unwrap();
    }
}
