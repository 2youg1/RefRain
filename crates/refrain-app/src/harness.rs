// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

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
//!
//! # 探测成本
//!
//! 探测是版本探针：`kimi --version` 每次要起一个 2 秒级的子进程
//! （Windows 实测 2.3-2.6 s），而版本在会话内几乎不变。结果按 TTL 缓存，
//! 「重新探测」按钮走 `probe_harnesses_forced` 绕过缓存。

use refrain_core::context_compiler::SkillStatus;
use refrain_host::Tier;
use refrain_host::adapters::{
    CHANNELS, HarnessAdapter, PrintAdapter, channel_skill_bytes, channel_skill_path, find_on_path,
};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 探测结果多久视为新鲜。版本变化（升级/卸载）在秒级内不会发生；
/// 手动刷新按钮会绕过它。
const PROBE_TTL: Duration = Duration::from_secs(15);

static PROBE_CACHE: Mutex<Option<(Instant, Vec<HarnessStatus>)>> = Mutex::new(None);

/// 探测本机 Harness，命中 15 秒内的缓存则直接用。
pub fn probe_harnesses() -> Vec<HarnessStatus> {
    probe_harnesses_impl(false)
}

/// 绕过缓存重新探测，供显式的「重新探测」按钮。
pub fn probe_harnesses_forced() -> Vec<HarnessStatus> {
    probe_harnesses_impl(true)
}

fn probe_harnesses_impl(force: bool) -> Vec<HarnessStatus> {
    if !force
        && let Ok(cache) = PROBE_CACHE.lock()
        && let Some((at, statuses)) = cache.as_ref()
        && at.elapsed() < PROBE_TTL
    {
        return statuses.clone();
    }
    // 名单来自注册表：新 harness = adapters 注册表加一行，这里自动跟随。
    let home = home_dir();
    let statuses: Vec<HarnessStatus> = CHANNELS
        .iter()
        .map(|channel| {
            let detected = PrintAdapter::detect(channel).map(probe_of);
            let skill = home.as_deref().map(|home| {
                refrain_host::adapters::skill_status_at(
                    &channel_skill_path(home, channel),
                    &channel_skill_bytes(channel),
                )
            });
            status_of(channel.id, channel.program, detected, skill)
        })
        .collect();
    if let Ok(mut cache) = PROBE_CACHE.lock() {
        *cache = Some((Instant::now(), statuses.clone()));
    }
    statuses
}

/// 作者的 home 目录：harness 的 skill 目录都挂在它下面
/// （`~/.kimi-code/skills/…`、`~/.claude/skills/…`）。Windows 上是
/// `USERPROFILE`，其余平台 `HOME`。探不到就是没有可读的协议状态——
/// 徽章画「未装」而不是失败。
fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
}

/// 把生成的协议装进一个 harness 的 skill 目录（作者显式点击；这是
/// Root 之外的唯一写路径，verify-write-path 注释已登记）。装完返回
/// 刷新后的整份名单——徽章不需要第二次探测。
pub fn install_skill(harness_id: &str) -> Result<Vec<HarnessStatus>, String> {
    let home = home_dir().ok_or_else(|| "no home directory to install into".to_string())?;
    let channel = refrain_host::adapters::channel(harness_id)
        .ok_or_else(|| format!("no adapter named {harness_id}"))?;
    refrain_host::adapters::install_skill_at(
        &channel_skill_path(&home, channel),
        &channel_skill_bytes(channel),
    )
    .map_err(|error| format!("install the protocol: {error}"))?;
    // 刚写下的那份必然与本次构建一致；刷新探测会读到 `Current`。
    Ok(probe_harnesses_forced())
}

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
    /// 协议装载状态：本机会话的 `skill_digest` 之外的第二个事实来源。
    /// 读文件本身——`Current` 是「装了且与本次构建逐字一致」，`Stale`
    /// 是「有一份但不是现在的协议」，`None` 是没装。徽章据此画。
    pub skill: SkillStatus,
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
///
/// 缓存与强制刷新在 `probe_harnesses_impl`：这里保留旧签名，供测试与
/// 无界面调用点直接拿现成实现。
fn probe_of<A: HarnessAdapter>(adapter: A) -> (String, Tier) {
    adapter
        .probe()
        .map(|probe| (probe.version, probe.tier))
        .unwrap_or_else(|| (String::new(), adapter.tier()))
}

fn status_of(
    id: &str,
    program: &str,
    detected: Option<(String, Tier)>,
    skill: Option<SkillStatus>,
) -> HarnessStatus {
    match detected {
        Some((version, tier)) => HarnessStatus {
            id: id.to_string(),
            program: program.to_string(),
            state: HarnessState::Ready,
            version,
            tier: tier.into(),
            skill: skill.unwrap_or(SkillStatus::None),
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
            skill: skill.unwrap_or(SkillStatus::None),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use refrain_core::context_compiler::SkillStatus;

    fn scratch_home(label: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "refrain-harness-home-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos()),
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// 装协议 → Current；改一个字节 → Stale；删掉 → None。三态都从文件
    /// 本身读，不信任任何人的记录。
    #[test]
    fn the_skill_badge_reads_the_file_itself() {
        use refrain_host::adapters::{
            channel_skill_bytes, channel_skill_path, install_skill_at, skill_status_at,
        };
        let channel = refrain_host::adapters::channel("kimi-print").expect("registered");
        let home = scratch_home("badge");
        let path = channel_skill_path(&home, channel);
        let bytes = channel_skill_bytes(channel);
        assert_eq!(skill_status_at(&path, &bytes), SkillStatus::None);
        let (_path, digest) = install_skill_at(&path, &bytes).unwrap();
        assert!(!digest.is_empty());
        assert_eq!(skill_status_at(&path, &bytes), SkillStatus::Current);
        // 弄坏它：追加一个字节。哈希不同 → Stale。
        let mut mutated = std::fs::read(&path).unwrap();
        mutated.push(b'x');
        std::fs::write(&path, mutated).unwrap();
        assert_eq!(skill_status_at(&path, &bytes), SkillStatus::Stale);
        // 删掉 → None。
        std::fs::remove_file(&path).unwrap();
        assert_eq!(skill_status_at(&path, &bytes), SkillStatus::None);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn every_known_harness_is_reported_whether_or_not_it_is_installed() {
        // 名单固定：一台没装任何 Harness 的机器上，作者仍要看见「可以连
        // 这些」。只报装了的，那个界面在全新机器上是空的，而空界面
        // 读起来与「这个功能坏了」一样。名单来自注册表——新通道加进
        // 注册表，这里自动跟随，但至少要有那三家。
        let statuses = probe_harnesses();
        assert!(
            statuses.len() >= 3,
            "expected at least kimi/claude/pi, got {}",
            statuses.len()
        );
        assert_eq!(statuses[0].id, "kimi-print");
        assert_eq!(statuses[1].id, "claude-print");
        assert_eq!(statuses[2].id, "pi-print");
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
