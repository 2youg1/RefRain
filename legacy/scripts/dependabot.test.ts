import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

interface Update {
  "package-ecosystem": string;
  directory: string;
  schedule?: { interval?: string };
}

test("every locked ecosystem has one weekly Dependabot update route", () => {
  const config = parse(readFileSync(".github/dependabot.yml", "utf8")) as {
    version?: number;
    updates?: Update[];
  };
  expect(config.version).toBe(2);
  const routes = (config.updates ?? []).map(
    (update) => `${update["package-ecosystem"]}:${update.directory}:${update.schedule?.interval}`,
  );
  expect(routes).toEqual([
    "bun:/:weekly",
    "npm:/e2e/ime:weekly",
    "npm:/e2e/ime/shells/e42:weekly",
    "npm:/e2e/ime/shells/e43:weekly",
    "npm:/e2e/ime/shells/e44:weekly",
    "cargo:/packages/fs:weekly",
    "github-actions:/:weekly",
  ]);
});
