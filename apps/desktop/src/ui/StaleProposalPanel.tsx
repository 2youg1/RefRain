/**
 * 提案过期时给作者看的那一块。
 *
 * 领域拒绝了这次合并（`TextRefusal::StaleProposal`），因为作者在派发之后改过
 * 那一段。这里出示 **Agent 当时读到的原文**，让他自己判断那条建议对现在的
 * 文字还成不成立——默默套用是丢他的字，直接丢弃是丢 Agent 的活，两者都不能
 * 替他决定（Memo「四区·边缘情况 3」）。
 *
 * 独立成文件而不是留在 ReviewSurface 里：判断已经归 `stale-proposal.ts`，
 * 这里只剩摆放，而摆放的东西自成一块——裁决界面不必为了显示它而变长。
 */

import { For, type JSX, Show } from "solid-js";

export interface StaleProposalPanelProps {
  /** Agent 当时读到的原文。空串表示取不到，那时不显示对照块。 */
  readonly frozenText: string;
  /** 作者可以走的路，按领域给的次序。 */
  readonly steps: readonly string[];
}

export function StaleProposalPanel(props: StaleProposalPanelProps): JSX.Element {
  return (
    <section class="stale-proposal" aria-label="提案已过期">
      {/*
        取不到原文时整块不出现，而不是显示一个写着「无」的空盒子：
        一块声称有内容却没有的区域，比没有这块区域更让人困惑。
      */}
      <Show when={props.frozenText}>
        {(frozen) => (
          <figure>
            <figcaption>Agent 当时读到的是：</figcaption>
            <blockquote>{frozen()}</blockquote>
          </figure>
        )}
      </Show>
      <ul>
        <For each={props.steps}>{(step) => <li>{step}</li>}</For>
      </ul>
    </section>
  );
}
