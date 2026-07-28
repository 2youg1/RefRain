use refrain_core::{ChangeClass, EditScope, Proposal, SliceKind, classify_change};

fn proposal(before: String, after: String) -> Proposal {
    Proposal::new(
        refrain_core::Id::new(),
        refrain_core::Id::new(),
        EditScope::new(vec![refrain_core::Id::new()]).unwrap(),
        before,
        Some(after),
    )
}

#[test]
fn formatting_classification_never_waves_through_meaning_changes() {
    for (before, after) in [
        ("他说,好。", "他说，好。"),
        ("用 Bun 跑", "用Bun跑"),
        ("他说\"走\"", "他说「走」"),
        ("等等...", "等等……"),
    ] {
        assert_eq!(classify_change(before, after), ChangeClass::Formatting);
    }
    for (before, after) in [
        ("下雨天留客，天留我不留。", "下雨天，留客天，留我不？留。"),
        ("工程师 👩‍💻", "工程师 👩💻"),
        ("雾散了。", "雨散了。"),
        ("他慢慢地走了,很久。", "他走了。"),
        ("他停笔,雾散了。", "雾散了,他停笔。"),
        ("第三章", "第四章"),
        ("用 bun 跑", "用 Bun 跑"),
        ("他走了。", "他走了。天亮了。"),
    ] {
        assert_eq!(classify_change(before, after), ChangeClass::Semantic);
    }
}

#[test]
fn one_proposal_owns_one_stable_sliced_result() {
    let proposal = proposal("甲。乙。".to_owned(), "甲。丙。".to_owned());
    let first_ids = proposal
        .slices()
        .iter()
        .map(|slice| slice.id())
        .collect::<Vec<_>>();

    assert!(std::ptr::eq(proposal.slices(), proposal.slices()));
    assert_eq!(
        proposal
            .slices()
            .iter()
            .map(|slice| slice.id())
            .collect::<Vec<_>>(),
        first_ids
    );
}

#[test]
fn sentence_moves_are_semantic_but_a_punctuation_sweep_is_formatting() {
    let sweep = proposal(
        "他说,好.她说,行.".to_owned(),
        "他说，好。她说，行。".to_owned(),
    );
    assert_eq!(sweep.change_class(), ChangeClass::Formatting);

    let moved = proposal("他走了。天亮了。".to_owned(), "天亮了。他走了。".to_owned());
    assert_eq!(moved.change_class(), ChangeClass::Semantic);

    let across_context = proposal(
        "第一句。中间的一句。".to_owned(),
        "中间的一句。第一句。".to_owned(),
    );
    assert_eq!(across_context.change_class(), ChangeClass::Semantic);
}

fn sentence(index: usize) -> String {
    format!("第{index}句話在這裏，長度大致相當於一句普通的中文。")
}

#[test]
fn one_change_in_a_hundred_thousand_sentences_is_a_small_problem() {
    let before = (0..100_000).map(sentence).collect::<Vec<_>>();
    let mut after = before.clone();
    after[50_000] = "只有這一句被改了。".to_owned();

    let started = std::time::Instant::now();
    let proposal = proposal(before.concat(), after.concat());
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind().is_changed())
            .count(),
        2
    );
}

#[test]
fn scattered_edits_remain_small_at_ten_and_one_hundred_thousand_sentences() {
    for (count, changes, budget) in [
        (10_000, 10, std::time::Duration::from_secs(1)),
        (100_000, 1_000, std::time::Duration::from_secs(3)),
    ] {
        let before = (0..count).map(sentence).collect::<Vec<_>>();
        let mut after = before.clone();
        let stride = if count == 10_000 { 997 } else { 97 };
        for index in 0..changes {
            after[index * stride] = format!("第{index}處改動。");
        }

        let started = std::time::Instant::now();
        let proposal = proposal(before.concat(), after.concat());
        assert!(started.elapsed() < budget);
        assert_eq!(
            proposal
                .slices()
                .iter()
                .filter(|slice| slice.kind().is_changed())
                .count(),
            changes * 2
        );
    }
}

#[test]
fn segmentation_changes_cost_but_not_review_slice_meaning() {
    let before = [
        "第一句。",
        "第二句。",
        "共同的一句。",
        "共同的二句。",
        "共同的三句。",
        "共同的四句。",
        "共同的五句。",
        "共同的六句。",
        "共同的七句。",
        "共同的八句。",
        "共同的九句。",
        "最後一句。",
    ]
    .concat();
    let after = before
        .replace("第二句。", "改寫的第二句。")
        .replace("最後一句。", "改寫的末句。");
    let proposal = proposal(before, after);

    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Delete)
            .map(|slice| slice.text())
            .collect::<Vec<_>>(),
        ["第二句。", "最後一句。"]
    );
    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Insert)
            .map(|slice| slice.text())
            .collect::<Vec<_>>(),
        ["改寫的第二句。", "改寫的末句。"]
    );
    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Same)
            .count(),
        10
    );
}

#[test]
fn a_large_deleted_run_resynchronises_beyond_the_local_probe() {
    let kept = (0..20_000).map(sentence).collect::<Vec<_>>().concat();
    let removed = (0..100)
        .map(|index| format!("移除的第{index}句。"))
        .collect::<Vec<_>>()
        .concat();
    let proposal = proposal(format!("{removed}{kept}"), kept);

    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Delete)
            .count(),
        100
    );
    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Insert)
            .count(),
        0
    );
    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Same)
            .count(),
        20_000
    );
}

#[test]
fn a_large_inserted_run_resynchronises_beyond_the_local_probe() {
    let before = (0..20_000).map(sentence).collect::<Vec<_>>().concat();
    let inserted = (0..100)
        .map(|index| format!("插入的第{index}句。"))
        .collect::<Vec<_>>()
        .concat();
    let proposal = proposal(before.clone(), format!("{inserted}{before}"));

    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Insert)
            .count(),
        100
    );
    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Delete)
            .count(),
        0
    );
    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Same)
            .count(),
        20_000
    );
}

#[test]
fn one_sentence_inserted_at_the_head_does_not_defeat_segmentation() {
    let before = (0..20_000).map(sentence).collect::<Vec<_>>().concat();
    let started = std::time::Instant::now();
    let proposal = proposal(before.clone(), format!("插入的第一句。{before}"));

    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Insert)
            .map(|slice| slice.text())
            .collect::<Vec<_>>(),
        ["插入的第一句。"]
    );
    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Delete)
            .count(),
        0
    );
}

#[test]
fn fully_divergent_texts_fall_back_instead_of_allocating_a_quadratic_table() {
    let before = (0..5_000)
        .map(|index| format!("甲{index}這句完全不同。"))
        .collect::<Vec<_>>()
        .concat();
    let after = (0..5_000)
        .map(|index| format!("乙{index}那句毫不相干。"))
        .collect::<Vec<_>>()
        .concat();

    let started = std::time::Instant::now();
    let proposal = proposal(before, after);
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Delete)
            .count(),
        5_000
    );
    assert_eq!(
        proposal
            .slices()
            .iter()
            .filter(|slice| slice.kind() == SliceKind::Insert)
            .count(),
        5_000
    );
}
