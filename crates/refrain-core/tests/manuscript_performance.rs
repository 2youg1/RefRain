use refrain_core::{
    EditorAction, EditorChange, Lineage, Manuscript, Replacement, SourceSnapshot, TextCommand,
};
use std::time::{Duration, Instant};

fn percentile(samples: &mut [Duration], numerator: usize, denominator: usize) -> Duration {
    samples.sort_unstable();
    samples[(samples.len() * numerator)
        .div_ceil(denominator)
        .saturating_sub(1)]
}

#[test]
fn one_block_confirmation_is_not_linear_in_a_hundred_thousand_block_manuscript() {
    let source = (0..100_000)
        .map(|index| format!("block {index:06} carries enough text for a real editing projection"))
        .collect::<Vec<_>>()
        .join("\n\n")
        .into_bytes();
    let snapshot = SourceSnapshot::read(source);
    let lineage = Lineage::fresh(snapshot.block_count());
    let mut manuscript = Manuscript::open(snapshot, lineage).unwrap();
    let block = manuscript.head().block_ids()[50_000];
    let mut samples = Vec::with_capacity(20);

    for index in 0..20 {
        let command = TextCommand::Editor(EditorAction::new(
            manuscript.head().id(),
            vec![EditorChange::Replace(
                Replacement::new(vec![block], Some(format!("replacement {index}"))).unwrap(),
            )],
            "performance contract",
        ));
        let before = manuscript.materialize().unwrap();
        let started = Instant::now();
        let transition = manuscript.execute(command).unwrap();
        samples.push(started.elapsed());
        assert_eq!(
            transition.byte_patch().apply(&before).unwrap(),
            manuscript.materialize().unwrap()
        );
        if index == 0 {
            assert!(transition.byte_patch().apply(b"different source").is_err());
        }
    }

    let p95 = percentile(&mut samples, 95, 100);
    let budget = Duration::from_millis(10);
    eprintln!("one-block confirmation p95: {p95:?}");
    assert!(
        p95 < budget,
        "one-block confirmation p95 was {p95:?}, budget {budget:?}; samples: {samples:?}"
    );
}
