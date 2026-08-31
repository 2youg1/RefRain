// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Copyright (c) 2026 2youg1 and the RefRain contributors

//! 作者给 Agent 的身份，以及它进入 `AGENTS.md` 的两种方式。
//!
//! # 为什么是二态而不是一段文字
//!
//! 作者用 Agent 做两件不同的事：让它**干活**（改稿、检查、整理），
//! 和让它**扮演**（一个角色、一种声音）。两者要的身份文件不同：
//!
//! - **干活**时，作者写下的就是他要的全部。多一个字都是干扰——一句
//!   「你是一位资深编辑」后面被应用补上「请以第一人称输出文学化文本」，
//!   那个 Agent 就开始写小说。
//! - **扮演**时，作者写的是这个角色是谁，而**怎么演**是一套可复用的
//!   方法（欲望推动、克制自我阐释、让对白承担职能）。每个角色重抄一遍
//!   那套方法，改进它就要改 N 处。
//!
//! # 唯一的硬规则：用户原文不改字节
//!
//! 两态都逐字节保留作者写的东西。**不 `trim()`**——首尾空白可能是他有意
//! 排的版；不加标题；不插解释。Cosplay 只在原文**之后**追加，所以
//! 「文件的前 body.len() 字节与作者写的完全相同」在两态下都成立，
//! 是一条能被逐字节检查的不变量。
//!
//! 协议不进这个文件：它每轮随 `request.md` 走。把协议写进身份文件，
//! 协议改一次就要重写每个 Agent 的身份。

/// 作者给 Agent 的身份。
///
/// 判别联合而不是「一段文字 + 一个布尔」：布尔会让「空身份但选了扮演」
/// 这种状态可表示，而它没有意义——没有身份就没有可扮演的角色。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Persona {
    /// 让它干活：作者写下的就是全部，一个字也不加。
    Work { body: String },
    /// 让它扮演：作者写角色，应用补一套演法。
    ///
    /// 演法是**全局一份**的预设，不做每 Agent 的第二份覆盖——两份配置
    /// 会让「现在到底发了哪段」重新分裂，而那正是这个类型要消除的。
    Cosplay { body: String },
}

impl Persona {
    /// 作者写下的那段字，逐字节。
    #[must_use]
    pub fn body(&self) -> &str {
        match self {
            Self::Work { body } | Self::Cosplay { body } => body,
        }
    }

    /// 这个身份进入 `AGENTS.md` 的样子。
    ///
    /// `preset` 只在 Cosplay 下使用。Work 下即使传了也不追加——两态的
    /// 差别就在这里，而把判断交给调用方会让它在某个调用点被写反。
    #[must_use]
    pub fn agent_file(&self, preset: &str) -> String {
        match self {
            // 逐字节。作者写什么就是什么，包括首尾空白与换行风格。
            Self::Work { body } => body.clone(),
            Self::Cosplay { body } => {
                if preset.trim().is_empty() {
                    // 没有预设就退成 Work 的形状，而不是留下两个空行。
                    // 空预设是设置里的一个状态，不是一次失败。
                    return body.clone();
                }
                // 原文、两个换行、预设。顺序固定：作者的字在前，应用的
                // 后缀在后——这样「前 body.len() 字节相同」逐字节可查。
                format!("{body}\n\n{preset}")
            }
        }
    }

    /// 这一轮是扮演吗。界面据此显示当前模式。
    #[must_use]
    pub const fn is_cosplay(&self) -> bool {
        matches!(self, Self::Cosplay { .. })
    }

    /// 换一个模式，原文原样带过去。
    ///
    /// 切换不该丢掉作者写的字：他试完扮演想切回干活，那段角色描述还在。
    #[must_use]
    pub fn toggled(&self) -> Self {
        match self {
            Self::Work { body } => Self::Cosplay { body: body.clone() },
            Self::Cosplay { body } => Self::Work { body: body.clone() },
        }
    }
}

/// 默认的 Cosplay 预设。
///
/// 依 McKee 公开课程页所列的 desire／intent／action／verbal tactic／
/// text-subtext 与 cueing 原则写成的**原创归纳**，不是《对白》的引文。
/// 官方依据：<https://mckeestory.com/webinars/dialogue/>
pub const DEFAULT_COSPLAY_PRESET: &str = "让你此刻的欲望、目标推动场景剧情，但你不应该将它们「写在脸上」，而是设身处地地思考后写成具体的对白或行动：你应同其他角色有不完全一致的诉求、有限的信息与可用手段，并基于它们用对白承担试探、隐瞒、施压、安抚、自我暴露或交换等职能；用选择、动作、停顿和误解呈现心理、设定和变化，让台词携带未明说或无法明说的当下意图，克制不做自我阐释。阻力迫使你改变策略；压力迫使你在解决眼前问题时在剧情中留下代价、暴露或新难题。创作的结尾使权力、关系、信息或处境等在下一段不可避免地至少改变一项；变化不仅来自有意识的行动，还来自局限性与不可预见的效应。保持你的角色声音、特征、知识边界、叙事视角与既有事实等局限性，让它们塑造你不完美的人设，在一个具体的世界设定中行动和变化，不替他人决定心理或选择以控制故事。你正在一个互动故事创作项目中承担上述角色，遵守其规则，只以第一人称输出文学化的具体文本，不添加任何格式标记、不用全知旁白或创作解读，以用户的语言输出。";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn work_writes_the_author_s_bytes_and_nothing_else() {
        // 逐字节，含首尾空白与混合换行。多一个字都是干扰：一句「你是一位
        // 资深编辑」后面被补上「以第一人称输出文学化文本」，那个 Agent
        // 就开始写小说。
        let body = "  你是一位资深编辑。\r\n\n注意：不要改我的标点。  ";
        let persona = Persona::Work {
            body: body.to_string(),
        };
        assert_eq!(persona.agent_file(DEFAULT_COSPLAY_PRESET), body);
    }

    #[test]
    fn cosplay_appends_after_the_author_s_bytes_without_touching_them() {
        // 「前 body.len() 字节与原文相同」是这条设计的可检查形态。
        let body = " 我是沈青，二十七岁，话很少。 ";
        let persona = Persona::Cosplay {
            body: body.to_string(),
        };
        let file = persona.agent_file("演法预设");
        assert_eq!(&file[..body.len()], body, "the author's bytes changed");
        assert_eq!(&file[body.len()..], "\n\n演法预设");
    }

    #[test]
    fn an_empty_preset_falls_back_to_the_work_shape() {
        // 近失手：空预设仍然追加两个换行，文件末尾多出两个空行——它进了
        // digest，于是清空预设会让每个 Cosplay Agent 的身份文件重写一次。
        let body = "我是沈青。".to_string();
        let persona = Persona::Cosplay { body: body.clone() };
        assert_eq!(persona.agent_file(""), body);
        assert_eq!(persona.agent_file("   \n  "), body);
    }

    #[test]
    fn switching_modes_keeps_the_author_s_text() {
        // 作者试完扮演想切回干活，那段角色描述还在。丢掉它，他得重写。
        let persona = Persona::Work {
            body: "我是沈青。".to_string(),
        };
        let cosplay = persona.toggled();
        assert!(cosplay.is_cosplay());
        assert_eq!(cosplay.body(), persona.body());
        assert_eq!(cosplay.toggled(), persona, "toggling twice is identity");
    }

    #[test]
    fn the_two_modes_produce_different_files_from_the_same_body() {
        // 两态必须真的不同，否则「切换模式」是一个什么也不做的按钮，
        // 而作者会以为自己已经切过去了。
        let body = "我是沈青。".to_string();
        let work = Persona::Work { body: body.clone() };
        let cosplay = Persona::Cosplay { body };
        assert_ne!(
            work.agent_file(DEFAULT_COSPLAY_PRESET),
            cosplay.agent_file(DEFAULT_COSPLAY_PRESET),
        );
    }
}
