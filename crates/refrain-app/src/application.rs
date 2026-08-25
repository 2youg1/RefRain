//! The one router: one exhaustive input in, one bounded output out.
//!
//! # 接上哪个功能
//!
//! 全部。W5「project channel」的应用侧终点：原生宿主解出一条
//! [`ProjectInput`]，这里把它交给持有那条规则的用例模块，再把结果装成一条
//! [`ProjectOutput`]。
//!
//! # 这一层持有的不变量
//!
//! **臂里不做工作。** 每条臂只做三件事：取出这次动作要用的所有物（时刻、
//! 设置、项目锁），调**一个**用例函数，装成一条答复。顺序知识、拒绝措辞与
//! 落盘纪律都在用例模块里——写在臂里的规则没有名字，也没有单独的测试。
//!
//! **一条输入一条答复。** 界面在动作之后不再发第二次读：答复本身就是新的
//! 视图（信箱、草稿名录、历史都是这条纪律）。要读两次才对的答复，说明第一
//! 次答错了。
//!
//! **[`Application`] 只持有四样东西**：已采用的 Root、KARA、设置、生产者
//! runner。它们各自的规则在各自的模块，这里只保证一次动作用到的几样东西落在
//! 同一个作用域里。
//!
//! # 能复用什么
//!
//! [`Application::with_project`] 是「在一个项目上做一件事」的公开入口，原生
//! 宿主与集成测试用的是同一个。新增一条输入的做法：在持有那条规则的模块里加
//! 一个用例函数，在 `project_channel` 加一个变体，在这里加一条臂——
//! 不在这里加规则。

use refrain_core::{DocumentRole, ErrorCode, QuietEvent, RefrainError};
use refrain_store::config::{Config, ConfigChange, ConfigStore};
use refrain_store::project::{DocumentRow, RootLocator};
use std::path::Path;
use std::sync::Mutex;

use crate::collect::CollectReport;
use crate::host_session;
use crate::kara::Kara;
use crate::materials::MaterialDraftView;
use crate::native_document::AnchorSource;
use crate::platform::{ProjectImport, ProjectPlatform, selected_path_failure};
use crate::project_channel::{ProjectInput, ProjectOutput};
use crate::root::{OpenRoots, ProjectEntry, ProjectOpened, RootKind};

/// 这个进程的应用状态：四样所有物，一个入口。
pub struct Application {
    /// 已采用的 Root 与它们的活句柄。
    roots: OpenRoots,
    /// KARA 的机器与策略。
    kara: Kara,
    /// 设置的唯一写者与它最近一次快照。
    ///
    /// 收进这里而不是留在装配层：`ConfigStore::apply` 已经是唯一写者，
    /// 但此前它住在 Tauri 的 `lib.rs`，于是原生表面够不着同一份设置。
    /// 放在 `Application` 之后两个宿主读的是同一份，步骤 10 删掉 Tauri
    /// 也不会带走设置权威。
    config: Mutex<(ConfigStore, Config)>,
    /// 生产者 runner（M9）的活动表：本机握着句柄的 Run。泵在 `ReadHost`
    /// 里跑——轮询链本来就在那里，零新机制。
    runner: Mutex<crate::runner::Runner>,
}

impl Application {
    /// 打开机器级状态：app.db、设置文件、空的项目表与 runner。
    ///
    /// # Errors
    ///
    /// app.db 或设置文件打不开时具名失败。
    pub fn open(data_dir: &Path) -> Result<Self, RefrainError> {
        Ok(Self {
            roots: OpenRoots::open(data_dir)?,
            kara: Kara::new(),
            config: Mutex::new({
                let (store, snapshot) = ConfigStore::load(data_dir).map_err(|error| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "load the config",
                        error.to_string(),
                    )
                })?;
                (store, snapshot.config)
            }),
            runner: Mutex::new(crate::runner::Runner::default()),
        })
    }

    /// 这个进程的 KARA。集成测试读它的状态，用例经它记事件。
    #[must_use]
    pub fn kara(&self) -> &Kara {
        &self.kara
    }

    /// 当前设置。读的是缓存的快照，不重读文件——`apply` 是唯一写者，
    /// 它写盘的同时更新这里，两者不会分开。
    ///
    /// # Errors
    ///
    /// 设置的锁被毒化时报 `StateUnavailable`。
    pub fn config(&self) -> Result<Config, RefrainError> {
        self.config.lock().map(|held| held.1.clone()).map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the config", "config")
        })
    }

    /// 改一项设置，返回改完之后的完整 Config。
    ///
    /// 校验、迁移、原子写盘与「拖动值与档位互斥」这类规则都在
    /// `ConfigStore::apply` 里，这里只保证盘上与内存里的那一份同时更新。
    ///
    /// # Errors
    ///
    /// 设置被拒绝（校验不过、文件更新）或锁被毒化时具名失败。
    pub fn apply_config(&self, change: ConfigChange) -> Result<Config, RefrainError> {
        let mut held = self.config.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the config", "config")
        })?;
        let snapshot = held.0.apply(change).map_err(|error| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "apply a config change",
                error.to_string(),
            )
        })?;
        held.1 = snapshot.config.clone();
        Ok(snapshot.config)
    }

    /// 在一个开着的 Root 上做一件事。crate 内外共用的项目入口。
    ///
    /// # Errors
    ///
    /// Root 没开、锁被毒化，或闭包自己失败时上抛。
    pub fn with_project<T>(
        &self,
        root_id: &str,
        use_entry: impl FnOnce(&mut ProjectEntry) -> Result<T, RefrainError>,
    ) -> Result<T, RefrainError> {
        self.roots.with(root_id, use_entry)
    }

    /// 原生表面的锚定来源：这份文档的批注与待裁决提案。
    ///
    /// # Errors
    ///
    /// Root 没开，或提案与批注读不出来时具名失败。
    pub fn native_anchor_sources(
        &self,
        root_id: &str,
        relative: &str,
    ) -> Result<Vec<AnchorSource>, RefrainError> {
        self.roots.with(root_id, |entry| {
            crate::review::anchor_sources(entry, relative)
        })
    }

    /// 成稿或退回一条材料草稿。
    ///
    /// # Errors
    ///
    /// 见 `materials::commit_draft`。
    pub fn commit_material_action(
        &self,
        root_id: &str,
        draft_id: &str,
        edited_body: Option<String>,
        dismiss: bool,
        role: DocumentRole,
    ) -> Result<Option<DocumentRow>, RefrainError> {
        crate::materials::commit_draft(
            &self.roots,
            &self.kara,
            root_id,
            draft_id,
            edited_body,
            dismiss,
            role,
        )
    }

    /// 材料草稿名录。
    ///
    /// # Errors
    ///
    /// Root 没开或草稿表读不出来时具名失败。
    pub fn material_draft_views(
        &self,
        root_id: &str,
    ) -> Result<Vec<MaterialDraftView>, RefrainError> {
        self.roots.with(root_id, crate::materials::drafts)
    }

    /// 一条输入的答复。臂里不做工作：取所有物、调一个用例、装一条答复。
    ///
    /// # Errors
    ///
    /// 用例的具名拒绝原样上抛——作者要读到的是「为什么不行」，不是一个
    /// 通用的失败。
    pub fn project(
        &self,
        platform: &impl ProjectPlatform,
        input: ProjectInput,
    ) -> Result<ProjectOutput, RefrainError> {
        let now = now();
        match input {
            ProjectInput::ChooseAndAdoptRoot { kind } => {
                let Some(path) = platform.choose_root(kind).map_err(|error| {
                    selected_path_failure(error, "choose a Root", "selected Root")
                })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                self.adopt(RootLocator { path, kind })
                    .map_err(|error| selected_path_failure(error, "adopt a Root", "selected Root"))
                    .map(ProjectOutput::Opened)
            }
            ProjectInput::ChooseAndCreateProject { name } => {
                // 名字先判：非法的名字不该先弹一次对话框再拒绝。规则在
                // `root::legal_project_name`，建目录时再守一次。
                crate::root::legal_project_name(&name)?;
                let Some(parent) = platform.choose_project_parent().map_err(|error| {
                    selected_path_failure(error, "choose a project location", name.clone())
                })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                crate::root::create_project_directory(&parent, &name)
                    .and_then(|path| {
                        self.adopt(RootLocator {
                            path,
                            kind: RootKind::Folder,
                        })
                    })
                    .map_err(|error| selected_path_failure(error, "create a project", name.clone()))
                    .map(ProjectOutput::Opened)
            }
            ProjectInput::OpenDocument { root_id, path } => self
                .roots
                .with(&root_id, |entry| {
                    crate::document::open(entry, &self.kara, &path)
                })
                .map(Box::new)
                .map(ProjectOutput::DocumentOpened),
            ProjectInput::CreateDocument {
                root_id,
                title,
                role,
            } => self
                .roots
                .with(&root_id, |entry| {
                    crate::document::create(entry, &self.kara, &title, role)
                })
                .map(Box::new)
                .map(ProjectOutput::DocumentOpened),
            ProjectInput::ChooseAndImportMaterial { root_id } => {
                let Some(path) =
                    platform
                        .choose_import(ProjectImport::Material)
                        .map_err(|error| {
                            selected_path_failure(error, "choose a material", "selected material")
                        })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                crate::materials::import_material(&self.roots, &root_id, path)
                    .map(ProjectOutput::Imported)
            }
            ProjectInput::ChooseAndImportManuscript { root_id } => {
                let Some(path) =
                    platform
                        .choose_import(ProjectImport::Manuscript)
                        .map_err(|error| {
                            selected_path_failure(
                                error,
                                "choose a manuscript",
                                "selected manuscript",
                            )
                        })?
                else {
                    return Ok(ProjectOutput::Cancelled);
                };
                crate::materials::import_manuscript(&self.roots, &self.kara, &root_id, path)
                    .map(ProjectOutput::Imported)
            }
            ProjectInput::DocumentPage { root_id, after } => self
                .roots
                .with(&root_id, |entry| crate::root::page(entry, after))
                .map(ProjectOutput::Page),
            ProjectInput::DocumentSearch {
                root_id,
                query,
                precision,
            } => {
                let found = self.roots.with(&root_id, |entry| {
                    crate::search::documents(entry, &query, precision)
                })?;
                self.index_built(found.index_built)?;
                Ok(ProjectOutput::Documents(found.hits))
            }
            ProjectInput::BlockSearch {
                root_id,
                query,
                precision,
            } => {
                let found = self.roots.with(&root_id, |entry| {
                    crate::search::blocks(entry, &query, precision)
                })?;
                self.index_built(found.index_built)?;
                Ok(ProjectOutput::Blocks(found.hits))
            }
            ProjectInput::DeleteDocument { root_id, path } => self
                .roots
                .with(&root_id, |entry| crate::root::delete(entry, &path))
                .map(ProjectOutput::Deleted),
            ProjectInput::SetDisclosure {
                root_id,
                path,
                disclosure,
            } => self
                .roots
                .with(&root_id, |entry| {
                    crate::materials::set_disclosure(entry, &path, disclosure)
                })
                .map(ProjectOutput::DisclosureSet),
            ProjectInput::ReadConfig => self
                .config()
                .map(|config| ProjectOutput::Config(Box::new(config))),
            ProjectInput::ChangeConfig(change) => self
                .apply_config(change)
                .map(|config| ProjectOutput::Config(Box::new(config))),
            ProjectInput::KaraStep(event) => self
                .kara
                .step(event)
                .map(|transition| ProjectOutput::Kara(Box::new(transition))),
            ProjectInput::ReadHost { root_id } => {
                // M9：泵先于快照。轮询链（runs_tick → readHost）因此把全部
                // 活动 Run 推进一步，答复里就是最新的编排事实。
                let report = self.pump_runs(&root_id, now)?;
                for (_run, proposals) in &report.completed {
                    self.kara.run_completed(*proposals)?;
                }
                self.roots
                    .with(&root_id, host_session::snapshot)
                    .map(|snapshot| ProjectOutput::Host(Box::new(snapshot)))
            }
            ProjectInput::ReadMaterialDrafts { root_id } => self
                .material_draft_views(&root_id)
                .map(ProjectOutput::MaterialDrafts),
            ProjectInput::CommitMaterialDraft {
                root_id,
                draft_id,
                edited_body,
                dismiss,
                as_chapter,
            } => {
                self.commit_material_action(
                    &root_id,
                    &draft_id,
                    edited_body,
                    dismiss,
                    if as_chapter {
                        DocumentRole::Chapter
                    } else {
                        DocumentRole::Material
                    },
                )?;
                // 答复即刷新后的名录：动作与视图同一生灭，界面不再发一次读。
                self.material_draft_views(&root_id)
                    .map(ProjectOutput::MaterialDrafts)
            }
            ProjectInput::HostCommand { root_id, command } => self
                .roots
                .with(&root_id, move |entry| {
                    host_session::execute(entry, *command)
                })
                .map(|snapshot| ProjectOutput::Host(Box::new(snapshot))),
            ProjectInput::LaunchRun { root_id, run_id } => self
                .roots
                .with(&root_id, |entry| host_session::launch_run(entry, run_id))
                .map(|snapshot| ProjectOutput::Host(Box::new(snapshot))),
            ProjectInput::ReadHistory { root_id, path } => self
                .roots
                .with(&root_id, |entry| {
                    crate::history::recent_history(&entry.store, &path)
                })
                .map(ProjectOutput::History),
            ProjectInput::ReadAnnotations { root_id, path } => self
                .roots
                .with(&root_id, |entry| {
                    crate::history::annotations_of(&entry.store, &path)
                })
                .map(ProjectOutput::Annotations),
            ProjectInput::Annotate {
                root_id,
                path,
                selected,
                body,
            } => self
                .roots
                .with(&root_id, |entry| {
                    crate::history::annotate_selection(entry, &path, &selected, body, now)
                })
                .map(ProjectOutput::Annotations),
            ProjectInput::ConvertWidth {
                root_id,
                path,
                selected,
                whole_document,
                direction,
            } => self
                .roots
                .with(&root_id, |entry| {
                    crate::text_width::convert(entry, &path, &selected, whole_document, &direction)
                })
                .map(ProjectOutput::History),
            // 不经项目锁：探测问的是这台机器，没有项目也该答得出。
            ProjectInput::ReadHarnesses { force } => {
                let statuses = if force {
                    crate::harness::probe_harnesses_forced()
                } else {
                    crate::harness::probe_harnesses()
                };
                Ok(ProjectOutput::Harnesses(statuses))
            }
            ProjectInput::InstallSkill { harness_id } => crate::harness::install_skill(&harness_id)
                .map(ProjectOutput::Harnesses)
                .map_err(|detail| {
                    RefrainError::new(
                        ErrorCode::StateUnavailable,
                        "install the protocol",
                        &harness_id,
                    )
                    .with_detail(detail)
                }),
            ProjectInput::Dispatch { root_id, request } => {
                // 设置在项目锁之外读：接续与协议装载的事实住在 Config 与工作区
                // 里，不在请求里。
                let config = self.config()?;
                self.roots
                    .with(&root_id, |entry| {
                        crate::dispatch::dispatch(entry, &config, &request)
                    })
                    .map(|dispatched| ProjectOutput::Dispatched(Box::new(dispatched)))
            }
            ProjectInput::PreviewDispatch { root_id, request } => {
                let config = self.config()?;
                self.roots
                    .with(&root_id, |entry| {
                        crate::dispatch::preview(entry, &config, &request)
                    })
                    .map(|package| ProjectOutput::DispatchPreview(Box::new(package)))
            }
            ProjectInput::ReadProposals { root_id, path } => self
                .roots
                .with(&root_id, |entry| crate::review::read(&entry.store, &path))
                .map(ProjectOutput::Proposals),
            ProjectInput::ReadBlocks {
                root_id,
                path,
                after,
                count,
            } => self
                .roots
                .with(&root_id, |entry| {
                    crate::scope::list_blocks(entry, &path, after, count)
                })
                .map(ProjectOutput::DocumentBlocks),
            ProjectInput::ReadMaterials { root_id } => self
                .roots
                .with(&root_id, crate::materials::listing)
                .map(ProjectOutput::Materials),
            ProjectInput::StageVerdict {
                root_id,
                path,
                proposal_id,
                kind,
                final_text,
                reason,
            } => self
                .roots
                .with(&root_id, |entry| {
                    crate::review::stage_verdict(
                        &mut entry.store,
                        &path,
                        &proposal_id,
                        kind,
                        final_text,
                        reason,
                        now,
                    )
                })
                .map(ProjectOutput::Proposals),
            ProjectInput::CommitVerdicts { root_id, path } => self
                .roots
                .with(&root_id, |entry| {
                    crate::decide::commit_verdicts(entry, &path)
                })
                .map(ProjectOutput::Decided),
            ProjectInput::JudgeVerdict {
                root_id,
                path,
                proposal_id,
                kind,
                final_text,
                reason,
            } => self
                .roots
                .with(&root_id, |entry| {
                    // 先记后交：账本只增，所以次序不能反。饭盒的接受/退回
                    // 走这条——判完即落盘，作者回到写作。
                    crate::review::stage_verdict(
                        &mut entry.store,
                        &path,
                        &proposal_id,
                        kind,
                        final_text,
                        reason,
                        now,
                    )?;
                    crate::decide::commit_verdicts(entry, &path)
                })
                .map(ProjectOutput::Decided),
            ProjectInput::Countermand {
                root_id,
                path,
                proposal_ids,
            } => self
                .roots
                .with(&root_id, |entry| {
                    crate::decide::countermand(entry, &path, &proposal_ids, now)
                })
                .map(ProjectOutput::Decided),
            ProjectInput::CollectRun { root_id, run_id } => {
                let report = self.roots.with(&root_id, |entry| {
                    crate::collect::collect_run(entry, &run_id, now)
                })?;
                // 安静事件：Run 完成记 AgentCompleted；带来提案再记
                // ProposalArrived——两个事实，两种分量。
                if let CollectReport::Completed { proposals, .. } = &report {
                    self.kara.run_completed(*proposals)?;
                }
                Ok(ProjectOutput::Collected(report))
            }
            ProjectInput::NativeSaved { root_id, path } => {
                let history = self.roots.with(&root_id, |entry| {
                    crate::document::reconcile_saved_chain(entry, &path)
                })?;
                // 安静事件：保存成功。事实在领域发生处落地，不经视图转述——
                // 离场小结带读的是机器里的队列，不是界面的记忆。
                self.kara.quiet(QuietEvent::SaveSucceeded)?;
                Ok(ProjectOutput::History(history))
            }
            ProjectInput::ReadMailbox { root_id, discarded } => self
                .roots
                .with(&root_id, |entry| {
                    if discarded {
                        crate::mailbox::discarded(&entry.store)
                    } else {
                        crate::mailbox::entries(&entry.store)
                    }
                })
                .map(ProjectOutput::Mailbox),
            ProjectInput::MailboxPin {
                root_id,
                entry_id,
                box_name,
                pinned,
            } => self
                .roots
                .with(&root_id, |entry| {
                    crate::mailbox::set_pinned(entry, &entry_id, box_name, pinned, now)
                })
                .map(ProjectOutput::Mailbox),
            ProjectInput::MailboxRank {
                root_id,
                entry_id,
                box_name,
                rank,
            } => self
                .roots
                .with(&root_id, |entry| {
                    crate::mailbox::set_rank(entry, &entry_id, box_name, rank, now)
                })
                .map(ProjectOutput::Mailbox),
            ProjectInput::MailboxSwap {
                root_id,
                entry_id,
                other_id,
            } => self
                .roots
                .with(&root_id, |entry| {
                    crate::mailbox::swap_ranks(entry, &entry_id, &other_id, now)
                })
                .map(ProjectOutput::Mailbox),
            ProjectInput::MailboxDiscard {
                root_id,
                entry_id,
                box_name,
            } => self
                .roots
                .with(&root_id, |entry| {
                    crate::mailbox::discard(entry, &entry_id, box_name, now)
                })
                .map(ProjectOutput::Mailbox),
            ProjectInput::MailboxRestore { root_id, entry_id } => self
                .roots
                .with(&root_id, |entry| {
                    crate::mailbox::restore(entry, &entry_id, now)
                })
                .map(ProjectOutput::Mailbox),
        }
    }

    /// 采用一个 Root，并让 KARA 重新上膛：新项目上「第一份正文」重新有意义。
    fn adopt(&self, locator: RootLocator) -> Result<ProjectOpened, RefrainError> {
        let opened = self.roots.adopt(locator)?;
        self.kara.rearm()?;
        Ok(opened)
    }

    /// 懒建索引的建成时刻：这次检索把它从「待建」变成「已建」。事实归安静
    /// 事件，且在项目锁之外发。
    fn index_built(&self, built: bool) -> Result<(), RefrainError> {
        if built {
            self.kara.quiet(QuietEvent::IndexRefreshed)?;
        }
        Ok(())
    }

    /// 推进这个 Root 的生产者 runner 一步（M9）。泵的全部规则在 `runner`
    /// 模块；这里只把三样东西交到同一个作用域：活动表、项目、设置。
    fn pump_runs(
        &self,
        root_id: &str,
        now: u64,
    ) -> Result<crate::runner::PumpReport, RefrainError> {
        let config = self.config()?;
        let mut runner = self.runner.lock().map_err(|_| {
            RefrainError::new(
                ErrorCode::StateUnavailable,
                "lock the producer runner",
                "runner",
            )
        })?;
        self.roots.with(root_id, |entry| {
            crate::runner::pump(root_id, entry, &mut runner, &config, now)
        })
    }
}

/// 现在是什么时候，毫秒。一次动作读一次，交给用到它的用例——同一次动作里
/// 记下的时刻因此处处相同，而用例函数不必各自认识时钟。
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}
