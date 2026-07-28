import { parse } from "yaml";

interface Workflow {
  jobs?: Record<string, { steps?: { run?: unknown }[] }>;
}

/** Shell bodies attached to actual workflow `run` keys; comments and prose never enter. */
export const workflowRuns = (source: string): string[] => {
  const workflow = parse(source) as Workflow | null;
  return Object.values(workflow?.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => (typeof step.run === "string" ? [step.run] : [])),
  );
};

const escaped = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const commandStart = "(?:^|[\\n;&|])\\s*";
const commandEnd = "(?=$|[\\s;&|])";

/** A Bun invocation of this file, not a mention handed to echo or another command. */
export const runsBunFile = (runs: readonly string[], name: string): boolean => {
  const file = escaped(name);
  const invocation = new RegExp(
    `${commandStart}bun\\s+(?:run\\s+)?(?:[^\\s;&|]*[/\\\\])?${file}${commandEnd}`,
    "m",
  );
  return runs.some((run) => invocation.test(run));
};

/** A `bun run` invocation of one package script. */
export const runsBunScript = (runs: readonly string[], name: string): boolean => {
  const invocation = new RegExp(`${commandStart}bun\\s+run\\s+${escaped(name)}${commandEnd}`, "m");
  return runs.some((run) => invocation.test(run));
};

/** An executable token in a run body, including `bun x <name>`. */
export const runsCommand = (runs: readonly string[], name: string): boolean => {
  const invocation = new RegExp(
    `${commandStart}(?:bun\\s+x\\s+)?${escaped(name)}${commandEnd}`,
    "m",
  );
  return runs.some((run) => invocation.test(run));
};
