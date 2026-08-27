#!/usr/bin/env bun
// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { dirname, resolve } from "node:path";

import { collectSourceExecutableIdentity } from "../../scripts/native-document-evidence-identity.ts";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

const root = resolve(option("--root"));
const executable = resolve(option("--executable"));
const output = resolve(option("--output"));
const identity = await collectSourceExecutableIdentity(root, executable);
await Bun.write(output, `${JSON.stringify(identity, null, 2)}\n`, {
  createPath: true,
});
console.log(`captured Native IME source/executable identity -> ${output}`);
console.log(`identity directory: ${dirname(output)}`);
