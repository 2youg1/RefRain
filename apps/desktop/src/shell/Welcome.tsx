/**
 * 还没有项目时的第一屏。
 *
 * 它与工作台没有共享状态：三个动作、一句话、一个印。放在 Workbench 里只是因为
 * 「打开项目之前」和「打开项目之后」写在同一个组件里，而那是两个场景，不是一个
 * 场景的两种状态——作者在这一屏做的唯一决定是从哪里开始。
 */

import type { JSX } from "solid-js";
import { Show } from "solid-js";

import { LogoMark } from "../ui/LogoMark";

export interface WelcomeProps {
  readonly notice: string | null;
  readonly onOpenFolder: () => void;
  readonly onCreateProject: () => void;
  readonly onOpenDocument: () => void;
}

export function Welcome(props: WelcomeProps): JSX.Element {
  return (
    <section class="welcome">
      <LogoMark size={64} label="RefRain" />
      <h1 class="welcome-brand">RefRain</h1>
      <p class="welcome-tag">一个本地写作工作台。你写的每一个字都在磁盘上。</p>
      <button class="primary welcome-open" type="button" onClick={() => props.onOpenFolder()}>
        打开文件夹
      </button>
      <div class="secondary">
        <button type="button" onClick={() => props.onCreateProject()}>
          新建项目
        </button>
        <button type="button" onClick={() => props.onOpenDocument()}>
          打开文档
        </button>
      </div>
      <Show when={props.notice}>{(text) => <p class="notice">{text()}</p>}</Show>
    </section>
  );
}
