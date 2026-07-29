//! HTML projection on html5gum (KL9: borrow the ultralight agent-native
//! browser approach, in our language): a spec-shaped tokenizer, not regex.
//! Scripts and styles never become text; block-level tags become line
//! breaks; everything else streams through with entities decoded.

use html5gum::{EndTag, StartTag, Token, Tokenizer};

const BLOCK_TAGS: &[&[u8]] = &[
    b"p",
    b"div",
    b"br",
    b"li",
    b"ul",
    b"ol",
    b"section",
    b"article",
    b"blockquote",
    b"tr",
    b"td",
    b"th",
    b"table",
    b"header",
    b"footer",
    b"main",
    b"aside",
    b"figure",
    b"figcaption",
    b"hr",
    b"h1",
    b"h2",
    b"h3",
    b"h4",
    b"h5",
    b"h6",
];

const SKIP_TAGS: &[&[u8]] = &[
    b"script",
    b"style",
    b"noscript",
    b"template",
    b"svg",
    b"head",
];

fn is_tag(name: &[u8], list: &[&[u8]]) -> bool {
    list.iter().any(|tag| name.eq_ignore_ascii_case(tag))
}

/// Project the readable text out of an HTML document.
pub fn extract(source: &str) -> String {
    let mut out = String::with_capacity(source.len() / 2);
    let mut skipping: Option<Vec<u8>> = None;
    for token in Tokenizer::new(source).map_while(Result::ok) {
        match token {
            Token::StartTag(StartTag { name, .. }) => {
                if skipping.is_none() && is_tag(&name, SKIP_TAGS) {
                    skipping = Some(name.to_ascii_lowercase());
                } else if skipping.is_none() && is_tag(&name, BLOCK_TAGS) {
                    out.push('\n');
                }
            }
            Token::EndTag(EndTag { name, .. }) => {
                if skipping.as_deref() == Some(name.to_ascii_lowercase().as_slice()) {
                    skipping = None;
                } else if skipping.is_none() && is_tag(&name, BLOCK_TAGS) {
                    out.push('\n');
                }
            }
            Token::String(text) if skipping.is_none() => {
                out.push_str(&super::decode_entities(&String::from_utf8_lossy(&text)));
            }
            _ => {}
        }
    }
    super::normalize(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readable_text_survives_and_chrome_does_not() {
        let html = r#"<!doctype html><html><head><title>忽略我</title>
            <style>.a { color: red }</style></head>
            <body><h1>标题 &amp; 副题</h1>
            <p>第一段，有<a href='#local'>链接</a>。</p>
            <script>alert("不该出现")</script>
            <ul><li>甲</li><li>乙</li></ul></body></html>"#;
        let text = extract(html);
        assert!(text.contains("标题 & 副题"), "{text}");
        assert!(text.contains("第一段，有链接。"), "{text}");
        assert!(text.contains("甲"), "{text}");
        assert!(!text.contains("不该出现"), "{text}");
        assert!(!text.contains("color: red"), "{text}");
        assert!(!text.contains("忽略我"), "{text}");
    }
}
