//! Making Chinese searchable.
//!
//! # The problem, measured
//!
//! SQLite's FTS5 offers two tokenizers that might handle Chinese, and both
//! fail. `unicode61` splits on whitespace, so a run of Chinese becomes one
//! enormous token and searching 「营销」 inside it matches nothing. `trigram`
//! is the usual recommendation and fails twice over: it indexes nothing
//! shorter than three characters, so the two-character words that make up most
//! Chinese queries return zero rows, and it keeps no column-size statistics,
//! so `bm25()` returns -0.0000 for every match. A ranking that cannot tell two
//! documents apart is not a ranking.
//!
//! Both failures are measured, not assumed: `review/search-probe-results.md`.
//!
//! # The fix
//!
//! Split each run of Chinese into overlapping two-character pieces and let
//! `unicode61` index those. 「陆沉舟」 becomes 「陆沉 沉舟」, and a query for
//! 「沉舟」 finds it. Latin text, digits, and punctuation pass through
//! untouched, so an author searching for an English term or a chapter number
//! gets ordinary word matching.
//!
//! Two-character pieces rather than three because Chinese words are
//! overwhelmingly one or two characters. Three-character pieces are exactly
//! what `trigram` does, and its inability to match 「营销」 is the reason this
//! module exists.
//!
//! # The one rule
//!
//! **The same transformation must run on both sides.** Text is bigrammed when
//! it enters the index and a query is bigrammed before it is matched. Applying
//! it to one side only produces a table that silently matches nothing, which
//! is why the transformation lives in one function that both callers use.

/// Whether a character belongs to a script written without spaces between
/// words, and therefore needs splitting.
///
/// Covers CJK Unified Ideographs and Extension A (rare characters that do
/// appear in names), plus kana: a Chinese manuscript quoting Japanese should
/// stay searchable.
fn needs_splitting(character: char) -> bool {
    matches!(character,
        '\u{4E00}'..='\u{9FFF}'   // CJK Unified Ideographs
        | '\u{3400}'..='\u{4DBF}' // Extension A
        | '\u{F900}'..='\u{FAFF}' // Compatibility Ideographs
        | '\u{3040}'..='\u{309F}' // Hiragana
        | '\u{30A0}'..='\u{30FF}' // Katakana
    )
}

/// Rewrite text so that FTS5's `unicode61` tokenizer can index Chinese.
///
/// A single character surrounded by non-Chinese stays as itself rather than
/// disappearing: 「我」 is a word, and an author who searches for one character
/// should find it.
pub fn bigram(text: &str) -> String {
    // Chinese text roughly doubles; Latin text does not grow at all.
    let mut out = String::with_capacity(text.len() * 2);
    let mut run: Vec<char> = Vec::new();

    for character in text.chars() {
        if needs_splitting(character) {
            run.push(character);
            continue;
        }
        flush(&mut run, &mut out);
        out.push(character);
    }
    flush(&mut run, &mut out);
    out
}

/// Emit one run of unspaced script as overlapping pairs.
fn flush(run: &mut Vec<char>, out: &mut String) {
    match run.len() {
        0 => {}
        // A lone character is its own token — 「我」 must stay findable.
        1 => {
            out.push(' ');
            out.push(run[0]);
            out.push(' ');
        }
        _ => {
            for pair in run.windows(2) {
                out.push(' ');
                out.push(pair[0]);
                out.push(pair[1]);
            }
            out.push(' ');
        }
    }
    run.clear();
}

/// Turn an author's query into an FTS5 MATCH expression.
///
/// Pieces are joined with AND, which was chosen by measurement over a real
/// 252MB corpus of 22,410 documents:
///
/// | query | OR | AND | NEAR |
/// |---|---|---|---|
/// | 不存在的词 | 500 hits | 21 | 0 |
/// | 渐进式披露 | 185 | 7 | **0** |
///
/// OR treats a document holding any one pair as a candidate, and pairs like
/// 「存在」 occur everywhere, so a query for a phrase nobody wrote still
/// returned five hundred documents. AND cuts that to twenty-one without losing
/// a single real answer, and runs faster for it — 278µs against 1859µs.
///
/// NEAR looks stricter still and is a trap: requiring the pairs to be adjacent
/// returned nothing at all for 「渐进式披露」, a phrase that genuinely appears
/// in the corpus and that OR and AND both scored at 49.8. Adjacency is too
/// tight a constraint on overlapping bigrams.
///
/// Every piece is quoted, because a bigram may contain characters FTS5 reads
/// as syntax.
///
/// Returns `None` for a query with nothing to match, so callers distinguish
/// "no results" from "no query" instead of running an empty MATCH that errors.
pub fn match_expression(query: &str) -> Option<String> {
    let pieces: Vec<String> = bigram(query)
        .split_whitespace()
        // A piece made only of punctuation carries no search intent. An
        // author who types 「说"是"」 means the two words, not the quotation
        // marks, and indexing them would match every document that contains a
        // quotation mark — which, in a manuscript, is all of them.
        .filter(|piece| piece.chars().any(char::is_alphanumeric))
        .map(|piece| format!("\"{}\"", piece.replace('"', "\"\"")))
        .collect();
    if pieces.is_empty() {
        return None;
    }
    Some(pieces.join(" AND "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_splits_into_overlapping_pairs() {
        assert_eq!(bigram("陆沉舟").trim(), "陆沉 沉舟");
    }

    #[test]
    fn a_two_character_word_survives() {
        // trigram indexes nothing shorter than three characters, so 「营销」
        // was unfindable. That failure is why this module exists.
        assert_eq!(bigram("营销").trim(), "营销");
    }

    #[test]
    fn a_lone_character_is_its_own_token() {
        // 「我」 is a word. Dropping it would make single-character searches
        // silently return nothing.
        assert_eq!(bigram("我").trim(), "我");
    }

    #[test]
    fn latin_passes_through_untouched() {
        assert_eq!(bigram("hello world"), "hello world");
    }

    #[test]
    fn mixed_text_splits_only_the_chinese() {
        assert_eq!(
            bigram("BDV 变压器 test")
                .split_whitespace()
                .collect::<Vec<_>>(),
            vec!["BDV", "变压", "压器", "test"]
        );
    }

    #[test]
    fn punctuation_breaks_a_run() {
        // 「一，二」 is two runs, not one: the comma is a boundary the author
        // wrote, and pairing across it would invent a word.
        let split = bigram("一，二");
        let pieces: Vec<&str> = split.split_whitespace().collect();
        assert_eq!(pieces, vec!["一", "，", "二"]);
    }

    #[test]
    fn kana_is_split_too() {
        // A Chinese manuscript quoting Japanese stays searchable.
        assert_eq!(bigram("ひらがな").trim(), "ひら らが がな");
    }

    #[test]
    fn empty_text_stays_empty() {
        assert_eq!(bigram(""), "");
    }

    #[test]
    fn a_query_becomes_quoted_pieces_joined_by_and() {
        // AND, not OR: measured over 22,410 real documents, OR returned five
        // hundred hits for a phrase nobody had written, because pairs like
        // 「存在」 appear everywhere.
        assert_eq!(match_expression("陆沉舟").unwrap(), "\"陆沉\" AND \"沉舟\"");
    }

    #[test]
    fn a_query_with_no_content_is_none_not_an_empty_match() {
        // An empty MATCH expression is a SQL error, not an empty result.
        assert!(match_expression("").is_none());
        assert!(match_expression("   ").is_none());
    }

    #[test]
    fn punctuation_only_pieces_are_dropped() {
        // 「说"是"」 means the two words. Keeping the quotation marks as their
        // own token would match every document containing a quotation mark,
        // which in a manuscript is all of them.
        assert_eq!(match_expression("说\"是\"").unwrap(), "\"说\" AND \"是\"");
    }

    #[test]
    fn a_query_of_only_punctuation_matches_nothing_rather_than_erroring() {
        assert!(match_expression("\"\"\"").is_none());
        assert!(match_expression("，。！").is_none());
    }

    #[test]
    fn indexing_and_querying_use_the_same_split() {
        // The one rule. If these ever disagree the table matches nothing and
        // no error is raised anywhere.
        let indexed = bigram("陆沉舟站在窗前");
        for piece in bigram("沉舟").split_whitespace() {
            assert!(indexed.contains(piece), "索引里找不到 {piece}");
        }
    }
}
