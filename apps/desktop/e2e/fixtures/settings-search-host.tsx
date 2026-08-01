// `verify:settings-search` 的宿主。
//
// 挂的是**产品本体** `SettingsSearch`，不是一份仿制品：仿制品只会证明仿制品
// 自己能用。产品里它由 `SettingsSurface` 渲染，那个组件要 Tauri 桥才能起，
// 而搜索本身不碰桥——所以这里单独挂它，正好也让「零桥调用」这条判据成立时
// 有意义（桥根本没接上，任何一次调用都会是显式的失败）。

import { createSignal } from "solid-js";
import { render } from "solid-js/web";

import { SettingsSearch } from "../../src/ui/SettingsSearch";

type Section = "appearance" | "typography" | "shortcuts";

function Host() {
  const [section, setSection] = createSignal<Section>("appearance");
  return (
    <>
      <SettingsSearch onJump={setSection} />
      {/* 门禁读这里判断「点击是否真的切了页」。 */}
      <p id="current-section">{section()}</p>
    </>
  );
}

render(() => <Host />, document.getElementById("host") as HTMLElement);
