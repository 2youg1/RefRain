use refrain_core::SourceLayout;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Layouts {
    schema_version: u8,
    corpora: Vec<CorpusLayout>,
}

#[derive(Deserialize)]
struct CorpusLayout {
    file: String,
    spans: Vec<Span>,
}

#[derive(Deserialize)]
struct Span {
    start: usize,
    end: usize,
}

const CORPORA: &[(&str, &[u8])] = &[
    (
        "ideographic-indent.md",
        include_bytes!("../../../tests/corpora/ideographic-indent.md"),
    ),
    (
        "half-width-indent.md",
        include_bytes!("../../../tests/corpora/half-width-indent.md"),
    ),
    (
        "consecutive-blank-lines.md",
        include_bytes!("../../../tests/corpora/consecutive-blank-lines.md"),
    ),
    (
        "fence-holding-a-blank-line.md",
        include_bytes!("../../../tests/corpora/fence-holding-a-blank-line.md"),
    ),
    (
        "tilde-fence.md",
        include_bytes!("../../../tests/corpora/tilde-fence.md"),
    ),
    (
        "nested-fence-markers.md",
        include_bytes!("../../../tests/corpora/nested-fence-markers.md"),
    ),
    (
        "hard-line-break.md",
        include_bytes!("../../../tests/corpora/hard-line-break.md"),
    ),
    ("crlf.md", include_bytes!("../../../tests/corpora/crlf.md")),
    (
        "no-trailing-newline.md",
        include_bytes!("../../../tests/corpora/no-trailing-newline.md"),
    ),
    (
        "byte-order-mark.md",
        include_bytes!("../../../tests/corpora/byte-order-mark.md"),
    ),
    (
        "leading-blank-lines.md",
        include_bytes!("../../../tests/corpora/leading-blank-lines.md"),
    ),
    (
        "trailing-blank-lines.md",
        include_bytes!("../../../tests/corpora/trailing-blank-lines.md"),
    ),
    (
        "astral-characters.md",
        include_bytes!("../../../tests/corpora/astral-characters.md"),
    ),
    (
        "mixed-scripts.md",
        include_bytes!("../../../tests/corpora/mixed-scripts.md"),
    ),
    (
        "blockquote-and-list.md",
        include_bytes!("../../../tests/corpora/blockquote-and-list.md"),
    ),
    (
        "table.md",
        include_bytes!("../../../tests/corpora/table.md"),
    ),
    ("tabs.md", include_bytes!("../../../tests/corpora/tabs.md")),
    (
        "empty-file.md",
        include_bytes!("../../../tests/corpora/empty-file.md"),
    ),
    (
        "only-whitespace.md",
        include_bytes!("../../../tests/corpora/only-whitespace.md"),
    ),
    (
        "everything-at-once.md",
        include_bytes!("../../../tests/corpora/everything-at-once.md"),
    ),
];

fn layouts() -> Layouts {
    serde_json::from_str(include_str!("../../../tests/corpora/layouts.json")).unwrap()
}

#[test]
fn every_frozen_corpus_matches_the_legacy_byte_spans() {
    let fixtures = layouts();
    assert_eq!(fixtures.schema_version, 1);
    assert_eq!(fixtures.corpora.len(), CORPORA.len());

    for fixture in fixtures.corpora {
        let (_, source) = CORPORA
            .iter()
            .find(|(file, _)| *file == fixture.file)
            .unwrap_or_else(|| panic!("fixture names unknown corpus {}", fixture.file));
        let layout = SourceLayout::read(source);
        let actual: Vec<(usize, usize)> = layout
            .blocks()
            .iter()
            .map(|span| (span.start, span.end))
            .collect();
        let expected: Vec<(usize, usize)> = fixture
            .spans
            .iter()
            .map(|span| (span.start, span.end))
            .collect();
        assert_eq!(actual, expected, "{}", fixture.file);
        assert_eq!(
            layout.reproduce(source).unwrap(),
            *source,
            "{}",
            fixture.file
        );
    }
}

#[test]
fn a_layout_refuses_to_slice_changed_source_bytes() {
    let source = b"first\n\nsecond\n";
    let layout = SourceLayout::read(source);
    let mut changed = source.to_vec();
    changed[0] = b'F';
    assert!(layout.reproduce(&changed).is_err());
}
