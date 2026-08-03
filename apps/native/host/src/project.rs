use crate::protocol::{
    ERROR_DOMAIN_REFUSAL, ERROR_HOST_FAILURE, ERROR_INVALID_REQUEST, EVENT_TEXT_BYTES,
    PROJECTION_BYTES, RefrainNativeRequest, RefrainNativeResponse,
};
use directories::ProjectDirs;
use refrain_app::{Application, ProjectInput, ProjectOutput, ProjectPlatform, RootKind};
use refrain_core::{DocumentFormat, RefrainError};
use std::path::PathBuf;
use std::sync::OnceLock;

pub const ACTION_PROJECT: u16 = 5;

struct NativeProjectPlatform;

impl ProjectPlatform for NativeProjectPlatform {
    fn choose_root(&self, kind: RootKind) -> Result<Option<PathBuf>, RefrainError> {
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
        Ok(rfd::FileDialog::new()
            .set_title("选择项目的父目录")
            .pick_folder())
    }
}

pub fn dispatch(request: &RefrainNativeRequest) -> RefrainNativeResponse {
    let application = match application() {
        Ok(application) => application,
        Err(error) => return failure(ERROR_HOST_FAILURE, &error),
    };
    dispatch_with(application, &NativeProjectPlatform, request)
}

fn dispatch_with(
    application: &Application,
    platform: &impl ProjectPlatform,
    request: &RefrainNativeRequest,
) -> RefrainNativeResponse {
    let input = match request_text(request)
        .and_then(|text| serde_json::from_str::<ProjectInput>(text).map_err(invalid_json))
    {
        Ok(input) => input,
        Err(error) => return failure(ERROR_INVALID_REQUEST, &error),
    };
    match application.project(platform, input) {
        Ok(output) => success(&output),
        Err(_error) => failure(ERROR_DOMAIN_REFUSAL, "Rust refused the project input."),
    }
}

fn request_text(request: &RefrainNativeRequest) -> Result<&str, String> {
    let length = usize::try_from(request.text_len).map_err(|error| error.to_string())?;
    if length > EVENT_TEXT_BYTES {
        return Err(format!(
            "project input is {length} bytes; the ABI bound is {EVENT_TEXT_BYTES}"
        ));
    }
    std::str::from_utf8(&request.text[..length]).map_err(|error| error.to_string())
}

fn invalid_json(error: serde_json::Error) -> String {
    format!("decode the project input: {error}")
}

fn success(output: &ProjectOutput) -> RefrainNativeResponse {
    let mut bounded = output.clone();
    loop {
        match serde_json::to_vec(&bounded) {
            Ok(bytes) if bytes.len() <= PROJECTION_BYTES => {
                let mut response = RefrainNativeResponse::empty(0, ACTION_PROJECT);
                response.text_len = bytes.len() as u32;
                response.text[..bytes.len()].copy_from_slice(&bytes);
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
            page.next = page.documents.last().map(|document| document.path.clone());
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
        ProjectOutput::Cancelled | ProjectOutput::Deleted(_) | ProjectOutput::DisclosureSet(_) => {
            false
        }
    }
}

fn failure(status: u32, detail: &str) -> RefrainNativeResponse {
    let mut response = RefrainNativeResponse::empty(status, ACTION_PROJECT);
    let bytes = detail.as_bytes();
    let length = bytes.len().min(PROJECTION_BYTES);
    response.text_len = length as u32;
    response.text[..length].copy_from_slice(&bytes[..length]);
    response
}

fn application() -> Result<&'static Application, String> {
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
    }

    fn request(input: &ProjectInput) -> RefrainNativeRequest {
        let bytes = serde_json::to_vec(input).unwrap();
        let mut request = RefrainNativeRequest {
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
            viewport_block_count: 0,
            text_len: bytes.len() as u32,
            text: [0; EVENT_TEXT_BYTES],
        };
        request.text[..bytes.len()].copy_from_slice(&bytes);
        request
    }

    #[test]
    fn one_native_project_action_adopts_without_returning_a_path() {
        let data = scratch("data");
        let root = scratch("root");
        fs::write(root.join("正文.md"), "Rust owns this path.\n").unwrap();
        let application = Application::open(&data).unwrap();
        let response = dispatch_with(
            &application,
            &Selected(Mutex::new(Some(root.clone()))),
            &request(&ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            }),
        );

        assert_eq!(response.status, 0);
        assert_eq!(response.action, ACTION_PROJECT);
        let json: serde_json::Value =
            serde_json::from_slice(&response.text[..response.text_len as usize]).unwrap();
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

    #[test]
    fn maximum_project_catalog_page_fits_the_fixed_native_payload() {
        let data = scratch("data");
        let root = scratch("max-page-root");
        for index in 0..256 {
            fs::write(root.join(format!("{index:03}.md")), "bounded\n").unwrap();
        }
        let application = Application::open(&data).unwrap();
        let response = dispatch_with(
            &application,
            &Selected(Mutex::new(Some(root.clone()))),
            &request(&ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            }),
        );

        assert_eq!(
            response.status,
            0,
            "{}",
            std::str::from_utf8(&response.text[..response.text_len as usize]).unwrap()
        );
        assert!((response.text_len as usize) <= PROJECTION_BYTES);
        let output: serde_json::Value =
            serde_json::from_slice(&response.text[..response.text_len as usize]).unwrap();
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
    fn project_refusals_do_not_leak_selected_paths_across_the_native_boundary() {
        let data = scratch("data");
        let selected = scratch("selected-secret").join("missing-root");
        let application = Application::open(&data).unwrap();
        let response = dispatch_with(
            &application,
            &Selected(Mutex::new(Some(selected.clone()))),
            &request(&ProjectInput::ChooseAndAdoptRoot {
                kind: RootKind::Folder,
            }),
        );

        assert_eq!(response.status, ERROR_DOMAIN_REFUSAL);
        let detail = std::str::from_utf8(&response.text[..response.text_len as usize]).unwrap();
        assert_eq!(detail, "Rust refused the project input.");
        assert!(!detail.contains(&selected.to_string_lossy().to_string()));

        drop(application);
        fs::remove_dir_all(data).unwrap();
        fs::remove_dir_all(selected.parent().unwrap()).unwrap();
    }

    #[test]
    fn oversized_or_malformed_project_inputs_are_refused_before_use_case_execution() {
        let data = scratch("data");
        let application = Application::open(&data).unwrap();
        let mut malformed = request(&ProjectInput::ChooseAndAdoptRoot {
            kind: RootKind::Folder,
        });
        malformed.text[..4].copy_from_slice(b"nope");
        malformed.text_len = 4;
        let response = dispatch_with(&application, &Selected(Mutex::new(None)), &malformed);
        assert_eq!(response.status, ERROR_INVALID_REQUEST);

        let mut oversized = malformed;
        oversized.text_len = (EVENT_TEXT_BYTES + 1) as u32;
        let response = dispatch_with(&application, &Selected(Mutex::new(None)), &oversized);
        assert_eq!(response.status, ERROR_INVALID_REQUEST);

        drop(application);
        fs::remove_dir_all(data).unwrap();
    }
}
