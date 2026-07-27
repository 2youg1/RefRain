import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type AtomicWriteCheckpoint,
  AtomicWriteFailure,
  ownsInterruptedWrite,
  recoverInterruptedWrite,
  replaceFileAtomically,
  replaceStateFileAtomically,
} from "../src/index.ts";

const scratch = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "refrain-writing-recovery-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

const evidencePaths = (root: string, target: string): string[] =>
  readdirSync(root)
    .filter(
      (name) => name.startsWith(`${basename(target)}.writing.`) && !name.endsWith(".refrain-owner"),
    )
    .map((name) => join(root, name));

describe("an interrupted atomic write is recovered before the next save", () => {
  test("a residue identical to the canonical target is safely cleared", () => {
    const { root, cleanup } = scratch();
    try {
      const target = join(root, "chapter.md");
      writeFileSync(target, "canonical\n");
      writeFileSync(`${target}.writing`, "canonical\n");

      const result = replaceFileAtomically(target, "next\n");

      expect(result as unknown).toEqual({});
      expect(readFileSync(target, "utf8")).toBe("next\n");
      expect(existsSync(`${target}.writing`)).toBe(false);
      expect(evidencePaths(root, target)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("a differing residue is preserved and its location is returned", () => {
    const { root, cleanup } = scratch();
    try {
      const target = join(root, "chapter.md");
      writeFileSync(target, "canonical\n");
      writeFileSync(`${target}.writing`, "interrupted candidate\n");

      const result = replaceFileAtomically(target, "next\n");
      const evidence = evidencePaths(root, target);

      expect(evidence).toHaveLength(1);
      expect(result as unknown).toEqual({ recoveryEvidencePath: evidence[0] });
      expect(readFileSync(evidence[0] ?? "", "utf8")).toBe("interrupted candidate\n");
      expect(readFileSync(target, "utf8")).toBe("next\n");
      expect(existsSync(`${target}.writing`)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("a residue is preserved when the canonical target does not exist", () => {
    const { root, cleanup } = scratch();
    try {
      const target = join(root, "new-chapter.md");
      writeFileSync(`${target}.writing`, "only copy left by the crash\n");

      const result = replaceFileAtomically(target, "new canonical\n");
      const evidence = evidencePaths(root, target);

      expect(evidence).toHaveLength(1);
      expect(result as unknown).toEqual({ recoveryEvidencePath: evidence[0] });
      expect(readFileSync(evidence[0] ?? "", "utf8")).toBe("only copy left by the crash\n");
      expect(readFileSync(target, "utf8")).toBe("new canonical\n");
    } finally {
      cleanup();
    }
  });

  for (const checkpoint of [
    "recovery-linked",
    "recovery-directory-synced",
    "recovery-unlinked",
  ] satisfies AtomicWriteCheckpoint[]) {
    test(`a crash after ${checkpoint} leaves a durable name for the candidate`, () => {
      const { root, cleanup } = scratch();
      try {
        const target = join(root, "chapter.md");
        const temporary = `${target}.writing`;
        writeFileSync(target, "canonical\n");
        writeFileSync(temporary, "interrupted candidate\n");
        let failure: unknown;

        try {
          recoverInterruptedWrite(target, (reached) => {
            if (reached === checkpoint) throw new Error(`power loss after ${checkpoint}`);
          });
        } catch (error) {
          failure = error;
        }

        expect(failure).toBeInstanceOf(AtomicWriteFailure);
        const evidence = (failure as AtomicWriteFailure).recoveryEvidencePath;
        expect(readFileSync(evidence, "utf8")).toBe("interrupted candidate\n");
        expect(existsSync(temporary)).toBe(checkpoint !== "recovery-unlinked");
        if (existsSync(temporary))
          expect(readFileSync(temporary, "utf8")).toBe("interrupted candidate\n");
      } finally {
        cleanup();
      }
    });
  }

  test("a state writer stops after preserving residue it has no notice channel for", () => {
    const { root, cleanup } = scratch();
    try {
      const target = join(root, "host.json");
      writeFileSync(target, "canonical\n");
      writeFileSync(`${target}.writing`, "interrupted state\n");
      let failure: unknown;

      try {
        replaceStateFileAtomically(target, "next\n");
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(AtomicWriteFailure);
      expect(readFileSync(target, "utf8")).toBe("canonical\n");
      expect(existsSync(`${target}.writing`)).toBe(false);
      expect(readFileSync((failure as AtomicWriteFailure).recoveryEvidencePath, "utf8")).toBe(
        "interrupted state\n",
      );
      replaceStateFileAtomically(target, "next\n");
      expect(readFileSync(target, "utf8")).toBe("next\n");
    } finally {
      cleanup();
    }
  });

  test("a second recovery keeps both pieces of evidence and the old-or-new guarantee", () => {
    const { root, cleanup } = scratch();
    try {
      const target = join(root, "chapter.md");
      writeFileSync(target, "canonical\n");
      writeFileSync(`${target}.writing`, "first interrupted candidate\n");

      expect(() =>
        replaceFileAtomically(target, "second interrupted candidate\n", (checkpoint) => {
          if (checkpoint === ("written" satisfies AtomicWriteCheckpoint))
            throw new Error("stop the recovered write");
        }),
      ).toThrow("stop the recovered write");

      expect(ownsInterruptedWrite(target)).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("canonical\n");
      expect(readFileSync(`${target}.writing`, "utf8")).toBe("second interrupted candidate\n");
      const firstEvidence = evidencePaths(root, target);
      expect(firstEvidence).toHaveLength(1);
      expect(readFileSync(firstEvidence[0] ?? "", "utf8")).toBe("first interrupted candidate\n");

      const result = replaceFileAtomically(target, "final\n");
      const allEvidence = evidencePaths(root, target);

      expect(allEvidence).toHaveLength(2);
      expect(new Set(allEvidence.map((path) => readFileSync(path, "utf8")))).toEqual(
        new Set(["first interrupted candidate\n", "second interrupted candidate\n"]),
      );
      expect(result as unknown).toEqual({
        recoveryEvidencePath: allEvidence.find((path) => !firstEvidence.includes(path)),
      });
      expect(readFileSync(firstEvidence[0] ?? "", "utf8")).toBe("first interrupted candidate\n");
      expect(readFileSync(target, "utf8")).toBe("final\n");
      expect(existsSync(`${target}.writing`)).toBe(false);
    } finally {
      cleanup();
    }
  });
});
