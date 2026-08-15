//! 把一条 `ProjectOutput` 写成界面读得动的行。
//!
//! **接上哪个功能**：`project::dispatch` 的成功出口。它以前把 `ProjectOutput`
//! 整棵树 serde 成 JSON 送过界，界面再在字节里找字段；现在这里按
//! `protocol/host.json` 的答复表填定长结构体，两边都不解析。
//!
//! **在全局逻辑中负责什么**：只做投影，不做判断。哪些 Run 算在飞、哪一行能不能
//! 点，仍然归界面与领域层——这里回答的是「界面要看的那六十个字段现在各是什么」。
//!
//! **为什么形状不是 Rust 类型树的镜像**：`Config`、`HostSnapshot`、`KaraTransition`
//! 都比界面读的那一层深得多。线上形状按**界面真的读什么**定，所以四处「在字节里
//! 找东西」的代码可以整块消失——Rust 本来就知道答案：
//!
//! - tasks × runs 的内连接：`RunRow` 直接带 `document`，界面不再自己连；
//! - 待恢复名单扫描：`needs_recovery` 是行上的一个 bool；
//! - 已暂存提案扫描：`staged` 是行上的一个 bool；
//! - KARA 的 effects 遍历：换成一个枚举、一个位掩码与两段文本。
//!
//! **十三个封闭集过 u8 枚举**（角色、Run 状态、披露档、harness 三面、信箱格、
//! persona 模式、裁决与收取的结局、KARA 态、token 三态、面板材质）。中文措辞仍在
//! `project_view.zig`，但它的 `switch` 现在穷尽：新增一个状态而忘了写读法是编译
//! 错误，而不是一行「未知」。

use crate::wire::{
    self, AgentRow, AnnotationRow, ChangeRow, CollectState, ConnectionRow, DecisionState,
    DeskBlockRow, Disclosure, DocumentRole, DocumentRow, HarnessRow, HarnessSkill, HarnessState,
    HarnessTier, HitRow, Kind, MailboxBox, MailboxRow, ManifestRow, MaterialDraftRow, MaterialRow,
    PanelMaterial, PersonaMode, ProposalRow, RunProgress, RunRow, Str, Tokens, WireRow, Writer,
};
use refrain_app::{ProjectOutput, ProjectProposals};
use refrain_core::kara::{InterruptEvent, KaraEffect, KaraState, QuietEvent};
use refrain_core::persona::Persona;
use refrain_host::host::RunProgress as HostProgress;
use refrain_store::config::{AdapterKind, PanelMaterial as StorePanelMaterial};
use refrain_store::mailbox::MailboxBoxName;
use refrain_store::project::DocumentRow as CatalogRow;

/// 一条答复的线上字节。
///
/// 每种答复自己开一个 `Writer`：头的大小由种类决定，而行与文本要在头写回去之前
/// 追加完——顺序在这里是构造出来的，不靠调用方记得。
#[expect(
    clippy::too_many_lines,
    reason = "one arm per reply kind: the projection table is the point, and splitting it would \
              hide which kinds exist"
)]
pub fn encode(output: &ProjectOutput) -> Vec<u8> {
    match output {
        ProjectOutput::Cancelled => empty(Kind::Cancelled),

        ProjectOutput::Opened(opened) => {
            let mut writer = Writer::new(Kind::Opened, wire::OpenedHead::BYTES);
            let root_id = writer.text(&opened.root_id);
            let cursor = writer.text(opened.document_cursor.as_deref().unwrap_or_default());
            let rows = document_rows(&mut writer, &opened.documents);
            writer.finish(&wire::OpenedHead {
                root_id,
                document_cursor: cursor,
                document_total: opened.document_total,
                documents: rows,
            })
        }

        ProjectOutput::DocumentOpened(document) => {
            let mut writer = Writer::new(Kind::DocumentOpened, wire::DocumentOpenedHead::BYTES);
            // 打开一份稿子不换 Root：界面已有的 root_id 就是它的，送一个空的
            // 会让下一次「按 root 读」失去收件人。
            let root_id = writer.text("");
            let _ = &document.document;
            writer.finish(&wire::DocumentOpenedHead { root_id })
        }

        ProjectOutput::Imported(row) => single_document(Kind::Imported, row),
        ProjectOutput::Deleted(row) => single_document(Kind::Deleted, row),
        ProjectOutput::DisclosureSet(row) => single_document(Kind::DisclosureSet, row),

        ProjectOutput::Page(page) => {
            let mut writer = Writer::new(Kind::Page, wire::PageHead::BYTES);
            let cursor = writer.text(page.document_cursor.as_deref().unwrap_or_default());
            let rows = document_rows(&mut writer, &page.documents);
            writer.finish(&wire::PageHead {
                document_cursor: cursor,
                document_total: page.document_total,
                documents: rows,
            })
        }

        ProjectOutput::Documents(listing) => {
            let mut writer = Writer::new(Kind::Documents, wire::DocumentsHead::BYTES);
            let rows = document_rows(&mut writer, &listing.documents);
            writer.finish(&wire::DocumentsHead { documents: rows })
        }

        ProjectOutput::Blocks(listing) => {
            let mut writer = Writer::new(Kind::Blocks, wire::BlocksHead::BYTES);
            let mut rows = Vec::with_capacity(listing.blocks.len());
            for hit in &listing.blocks {
                let path = writer.text(&hit.path);
                let text = writer.text(&hit.text);
                rows.push(HitRow {
                    path,
                    text,
                    ordinal: hit.ordinal,
                    block: true,
                });
            }
            let hits = writer.rows(&rows);
            writer.finish(&wire::BlocksHead { hits })
        }

        ProjectOutput::DocumentBlocks(listing) => {
            let mut writer = Writer::new(Kind::DocumentBlocks, wire::DocumentBlocksHead::BYTES);
            let mut rows = Vec::with_capacity(listing.blocks.len());
            for block in &listing.blocks {
                let id = writer.text(&block.id);
                let kind = writer.text(&block.kind);
                let peek = writer.text(&block.peek);
                rows.push(DeskBlockRow {
                    id,
                    kind,
                    peek,
                    ordinal: block.ordinal,
                    chars: block.chars,
                });
            }
            let blocks = writer.rows(&rows);
            // 0 是「没有下一页」：翻页游标恒 ≥ 1，所以缺席与 0 在这里是一件事。
            writer.finish(&wire::DocumentBlocksHead {
                blocks,
                next: listing.next.unwrap_or(0),
            })
        }

        ProjectOutput::Materials(listing) => {
            let mut writer = Writer::new(Kind::Materials, wire::MaterialsHead::BYTES);
            let mut rows = Vec::with_capacity(listing.materials.len());
            for material in &listing.materials {
                let path = writer.text(&material.path);
                rows.push(MaterialRow {
                    path,
                    disclosure: disclosure(material.disclosure.as_deref()),
                });
            }
            let materials = writer.rows(&rows);
            writer.finish(&wire::MaterialsHead {
                materials,
                truncated: listing.truncated,
            })
        }

        ProjectOutput::Config(config) => {
            let mut writer = Writer::new(Kind::Config, wire::ConfigHead::BYTES);
            let appearance = &config.appearance;
            let typography = &appearance.typography;
            let theme = writer.text(&appearance.theme);
            let font_latin = writer.text(&typography.fonts.latin);
            let font_chinese = writer.text(&typography.fonts.chinese);
            let font_japanese = writer.text(&typography.fonts.japanese);
            let mut agent_rows = Vec::with_capacity(config.agents.len());
            for agent in &config.agents {
                let id = writer.text(&agent.id.to_string());
                let name = writer.text(&agent.name);
                let persona_body = writer.text(agent.persona.as_ref().map_or("", Persona::body));
                let connection_id = writer.text(
                    &agent
                        .connection_id
                        .map(|id| id.to_string())
                        .unwrap_or_default(),
                );
                agent_rows.push(AgentRow {
                    id,
                    name,
                    persona_body,
                    connection_id,
                    argv_count: u32::try_from(agent.argv.len()).unwrap_or(u32::MAX),
                    mode: persona_mode(agent.persona.as_ref()),
                });
            }
            let agents = writer.rows(&agent_rows);
            let mut connection_rows = Vec::with_capacity(config.harness_connections.len());
            for connection in &config.harness_connections {
                let adapter = writer.text(adapter_name(connection.adapter));
                let executable = writer.text(&connection.executable.to_string_lossy());
                connection_rows.push(ConnectionRow {
                    adapter,
                    executable,
                    argv_count: u32::try_from(connection.argv.len()).unwrap_or(u32::MAX),
                });
            }
            let connections = writer.rows(&connection_rows);
            writer.finish(&wire::ConfigHead {
                theme,
                font_latin,
                font_chinese,
                font_japanese,
                text_size_tenths_px: u32::from(typography.text_size_tenths_px),
                measure_tenths_em: u32::from(typography.measure_tenths_em),
                line_height_percent: u32::from(typography.line_height_percent),
                agents,
                connections,
                panel_material: panel_material(appearance.panel_material),
            })
        }

        ProjectOutput::Kara(transition) => {
            let mut writer = Writer::new(Kind::Kara, wire::KaraHead::BYTES);
            // 两件自消展示在这里就答完：界面以前要走一遍 effects 数组找它们，
            // 而「第一条叫这个名字的效果」是 Rust 侧一句 `find`。
            let card_tail = transition.effects.iter().find_map(|effect| match effect {
                KaraEffect::ShowReturnCard { point } => Some(point.sentence_tail.as_str()),
                _ => None,
            });
            let interrupt = transition.effects.iter().find_map(|effect| match effect {
                KaraEffect::InterruptNow(event) => Some(interrupt_name(*event)),
                _ => None,
            });
            let return_tail = writer.text(card_tail.unwrap_or_default());
            let interrupt_text = writer.text(interrupt.unwrap_or_default());
            writer.finish(&wire::KaraHead {
                return_tail,
                interrupt: interrupt_text,
                queued_mask: queued_mask(&transition.machine.queued),
                state: kara_state(&transition.machine.state),
                card: card_tail.is_some(),
            })
        }

        ProjectOutput::Host(snapshot) => {
            let mut writer = Writer::new(Kind::Host, wire::HostHead::BYTES);
            let mut rows = Vec::with_capacity(snapshot.runs.len());
            for run in &snapshot.runs {
                // tasks × runs 的内连接在这里做一次，而不是让界面为每一行走一遍
                // 两张表。连不上的 Run 仍然过界（它是真实存在的），只是没有文档名。
                let document = snapshot
                    .tasks
                    .iter()
                    .find(|task| task.id == run.task_id)
                    .map(|task| task.document.as_str())
                    .unwrap_or_default();
                let id = writer.text(&run.id.to_string());
                let document = writer.text(document);
                let workspace = writer.text(&run.workspace);
                let failure = writer.text(match &run.progress {
                    HostProgress::Failed { failure } => failure.as_str(),
                    _ => "",
                });
                let needs_recovery = snapshot.runs_requiring_recovery.contains(&run.id);
                rows.push(RunRow {
                    id,
                    document,
                    workspace,
                    failure,
                    progress: run_progress(&run.progress),
                    needs_recovery,
                });
            }
            let runs = writer.rows(&rows);
            writer.finish(&wire::HostHead {
                runs,
                run_total: u32::try_from(snapshot.run_total).unwrap_or(u32::MAX),
            })
        }

        ProjectOutput::History(entries) => {
            let mut writer = Writer::new(Kind::History, wire::HistoryHead::BYTES);
            let mut rows = Vec::with_capacity(entries.len());
            for entry in entries {
                let id = writer.text(&entry.id);
                let cause = writer.text(&entry.cause);
                rows.push(ChangeRow {
                    id,
                    cause,
                    ordinal: entry.ordinal,
                    undone: entry.undone,
                });
            }
            let changes = writer.rows(&rows);
            writer.finish(&wire::HistoryHead { changes })
        }

        ProjectOutput::Annotations(entries) => {
            let mut writer = Writer::new(Kind::Annotations, wire::AnnotationsHead::BYTES);
            let mut rows = Vec::with_capacity(entries.len());
            for entry in entries {
                let quote = writer.text(&entry.quote);
                let body = writer.text(&entry.body);
                rows.push(AnnotationRow {
                    quote,
                    body,
                    comment: entry.comment,
                });
            }
            let annotations = writer.rows(&rows);
            writer.finish(&wire::AnnotationsHead { annotations })
        }

        ProjectOutput::Harnesses(entries) => {
            let mut writer = Writer::new(Kind::Harnesses, wire::HarnessesHead::BYTES);
            let mut rows = Vec::with_capacity(entries.len());
            for entry in entries {
                let id = writer.text(&entry.id);
                let program = writer.text(&entry.program);
                let version = writer.text(&entry.version);
                rows.push(HarnessRow {
                    id,
                    program,
                    version,
                    state: harness_state(entry.state),
                    tier: harness_tier(entry.tier),
                    skill: harness_skill(entry.skill),
                });
            }
            let harnesses = writer.rows(&rows);
            writer.finish(&wire::HarnessesHead { harnesses })
        }

        ProjectOutput::Dispatched(dispatched) => {
            let writer = Writer::new(Kind::Dispatched, wire::DispatchedHead::BYTES);
            writer.finish(&wire::DispatchedHead {
                run_count: u32::try_from(dispatched.runs.len()).unwrap_or(u32::MAX),
            })
        }

        ProjectOutput::Proposals(listing) => proposals(listing),

        ProjectOutput::Decided(report) => {
            let writer = Writer::new(Kind::Decided, wire::DecidedHead::BYTES);
            writer.finish(&wire::DecidedHead {
                state: decision_state(report),
            })
        }

        ProjectOutput::Collected(report) => {
            let writer = Writer::new(Kind::Collected, wire::CollectedHead::BYTES);
            writer.finish(&wire::CollectedHead {
                state: collect_state(report),
            })
        }

        ProjectOutput::Mailbox(entries) => {
            let mut writer = Writer::new(Kind::Mailbox, wire::MailboxHead::BYTES);
            let mut rows = Vec::with_capacity(entries.len());
            for entry in entries {
                let id = writer.text(&entry.id);
                let document = writer.text(&entry.document);
                let scope = writer.text(&entry.scope);
                let before_text = writer.text(&entry.before_text);
                let after_text = writer.text(entry.after_text.as_deref().unwrap_or_default());
                rows.push(MailboxRow {
                    id,
                    document,
                    scope,
                    before_text,
                    after_text,
                    rank: entry.rank.unwrap_or(0),
                    box_name: mailbox_box(entry.box_name),
                    pinned: entry.pinned,
                    ranked: entry.rank.is_some(),
                });
            }
            let entries = writer.rows(&rows);
            writer.finish(&wire::MailboxHead { entries })
        }

        ProjectOutput::DispatchPreview(package) => {
            let mut writer = Writer::new(Kind::DispatchPreview, wire::DispatchPreviewHead::BYTES);
            let digest = writer.text(&package.digest);
            let mut rows = Vec::with_capacity(package.manifest.len());
            for entry in &package.manifest {
                let section = writer.text(&entry.section);
                let source = writer.text(&entry.source);
                rows.push(ManifestRow {
                    section,
                    source,
                    bytes: entry.bytes,
                    tokens: tokens(entry.tokens),
                });
            }
            let manifest = writer.rows(&rows);
            writer.finish(&wire::DispatchPreviewHead {
                digest,
                prefix_bytes: package.prefix_bytes,
                manifest,
            })
        }

        ProjectOutput::MaterialDrafts(drafts) => {
            let mut writer = Writer::new(Kind::MaterialDrafts, wire::MaterialDraftsHead::BYTES);
            let mut rows = Vec::with_capacity(drafts.len());
            for draft in drafts {
                let id = writer.text(&draft.id);
                let title = writer.text(&draft.title);
                let kind = writer.text(&draft.kind);
                let body = writer.text(&draft.body);
                rows.push(MaterialDraftRow {
                    id,
                    title,
                    kind,
                    body,
                });
            }
            let drafts = writer.rows(&rows);
            writer.finish(&wire::MaterialDraftsHead { drafts })
        }
    }
}

fn empty(kind: Kind) -> Vec<u8> {
    let writer = Writer::new(kind, wire::CancelledHead::BYTES);
    writer.finish(&wire::CancelledHead::default())
}

fn single_document(kind: Kind, row: &CatalogRow) -> Vec<u8> {
    let mut writer = Writer::new(kind, wire::ImportedHead::BYTES);
    let rows = document_rows(&mut writer, std::slice::from_ref(row));
    writer.finish(&wire::ImportedHead { documents: rows })
}

fn document_rows(writer: &mut Writer, rows: &[CatalogRow]) -> wire::Rows {
    let mut encoded = Vec::with_capacity(rows.len());
    for row in rows {
        let path = writer.text(&row.path);
        // 目录行没有独立的标题字段：路径就是作者给它起的名字。留着这一格是
        // 因为界面已经为它排了版，而将来的标题不该再换一次线上形状。
        let title = Str::default();
        encoded.push(DocumentRow {
            path,
            title,
            role: document_role(row.role),
        });
    }
    writer.rows(&encoded)
}

fn proposals(listing: &ProjectProposals) -> Vec<u8> {
    let mut writer = Writer::new(Kind::Proposals, wire::ProposalsHead::BYTES);
    let mut rows = Vec::with_capacity(listing.proposals.len());
    for proposal in &listing.proposals {
        let id = writer.text(&proposal.id);
        let scope = writer.text(&proposal.scope);
        let before_text = writer.text(&proposal.before_text);
        let after_text = writer.text(proposal.after_text.as_deref().unwrap_or_default());
        // 「这一条判过了吗」在这里答一次。界面以前为每一行走一遍 staged 数组，
        // 而配对本来就是这一侧做的。
        let staged = listing.staged.iter().any(|entry| entry == &proposal.id);
        rows.push(ProposalRow {
            id,
            scope,
            before_text,
            after_text,
            staged,
        });
    }
    let proposals = writer.rows(&rows);
    writer.finish(&wire::ProposalsHead {
        proposals,
        staged_count: u32::try_from(listing.staged.len()).unwrap_or(u32::MAX),
    })
}

// ------------------------------------------------------- 封闭集：词到一个字节

fn document_role(role: refrain_core::DocumentRole) -> DocumentRole {
    match role {
        refrain_core::DocumentRole::Chapter => DocumentRole::Chapter,
        refrain_core::DocumentRole::Document => DocumentRole::Document,
        refrain_core::DocumentRole::Material => DocumentRole::Material,
    }
}

fn disclosure(name: Option<&str>) -> Disclosure {
    match name {
        None | Some("retrievable") => Disclosure::Retrievable,
        Some("outline-only") => Disclosure::OutlineOnly,
        Some("full") => Disclosure::Full,
        Some(_) => Disclosure::Unknown,
    }
}

fn run_progress(progress: &HostProgress) -> RunProgress {
    match progress {
        HostProgress::Queued => RunProgress::Queued,
        HostProgress::Authorized { .. } => RunProgress::Authorized,
        HostProgress::Launching { .. } => RunProgress::Launching,
        HostProgress::Dispatched { .. } => RunProgress::Dispatched,
        HostProgress::Completed { .. } => RunProgress::Completed,
        HostProgress::Failed { .. } => RunProgress::Failed,
        HostProgress::Cancelled => RunProgress::Cancelled,
    }
}

fn harness_state(state: refrain_app::harness::HarnessState) -> HarnessState {
    match state {
        refrain_app::harness::HarnessState::Ready => HarnessState::Ready,
        refrain_app::harness::HarnessState::NotInstalled => HarnessState::NotInstalled,
        refrain_app::harness::HarnessState::Unreadable => HarnessState::Unreadable,
    }
}

fn harness_tier(tier: refrain_app::harness::HarnessTier) -> HarnessTier {
    match tier {
        refrain_app::harness::HarnessTier::File => HarnessTier::File,
        refrain_app::harness::HarnessTier::Launch => HarnessTier::Launch,
        refrain_app::harness::HarnessTier::Usage => HarnessTier::Usage,
    }
}

fn harness_skill(skill: refrain_core::context_compiler::SkillStatus) -> HarnessSkill {
    match skill {
        refrain_core::context_compiler::SkillStatus::None => HarnessSkill::None,
        refrain_core::context_compiler::SkillStatus::Current => HarnessSkill::Current,
        refrain_core::context_compiler::SkillStatus::Stale => HarnessSkill::Stale,
    }
}

fn mailbox_box(name: MailboxBoxName) -> MailboxBox {
    match name {
        MailboxBoxName::Draft => MailboxBox::Draft,
        MailboxBoxName::Unread => MailboxBox::Unread,
        MailboxBoxName::Done => MailboxBox::Done,
    }
}

fn persona_mode(persona: Option<&Persona>) -> PersonaMode {
    match persona {
        None => PersonaMode::None,
        Some(Persona::Work { .. }) => PersonaMode::Work,
        Some(Persona::Cosplay { .. }) => PersonaMode::Cosplay,
    }
}

fn panel_material(material: StorePanelMaterial) -> PanelMaterial {
    match material {
        StorePanelMaterial::Solid => PanelMaterial::Solid,
        StorePanelMaterial::Acrylic => PanelMaterial::Acrylic,
        StorePanelMaterial::Liquid => PanelMaterial::Liquid,
    }
}

fn tokens(value: refrain_core::context_compiler::Tokens) -> Tokens {
    match value {
        refrain_core::context_compiler::Tokens::Actual(_) => Tokens::Actual,
        refrain_core::context_compiler::Tokens::Estimated(_) => Tokens::Estimated,
        refrain_core::context_compiler::Tokens::Unknown => Tokens::Unknown,
    }
}

fn decision_state(report: &refrain_app::DecisionReport) -> DecisionState {
    match report {
        refrain_app::DecisionReport::Durable => DecisionState::Durable,
        refrain_app::DecisionReport::BodyDurable { .. } => DecisionState::BodyDurable,
        refrain_app::DecisionReport::Conflict => DecisionState::Conflict,
    }
}

fn collect_state(report: &refrain_app::CollectReport) -> CollectState {
    match report {
        refrain_app::CollectReport::Waiting => CollectState::Waiting,
        refrain_app::CollectReport::Completed { .. } => CollectState::Completed,
        refrain_app::CollectReport::Failed { .. } => CollectState::Failed,
    }
}

fn kara_state(state: &KaraState) -> wire::KaraState {
    match state {
        KaraState::Off => wire::KaraState::Off,
        KaraState::Entering { .. } => wire::KaraState::Entering,
        KaraState::Writing { .. } => wire::KaraState::Writing,
        KaraState::Reviewing { .. } => wire::KaraState::Reviewing,
        KaraState::Away { .. } => wire::KaraState::Away,
        KaraState::Leaving { .. } => wire::KaraState::Leaving,
    }
}

/// 安静事件队列的掩码：1 已保存 / 2 agent 完成 / 4 提案到达 / 8 索引刷新。
///
/// 位序由 `QuietEvent` 的变体序决定，穷尽匹配守着它——新增一种安静事件而忘了
/// 给它一位，是编译错误。
fn queued_mask(queued: &[QuietEvent]) -> u32 {
    let mut mask = 0u32;
    for event in queued {
        mask |= match event {
            QuietEvent::SaveSucceeded => 1,
            QuietEvent::AgentCompleted => 2,
            QuietEvent::ProposalArrived => 4,
            QuietEvent::IndexRefreshed => 8,
        };
    }
    mask
}

fn interrupt_name(event: InterruptEvent) -> &'static str {
    match event {
        InterruptEvent::SaveFailed => "save-failed",
        InterruptEvent::DiskUnwritable => "disk-unwritable",
        InterruptEvent::RootIdentityChanged => "root-identity-changed",
        InterruptEvent::ExternalConflict => "external-conflict",
    }
}

fn adapter_name(adapter: AdapterKind) -> &'static str {
    match adapter {
        AdapterKind::L0 => "l0",
        AdapterKind::Codex => "codex",
        AdapterKind::ClaudeCode => "claude-code",
        AdapterKind::Pi => "pi",
        AdapterKind::KimiCode => "kimi-code",
        AdapterKind::Hermes => "hermes",
    }
}
