// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto";
import { join } from "node:path";

export interface SourceExecutableIdentity {
  readonly sourceRevision: string;
  readonly sourceDirty: boolean;
  readonly dirtyManifestSha256: string;
  readonly executableSha256: string;
}

export async function collectSourceExecutableIdentity(
  root: string,
  executable: string,
): Promise<SourceExecutableIdentity> {
  const decoder = new TextDecoder();
  const sourceRevision = decoder.decode(commandBytes(root, ["git", "rev-parse", "HEAD"])).trim();
  const trackedDiff = commandBytes(root, ["git", "diff", "--binary", "HEAD", "--", "."]);
  const untracked = decoder
    .decode(commandBytes(root, ["git", "ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();
  const manifest = createHash("sha256");
  manifest.update("tracked-diff\0");
  manifest.update(trackedDiff);
  for (const path of untracked) {
    manifest.update("untracked\0");
    manifest.update(path);
    manifest.update("\0");
    manifest.update(new Uint8Array(await Bun.file(join(root, path)).arrayBuffer()));
  }
  const executableBytes = new Uint8Array(await Bun.file(executable).arrayBuffer());
  return {
    sourceRevision,
    sourceDirty: trackedDiff.length > 0 || untracked.length > 0,
    dirtyManifestSha256: manifest.digest("hex"),
    executableSha256: createHash("sha256").update(executableBytes).digest("hex"),
  };
}

export function assertSourceExecutableIdentityUnchanged(
  before: SourceExecutableIdentity,
  after: SourceExecutableIdentity,
): void {
  if (before.sourceRevision !== after.sourceRevision) {
    throw new Error(
      `Native evidence source revision changed from ${before.sourceRevision} to ${after.sourceRevision}`,
    );
  }
  if (before.sourceDirty !== after.sourceDirty) {
    throw new Error(
      `Native evidence source dirty state changed from ${before.sourceDirty} to ${after.sourceDirty}`,
    );
  }
  if (before.dirtyManifestSha256 !== after.dirtyManifestSha256) {
    throw new Error(
      "Native evidence dirty source manifest SHA-256 changed during process sampling",
    );
  }
  if (before.executableSha256 !== after.executableSha256) {
    throw new Error("Native evidence executable SHA-256 changed during process sampling");
  }
}

function commandBytes(root: string, args: readonly string[]): Uint8Array {
  const result = Bun.spawnSync([...args], {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 || result.stderr.length > 0) {
    throw new Error(
      `${args.join(" ")} failed (${result.exitCode})\n${result.stdout.toString()}${result.stderr.toString()}`,
    );
  }
  return result.stdout;
}
