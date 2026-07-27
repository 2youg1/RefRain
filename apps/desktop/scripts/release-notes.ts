/**
 * Release notes for a tag, taken from ROADMAP.md.
 *
 * The notes used to be pasted into release.yml as a literal. Two copies of the
 * same paragraphs meant two places to update and one of them lost: at v0.1.6
 * the workflow still announced "RefRain 0.1.5 is available", because a release
 * is cut by pushing a tag and nothing made the mismatch visible.
 *
 * ROADMAP.md is the single authority. This reads the section for the tag being
 * released and prints it, with the standing caveats appended — those belong to
 * the release channel rather than to the release, so they live here.
 *
 * Usage: bun scripts/release-notes.ts v0.1.6
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: release-notes.ts <tag>   e.g. v0.1.6");
  process.exit(1);
}

const version = tag.replace(/^v/, "");
const desktopPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version?: unknown };
if (desktopPackage.version !== version) {
  console.error(
    `tag ${tag} does not match apps/desktop/package.json version ${String(desktopPackage.version)}`,
  );
  process.exit(1);
}
const roadmap = readFileSync(
  fileURLToPath(new URL("../../../ROADMAP.md", import.meta.url)),
  "utf8",
);

/* The heading for this version, up to the next second-level heading. */
const heading = new RegExp(`^## Shipped — v${version.replace(/\./g, "\\.")}\\s*$`, "m");
const start = roadmap.search(heading);
if (start < 0) {
  console.error(
    `ROADMAP.md has no "## Shipped — v${version}" section.\n` +
      "Write the section before tagging: the release notes are not a second\n" +
      "place to say what shipped.",
  );
  process.exit(1);
}

const body = roadmap.slice(start);
const end = body.search(/\n## /);
const section = (end < 0 ? body : body.slice(0, end)).replace(heading, "").trim();

if (section.length < 200) {
  console.error(`the v${version} section is ${section.length} characters — too thin to publish`);
  process.exit(1);
}

/*
 * Standing caveats. These describe how the release is distributed and what
 * evidence does not exist, which is true of every build until the situation
 * changes — so they are stated once here rather than rewritten per version.
 */
const caveats = `
Open or drop a folder of Markdown files. **Ctrl K** reaches every command;
**Ctrl Enter** enters Zen.

The application makes no network requests, has no accounts, and never merges
agent output without a human click. Token counts show exactly what a harness
reports, and unknown when it reports nothing.

The Windows IME gate (\`e2e/ime\`, Microsoft Pinyin through real \`SendInput\`) has
not been run against this build: it needs a real desktop with an input method
installed, which no hosted runner provides.

This is an unsigned preview release. Windows SmartScreen may therefore ask for
an explicit confirmation.`;

console.log(`RefRain ${version} is available for **Windows x64**.\n\n${section}\n${caveats}`);
