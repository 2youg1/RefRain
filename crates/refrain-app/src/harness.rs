//! 本机装了哪些 Harness：探测、报告、说清为什么用不了。
//!
//! # 为什么要一个用例
//!
//! 两个适配器各有 `detect()`，但**此前零调用者**——「连接」那个去处画不出
//! 任何东西，因为没有人问过「这台机器上有什么」。探测本身不难，难的是
//! 把「没找到」讲成一件作者能处理的事：
//!
//! - **没装**与**装了但版本读不出来**是两件事。前者去装，后者多半是
//!   PATH 上有个同名的东西，或者那个可执行文件坏了。压成一个「不可用」
//!   会让作者去装一个他已经装了的程序。
//! - 等级（L0/L1/L2）决定这个 Harness 能做什么：L1 才有取消，L2 才有
//!   诚实的用量。作者在派发之前就该看见它，而不是取消按钮按下去没反应。
//!
//! # 这里不做的事
//!
//! 不写配置。作者在 Config 里声明的连接指向一个确切的可执行文件
//! （`KimiPrint::at`），那条路径优先于 PATH 查找——这里只报告 PATH 上
//! 找得到什么，是「你还可以连这些」而不是「你连的是这些」。

use refrain_host::Tier;
use refrain_host::adapters::{ClaudePrint, HarnessAdapter, KimiPrint, find_on_path};

/// 一个 Harness 在这台机器上的状况。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    /// 适配器的稳定 id，与 Config 里写的那个是同一个词。
    pub id: String,
    /// 作者在 PATH 上要找的那个程序名。
    pub program: String,
    /// 这台机器上的状况。
    pub state: HarnessState,
    /// 探到的版本，没探到就是空。
    pub version: String,
    /// 这个 Harness 能做到哪一层，探不到时按最低算。
    pub tier: HarnessTier,
}

/// 探测的三种结果。
///
/// 用枚举而不是 `Option`，因为「没装」与「装了但答不出版本」要作者做的事
/// 完全不同，而压成一个空值就只能报一种原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessState {
    /// 探到了，可以连。
    Ready,
    /// PATH 上没有这个程序。
    NotInstalled,
    /// PATH 上有，但版本读不出来——多半是同名的别的东西，或者它坏了。
    Unreadable,
}

/// 等级的跨界形态。
///
/// 与 `Tier` 分开是因为跨界要一个稳定的词：`Tier` 是领域枚举，改名不该
/// 让界面上的标签跟着变。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessTier {
    /// 写请求、等结果。没有启动，也没有取消。
    File,
    /// 能启动、能完成、能取消。
    Launch,
    /// 还能报诚实的用量与压缩事件。
    Usage,
}

impl From<Tier> for HarnessTier {
    fn from(tier: Tier) -> Self {
        match tier {
            Tier::L0 => Self::File,
            Tier::L1 => Self::Launch,
            Tier::L2 => Self::Usage,
        }
    }
}

/// 探测本机装了哪些 Harness。
///
/// 顺序固定，不按探测结果排序：作者记住的是「第二行是 Claude」，而按
/// 「装了的排前面」会让这一行在装上另一个之后跳到别处。
#[must_use]
pub fn probe_harnesses() -> Vec<HarnessStatus> {
    vec![
        status_of("kimi-print", "kimi", KimiPrint::detect().map(probe_of)),
        status_of(
            "claude-print",
            "claude",
            ClaudePrint::detect().map(probe_of),
        ),
    ]
}

fn probe_of<A: HarnessAdapter>(adapter: A) -> (String, Tier) {
    adapter
        .probe()
        .map(|probe| (probe.version, probe.tier))
        .unwrap_or_else(|| (String::new(), adapter.tier()))
}

fn status_of(id: &str, program: &str, detected: Option<(String, Tier)>) -> HarnessStatus {
    match detected {
        Some((version, tier)) => HarnessStatus {
            id: id.to_string(),
            program: program.to_string(),
            state: HarnessState::Ready,
            version,
            tier: tier.into(),
        },
        // 探测失败分两种：PATH 上根本没有，与 PATH 上有但版本读不出来。
        // 后者是作者最需要知道的那一种——他装过了，坏的是别的东西。
        None => HarnessStatus {
            id: id.to_string(),
            program: program.to_string(),
            state: if find_on_path(program).is_some() {
                HarnessState::Unreadable
            } else {
                HarnessState::NotInstalled
            },
            version: String::new(),
            tier: HarnessTier::File,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_known_harness_is_reported_whether_or_not_it_is_installed() {
        // 名单固定：一台没装任何 Harness 的机器上，作者仍要看见「可以连
        // 这两个」。只报装了的，那个界面在全新机器上是空的，而空界面
        // 读起来与「这个功能坏了」一样。
        let statuses = probe_harnesses();
        assert_eq!(statuses.len(), 2);
        assert_eq!(statuses[0].id, "kimi-print");
        assert_eq!(statuses[1].id, "claude-print");
    }

    #[test]
    fn a_harness_that_is_not_on_path_says_so_rather_than_reading_as_broken() {
        // 近失手：把「没装」与「装了但答不出版本」压成一个「不可用」，
        // 作者会去装一个他已经装了的程序。这台机器上多半两个都没装，
        // 所以这条断言的是那个具体的状态词，不是「不是 Ready」。
        for status in probe_harnesses() {
            if status.state != HarnessState::Ready {
                assert!(
                    matches!(
                        status.state,
                        HarnessState::NotInstalled | HarnessState::Unreadable
                    ),
                    "{status:?}"
                );
                // 探不到就没有版本可报。报一个空串以外的东西等于编造。
                assert!(status.version.is_empty(), "{status:?}");
            }
        }
    }

    #[test]
    fn an_undetected_harness_claims_the_lowest_tier() {
        // 探不到却报 L1，界面就会画出一个取消按钮——按下去什么也不会
        // 发生，因为那条通道根本没建立。
        for status in probe_harnesses() {
            if status.state != HarnessState::Ready {
                assert_eq!(status.tier, HarnessTier::File, "{status:?}");
            }
        }
    }

    #[test]
    fn the_tier_words_do_not_collapse_into_one() {
        // 三个等级要各自不同：合并任意两个，界面就无法区分「能取消」与
        // 「能报用量」，而作者是按这个决定派发给谁的。
        let words = [
            HarnessTier::from(Tier::L0),
            HarnessTier::from(Tier::L1),
            HarnessTier::from(Tier::L2),
        ];
        assert_eq!(words[0], HarnessTier::File);
        assert_eq!(words[1], HarnessTier::Launch);
        assert_eq!(words[2], HarnessTier::Usage);
        assert_ne!(words[0], words[1]);
        assert_ne!(words[1], words[2]);
    }
}
