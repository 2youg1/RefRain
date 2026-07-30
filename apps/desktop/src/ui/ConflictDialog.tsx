// The Safety surface for a changed-underneath conflict (SPEC 9.1: the only
// modal layer). Both versions are shown; the author chooses. Nothing is
// decided for them — silently winning would destroy an edit made elsewhere.
import type { JSX } from "solid-js";

export type ConflictChoice = "mine" | "theirs";

export type ConflictDialogProps = {
  mine: string;
  theirs: string;
  onResolve: (choice: ConflictChoice) => void;
};

export function ConflictDialog(props: ConflictDialogProps): JSX.Element {
  return (
    <dialog open class="safety" aria-label="保存冲突">
      <h2>磁盘上的版本已经变了</h2>
      <p>另一个程序（或另一次编辑）改了这个文件。选哪一版留下，由你决定。</p>
      <div class="sides">
        <section>
          <h3>我在这个窗口写的</h3>
          <pre>{props.mine}</pre>
          <button type="button" onClick={() => props.onResolve("mine")}>
            用我的覆盖磁盘
          </button>
        </section>
        <section>
          <h3>磁盘上现在的</h3>
          <pre>{props.theirs}</pre>
          <button type="button" onClick={() => props.onResolve("theirs")}>
            用磁盘的，丢弃我的
          </button>
        </section>
      </div>
    </dialog>
  );
}
