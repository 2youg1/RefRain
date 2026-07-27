import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import type { ReviewTask } from "@refrain/agent";
import type { Edit, Proposal, Verdict } from "@refrain/core";
import type { SortOrder } from "@refrain/fs";

interface ReviewCommit {
  readonly chapter: string;
  readonly verdicts: Verdict[];
}

interface IpcArguments {
  "project:open": [];
  "project:open-file": [];
  "project:create": [];
  "project:resolve-drop": [path: string];
  "project:load-workspace": [roots: string[]];
  "project:load": [root: string];
  "project:save": [root: string, chapterId: string, text: string];
  "project:resolve-conflict": [root: string, chapterId: string, choice: "mine" | "disk"];
  "edits:revert": [root: string, chapterId: string, edit: Edit];
  "edits:revert-all": [root: string, chapterId: string, edits: Edit[]];
  "edits:describe": [edits: Edit[]];
  "fonts:list": [];
  "shell:open-project-url": [url: string];
  "agent:list": [root: string];
  "agent:trust": [root: string, id: string];
  "agent:probe": [root: string, id: string];
  "agent:remove": [root: string, id: string];
  "agent:add": [
    root: string,
    name: string,
    command: string,
    model: string,
    reasoningEffort: string,
  ];
  "agent:enqueue": [root: string, task: ReviewTask];
  "agent:manifest": [root: string];
  "agent:send": [root: string];
  "agent:cancel": [root: string, runId: string];
  "agent:runs": [root: string];
  "agent:collect": [root: string, runId: string];
  "review:slice": [proposal: Proposal];
  "review:commit": [root: string, payload: ReviewCommit];
  "ledger:all": [root: string];
  "ledger:reply": [root: string, proposalId: string];
  "ledger:search": [root: string, fragment: string];
  "files:scan": [root: string, options: Record<string, unknown> | undefined];
  "files:page": [root: string, offset: number, limit: number];
  "files:search": [root: string, query: string, limit: number | undefined];
  "files:search-directories": [root: string, query: string, limit: number | undefined];
  "files:sort": [root: string, order: SortOrder, descending: boolean];
  "files:move": [root: string, from: string, to: string, replace: boolean | undefined];
  "files:copy": [root: string, from: string, to: string, replace: boolean | undefined];
  "files:trash": [root: string, targets: string[]];
  "files:trash-via-home": [root: string, target: string];
  "files:link": [root: string, target: string, linkPath: string];
  "files:create-directory": [root: string, path: string];
  "files:admits": [root: string, path: string];
  "window:fullscreen": [on: boolean];
  "display:profile": [];
}

export type IpcChannel = keyof IpcArguments;
export type RootIpcChannel =
  | "project:load"
  | "project:save"
  | "project:resolve-conflict"
  | "edits:revert"
  | "edits:revert-all"
  | "agent:list"
  | "agent:trust"
  | "agent:probe"
  | "agent:remove"
  | "agent:add"
  | "agent:enqueue"
  | "agent:manifest"
  | "agent:send"
  | "agent:cancel"
  | "agent:runs"
  | "agent:collect"
  | "review:commit"
  | "ledger:all"
  | "ledger:reply"
  | "ledger:search"
  | "files:scan"
  | "files:page"
  | "files:search"
  | "files:search-directories"
  | "files:sort"
  | "files:move"
  | "files:copy"
  | "files:trash"
  | "files:trash-via-home"
  | "files:link"
  | "files:create-directory"
  | "files:admits";

export type IpcArgs<C extends IpcChannel> = IpcArguments[C];

type Decode<T> = ((value: unknown, path: string) => T) & { readonly optional?: true };
type Parse<T extends unknown[]> = (channel: string, values: unknown[]) => T;

const refuse = (path: string, expected: string): never => {
  throw new Error(`Refused IPC argument ${path}: expected ${expected}`);
};

const text: Decode<string> = (value, path) =>
  typeof value === "string" ? value : refuse(path, "a string");

const nonEmptyText: Decode<string> = (value, path) => {
  const decoded = text(value, path);
  return decoded.trim().length > 0 ? decoded : refuse(path, "a non-empty string");
};

const boolean: Decode<boolean> = (value, path) =>
  typeof value === "boolean" ? value : refuse(path, "a boolean");

const integer =
  (minimum: number): Decode<number> =>
  (value, path) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
      ? value
      : refuse(path, `an integer >= ${minimum}`);

const oneOf = <const Values extends readonly string[]>(
  ...allowed: Values
): Decode<Values[number]> =>
  ((value: unknown, path: string) =>
    typeof value === "string" && allowed.includes(value)
      ? (value as Values[number])
      : refuse(path, allowed.map((entry) => JSON.stringify(entry)).join(" or "))) as Decode<
    Values[number]
  >;

const optional = <T>(decode: Decode<T>): Decode<T | undefined> =>
  Object.assign(
    (value: unknown, path: string) => (value === undefined ? undefined : decode(value, path)),
    { optional: true as const },
  );

const list =
  <T>(decode: Decode<T>): Decode<T[]> =>
  (value, path) => {
    if (!Array.isArray(value)) return refuse(path, "an array");
    if (value.length > 100_000) return refuse(path, "at most 100000 items");
    const decoded: T[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) refuse(`${path}[${index}]`, "an array item");
      decoded.push(decode(value[index], `${path}[${index}]`));
    }
    return decoded;
  };

const uniqueNonEmptyTexts: Decode<string[]> = (value, path) => {
  const decoded = list(nonEmptyText)(value, path);
  return new Set(decoded).size === decoded.length
    ? decoded
    : refuse(path, "unique non-empty strings");
};

const record = (value: unknown, path: string, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return refuse(path, "an object");
  const held = value as Record<string, unknown>;
  const unknown = Object.keys(held).find((key) => !keys.includes(key));
  if (unknown !== undefined) refuse(`${path}.${unknown}`, "no unknown field");
  return held;
};

const tuple =
  <T extends unknown[]>(...decoders: { [K in keyof T]: Decode<T[K]> }): Parse<T> =>
  (channel, values) => {
    const required = decoders.findIndex((decode) => decode.optional === true);
    const minimum = required === -1 ? decoders.length : required;
    if (values.length < minimum || values.length > decoders.length)
      refuse(
        `${channel} count`,
        `${minimum}${minimum === decoders.length ? "" : `..${decoders.length}`} argument(s)`,
      );
    return decoders.map((decode, index) => decode(values[index], `${channel}[${index}]`)) as T;
  };

const absolutePath: Decode<string> = (value, path) => {
  const candidate = text(value, path);
  return isAbsolute(candidate) ? normalize(candidate) : refuse(path, "an absolute path");
};

const under = (root: string, value: unknown, path: string): string => {
  const candidate = absolutePath(value, path);
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  )
    return candidate;
  return refuse(path, `a path inside Root ${root}`);
};

const chapterId = (root: string, value: unknown, path: string): string => {
  const candidate = text(value, path);
  if (isAbsolute(candidate)) return refuse(path, "a relative chapter path");
  under(root, resolve(root, candidate), path);
  return candidate;
};

const edit: Decode<Edit> = (value, path) => {
  const held = record(value, path, [
    "id",
    "kind",
    "blockId",
    "before",
    "after",
    "nextBlockId",
    "previousBlockId",
    "at",
    "note",
  ]);
  text(held.id, `${path}.id`);
  const kind = oneOf("replace", "insert", "remove")(held.kind, `${path}.kind`);
  text(held.blockId, `${path}.blockId`);
  optional(text)(held.before, `${path}.before`);
  optional(text)(held.after, `${path}.after`);
  optional(text)(held.nextBlockId, `${path}.nextBlockId`);
  optional(text)(held.previousBlockId, `${path}.previousBlockId`);
  text(held.at, `${path}.at`);
  optional(text)(held.note, `${path}.note`);
  if (kind !== "insert" && typeof held.before !== "string")
    refuse(`${path}.before`, `a string for ${kind}`);
  if (kind !== "remove" && typeof held.after !== "string")
    refuse(`${path}.after`, `a string for ${kind}`);
  return held as unknown as Edit;
};

const taskScope: Decode<ReviewTask["editScopes"][number]> = (value, path) => {
  const held = record(value, path, ["id", "blockIds", "text"]);
  nonEmptyText(held.id, `${path}.id`);
  uniqueNonEmptyTexts(held.blockIds, `${path}.blockIds`);
  text(held.text, `${path}.text`);
  return held as unknown as ReviewTask["editScopes"][number];
};

const reviewTask: Decode<ReviewTask> = (value, path) => {
  const held = record(value, path, [
    "id",
    "agentId",
    "baseline",
    "prompt",
    "contextScope",
    "editScopes",
  ]);
  nonEmptyText(held.id, `${path}.id`);
  nonEmptyText(held.agentId, `${path}.agentId`);
  nonEmptyText(held.baseline, `${path}.baseline`);
  nonEmptyText(held.prompt, `${path}.prompt`);
  uniqueNonEmptyTexts(held.contextScope, `${path}.contextScope`);
  const editScopes = list(taskScope)(held.editScopes, `${path}.editScopes`);
  if (new Set(editScopes.map((scope) => scope.id)).size !== editScopes.length)
    refuse(`${path}.editScopes`, "unique scope ids");
  return held as unknown as ReviewTask;
};

const proposal: Decode<Proposal> = (value, path) => {
  const held = record(value, path, ["id", "runId", "baseline", "scope", "before", "after"]);
  nonEmptyText(held.id, `${path}.id`);
  nonEmptyText(held.runId, `${path}.runId`);
  nonEmptyText(held.baseline, `${path}.baseline`);
  const scope = record(held.scope, `${path}.scope`, ["id", "blockIds"]);
  nonEmptyText(scope.id, `${path}.scope.id`);
  uniqueNonEmptyTexts(scope.blockIds, `${path}.scope.blockIds`);
  text(held.before, `${path}.before`);
  if (held.after !== null) text(held.after, `${path}.after`);
  return held as unknown as Proposal;
};

const verdict: Decode<Verdict> = (value, path) => {
  const held = record(value, path, [
    "id",
    "proposalId",
    "sliceId",
    "kind",
    "finalText",
    "reason",
    "baseline",
    "decidedAt",
  ]);
  text(held.id, `${path}.id`);
  text(held.proposalId, `${path}.proposalId`);
  optional(text)(held.sliceId, `${path}.sliceId`);
  const kind = oneOf(
    "accept",
    "accept-modified",
    "reject",
    "comment-only",
  )(held.kind, `${path}.kind`);
  optional(text)(held.finalText, `${path}.finalText`);
  optional(text)(held.reason, `${path}.reason`);
  text(held.baseline, `${path}.baseline`);
  text(held.decidedAt, `${path}.decidedAt`);
  if (kind === "accept-modified" && typeof held.finalText !== "string")
    refuse(`${path}.finalText`, "a string for accept-modified");
  return held as unknown as Verdict;
};

const reviewCommit: Decode<ReviewCommit> = (value, path) => {
  const held = record(value, path, ["chapter", "verdicts"]);
  text(held.chapter, `${path}.chapter`);
  list(verdict)(held.verdicts, `${path}.verdicts`);
  return held as unknown as ReviewCommit;
};

const scanOptions: Decode<Record<string, unknown>> = (value, path) => {
  const held = record(value, path, ["followSymlinks", "maxDepth", "manuscriptsOnly"]);
  optional(boolean)(held.followSymlinks, `${path}.followSymlinks`);
  optional(integer(0))(held.maxDepth, `${path}.maxDepth`);
  optional(boolean)(held.manuscriptsOnly, `${path}.manuscriptsOnly`);
  return held;
};

const rootedPair = (
  channel: string,
  values: unknown[],
): [root: string, from: string, to: string, replace: boolean | undefined] => {
  const [root, from, to, replace] = tuple<[string, string, string, boolean | undefined]>(
    absolutePath,
    text,
    text,
    optional(boolean),
  )(channel, values);
  return [root, under(root, from, `${channel}[1]`), under(root, to, `${channel}[2]`), replace];
};

const rootedPath = (channel: string, values: unknown[]): [root: string, path: string] => {
  const [root, path] = tuple<[string, string]>(absolutePath, text)(channel, values);
  return [root, under(root, path, `${channel}[1]`)];
};

const rootedPaths = (channel: string, values: unknown[]): [root: string, paths: string[]] => {
  const [root, paths] = tuple<[string, string[]]>(absolutePath, list(text))(channel, values);
  return [root, paths.map((path, index) => under(root, path, `${channel}[1][${index}]`))];
};

const parsers = {
  "project:open": tuple(),
  "project:open-file": tuple(),
  "project:create": tuple(),
  "project:resolve-drop": tuple(absolutePath),
  "project:load-workspace": tuple(list(absolutePath)),
  "project:load": tuple(absolutePath),
  "project:save": (channel, values) => {
    const [root, chapter, body] = tuple<[string, string, string]>(
      absolutePath,
      text,
      text,
    )(channel, values);
    return [root, chapterId(root, chapter, `${channel}[1]`), body];
  },
  "project:resolve-conflict": (channel, values) => {
    const [root, chapter, choice] = tuple<[string, string, "mine" | "disk"]>(
      absolutePath,
      text,
      oneOf("mine", "disk"),
    )(channel, values);
    return [root, chapterId(root, chapter, `${channel}[1]`), choice];
  },
  "edits:revert": (channel, values) => {
    const [root, chapter, held] = tuple<[string, string, Edit]>(
      absolutePath,
      text,
      edit,
    )(channel, values);
    return [root, chapterId(root, chapter, `${channel}[1]`), held];
  },
  "edits:revert-all": (channel, values) => {
    const [root, chapter, held] = tuple<[string, string, Edit[]]>(
      absolutePath,
      text,
      list(edit),
    )(channel, values);
    return [root, chapterId(root, chapter, `${channel}[1]`), held];
  },
  "edits:describe": tuple(list(edit)),
  "fonts:list": tuple(),
  "shell:open-project-url": tuple(text),
  "agent:list": tuple(absolutePath),
  "agent:trust": tuple(absolutePath, text),
  "agent:probe": tuple(absolutePath, text),
  "agent:remove": tuple(absolutePath, text),
  "agent:add": tuple(absolutePath, text, text, text, text),
  "agent:enqueue": tuple(absolutePath, reviewTask),
  "agent:manifest": tuple(absolutePath),
  "agent:send": tuple(absolutePath),
  "agent:cancel": tuple(absolutePath, nonEmptyText),
  "agent:runs": tuple(absolutePath),
  "agent:collect": tuple(absolutePath, text),
  "review:slice": tuple(proposal),
  "review:commit": (channel, values) => {
    const [root, payload] = tuple<[string, ReviewCommit]>(absolutePath, reviewCommit)(
      channel,
      values,
    );
    chapterId(root, payload.chapter, `${channel}[1].chapter`);
    return [root, payload];
  },
  "ledger:all": tuple(absolutePath),
  "ledger:reply": tuple(absolutePath, text),
  "ledger:search": tuple(absolutePath, text),
  "files:scan": tuple(absolutePath, optional(scanOptions)),
  "files:page": tuple(absolutePath, integer(0), integer(0)),
  "files:search": tuple(absolutePath, text, optional(integer(0))),
  "files:search-directories": tuple(absolutePath, text, optional(integer(0))),
  "files:sort": tuple(absolutePath, oneOf("name", "modified", "size", "kind"), boolean),
  "files:move": rootedPair,
  "files:copy": rootedPair,
  "files:trash": rootedPaths,
  "files:trash-via-home": rootedPath,
  "files:link": (channel, values) => {
    const [root, target, linkPath] = tuple<[string, string, string]>(
      absolutePath,
      text,
      text,
    )(channel, values);
    return [root, under(root, target, `${channel}[1]`), under(root, linkPath, `${channel}[2]`)];
  },
  "files:create-directory": rootedPath,
  "files:admits": rootedPath,
  "window:fullscreen": tuple(boolean),
  "display:profile": tuple(),
} satisfies { [C in IpcChannel]: Parse<IpcArguments[C]> };

export const IPC_CHANNELS = Object.freeze(Object.keys(parsers) as IpcChannel[]);

export const parseIpcArgs = <C extends IpcChannel>(
  channel: C,
  values: unknown[],
): IpcArguments[C] => parsers[channel](channel, values) as IpcArguments[C];
