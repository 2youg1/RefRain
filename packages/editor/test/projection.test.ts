import { describe, expect, test } from "bun:test";
import type { Block } from "../src/index.ts";
import { applyLocally, PENDING_ID_PREFIX } from "../src/projection.ts";

/*
 * The local projection mirrors settled changes until the domain confirms.
 * Two contracts live here and nowhere else: a replacement keeps the block's
 * shape hints (height prediction and fence highlighting read them), and an
 * insertion's placeholder ids carry the one prefix the view reconciles
 * against the domain's ids on confirmation.
 */
describe("local projection", () => {
  const shaped: Block = {
    id: "01923f4c-7b2a-7000-8000-000000000001",
    text: "```rust\nfn main() {}\n```",
    widthUnits: 40,
    hardLines: 2,
    maxLineUnits: 20,
    isFence: true,
  };

  test("a replacement keeps the block's shape hints", () => {
    const [next] = applyLocally([shaped], [{ kind: "replace", blocks: [shaped.id], text: "改" }]);
    expect(next).toEqual({ ...shaped, text: "改" });
  });

  test("a replacement does not mutate the block it was given", () => {
    applyLocally([shaped], [{ kind: "replace", blocks: [shaped.id], text: "改" }]);
    expect(shaped.text).toBe("```rust\nfn main() {}\n```");
  });

  test("an insertion mints placeholder ids under the one prefix", () => {
    const next = applyLocally([shaped], [{ kind: "insert", before: null, texts: ["新段"] }]);
    const minted = next.at(-1);
    expect(minted?.id.startsWith(PENDING_ID_PREFIX)).toBe(true);
    expect(minted?.text).toBe("新段");
  });
});
