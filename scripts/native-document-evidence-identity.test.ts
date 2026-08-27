// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  assertSourceExecutableIdentityUnchanged,
  type SourceExecutableIdentity,
} from "./native-document-evidence-identity.ts";

const identity: SourceExecutableIdentity = {
  sourceRevision: "d17bf91dddb3e5033768279f84c6ee66e19c2632",
  sourceDirty: true,
  dirtyManifestSha256: "a".repeat(64),
  executableSha256: "b".repeat(64),
};

describe("Native document evidence identity", () => {
  test("accepts the same source and executable identity after all process samples", () => {
    expect(() => assertSourceExecutableIdentityUnchanged(identity, identity)).not.toThrow();
  });

  test("rejects an executable that changed after interaction evidence", () => {
    expect(() =>
      assertSourceExecutableIdentityUnchanged(identity, {
        ...identity,
        executableSha256: "c".repeat(64),
      }),
    ).toThrow("executable SHA-256 changed");
  });

  test("rejects a dirty source manifest that changed during process sampling", () => {
    expect(() =>
      assertSourceExecutableIdentityUnchanged(identity, {
        ...identity,
        dirtyManifestSha256: "d".repeat(64),
      }),
    ).toThrow("dirty source manifest SHA-256 changed");
  });
});
