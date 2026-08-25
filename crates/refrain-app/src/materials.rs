//! 资料：导进来的参考文档、派发台勾选的名录，以及 Agent 交来的草稿。
//!
//! # 接上哪个功能
//!
//! F13「资料与导入」。抽取（PDF／Office／HTML → 纯文本）归
//! `refrain_store::ingest`，克隆与草稿行归 `refrain_store::materials`；
//! 这一层是它们之间的顺序，以及跨界那一刻的形状。
//!
//! # 这一层持有的不变量
//!
//! **原件永远只被读。** 导入是「克隆进 `.refrain-source/materials/`，再把抽取
//! 出来的文本建成一份文档」；作者磁盘上的那一份从头到尾没被写过。正文里第一
//! 行的来源注记（格式、blake3 前 12 位、克隆的相对位置）是这份克隆的收据——
//! 没有它，半年后没人能回答「这段文字是从哪来的」。
//!
//! **名录一页 200 行，超了就截尾并说清。** 装不下的答复会被跨界截断层丢尾
//! （`truncate_output` 丢的是尾巴），那时作者看到的是一份看起来完整的短名单。
//! 在这里截断，`truncated` 是诚实的那一位。
//!
//! **档位以线名过河，不过枚举。** 名录里没设过档位是 `null`，读法（默认 =
//! 可检索）归界面；加一个新档位不该改变跨界的类型形状。
//!
//! # 能复用什么
//!
//! 导入正文与草稿提拔成正文走同一条落地（`document::create_with_body`）与同一
//! 条 KARA 进场判断，所以「第一份正文打开」这件事在两条路上是同一个事实。

use refrain_core::material_listing::Disclosure;
use refrain_core::{DocumentRole, ErrorCode, RefrainError};
use refrain_store::project::DocumentRow;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};

use crate::document::{ImportedFrom, create_with_body};
use crate::journal::into_domain;
use crate::kara::Kara;
use crate::platform::selected_path_failure;
use crate::root::{OpenRoots, ProjectEntry};

/// 资料名录一页的行数上限：超过就截尾并置 `truncated`——装不下的答复
/// 会被跨界截断层丢尾，不如在这里截断并说清。
const MATERIALS_PAGE: usize = 200;

/// 资料名录的一行：派发台勾选什么，界面要的只有这两列。
///
/// `disclosure` 是线名（kebab-case 词）或 null——名录里没设过档位时
/// 是 null，读法（默认 = 可检索）归界面；一个新档位不该改变这里的类型
/// 形状，所以不过 `Disclosure` 枚举本身。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MaterialRow {
    pub path: String,
    pub disclosure: Option<String>,
}

/// 这个项目的资料名录。超 ~200 行截尾并说清——装不下的答复会被
/// 跨界截断层丢尾，在这里截断，作者看到的是诚实的清单。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMaterials {
    pub materials: Vec<MaterialRow>,
    pub truncated: bool,
}

/// 一条材料草稿在界面上的样子。body 随行走：行内编辑从它起笔，
/// 不必再发一次读。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MaterialDraftView {
    pub id: String,
    pub title: String,
    /// 草稿的种类（chapter-synopsis / character-profile / …），协议词汇。
    pub kind: String,
    /// 本轮给 Agent 的文档依据（文档@修订 的 JSON）。
    pub basis: String,
    pub body: String,
}

impl From<refrain_store::materials::MaterialDraftRow> for MaterialDraftView {
    fn from(row: refrain_store::materials::MaterialDraftRow) -> Self {
        Self {
            id: row.id,
            title: row.title,
            kind: row.kind,
            basis: row.basis,
            body: row.body,
        }
    }
}

/// 这个项目的资料名录：派发台「这轮给 agent 读什么」的勾选行。
///
/// # Errors
///
/// 目录读不出来时具名失败。
pub fn listing(entry: &mut ProjectEntry) -> Result<ProjectMaterials, RefrainError> {
    let catalog = entry.store.documents()?;
    let mut materials: Vec<MaterialRow> = catalog
        .iter()
        .filter(|row| row.role == DocumentRole::Material)
        .map(|row| MaterialRow {
            path: row.path.clone(),
            disclosure: row.disclosure.map(|tier| tier.as_str().to_string()),
        })
        .collect();
    let truncated = materials.len() > MATERIALS_PAGE;
    materials.truncate(MATERIALS_PAGE);
    Ok(ProjectMaterials {
        materials,
        truncated,
    })
}

/// 给一份资料定档位：这一轮 agent 能读到它的多少。
///
/// # Errors
///
/// 文档不在册时具名失败。
pub fn set_disclosure(
    entry: &mut ProjectEntry,
    path: &str,
    disclosure: Disclosure,
) -> Result<DocumentRow, RefrainError> {
    entry
        .store
        .set_disclosure(path, disclosure)
        .map_err(into_domain)
}

/// 材料草稿名录：等待成稿或退回的全部草稿。成稿与退回的答复就是
/// 刷新后的这一份——视图与事实同一生灭（与信箱动作同一纪律）。
///
/// # Errors
///
/// 草稿表读不出来时具名失败。
pub fn drafts(entry: &mut ProjectEntry) -> Result<Vec<MaterialDraftView>, RefrainError> {
    Ok(entry
        .store
        .material_drafts()
        .map_err(into_domain)?
        .into_iter()
        .map(MaterialDraftView::from)
        .collect())
}

/// 成稿或退回一条材料草稿。`role` 只接受 `Material`（收进资料区）与
/// `Chapter`（直接提拔成正文）——后者过 `Kara::manuscript_opened`，首份正文
/// 的 KARA 自动进场因此与拖入文件同一条路径。
///
/// # Errors
///
/// 角色不是这两种、草稿不在表里、或落地失败时具名失败。
pub fn commit_draft(
    roots: &OpenRoots,
    kara: &Kara,
    root_id: &str,
    draft_id: &str,
    edited_body: Option<String>,
    dismiss: bool,
    role: DocumentRole,
) -> Result<Option<DocumentRow>, RefrainError> {
    if !matches!(role, DocumentRole::Material | DocumentRole::Chapter) {
        return Err(RefrainError::new(
            ErrorCode::StateUnavailable,
            "commit a material draft as",
            format!("{role:?}"),
        ));
    }
    roots.with(root_id, |entry| {
        let draft = entry
            .store
            .material_drafts()
            .map_err(into_domain)?
            .into_iter()
            .find(|row| row.id == draft_id)
            .ok_or_else(|| {
                RefrainError::new(
                    ErrorCode::StateUnavailable,
                    "resolve a draft",
                    "no such draft",
                )
            })?;
        if dismiss {
            entry
                .store
                .material_draft_take(draft_id)
                .map_err(into_domain)?;
            return Ok(None);
        }

        let body = edited_body.unwrap_or_else(|| draft.body.clone());
        let transition = kara.manuscript_opened(role, &draft.title)?;
        let (row, _opened) = create_with_body(entry, &draft.title, &body, role, None, transition)?;
        entry
            .store
            .material_draft_take(draft_id)
            .map_err(into_domain)?;
        Ok(Some(row))
    })
}

/// 导入一份资料：克隆原件、抽取文本、建成资料区的一份文档。
///
/// 克隆目录要从项目布局里读，抽取在项目锁**外**做（PDF 抽取是秒级的，
/// 不该挡住这个项目上的别的动作），落地再进一次锁。
///
/// # Errors
///
/// 选中的不是文件、格式不支持、抽取失败或落地失败时具名失败；错误里不带
/// 作者的真实路径。
pub fn import_material(
    roots: &OpenRoots,
    root_id: &str,
    selected: PathBuf,
) -> Result<DocumentRow, RefrainError> {
    let source = chosen_file(selected)
        .map_err(|error| selected_path_failure(error, "import a material", "selected material"))?;
    let clone_dir = roots.with(root_id, |entry| {
        Ok(entry.store.layout().source_backup_dir.join("materials"))
    })?;
    let clone_base = clone_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let prepared = refrain_store::materials::prepare_material_source(&source, &clone_dir)
        .map_err(into_domain)
        .map_err(|error| selected_path_failure(error, "prepare a material", "selected material"))?;
    let ingested = prepared.material;
    let source_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("source");
    let clone_display = prepared
        .clone
        .strip_prefix(&clone_base)
        .unwrap_or(&prepared.clone)
        .display();
    let header = format!(
        "> 来源：{source_name}（{} · blake3 {}）；原件克隆：{clone_display}",
        ingested.format.as_str(),
        &ingested.source_digest[..12],
    );
    let body = format!("{header}\n\n{}", ingested.text);
    roots.with(root_id, |entry| {
        let (row, _opened) = create_with_body(
            entry,
            &ingested.title,
            &body,
            DocumentRole::Material,
            Some(ImportedFrom {
                digest: &ingested.source_digest,
                format: ingested.format.as_str(),
            }),
            None,
        )?;
        Ok(row)
    })
}

/// 导入一份正文：读字节、去 BOM、建成正文区的一份文档。
///
/// 与资料不同，正文不克隆原件——它从这一刻起就是作者在写的那一份。文件名
/// 的主干是标题；没有主干时用「拖入」，因为一份没有名字的正文在名录里是
/// 一行空白。
///
/// # Errors
///
/// 选中的不是文件、字节不是 UTF-8、或落地失败时具名失败；错误里不带作者的
/// 真实路径。
pub fn import_manuscript(
    roots: &OpenRoots,
    kara: &Kara,
    root_id: &str,
    selected: PathBuf,
) -> Result<DocumentRow, RefrainError> {
    let source = chosen_file(selected).map_err(|error| {
        selected_path_failure(error, "import a manuscript", "selected manuscript")
    })?;
    let bytes = refrain_store::ingest::read_source(&source).map_err(|error| {
        selected_path_failure(error, "read an imported manuscript", "selected manuscript")
    })?;
    let text_bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let text = String::from_utf8(text_bytes.to_vec()).map_err(|_| {
        RefrainError::new(
            ErrorCode::UnsupportedFormat,
            "read an imported manuscript",
            "not UTF-8 text",
        )
    })?;
    let title = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("拖入")
        .to_string();
    roots.with(root_id, |entry| {
        let transition = kara.manuscript_opened(DocumentRole::Chapter, &title)?;
        let (row, _opened) = create_with_body(
            entry,
            &title,
            &text,
            DocumentRole::Chapter,
            None,
            transition,
        )?;
        Ok(row)
    })
}

/// 作者选中的那一份，规范化之后确认它是文件。
///
/// 规范化在前：一条相对路径或带 `..` 的路径此后会指向别处，而导入的每一步
/// 都拿它当同一份东西看。
fn chosen_file(path: PathBuf) -> Result<PathBuf, RefrainError> {
    let canonical = path.canonicalize().map_err(|error| {
        RefrainError::new(
            ErrorCode::Io,
            "use a chosen source",
            path.display().to_string(),
        )
        .with_detail(error.to_string())
    })?;
    if !canonical.is_file() {
        return Err(RefrainError::new(
            ErrorCode::UnsupportedFormat,
            "use a chosen source",
            canonical.display().to_string(),
        ));
    }
    Ok(canonical)
}
