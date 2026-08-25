//! KARA 的应用侧门：机器住在这里，事件从用例发生的地方进来。
//!
//! # 接上哪个功能
//!
//! F14「KARA」。机器本身（六个状态、一个转移函数、具名效果）是
//! `refrain_core::kara` 的，这一层只回答两件事：这个进程的那一台机器在哪，
//! 以及一次用例算不算得上一个事件。
//!
//! # 这一层持有的不变量
//!
//! **策略在构造时定死。** 自动进场是产品决定，不是运行期开关；此前它由一个
//! 零调用者的 setter 假装可配，而 `Application::open` 一直写死 `true`——两个
//! 权威里没人用的那个，正是会先过期的那个。
//!
//! **一条 Run 完成有两个分量**：完成本身记 `AgentCompleted`，带来提案再记
//! `ProposalArrived`。这条规则此前在 `ReadHost` 与 `CollectRun` 两条臂里各写
//! 一遍；`run_completed` 是它现在唯一的写法。
//!
//! **事实在发生处落地，不经视图转述。** 离场小结带读的是机器里的队列，
//! 不是界面的记忆——所以安静事件由用例调用，不由 Zig 侧补发。
//!
//! # 能复用什么
//!
//! `quiet` 是安静事件的窄入口（调用方不要转移结果）；`step` 留给要读转移的
//! 那一条跨界输入。锁只有一把，且不与项目锁嵌套：路由在 `with_project`
//! 返回之后才发事件。

use refrain_core::{
    DocumentRole, ErrorCode, KaraAutoEntry, KaraEvent, KaraMachine, KaraPolicy, KaraTransition,
    QuietEvent, RefrainError,
};
use std::sync::Mutex;

/// 这个进程的 KARA 机器，连同它的策略。
pub struct Kara {
    machine: Mutex<KaraMachine>,
    policy: KaraPolicy,
}

impl Default for Kara {
    fn default() -> Self {
        Self::new()
    }
}

impl Kara {
    /// 新机器，自动进场开着：第一份正文打开时 KARA 自己进场，这是产品的
    /// 出厂行为（`Application::open` 此前写死的就是它）。
    #[must_use]
    pub fn new() -> Self {
        Self {
            machine: Mutex::new(KaraMachine::new()),
            policy: KaraPolicy {
                auto_enter_on_first_manuscript: true,
            },
        }
    }

    /// 推进一步，交回这次转移（新状态与要执行的效果）。
    ///
    /// # Errors
    ///
    /// 机器的锁被毒化时报 `StateUnavailable`。
    pub fn step(&self, event: KaraEvent) -> Result<KaraTransition, RefrainError> {
        let mut machine = self.locked()?;
        let transition = machine.step(event, self.policy);
        *machine = transition.machine.clone();
        Ok(transition)
    }

    /// 记一个安静事件。转移在这里丢弃——安静事件不改变作者眼前的东西，
    /// 它只进队列，等离场小结带读。
    ///
    /// # Errors
    ///
    /// 与 [`Self::step`] 相同。
    pub fn quiet(&self, event: QuietEvent) -> Result<(), RefrainError> {
        self.step(KaraEvent::Quiet(event))?;
        Ok(())
    }

    /// 一条 Run 完成：完成本身一记，带来提案再一记。两个事实，两种分量。
    ///
    /// # Errors
    ///
    /// 与 [`Self::step`] 相同。
    pub fn run_completed(&self, proposals: u32) -> Result<(), RefrainError> {
        self.quiet(QuietEvent::AgentCompleted)?;
        if proposals > 0 {
            self.quiet(QuietEvent::ProposalArrived)?;
        }
        Ok(())
    }

    /// 机器现在的样子。
    ///
    /// # Errors
    ///
    /// 机器的锁被毒化时报 `StateUnavailable`。
    pub fn state(&self) -> Result<KaraMachine, RefrainError> {
        self.locked().map(|machine| machine.clone())
    }

    /// 重新上膛：采用了一个新 Root 之后，「第一份正文」这件事重新有意义。
    ///
    /// # Errors
    ///
    /// 机器的锁被毒化时报 `StateUnavailable`。
    pub fn rearm(&self) -> Result<(), RefrainError> {
        self.locked()?.auto_entry = KaraAutoEntry::Pending;
        Ok(())
    }

    /// 打开了一份正文。资料不算——KARA 是写作的场，不是读资料的场。
    ///
    /// 返回 `None` 表示这份文档的角色不触发进场；`Some` 是真的转移了。
    ///
    /// # Errors
    ///
    /// 与 [`Self::step`] 相同，且把失败的 subject 换成这份文档，
    /// 让作者读到的是他刚点开的那个名字。
    pub fn manuscript_opened(
        &self,
        role: DocumentRole,
        subject: &str,
    ) -> Result<Option<KaraTransition>, RefrainError> {
        if !matches!(role, DocumentRole::Document | DocumentRole::Chapter) {
            return Ok(None);
        }
        let auto_entry = self.state()?.auto_entry;
        self.step(KaraEvent::FirstManuscriptOpened(auto_entry))
            .map(Some)
            .map_err(|mut error| {
                error.subject = subject.to_string();
                error
            })
    }

    fn locked(&self) -> Result<std::sync::MutexGuard<'_, KaraMachine>, RefrainError> {
        self.machine.lock().map_err(|_| {
            RefrainError::new(ErrorCode::StateUnavailable, "lock the KARA machine", "kara")
        })
    }
}
