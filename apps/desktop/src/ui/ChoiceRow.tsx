import { For, type JSX } from "solid-js";

/**
 * 外观里的一行选择：一个名字，一排互斥的格子。
 *
 * 主题、纸面、面板方向、面板材质、代码配色……它们的差别只有「有哪些选项」与
 * 「选中后写哪个字段」。此前每一行都自带一份读值、写值、记错误、更新本地信号的
 * 代码，加一项就再抄一遍——六项就是六份。
 *
 * 这里只负责「一排格子，点哪个亮哪个」。**写不写得进去、写完怎么办，归调用方**，
 * 因为那是它与 Config 的关系，不是一排按钮的事。
 */
export interface ChoiceRowProps<Value extends string> {
  readonly label: string;
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    readonly title?: string;
  }[];
  readonly current: Value;
  readonly onPick: (value: Value) => void;
  /** 分段格上的可选标记，供门禁与像素装置定位。 */
  readonly data?: string;
}

export function ChoiceRow<Value extends string>(props: ChoiceRowProps<Value>): JSX.Element {
  return (
    <div class="picker-block">
      <span class="picker-name">{props.label}</span>
      <div class="picker-rows">
        <fieldset class="seg" aria-label={props.label}>
          <For each={props.options}>
            {(option) => (
              <button
                type="button"
                classList={{ current: option.value === props.current }}
                attr:data-choice={
                  props.data === undefined ? undefined : `${props.data}:${option.value}`
                }
                title={option.title ?? option.label}
                onClick={() => props.onPick(option.value)}
              >
                {option.label}
              </button>
            )}
          </For>
        </fieldset>
      </div>
    </div>
  );
}
