//! 逆向裁决：对已合并的提案下冲销。
//!
//! 判据（设计 D）：文本逐字节回到冻结前；账本只 append 不删；一批冲销是一次
//! Text Action（一次撤销全还原）；锚定对不上就整体拒绝；冲销动作本身进历史、
//! 可撤销。

use std::fs;
use std::path::{Path, PathBuf};

use refrain_app::decide::{commit_decision_batch, countermand_proposals};
use refrain_core::manuscript::VerdictKind;
use refrain_core::{
    EditorAction, EditorChange, ErrorCode, Id, Lineage, Manuscript, Replacement, SourceSnapshot,
    TextCommand,
};
use refrain_store::ledger::{VerdictKindName, VerdictRecord};
use refrain_store::project::{ProjectStore, RootLocator};
use refrain_store::root::RootKind;
use refrain_store::schema::{AppDb, Database};
use rusqlite::Connection;

const CHAPTER: &str = "章一.md";
const OPENING: &str = "剑一直握在他手里。";
const SECOND: &str = "他没有说话，风从窗口进来。";
const MERGED: &str = "他握着剑。";
const MERGED_SECOND: &str = "风从窗口进来，他没有说话。";

fn scratch() -> PathBuf {
    let root = std::env::temp_dir().join(format!("refrain-countermand-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join(CHAPTER), format!("{OPENING}\n\n{SECOND}\n")).unwrap();
    root
}

fn store_at(root: &Path) -> (Connection, ProjectStore) {
    let mut app = Connection::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.to_path_buf(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();
    (app, store)
}

fn open_manuscript(root: &Path) -> Manuscript {
    let snapshot = SourceSnapshot::read(fs::read(root.join(CHAPTER)).unwrap());
    let lineage = Lineage::fresh(snapshot.block_count());
    Manuscript::open(snapshot, lineage).unwrap()
}

/// 把一条「改写法」提案冻进 store，返回 (proposal_id, verdict_id)。
fn stage_proposal(
    store: &mut ProjectStore,
    manuscript: &Manuscript,
    block: usize,
    before: &str,
    after: Option<&str>,
) -> String {
    let proposal = Id::new();
    let block_id = manuscript.head().blocks()[block].id();
    store
        .proposal_insert(&refrain_store::project::ProposalRow {
            id: proposal.to_string(),
            run: Id::new().to_string(),
            baseline: manuscript.head().id().to_string(),
            document_path: CHAPTER.to_string(),
            scope: serde_json::to_string(&[block_id]).unwrap(),
            before_text: before.to_string(),
            after_text: after.map(str::to_string),
            created_at: 1,
        })
        .unwrap();
    // 切片由 before/after 句级对齐生成：改写提案是 [Delete(0), Insert(1)]，
    // 删除提案（after=None）只有 [Delete(0)]。每一个变更切片都要下裁决——
    // 未裁决的 Delete 切片按合并规则保留原文，只裁 Insert 不算一次完整合并。
    let ordinals: Vec<u32> = if after.is_some() { vec![0, 1] } else { vec![0] };
    let verdict_ids: Vec<String> = ordinals
        .iter()
        .enumerate()
        .map(|(index, ordinal)| {
            let verdict = Id::new();
            store
                .ledger()
                .record(&VerdictRecord {
                    id: verdict.to_string(),
                    proposal_id: proposal.to_string(),
                    slice_id: format!("{proposal}:{ordinal}"),
                    kind: VerdictKindName::Accept,
                    final_text: None,
                    reason: None,
                    decided_at: 2 + index as u64,
                    legacy_baseline: None,
                })
                .unwrap();
            verdict.to_string()
        })
        .collect();
    store
        .review_session_set(CHAPTER, 0, &serde_json::to_string(&verdict_ids).unwrap())
        .unwrap();
    proposal.to_string()
}

/// 走完真实的合并路径：提案 + 接受裁决 + 提交批次。
fn merge(store: &mut ProjectStore, manuscript: &mut Manuscript) -> String {
    let proposal = stage_proposal(store, manuscript, 0, OPENING, Some(MERGED));
    commit_decision_batch(store, manuscript, CHAPTER).unwrap();
    proposal
}

fn head_text(manuscript: &Manuscript) -> String {
    manuscript.head().text()
}

fn ledger_kinds(store: &ProjectStore) -> Vec<VerdictKindName> {
    store
        .ledger()
        .for_document(CHAPTER)
        .unwrap()
        .iter()
        .map(|row| row.kind)
        .collect()
}

#[test]
fn a_countermand_restores_the_frozen_bytes_and_the_ledger_keeps_both_records() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let mut manuscript = open_manuscript(&root);
    let proposal = merge(&mut store, &mut manuscript);
    assert!(head_text(&manuscript).contains(MERGED));

    countermand_proposals(&mut store, &mut manuscript, CHAPTER, &[proposal], 20).unwrap();

    // 文本逐字节回到冻结前。
    assert_eq!(head_text(&manuscript), format!("{OPENING}\n\n{SECOND}"));
    // 账本 append-only：接受与冲销成对，都在（两个变更切片各一条接受）。
    assert_eq!(
        ledger_kinds(&store),
        vec![
            VerdictKindName::Accept,
            VerdictKindName::Accept,
            VerdictKindName::Countermanded
        ]
    );

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_batch_countermand_is_one_action_and_one_undo_restores_everything() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let mut manuscript = open_manuscript(&root);

    let first = merge(&mut store, &mut manuscript);
    let second = {
        let proposal = stage_proposal(&mut store, &manuscript, 1, SECOND, Some(MERGED_SECOND));
        commit_decision_batch(&mut store, &mut manuscript, CHAPTER).unwrap();
        proposal
    };
    assert!(head_text(&manuscript).contains(MERGED));
    assert!(head_text(&manuscript).contains(MERGED_SECOND));

    let actions_before = manuscript.actions().len();
    countermand_proposals(&mut store, &mut manuscript, CHAPTER, &[first, second], 20).unwrap();

    // 一批冲销 = 一次 Text Action。
    assert_eq!(manuscript.actions().len(), actions_before + 1);
    let action = manuscript.actions().last().unwrap();
    assert_eq!(action.cause(), "countermand");
    // 冲销动作不携带裁决——它就是一次编辑，撤销它不必跨过账本。
    assert!(action.verdicts().is_empty());
    assert_eq!(head_text(&manuscript), format!("{OPENING}\n\n{SECOND}"));

    // 一次撤销把整批冲销退回：两份合并后的文字一起回来。
    manuscript.undo_last().unwrap();
    let restored = head_text(&manuscript);
    assert!(restored.contains(MERGED));
    assert!(restored.contains(MERGED_SECOND));

    // 账本是事实，撤销不碰它：冲销记录还在。
    assert_eq!(
        ledger_kinds(&store)
            .iter()
            .filter(|kind| **kind == VerdictKindName::Countermanded)
            .count(),
        2
    );

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_anchor_that_appears_twice_refuses_instead_of_reversing_the_wrong_one() {
    // 审计 F-02 的原点。合并进正文的字节在稿子里逐字出现两次时，从前的定位
    // 固定取第一处，于是冲销回退了**另一段**：作者没有要求回退的文字被改了，
    // 他真正想回退的那一段原封不动。两处都是他的字，改错一处就是丢字。
    //
    // 冲销是一次写入。不确定改哪一处时写入，比不写入坏得多，所以整批拒绝。
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let mut manuscript = open_manuscript(&root);
    let proposal = merge(&mut store, &mut manuscript);

    // 作者在别处又写了一段与合并结果逐字相同的话——副歌就是这样出现的，
    // 而这个产品正叫 RefRain。
    let last_block = manuscript
        .head()
        .blocks()
        .iter()
        .next_back()
        .expect("a last block")
        .id();
    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![last_block], Some(MERGED.to_string())).unwrap(),
            )],
            "author edit",
        )))
        .unwrap();

    let text_before = head_text(&manuscript);
    let refusal =
        countermand_proposals(&mut store, &mut manuscript, CHAPTER, &[proposal], 20).unwrap_err();

    assert_eq!(refusal.code, ErrorCode::StaleProposal);
    // 说清是几处，而不是笼统一句「过期了」——那会让作者去找一段并没有消失的文字。
    let detail = refusal.detail.as_deref().expect("a detail");
    assert!(
        detail.contains("2 places"),
        "the refusal must say how many places hold these bytes, got {detail:?}"
    );
    // 一个字节都没动，账本也没有冲销记录。
    assert_eq!(head_text(&manuscript), text_before);
    assert_eq!(
        ledger_kinds(&store),
        vec![VerdictKindName::Accept, VerdictKindName::Accept]
    );

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_moved_anchor_refuses_the_whole_countermand_and_records_nothing() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let mut manuscript = open_manuscript(&root);
    let proposal = merge(&mut store, &mut manuscript);

    // 作者后来自己改了那一段——当初合并进去的字节已经不在正文里。
    let merged_block = manuscript
        .head()
        .blocks()
        .iter()
        .find(|block| block.text() == MERGED)
        .expect("merged block")
        .id();
    manuscript
        .execute(TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![merged_block], Some("他放下了剑。".to_string())).unwrap(),
            )],
            "author edit",
        )))
        .unwrap();

    let text_before = head_text(&manuscript);
    let refusal =
        countermand_proposals(&mut store, &mut manuscript, CHAPTER, &[proposal], 20).unwrap_err();

    // 具名拒绝：过期的事实，交还当初合并进去的原文。
    assert_eq!(refusal.code, ErrorCode::StaleProposal);
    assert_eq!(refusal.detail.as_deref(), Some(MERGED));
    // 什么都没动：文本不变，账本没有冲销记录。
    assert_eq!(head_text(&manuscript), text_before);
    assert_eq!(
        ledger_kinds(&store),
        vec![VerdictKindName::Accept, VerdictKindName::Accept]
    );

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn countermanding_what_was_never_merged_is_refused() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let mut manuscript = open_manuscript(&root);

    // 只有拒绝裁决的提案：从未进过正文，没有可冲销的东西。
    let proposal = Id::new();
    store
        .proposal_insert(&refrain_store::project::ProposalRow {
            id: proposal.to_string(),
            run: Id::new().to_string(),
            baseline: manuscript.head().id().to_string(),
            document_path: CHAPTER.to_string(),
            scope: serde_json::to_string(&[manuscript.head().blocks()[0].id()]).unwrap(),
            before_text: OPENING.to_string(),
            after_text: Some(MERGED.to_string()),
            created_at: 1,
        })
        .unwrap();
    store
        .ledger()
        .record(&VerdictRecord {
            id: Id::new().to_string(),
            proposal_id: proposal.to_string(),
            slice_id: format!("{proposal}:1"),
            kind: VerdictKindName::Reject,
            final_text: None,
            reason: None,
            decided_at: 2,
            legacy_baseline: None,
        })
        .unwrap();

    let refusal = countermand_proposals(
        &mut store,
        &mut manuscript,
        CHAPTER,
        &[proposal.to_string()],
        20,
    )
    .unwrap_err();
    assert_eq!(refusal.code, ErrorCode::StateUnavailable);
    assert!(
        refusal.action.contains("never merged"),
        "拒绝要说出为什么不能冲销: {refusal:?}"
    );

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn countermanding_a_deletion_merge_is_refused_with_its_reason() {
    let root = scratch();
    let (_app, mut store) = store_at(&root);
    let mut manuscript = open_manuscript(&root);

    // 删除型合并：正文里少了那一段，没有字节可当锚定物。
    let proposal = {
        let proposal = stage_proposal(&mut store, &manuscript, 0, OPENING, None);
        commit_decision_batch(&mut store, &mut manuscript, CHAPTER).unwrap();
        proposal
    };
    assert_eq!(head_text(&manuscript), SECOND);

    let refusal =
        countermand_proposals(&mut store, &mut manuscript, CHAPTER, &[proposal], 20).unwrap_err();
    assert_eq!(refusal.code, ErrorCode::StateUnavailable);
    assert!(
        refusal.action.contains("deleted its scope"),
        "删除型合并的冲销要说出它缺的是什么: {refusal:?}"
    );
    assert_eq!(head_text(&manuscript), SECOND);

    drop(store);
    fs::remove_dir_all(root).unwrap();
}

/// 成对出现的另一条路：冲销记录在 `<changes>` 流里的投影由桥决定，而领域
/// 只承诺一件事——冲销用的重建规则与合并用的是同一个函数。
#[test]
fn the_countermand_anchor_is_computed_by_the_merge_rule_itself() {
    use refrain_core::manuscript::{EditScope, Proposal, Verdict};

    let block = Id::new();
    let proposal = Proposal::new(
        Id::new(),
        Id::new(),
        EditScope::new(vec![block]).unwrap(),
        OPENING.to_string(),
        Some(MERGED.to_string()),
    );
    let verdicts: Vec<Verdict> = proposal
        .slices()
        .iter()
        .filter(|slice| slice.kind().is_changed())
        .map(|slice| Verdict::new(&proposal, slice.id(), VerdictKind::Accept, None).unwrap())
        .collect();
    assert_eq!(verdicts.len(), 2, "改写提案应有一条 Delete 加一条 Insert");

    assert_eq!(
        refrain_core::manuscript::merged_text(&proposal, &verdicts),
        MERGED,
        "冲销锚定的就是合并时落地的那一段"
    );
    // 只裁一半的合并同样按规则重建：未裁决的 Delete 保留原文。
    let insert = proposal
        .slices()
        .iter()
        .find(|slice| slice.kind() == refrain_core::SliceKind::Insert)
        .expect("an insertion slice");
    let insert_only = [Verdict::new(&proposal, insert.id(), VerdictKind::Accept, None).unwrap()];
    assert_eq!(
        refrain_core::manuscript::merged_text(&proposal, &insert_only),
        format!("{OPENING}{MERGED}"),
        "部分采纳的锚定物是部分采纳后的文本"
    );
}
