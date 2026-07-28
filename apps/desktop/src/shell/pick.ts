/**
 * One seam for every OS picker the workbench opens. The e2e harness cannot
 * reach a native dialog, so it plants its answer under `refrain.e2e.pick`;
 * production runs never set the key. It is read exactly here so a stray value
 * has one visible home — and it is a test seam, never a setting, which is why
 * `verify:config-authority` lets the `refrain.e2e.` prefix through.
 */
import { open } from "@tauri-apps/plugin-dialog";

const planted = (): string | null => window.localStorage.getItem("refrain.e2e.pick");

/** Ask for the project folder (SPEC 9.5: only an existing directory). */
export async function pickProjectFolder(title: string): Promise<string | null> {
  const answer = planted();
  if (answer !== null) return answer;
  const path = await open({ directory: true, title });
  return typeof path === "string" ? path : null;
}

/** Ask for one manuscript file. */
export async function pickDocumentFile(): Promise<string | null> {
  const answer = planted();
  if (answer !== null) return answer;
  const path = await open({
    directory: false,
    filters: [{ name: "Manuscript", extensions: ["md", "markdown", "mdown", "txt"] }],
  });
  return typeof path === "string" ? path : null;
}

/** Ask for the parent directory a new project is created in. */
export async function pickProjectParent(): Promise<string | null> {
  const answer = planted();
  if (answer !== null) return answer;
  const path = await open({ directory: true, title: "选择父目录" });
  return typeof path === "string" ? path : null;
}
