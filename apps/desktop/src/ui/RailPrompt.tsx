// 栏内表单：取代 window.prompt 的唯一去处。命名、批注这类一句话的询问
// 不跳出窗口，在侧栏里就地问完——Enter 交卷，Escape 收回。
import { createSignal, type JSX, onMount } from "solid-js";

export type RailPromptProps = {
  /** 问作者什么，例如「项目名」。 */
  label: string;
  /** 交出非空回答；空白等同收回。 */
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

export function RailPrompt(props: RailPromptProps): JSX.Element {
  let input: HTMLInputElement | undefined;
  const [value, setValue] = createSignal("");

  onMount(() => input?.focus());

  const submit = (): void => {
    const trimmed = value().trim();
    if (trimmed === "") {
      props.onCancel();
      return;
    }
    props.onSubmit(trimmed);
  };

  return (
    <form
      class="rail-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        }
      }}
    >
      <label>
        {props.label}
        <input
          ref={input}
          type="text"
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      <div class="rail-prompt-actions">
        <button type="submit">确定</button>
        <button type="button" onClick={() => props.onCancel()}>
          取消
        </button>
      </div>
    </form>
  );
}
