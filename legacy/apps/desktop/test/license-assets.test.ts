import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const desktop = join(here, "..");
const root = join(desktop, "..", "..");
const fonts = join(desktop, "src", "renderer", "fonts");
const read = (path: string): string => readFileSync(path, "utf8");

const FACES = {
  "AnticDidone.woff2": {
    sha256: "6ec05ca266efd4e02c16283152558d12ab2ba294335369dd105992d1b0ddcce3",
    notice:
      "Copyright (c) 2011, Santiago Orozco (hi@typemade.mx), with Reserved Font Name Antic Didone.",
  },
  "ChironSungHK.woff2": {
    sha256: "fcf59f48407340c60032b2d172cf25c20bcd59b766e77d8358fafb57ef08f375",
    notice: "© 2017-2024 Adobe (http://www.adobe.com/).",
  },
  "CourierPrime.woff2": {
    sha256: "379e072a845ea9bb657502382f110855504178042b0800225b761a7c9f9dd048",
    notice:
      "Copyright 2015 The Courier Prime Project Authors (https://github.com/quoteunquoteapps/CourierPrime).",
  },
  "Jost.woff2": {
    sha256: "2db5fae71560203f4e7284897746212335d523c8aa5dff908c1db906ba42e92f",
    notice: "Copyright 2020 The Jost Project Authors (https://github.com/indestructible-type/Jost)",
  },
  "Murecho.woff2": {
    sha256: "f2dcb40f89d648e5bf301bd79d07bb06f5736749748b637f58afbe17e5692c70",
    notice:
      "Copyright 2021 The Murecho Project Authors (https://github.com/positype/Murecho-Project)",
  },
  "NotoSansSC-Regular.woff2": {
    sha256: "dd2a95745b73cfe5e51710e2401d78681ffe2bc9fbd7f5b051c4010b5bc08e75",
    notice: "© 2014-2021 Adobe (http://www.adobe.com/).",
  },
  "ShipporiMincho-Regular.woff2": {
    sha256: "4cdbc80eccf5d2709f9f497d14446e212833f303fbf719dea18d1a2a1da5adc3",
    notice:
      "Copyright 2021 The Shippori Mincho Project Authors (https://github.com/fontdasu/ShipporiMincho)",
  },
  "ZenKakuGothicNew-Regular.woff2": {
    sha256: "a3c02a9ae41b87b1811bc4aef6a1399b7a5c8349c947da1fd81b7671aa67ddc2",
    notice:
      "Copyright 2022 The Zen Project Authors (https://github.com/googlefonts/zen-kakugothic)",
  },
} as const;

const RESOURCES = [
  ["../../LICENSE", "licenses/RefRain-GPL-3.0.txt"],
  ["src/renderer/fonts/OFL-1.1.txt", "licenses/fonts/OFL-1.1.txt"],
  ["src/renderer/fonts/LICENSES.md", "licenses/fonts/ATTRIBUTIONS.md"],
] as const;

test("electron-builder packages the application and font licences as separate resources", () => {
  const config = read(join(desktop, "electron-builder.yml"));
  const start = config.indexOf("extraResources:");
  const end = config.indexOf("\n# The app never", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);

  const extraResources = config.slice(start, end);
  for (const [from, to] of RESOURCES) {
    expect(extraResources).toContain(`  - from: ${from}\n    to: ${to}`);
  }
});

test("the packaged OFL asset is the complete official text rather than a web link", () => {
  const ofl = read(join(fonts, "OFL-1.1.txt"));
  const sha256 = createHash("sha256").update(ofl).digest("hex");

  expect(Buffer.byteLength(ofl)).toBe(4599);
  expect(sha256).toBe("1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e");
  expect(ofl).toContain("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007");
  expect(ofl).toContain("PERMISSION & CONDITIONS");
  expect(ofl).toContain("TERMINATION");
  expect(ofl).toContain("DISCLAIMER");
});

test("every shipped font has its exact embedded copyright notice in the inventory", () => {
  const shipped = readdirSync(fonts)
    .filter((name) => name.endsWith(".woff2"))
    .sort();
  expect(shipped).toEqual(Object.keys(FACES).sort());

  const inventory = read(join(fonts, "LICENSES.md"));
  for (const [file, face] of Object.entries(FACES)) {
    const bytes = readFileSync(join(fonts, file));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(face.sha256);
    expect(inventory).toContain(`\`${file}\``);
    expect(inventory).toContain(face.notice);
  }
});

test("the project GPL remains present and is not presented as the fonts' licence", () => {
  const gpl = read(join(root, "LICENSE"));
  const inventory = read(join(fonts, "LICENSES.md"));

  expect(gpl).toContain("GNU GENERAL PUBLIC LICENSE");
  expect(inventory).toContain("licensed separately from the GPL-3.0-only application code");
  expect(inventory).toContain("each font remains under the SIL Open Font License");
});
