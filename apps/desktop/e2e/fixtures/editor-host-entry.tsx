// 门禁 `editor-host-identity.ts` 的浏览器侧装置。
//
// 它挂的是**真的** `EditorHost`，并复制 `Workbench.tsx` 里那段 `<Show when={active()}>`
// 结构——门禁要守的正是这个结构下的重挂语义，换成别的写法就测不到产品。
//
// 跨桥被替换成内存后端：这道门禁问的是组件生命周期，不是 Rust。

import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { OpenDocumentDto_Serialize } from "../../src/generated/bindings.gen";
import { EditorHost } from "../../src/ui/EditorHost";

type Doc = { path: string; revision: string; text: string };

const DOCUMENTS: Record<string, Doc> = {
  first: { path: "章一.md", revision: "revision-first", text: "第一份稿子" },
  second: { path: "章二.md", revision: "revision-second", text: "第二份稿子" },
};

let mounts = 0;
let lastBase: string | null = null;

const openDto = (doc: Doc): OpenDocumentDto_Serialize =>
  ({
    document: { path: doc.path, role: "chapter", title: doc.path },
    revision: doc.revision,
    blocks: [{ id: `${doc.path}-b1`, text: doc.text }],
    stamp: { size: 0, modifiedMs: 0, digest: "d" },
    replayed: 0,
    staleJournal: [],
    kara: null,
  }) as unknown as OpenDocumentDto_Serialize;

// EditorHost 通过 `commands.applyEditorAction` 与 `currentDocument` 跨桥。
// 这里把 Tauri 的 invoke 换成内存后端，记录每次提交所依据的 revision。
(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
  invoke: (command: string, payload: Record<string, unknown>) => {
    if (command === "apply_editor_action") {
      const action = payload.action as { base: string };
      lastBase = action.base;
      return Promise.resolve({ status: "ok", data: { revision: `${action.base}+1` } });
    }
    if (command === "current_document") {
      const path = payload.path as string;
      const doc = Object.values(DOCUMENTS).find((entry) => entry.path === path);
      return Promise.resolve({
        status: "ok",
        data: {
          revision: doc?.revision ?? "?",
          blocks: [{ id: `${path}-b1`, text: doc?.text ?? "" }],
        },
      });
    }
    return Promise.resolve({ status: "ok", data: null });
  },
};

const [key, setKey] = createSignal<"first" | "second">("first");
const active = () => DOCUMENTS[key()];

render(
  () => (
    // 刻意复制 Workbench.tsx 的结构：切文档时 active() 始终非空，
    // <Show> 因此复用组件实例。重挂的责任在 EditorHost 自己身上，
    // 所以这道门禁在这种「最不利」的调用形状下依然必须绿。
    <Show when={active()}>
      {(doc) => (
        <EditorHost
          rootId="root-1"
          path={doc().path}
          document={openDto(doc())}
          annotations={[]}
          onReady={(handle) => {
            if (handle !== null) mounts += 1;
          }}
          onConfirmed={() => {}}
          onRejected={() => {}}
          onContext={() => {}}
        />
      )}
    </Show>
  ),
  document.getElementById("root") as HTMLElement,
);

Object.assign(window, {
  hostReady: true,
  openDocument: (name: "first" | "second") => setKey(name),
  editorText: () => document.querySelector(".editor-host")?.textContent ?? "",
  submittedBase: () => lastBase,
  mountCount: () => mounts,
  typeInto: (text: string) => {
    const paragraph = document.querySelector(".editor-host [data-block-id]");
    if (paragraph === null) return;
    paragraph.textContent = text;
    paragraph.dispatchEvent(new InputEvent("input", { bubbles: true }));
  },
});
