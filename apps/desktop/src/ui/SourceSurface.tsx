// 原件面板：一份 Material 导入自哪个文件，就把那个文件的页面画在正文旁边。
//
// 为什么需要它：导入把 PDF 投影成文本块——作者能编辑，但页、栏、图注、表格
// 的版面全没了。核对一句引文时，投影不够，要看原件。
//
// **只读。** RefRain 从不写回任何来源（所有者裁定），也从不在导入之后写备份
// 目录。这里读的是导入当时留下的不可变克隆件。

// worker 源码由调用方按自己的构建器取——这个应用用 Vite，所以是 `?raw`。
import workerSource from "pdfjs-dist/build/pdf.worker.min.mjs?raw";
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
// PDF 渲染住在应用层，不在 `packages/editor` 里：`verify:typeset-purity` 要求
// 那个包零外部依赖——它不知道自己跑在哪，「服务端跑一切」才成立。pdf.js 既是
// 外部依赖，又要 `DOMMatrix` 与 `canvas`，两条都违背。
import { openPdf, renderPage, useWorkerSource } from "./pdf-render";

export type SourceSurfaceProps = {
  /** 源文件摘要，即克隆件的文件名。`null` 表示这份文档不是导入来的。 */
  sourceDigest: string | null;
  sourceFormat: string | null;
  /**
   * 取原始字节。由外壳给，组件不自己跨桥——`verify:component-depth` 守着
   * 这条（组件里的桥调用额度是 0）。副作用是这个面板可以用一个替身来测。
   */
  readBytes: (digest: string, format: string) => Promise<Uint8Array | null>;
  onClose: () => void;
};

/** 一次画多少页。整份三百页的 PDF 一次画完会让界面停住。 */
const PAGE_BATCH = 3;

// 模块加载时装一次。pdf.js 的 workerSrc 是全局的，重复设只是多造几个 blob。
useWorkerSource(workerSource);

export function SourceSurface(props: SourceSurfaceProps): JSX.Element {
  const [canvases, setCanvases] = createSignal<readonly HTMLCanvasElement[]>([]);
  const [total, setTotal] = createSignal(0);
  const [shown, setShown] = createSignal(0);
  const [failure, setFailure] = createSignal<string | null>(null);

  // 解析出来的文档要显式关掉：pdf.js 持有 worker 与解码缓冲，面板关了不放
  // 会一直占着。
  let opened: Awaited<ReturnType<typeof openPdf>> | null = null;
  const close = (): void => {
    void opened?.release();
    opened = null;
  };
  onCleanup(close);

  createEffect(() => {
    const digest = props.sourceDigest;
    const format = props.sourceFormat;
    setCanvases([]);
    setTotal(0);
    setShown(0);
    setFailure(null);
    close();
    if (digest === null || format === null) return;
    // 目前只画得了 PDF。其他格式（DOCX/EPUB）没有页面这个概念，投影出来的
    // 文本就是它们能给的全部。
    if (format !== "pdf") return;

    void (async () => {
      const bytes = await props.readBytes(digest, format);
      if (bytes === null) {
        // 导入早于 schema v10 的 Material，或克隆件已被移走。作者手上的文本
        // 仍然完好，所以这是一句说明而不是一个错误。
        setFailure("这份资料没有留下原件，只能看导入时抽出的文字。");
        return;
      }
      try {
        opened = await openPdf(bytes);
        setTotal(opened.document.numPages);
        await draw(1, Math.min(PAGE_BATCH, opened.document.numPages));
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "原件打不开。");
      }
    })();
  });

  const draw = async (from: number, to: number): Promise<void> => {
    const document_ = opened?.document ?? null;
    if (document_ === null) return;
    const drawn: HTMLCanvasElement[] = [];
    for (let page = from; page <= to; page += 1) {
      const rendered = await renderPage(document_, page, 1);
      drawn.push(rendered.canvas);
    }
    setCanvases((existing) => [...existing, ...drawn]);
    setShown(to);
  };

  const more = (): void => {
    const next = Math.min(shown() + PAGE_BATCH, total());
    if (next > shown()) void draw(shown() + 1, next);
  };

  return (
    <aside class="source-pages" data-quarter="reference" aria-label="原件">
      <header>
        <h2>原件</h2>
        <button type="button" onClick={props.onClose}>
          关闭
        </button>
      </header>
      <Show when={failure()}>
        <p class="source-note">{failure()}</p>
      </Show>
      <Show when={total() > 0}>
        <p class="source-note">
          共 {total()} 页，已显示 {shown()} 页。
        </p>
      </Show>
      <div class="source-canvas-list">
        <For each={canvases()}>{(canvas) => canvas}</For>
      </div>
      <Show when={shown() < total()}>
        <button type="button" onClick={more}>
          再看 {Math.min(PAGE_BATCH, total() - shown())} 页
        </button>
      </Show>
    </aside>
  );
}
