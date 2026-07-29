#!/usr/bin/env bun

export {};

const source = await Bun.file("apps/desktop/src/assets/mark.svg").text();
const compact = await Bun.file("apps/desktop/src/assets/mark-16.svg").text();
const component = await Bun.file("apps/desktop/src/shell/LogoMark.vue").text();
const packager = await Bun.file("scripts/make-app-icon.ts").text();

const geometries = [...source.matchAll(/\sd="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((value): value is string => value !== undefined);
const compactShapes = [...compact.matchAll(/<(?:path|rect)\b/g)];
const failures: string[] = [];

if (geometries.length === 0) failures.push("the mark source has no geometry");
for (const geometry of geometries) {
  if (!component.includes(`d="${geometry}"`)) {
    failures.push(`LogoMark.vue drifted from geometry ${geometry}`);
  }
}
if (compactShapes.length < 4) failures.push("the 16 px mark lost its simplified shapes");
for (const path of ["src/assets/mark.svg", "src/shell/LogoMark.vue"]) {
  if (!packager.includes(path)) failures.push(`the icon generator does not name ${path}`);
}

if (failures.length > 0) {
  console.error("FAIL  verify:logo");
  for (const failure of failures) console.error(`      ${failure}`);
  process.exit(1);
}

console.log(
  `PASS  verify:logo  (${geometries.length} shared paths, ${compactShapes.length} compact shapes, 1 icon generator)`,
);
