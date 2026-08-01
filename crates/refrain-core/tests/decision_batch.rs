use refrain_core::{
    DecisionBatch, EditScope, Lineage, Manuscript, Proposal, SourceSnapshot, TextCommand,
    TextRefusal, Verdict, VerdictKind,
};

fn open(source: &str) -> Manuscript {
    let source = SourceSnapshot::read(source.as_bytes().to_vec());
    let lineage = Lineage::fresh(source.block_count());
    Manuscript::open(source, lineage).unwrap()
}

fn proposal(
    manuscript: &Manuscript,
    run: refrain_core::Id,
    blocks: Vec<refrain_core::Id>,
    after: &str,
) -> Proposal {
    let before = manuscript
        .head()
        .blocks()
        .iter()
        .filter(|block| blocks.contains(&block.id()))
        .map(|block| block.text())
        .collect::<Vec<_>>()
        .join("\n\n");
    Proposal::new(
        run,
        manuscript.head().id(),
        EditScope::new(blocks).unwrap(),
        before,
        Some(after.to_owned()),
    )
}

fn verdicts(proposal: &Proposal, kind: VerdictKind) -> Vec<Verdict> {
    proposal
        .slices()
        .iter()
        .filter(|slice| slice.kind().is_changed())
        .map(|slice| Verdict::new(proposal, slice.id(), kind.clone(), None).unwrap())
        .collect()
}

#[test]
fn accepting_all_changed_slices_commits_one_text_action() {
    let mut manuscript = open("黑暗中有人问。\n\n声音很熟。她想起十年前那个雨夜。\n\n剑尖垂下去。");
    let blocks = manuscript.head().block_ids();
    let proposal = proposal(
        &manuscript,
        refrain_core::Id::new(),
        vec![blocks[1]],
        "剑没有松。她想起十年前那个雨夜。",
    );
    let verdicts = verdicts(&proposal, VerdictKind::Accept);

    let transition = manuscript
        .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            manuscript.head().id(),
            vec![proposal],
            verdicts.clone(),
        )))
        .unwrap();

    assert_eq!(
        transition.head().text(),
        "黑暗中有人问。\n\n剑没有松。她想起十年前那个雨夜。\n\n剑尖垂下去。"
    );
    assert_eq!(transition.action().verdicts(), verdicts);
}

#[test]
fn unjudged_and_rejected_slices_keep_the_authors_exact_whitespace() {
    for before in [
        "First sentence. Second one stays.",
        "甲。\n\n乙。",
        "A.  Two spaces.",
        "剑尖垂下去。\n她没有回头。",
        "黑暗中有人问。  ",
    ] {
        let mut manuscript = open(before);
        let block = manuscript.head().block_ids()[0];
        let proposal = proposal(
            &manuscript,
            refrain_core::Id::new(),
            vec![block],
            &format!("{before} 改写。"),
        );
        let rejected = verdicts(&proposal, VerdictKind::Reject);
        let source_before = manuscript.materialize().unwrap();
        let head_before = manuscript.head().id();

        let transition = manuscript
            .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
                head_before,
                vec![proposal],
                rejected.clone(),
            )))
            .unwrap();

        assert_eq!(manuscript.materialize().unwrap(), source_before);
        assert_eq!(transition.head().id(), head_before);
        assert_eq!(transition.action().verdicts(), rejected);
    }
}

#[test]
fn modified_wording_is_valid_only_for_an_inserted_slice() {
    let manuscript = open("原文。");
    let block = manuscript.head().block_ids()[0];
    let proposal = proposal(&manuscript, refrain_core::Id::new(), vec![block], "改写。");
    let deletion = proposal
        .slices()
        .iter()
        .find(|slice| slice.kind().is_changed() && !slice.kind().is_insertion())
        .unwrap();

    assert!(matches!(
        Verdict::new(
            &proposal,
            deletion.id(),
            VerdictKind::AcceptModified("作者定稿。".to_owned()),
            None,
        ),
        Err(TextRefusal::ModifiedVerdictRequiresInsertion { slice })
            if slice == deletion.id()
    ));
}

#[test]
fn accept_modified_uses_the_authors_final_wording() {
    let mut manuscript = open("声音很熟。她想起十年前那个雨夜。");
    let block = manuscript.head().block_ids()[0];
    let proposal = proposal(
        &manuscript,
        refrain_core::Id::new(),
        vec![block],
        "剑没有松。她想起十年前那个雨夜。",
    );
    let verdicts = proposal
        .slices()
        .iter()
        .filter(|slice| slice.kind().is_changed())
        .map(|slice| {
            let kind = if slice.kind().is_insertion() {
                VerdictKind::AcceptModified("剑反而更稳。".to_owned())
            } else {
                VerdictKind::Accept
            };
            Verdict::new(&proposal, slice.id(), kind, None).unwrap()
        })
        .collect();

    manuscript
        .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            manuscript.head().id(),
            vec![proposal],
            verdicts,
        )))
        .unwrap();
    assert_eq!(
        manuscript.head().text(),
        "剑反而更稳。她想起十年前那个雨夜。"
    );
}

#[test]
fn disjoint_proposals_commute_and_share_one_transition() {
    let start = "one.\n\ntwo.\n\nthree.";
    let mut forward = open(start);
    let mut reverse = forward.clone();
    let ids = forward.head().block_ids();
    let a = proposal(&forward, refrain_core::Id::new(), vec![ids[0]], "ONE.");
    let b = proposal(&forward, refrain_core::Id::new(), vec![ids[2]], "THREE.");
    let av = verdicts(&a, VerdictKind::Accept);
    let bv = verdicts(&b, VerdictKind::Accept);

    let first = forward
        .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            forward.head().id(),
            vec![a.clone(), b.clone()],
            [av.clone(), bv.clone()].concat(),
        )))
        .unwrap();
    let second = reverse
        .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            reverse.head().id(),
            vec![b, a],
            [bv, av].concat(),
        )))
        .unwrap();

    assert_eq!(first.head().text(), second.head().text());
    assert_eq!(first.head().text(), "ONE.\n\ntwo.\n\nTHREE.");
}

#[test]
fn competing_proposals_refuse_without_picking_an_ordered_winner() {
    let mut manuscript = open("before");
    let block = manuscript.head().block_ids()[0];
    let a = proposal(&manuscript, refrain_core::Id::new(), vec![block], "first");
    let b = proposal(&manuscript, refrain_core::Id::new(), vec![block], "second");
    let unchanged = manuscript.head().clone();

    assert!(matches!(
        manuscript.execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            manuscript.head().id(),
            vec![a.clone(), b.clone()],
            [verdicts(&a, VerdictKind::Accept), verdicts(&b, VerdictKind::Accept)].concat(),
        ))),
        Err(TextRefusal::OverlappingScopes { block: shared }) if shared == block
    ));
    assert_eq!(manuscript.head(), &unchanged);
}

#[test]
fn rejected_competitors_do_not_create_text_change_conflicts() {
    let mut manuscript = open("before");
    let block = manuscript.head().block_ids()[0];
    let a = proposal(&manuscript, refrain_core::Id::new(), vec![block], "first");
    let b = proposal(&manuscript, refrain_core::Id::new(), vec![block], "second");
    let verdicts = [
        verdicts(&a, VerdictKind::Reject),
        verdicts(&b, VerdictKind::Reject),
    ]
    .concat();
    let original = manuscript.head().id();

    let transition = manuscript
        .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            original,
            vec![a, b],
            verdicts.clone(),
        )))
        .unwrap();

    assert_eq!(transition.head().id(), original);
    assert_eq!(transition.action().verdicts(), verdicts);
}

#[test]
fn one_accepted_competitor_can_commit_while_the_other_is_rejected() {
    let mut manuscript = open("before");
    let block = manuscript.head().block_ids()[0];
    let accepted = proposal(&manuscript, refrain_core::Id::new(), vec![block], "first");
    let rejected = proposal(&manuscript, refrain_core::Id::new(), vec![block], "second");

    manuscript
        .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            manuscript.head().id(),
            vec![accepted.clone(), rejected.clone()],
            [
                verdicts(&accepted, VerdictKind::Accept),
                verdicts(&rejected, VerdictKind::Reject),
            ]
            .concat(),
        )))
        .unwrap();

    assert_eq!(manuscript.head().text(), "first");
}

#[test]
fn a_stale_proposal_can_still_be_rejected_without_touching_current_text() {
    let mut manuscript = open("before\n\nother");
    let block = manuscript.head().block_ids()[0];
    let proposal = proposal(&manuscript, refrain_core::Id::new(), vec![block], "agent");
    let rejected = verdicts(&proposal, VerdictKind::Reject);
    manuscript
        .execute(TextCommand::Editor(refrain_core::EditorAction::new(
            manuscript.head().id(),
            vec![refrain_core::EditorChange::Replace(
                refrain_core::Replacement::new(vec![block], Some("author".to_owned())).unwrap(),
            )],
            "author changed underneath",
        )))
        .unwrap();
    let current = manuscript.head().clone();

    let transition = manuscript
        .execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            current.id(),
            vec![proposal],
            rejected.clone(),
        )))
        .unwrap();

    assert_eq!(transition.head(), &current);
    assert_eq!(transition.action().verdicts(), rejected);
}

#[test]
fn a_proposal_whose_scope_drifted_is_refused() {
    let mut manuscript = open("before\n\nother");
    let block = manuscript.head().block_ids()[0];
    let proposal = proposal(&manuscript, refrain_core::Id::new(), vec![block], "agent");
    let verdicts = verdicts(&proposal, VerdictKind::Accept);
    let changed = refrain_core::Replacement::new(vec![block], Some("author".to_owned())).unwrap();
    manuscript
        .execute(TextCommand::Editor(refrain_core::EditorAction::new(
            manuscript.head().id(),
            vec![refrain_core::EditorChange::Replace(changed)],
            "author changed underneath",
        )))
        .unwrap();

    assert!(matches!(
        manuscript.execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            manuscript.head().id(),
            vec![proposal.clone()],
            verdicts,
        ))),
        Err(TextRefusal::StaleProposal { proposal: stale }) if stale == proposal.id()
    ));
}

#[test]
fn one_proposal_cannot_appear_twice_in_a_batch() {
    let mut manuscript = open("before");
    let block = manuscript.head().block_ids()[0];
    let proposal = proposal(&manuscript, refrain_core::Id::new(), vec![block], "after");
    let accepted = verdicts(&proposal, VerdictKind::Accept);

    assert!(matches!(
        manuscript.execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            manuscript.head().id(),
            vec![proposal.clone(), proposal.clone()],
            accepted,
        ))),
        Err(TextRefusal::DuplicateProposal { proposal: duplicate })
            if duplicate == proposal.id()
    ));
}

#[test]
fn a_verdict_from_a_proposal_omitted_from_the_batch_is_invalid() {
    let mut manuscript = open("before");
    let block = manuscript.head().block_ids()[0];
    let included = proposal(&manuscript, refrain_core::Id::new(), vec![block], "one");
    let omitted = proposal(&manuscript, refrain_core::Id::new(), vec![block], "two");
    let verdict = verdicts(&omitted, VerdictKind::Reject).remove(0);

    assert!(matches!(
        manuscript.execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            manuscript.head().id(),
            vec![included],
            vec![verdict],
        ))),
        Err(TextRefusal::UnknownProposal { proposal: missing }) if missing == omitted.id()
    ));
}

#[test]
fn judging_one_slice_twice_refuses_hidden_last_write_wins() {
    let mut manuscript = open("before");
    let block = manuscript.head().block_ids()[0];
    let proposal = proposal(&manuscript, refrain_core::Id::new(), vec![block], "after");
    let slice = proposal
        .slices()
        .iter()
        .find(|slice| slice.kind().is_changed())
        .unwrap();
    let accept = Verdict::new(&proposal, slice.id(), VerdictKind::Accept, None).unwrap();
    let reject = Verdict::new(&proposal, slice.id(), VerdictKind::Reject, None).unwrap();

    assert!(matches!(
        manuscript.execute(TextCommand::CommitDecisionBatch(DecisionBatch::new(
            manuscript.head().id(),
            vec![proposal],
            vec![accept, reject],
        ))),
        Err(TextRefusal::DuplicateVerdict { .. })
    ));
}
