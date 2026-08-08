//! 全半角互转：ASCII 集合与全角对映之间的一次性映射。
//!
//! **接上哪个功能**：正文选区的「转全角／转半角」菜单与命令面板的全文级
//! 转换。正文编辑在 Rust（INV-4、块身份、journal），所以转换也在 Rust：
//! 界面不持有正文字节，把转换放界面等于把一条字符规则复制两份。
//!
//! **拥有什么全局不变量**：全角对映表只有这一份。JIS X 0208 的惯例是全角
//! `U+FF01..U+FF5E` 与 ASCII `U+0021..U+007E` 逐位对映、全角空格 `U+3000`
//! 对半角空格 `U+0020`；这个范围之外一律不动——片假名、变体假名、其他
//! 全角符号各有自己的对映规则，把「全半角」做宽会把别人的规则错认成
//! 自己的（例如把 `ｶﾞ` 拆成两个字符）。不做正是这条映射的定义域。
//!
//! 两个方向互为逆：`to_half_width(to_full_width(s)) == s` 对**定义域内**
//! 的字符逐字节成立，对定义域外的字符两个方向都原样放行。

/// ASCII 空格在源码里是 `0x20`；全角空格 `U+3000` 不在对映区间里，单独成对。
const SPACE: char = ' ';
const FULL_SPACE: char = '\u{3000}';
/// `U+FF01` 是 `U+0021` 的镜像，区间长度一致，逐位相加即得。
const FULL_OFFSET: u32 = 0xff01 - 0x21;

/// 把一串文字里的 ASCII 标点、字母与数字换成全角对映，其余字符原样放行。
#[must_use]
pub fn to_full_width(text: &str) -> String {
    text.chars()
        .map(|character| match character {
            SPACE => FULL_SPACE,
            '!'..='~' => char::from_u32(character as u32 + FULL_OFFSET).expect("in range"),
            _ => character,
        })
        .collect()
}

/// 把一串文字里的全角标点、字母与数字换回 ASCII，其余字符原样放行。
#[must_use]
pub fn to_half_width(text: &str) -> String {
    text.chars()
        .map(|character| match character {
            FULL_SPACE => SPACE,
            '\u{ff01}'..='\u{ff5e}' => {
                char::from_u32(character as u32 - FULL_OFFSET).expect("in range")
            }
            _ => character,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_full_width_round_trip_is_identity_on_ascii() {
        let ascii = "Hello, 世界! (v0.3.0) \"引号\" 50%";
        assert_eq!(to_half_width(to_full_width(ascii).as_str()), ascii);
    }

    #[test]
    fn the_half_width_round_trip_is_identity_on_full_width() {
        let full = "Ｈｅｌｌｏ，世界！（ｖ０．３．０）";
        assert_eq!(to_full_width(to_half_width(full).as_str()), full);
    }

    /// 近失手：把对映做宽（例如顺手映射片假名或 `￥`）会让「不做」承诺
    /// 失效——转换一次之后，再转一次不该变成别的字。这条断言钉住
    /// 定义域边界：`U+FF61..U+FF9F`（半角片假名）与 `U+00A5`（日元符号）
    /// 不在 ASCII 对映区间内，两个方向都必须原样放行。
    #[test]
    fn the_definition_domain_stops_before_kana_and_non_ascii_symbols() {
        assert_eq!(to_half_width("ｶﾞ"), "ｶﾞ");
        assert_eq!(to_half_width("￥"), "￥");
        assert_eq!(to_full_width("ｶﾞ"), "ｶﾞ");
        assert_eq!(to_half_width("…"), "…");
    }

    /// 极端：空串与只含中文的串是合法的输入，映射后必须逐字节相同。
    #[test]
    fn empty_and_cjk_only_texts_pass_through() {
        assert_eq!(to_full_width(""), "");
        assert_eq!(to_half_width(""), "");
        assert_eq!(
            to_full_width("中文正文，带全角标点。"),
            "中文正文，带全角标点。"
        );
    }

    #[test]
    fn the_space_pair_maps_both_ways() {
        assert_eq!(to_full_width("a b"), "ａ\u{3000}ｂ");
        assert_eq!(to_half_width("ａ\u{3000}ｂ"), "a b");
    }
}
