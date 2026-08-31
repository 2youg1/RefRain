// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 已采用的 Root：机器级的项目表，以及在一个项目上做事的入口。
//!
//! # 接上哪个功能
//!
//! F4「Roots 与目录」的应用侧：采用一个 Root、新建一个项目、翻目录页、
//! 删一份文档。作者点开的每一条别的功能也从这里进——用例要动这个项目的
//! 存储，就得先经过 `OpenRoots::with` 拿到它的锁。
//!
//! # 这一层持有的不变量
//!
//! **一个 Root 只进表一次，且只经 `adopt` 进。** app.db 记的是机器级事实
//! （哪些 Root 被采用过、上次落在哪份文档），项目库记的是这个 Root 自己的
//! 事实；两者在采用那一刻一起就位，此后 `with` 是唯一的取用方式。让调用方
//! 自己攒 `ProjectEntry`，就会出现两个 `ProjectStore` 指着同一个目录而各写
//! 各的。
//!
//! **两把锁的次序**：先项目表、后单个项目，且取到 `Arc` 之后立刻放掉项目表
//! ——采用与使用因此不会互相等待。
//!
//! # 能复用什么
//!
//! `with` 是全 crate 的项目入口（`Application::with_project` 与原生宿主用的
//! 是同一个）。`ProjectEntry` 是用例函数的标准入参：一个用例只要收它，就能
//! 在集成测试里被单独驱动。

use refrain_core::{ErrorCode, Manuscript, RefrainError};
use refrain_store::application::{ApplicationStore, ApplicationStoreError};
use refrain_store::project::{
    BackupStatus, DocumentPage, DocumentPageQuery, DocumentRow, MAX_DOCUMENT_PAGE_SIZE,
    ProjectStore, RootLocator,
};
pub use refrain_store::root::RootKind;
use refrain_store::root::is_legal_segment;
use serde::Serialize;
use specta::Type;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::journal::into_domain;

/// Live handles for one adopted Root. The fields are visible to the use-case
/// modules: each of them takes `&mut ProjectEntry` and works inside the lock
/// this type is stored behind.
pub struct ProjectEntry {
    pub store: ProjectStore,
    pub manuscripts: HashMap<String, Manuscript>,
}

/// 一次采用的结果：这个 Root 的身份、备份状况，以及目录的第一页。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOpened {
    pub root_id: String,
    pub backup: BackupStatus,
    pub documents: Vec<DocumentRow>,
    pub document_total: u32,
    pub document_cursor: Option<String>,
    pub opened_path: Option<String>,
}

/// One page of a Root's catalogue.
///
/// The field names are deliberately the same three `ProjectOpened` carries.
/// They were `total` / `next`, which meant the surface had to know which of
/// two replies it was reading before it could find the page's own size and
/// cursor — and it did not: it read `documentTotal` from both, so every page
/// after an adopt reported a total of zero and lost its cursor. One name per
/// fact, across every reply that states the fact.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPage {
    pub documents: Vec<DocumentRow>,
    pub document_total: u32,
    pub document_cursor: Option<String>,
}

impl From<DocumentPage> for ProjectPage {
    fn from(page: DocumentPage) -> Self {
        Self {
            documents: page.documents,
            document_total: page.total,
            document_cursor: page.next,
        }
    }
}

/// 机器上开着的全部 Root：app.db 与每个项目的活句柄。
pub struct OpenRoots {
    store: Mutex<ApplicationStore>,
    open: Mutex<HashMap<String, Arc<Mutex<ProjectEntry>>>>,
}

impl OpenRoots {
    /// 打开机器级存储。目录不存在时由 `ApplicationStore` 自己建。
    ///
    /// # Errors
    ///
    /// app.db 打不开、迁移不过去，或目录不可写时具名失败。
    pub fn open(data_dir: &Path) -> Result<Self, RefrainError> {
        Ok(Self {
            store: Mutex::new(ApplicationStore::open(data_dir).map_err(store_failure)?),
            open: Mutex::new(HashMap::new()),
        })
    }

    /// 采用一个 Root：登记进 app.db、开它的项目库、读回目录第一页。
    ///
    /// # Errors
    ///
    /// 路径不能被采用（不是目录、备份建不起来、库迁移不过去）时具名失败；
    /// 锁被毒化时报 `StateUnavailable`。
    pub fn adopt(&self, locator: RootLocator) -> Result<ProjectOpened, RefrainError> {
        let (mut store, backup) = self
            .store
            .lock()
            .map_err(|_| RefrainError::new(ErrorCode::StateUnavailable, "lock app.db", "adopt"))?
            .adopt(&locator)
            .map_err(store_failure)?;
        let root_id = store.permit().root_id.to_string();
        let page = store
            .refresh_document_page(DocumentPageQuery {
                after: None,
                limit: MAX_DOCUMENT_PAGE_SIZE,
            })
            .map_err(into_domain)?;
        let opened_path = store.landing_document().map_err(into_domain)?;
        self.open
            .lock()
            .map_err(|_| {
                RefrainError::new(ErrorCode::StateUnavailable, "lock the project map", "adopt")
            })?
            .insert(
                root_id.clone(),
                Arc::new(Mutex::new(ProjectEntry {
                    store,
                    manuscripts: HashMap::new(),
                })),
            );
        Ok(ProjectOpened {
            root_id,
            backup,
            documents: page.documents,
            document_total: page.total,
            document_cursor: page.next,
            opened_path,
        })
    }

    /// 在一个开着的 Root 上做一件事。取 `Arc` 之后立刻放掉项目表：一个项目
    /// 上的长动作不挡住另一个项目的采用。
    ///
    /// # Errors
    ///
    /// Root 没开、或任一把锁被毒化时报 `StateUnavailable`；闭包自己的失败
    /// 原样上抛。
    pub fn with<T>(
        &self,
        root_id: &str,
        use_entry: impl FnOnce(&mut ProjectEntry) -> Result<T, RefrainError>,
    ) -> Result<T, RefrainError> {
        let entry = {
            let open = self.open.lock().map_err(|_| {
                RefrainError::new(ErrorCode::StateUnavailable, "lock the project map", root_id)
            })?;
            Arc::clone(open.get(root_id).ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "use a Root that is not open",
                    root_id,
                )
            })?)
        };
        let mut entry = entry.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the project", root_id)
        })?;
        use_entry(&mut entry)
    }
}

/// 一个项目名必须是一个合法的路径片段。
///
/// 路由在弹对话框**之前**先问这一句：一个非法的名字不该先让作者选完
/// 位置再被拒。[`create_project_directory`] 同样守一次——同一条规则，
/// 一个定义，两个调用点。
///
/// # Errors
///
/// 名字含分隔符、`..`、保留名或为空时报 `IllegalName`。
pub fn legal_project_name(name: &str) -> Result<(), RefrainError> {
    if is_legal_segment(name) {
        return Ok(());
    }
    Err(RefrainError::new(
        ErrorCode::IllegalName,
        "create a project",
        name,
    ))
}

/// 为一个新项目建目录：名字合法、位置没被占用，然后建。
///
/// 三段判断在采用之前完成——一个已经存在的目录不该被静默地当成新项目
/// 采用，作者读到的会是「新建成功」而里面是别人的文件。
///
/// # Errors
///
/// 名字含非法片段、目标已存在、或建目录失败时具名失败。
pub fn create_project_directory(parent: &Path, name: &str) -> Result<PathBuf, RefrainError> {
    legal_project_name(name)?;
    let path = parent.join(name);
    if path.try_exists().map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "check the project directory",
            path.display().to_string(),
        )
        .with_detail(error.to_string())
    })? {
        return Err(RefrainError::new(
            ErrorCode::Occupied,
            "create a project at",
            path.display().to_string(),
        ));
    }
    fs::create_dir(&path).map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "create the project directory",
            path.display().to_string(),
        )
        .with_detail(error.to_string())
    })?;
    Ok(path)
}

/// 目录的一页。`after` 是上一页的游标；`None` 从头。
///
/// # Errors
///
/// 项目库读不出来时具名失败。
pub fn page(entry: &mut ProjectEntry, after: Option<String>) -> Result<ProjectPage, RefrainError> {
    entry
        .store
        .refresh_document_page(DocumentPageQuery {
            after,
            limit: MAX_DOCUMENT_PAGE_SIZE,
        })
        .map(ProjectPage::from)
        .map_err(into_domain)
}

/// 删一份文档：进回收站（INV-3 由存储层守），并把它的活稿子从这个项目上摘掉。
///
/// # Errors
///
/// 文档不在册、或回收站不可用时具名失败。
pub fn delete(entry: &mut ProjectEntry, path: &str) -> Result<DocumentRow, RefrainError> {
    let row = entry.store.delete_document(path).map_err(into_domain)?;
    entry.manuscripts.remove(path);
    Ok(row)
}

/// app.db 的失败翻成领域错误。三种成因分开报：项目层的失败原样翻译，
/// 目录不可写与库本身打不开是两回事，压成一条会让作者读到错的补救。
fn store_failure(failure: ApplicationStoreError) -> RefrainError {
    match failure {
        ApplicationStoreError::Project(failure) => into_domain(failure),
        ApplicationStoreError::Io { path, source } => RefrainError::new(
            ErrorCode::Io,
            "open application storage",
            path.display().to_string(),
        )
        .with_detail(source.to_string()),
        ApplicationStoreError::Store(error) => RefrainError::new(
            ErrorCode::StateUnavailable,
            "open app.db",
            "application storage",
        )
        .with_detail(error.to_string()),
    }
}
