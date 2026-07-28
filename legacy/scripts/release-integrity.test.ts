import { describe, expect, test } from "bun:test";
import { validateReleaseWorkflow } from "./release-integrity.ts";

const releaseWorkflow = await Bun.file(
  new URL("../.github/workflows/release.yml", import.meta.url),
).text();

describe("release integrity", () => {
  test("the checked-in workflow pins Actions and publishes verified checksums", () => {
    expect(validateReleaseWorkflow(releaseWorkflow)).toEqual([]);
  });

  test("a mutable Action ref is rejected", () => {
    const mutable = releaseWorkflow.replace(/(uses:\s+actions\/checkout@)[0-9a-fv]+/, "$1v7");
    expect(validateReleaseWorkflow(mutable)).toContain(
      "actions/checkout@v7 must use a verified 40-character commit SHA",
    );
  });

  test("removing checksum readback is rejected", () => {
    const withoutReadback = releaseWorkflow.replace(/^\s*sha256sum --check SHA256SUMS\s*$/m, "");
    expect(validateReleaseWorkflow(withoutReadback)).toContain(
      "SHA256SUMS must be read back with sha256sum --check before publication",
    );
  });

  test("removing the published checksum is rejected", () => {
    const withoutChecksumAsset = releaseWorkflow.replace(/^\s*release-assets\/SHA256SUMS\s*$/m, "");
    expect(validateReleaseWorkflow(withoutChecksumAsset)).toContain(
      "softprops/action-gh-release must publish release-assets/SHA256SUMS",
    );
  });
});
