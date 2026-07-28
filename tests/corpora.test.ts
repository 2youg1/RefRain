import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import manifest from "./corpora/manifest.json" with { type: "json" };

/*
 * INV-5's frozen evidence.
 *
 * `verify:roundtrip` checks these digests as a gate. This checks them as a
 * test, and adds the part a digest cannot express: that the corpus still
 * contains the shapes it was cut to carry. A file can hash correctly and still
 * have been replaced wholesale by something that hashes to its own content.
 */
describe("frozen corpora", () => {
  test("the manifest lists twenty shapes", () => {
    expect(manifest.corpora).toHaveLength(20);
  });

  test.each(manifest.corpora)("$name matches its recorded digest", async (entry) => {
    const bytes = Buffer.from(await Bun.file(`tests/corpora/${entry.file}`).arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    expect(bytes.length).toBe(entry.bytes);
  });

  /*
   * The shapes themselves. Each of these is a byte sequence that damaged, or
   * could damage, an author's file — and each is invisible to a digest check,
   * because a digest only proves the file did not change, not that it is still
   * about anything.
   */
  test("a corpus carries CRLF line endings", async () => {
    const text = await Bun.file("tests/corpora/crlf.md").text();
    expect(text).toContain("\r\n");
  });

  /*
   * Read as bytes, not as text. `Bun.file(…).text()` strips a leading BOM
   * silently — the exact class of loss INV-5 exists to prevent, occurring in
   * the read API rather than in the serialiser. Any code that loads a
   * manuscript through `.text()` has already lost this corpus's first three
   * bytes before the parser sees them.
   */
  test("a corpus opens with a byte-order mark", async () => {
    const bytes = Buffer.from(await Bun.file("tests/corpora/byte-order-mark.md").arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  test("a corpus opens paragraphs with an ideographic space", async () => {
    const text = await Bun.file("tests/corpora/ideographic-indent.md").text();
    expect(text).toContain("\u3000\u3000");
  });

  test("a corpus ends without a final newline", async () => {
    const text = await Bun.file("tests/corpora/no-trailing-newline.md").text();
    expect(text.endsWith("\n")).toBe(false);
  });

  test("a corpus is empty", async () => {
    expect(await Bun.file("tests/corpora/empty-file.md").text()).toBe("");
  });

  test("a corpus holds a blank line inside a fence", async () => {
    const text = await Bun.file("tests/corpora/fence-holding-a-blank-line.md").text();
    expect(text).toMatch(/```ts\n[\s\S]*\n\n[\s\S]*\n```/);
  });
});
