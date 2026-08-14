#!/usr/bin/env bun
/**
 * 主题的真像素验收。
 *
 * **接上哪个功能**：步骤 6 的「真像素验收」判据。源码、token 与文本快照都不能
 * 单独证明视觉质量——只有从真实产品路径渲染出来的像素能。
 *
 * **在全局逻辑中负责什么**：起真窗口、逐套主题截图、把 PNG 交给 KL9。
 * 它断言**可机检的事实**（窗口真的起来了、每套都产出了非空像素、纸面色与色表
 * 一致），不断言好不好看——那是 KL9 的裁定。
 *
 * **能复用什么**：spawn → 等 automation 就绪 → automate 的顺序与
 * `native-document-runtime-evidence.ts` 相同；主题表从 `generated/themes.zig`
 * 读，不在这里复述任何色值。
 *
 * 用法：
 *
 *     bun scripts/verify-native-theme-pixels.ts [--out <dir>] [--display :100]
 *
 * Linux 上 `app.zon` 的 `gpu_backend` 写死 `metal`，直接启动会以
 * `UnsupportedViewKind` 退出。脚本临时改成 `software` 并在结束时**无条件**还原
 * ——三平台 manifest 的条件化属于步骤 9，这里不擅自改产品配置。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const root = process.cwd();
const nativeDir = join(root, "apps/native");
const manifestPath = join(nativeDir, "app.zon");
const nativeCli = join(nativeDir, "node_modules/.bin/native");
// 发布物在 Windows 上叫 `refrain.exe`。少了这个后缀，这道门禁在
// **唯一的发布平台**上永远停在「no executable」——像素证据因此只在 Linux
// 取得过，而产品从 Windows 发出去。命名规则与 `release-assets.test.ts` 同源。
const executable = join(
  nativeDir,
  process.platform === "win32" ? "zig-out/bin/refrain.exe" : "zig-out/bin/refrain",
);
const automationDir = join(nativeDir, ".zig-cache/native-sdk-automation");

const flag = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};
const outDir = flag("--out", "/tmp/refrain-theme-pixels");
const display = flag("--display", process.env.DISPLAY ?? ":100");

/** 主题表与 `generated/themes.zig` 同源：套数、顺序、纸面色都从那里读。 */
const table = readFileSync(join(nativeDir, "src/generated/themes.zig"), "utf8");
const slugs = [...table.matchAll(/^\s{8}\.slug = "([a-z]+)",$/gmu)].map((m) => m[1] ?? "");
if (slugs.length === 0) {
  console.error("FAIL  verify:native-theme-pixels: the generated table declares no theme");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const manifestBefore = readFileSync(manifestPath, "utf8");
let restored = false;
const restoreManifest = () => {
  if (restored) return;
  writeFileSync(manifestPath, manifestBefore, "utf8");
  restored = true;
};
process.on("exit", restoreManifest);
process.on("SIGINT", () => {
  restoreManifest();
  process.exit(130);
});

/**
 * PNG 左上角那个像素的十六进制色。
 *
 * 自己解而不是拉一个图像库：只需要第一行第一个像素，而这道验收的全部意义就是
 * 「屏幕上真的是这个颜色」——多一层依赖就多一处可能骗过自己的地方。
 * 只认 RGBA8（color type 6），SDK 的截图就是这一种；换了格式应当报错而不是
 * 猜一个值出来。
 */
const topLeftPixel = (path: string): string => {
  const png = readFileSync(path);
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} is not a PNG`);
  let offset = 8;
  let width = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (colorType !== 6) throw new Error(`${path} has colour type ${colorType}, expected 6 (RGBA8)`);
  if (width === 0) throw new Error(`${path} declares no width`);
  const raw = inflateSync(Buffer.concat(idat));
  // 第一行：一个 filter byte 之后就是像素。第一行的首像素在任何 filter 下都
  // 是恒等的——左侧与上方都不存在参考像素。
  const r = raw[1] ?? 0;
  const g = raw[2] ?? 0;
  const b = raw[3] ?? 0;
  return [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
};

writeFileSync(
  manifestPath,
  manifestBefore.replace('.gpu_backend = "metal"', '.gpu_backend = "software"'),
  "utf8",
);

// 真窗口构建：不能用 `build:null`，Null platform 没有 GPU 视图，
// 启动会以 `UnsupportedViewKind` 退出。`-Dautomation=true` 开的是
// automate 通道，截图要靠它。
const build = spawnSync(nativeCli, ["build", ".", "--yes", "-Dautomation=true"], {
  cwd: nativeDir,
  encoding: "utf8",
  env: { ...process.env, DISPLAY: display },
});
if (build.status !== 0) {
  console.error("FAIL  verify:native-theme-pixels: the build failed");
  console.error(`      ${(build.stderr ?? "").trim().split("\n").slice(-6).join("\n      ")}`);
  process.exit(1);
}
if (!existsSync(executable)) {
  console.error(`FAIL  verify:native-theme-pixels: no executable at ${executable}`);
  process.exit(1);
}

rmSync(automationDir, { force: true, recursive: true });
const runtime = Bun.spawn([executable], {
  cwd: nativeDir,
  env: {
    ...process.env,
    DISPLAY: display,
    // 无项目时开合成语料：这里验收的是主题像素，不是文档来源。
    REFRAIN_NATIVE_SCALE_FIXTURE: "1",
  },
  stdout: "ignore",
  stderr: "pipe",
});

const shots: string[] = [];
try {
  // 等 automation publisher 就绪，与 runtime-evidence 同一约定。
  const deadline = Bun.nanoseconds() + 30_000_000_000;
  let ready = false;
  while (Bun.nanoseconds() < deadline) {
    if (runtime.exitCode !== null) {
      throw new Error(`the runtime exited with ${runtime.exitCode} before publishing automation`);
    }
    const probe = spawnSync(nativeCli, ["automate", "snapshot"], {
      cwd: nativeDir,
      encoding: "utf8",
      env: { ...process.env, DISPLAY: display },
    });
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await Bun.sleep(250);
  }
  if (!ready) throw new Error("the automation publisher never became ready");

  /**
   * 换一套主题。
   *
   * 走 `theme.next` 这条**命令**，不去屏幕上找按钮。两个理由：一是命令空间
   * （W1）本来就是菜单与键位共用的那条路，门禁走它就与作者真正按下
   * Ctrl+Shift+T 时同一条链；二是原来那个写死的正则 `name="Theme"` 在一个
   * 中文界面里永远匹配不上，而它又正好只在 Windows 上被触发（另一个
   * 后缀 bug 先把这道门禁拦在了更早的一步）。
   */
  const nextTheme = () =>
    spawnSync(nativeCli, ["automate", "shortcut", "theme.next"], {
      cwd: nativeDir,
      encoding: "utf8",
      env: { ...process.env, DISPLAY: display },
    });

  /** 不再使用：保留定位能力供诊断。 */
  const themeButtonId = (): string => {
    const probe = spawnSync(nativeCli, ["automate", "snapshot"], {
      cwd: nativeDir,
      encoding: "utf8",
      env: { ...process.env, DISPLAY: display },
    });
    if (probe.status !== 0) throw new Error("could not take a snapshot to find the Theme button");
    const text = readFileSync(join(automationDir, "snapshot.txt"), "utf8");
    const id = text.match(/#(\d+) role=button name="Theme"/u)?.[1];
    if (id === undefined) throw new Error("no Theme button in the snapshot");
    return id;
  };

  /** 色表里每套的纸色，与 CSS 同源；用来对拍屏幕上真的画了这一套。 */
  const papers = [...table.matchAll(/\.background = Color\.rgb8\((\d+), (\d+), (\d+)\)/gu)].map(
    (m) =>
      [Number(m[1]), Number(m[2]), Number(m[3])]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join(""),
  );
  if (papers.length !== slugs.length) {
    throw new Error(`read ${slugs.length} slugs but ${papers.length} paper colours`);
  }

  void themeButtonId;

  const shoot = (): string => {
    const shot = spawnSync(nativeCli, ["automate", "screenshot", "document", "1"], {
      cwd: nativeDir,
      encoding: "utf8",
      env: { ...process.env, DISPLAY: display },
    });
    if (shot.status !== 0) {
      throw new Error(
        `screenshot failed: ${(shot.stderr ?? "").trim().split("\n").slice(-3).join(" ")}`,
      );
    }
    return join(automationDir, "screenshot-document.png");
  };

  const seen = new Set<string>();
  for (const [index, slug] of slugs.entries()) {
    const expected = papers[index] ?? "";

    // **判据是 PNG 里的像素，不是 snapshot 的 gpu_sample。**
    //
    // 两者不同步：采样先于画布内容更新一帧，按采样确认再截图会截到上一套的
    // 图——第一版就是这样，七张图整体错位一位而每一步的数字看起来都对。
    // 所以这里反过来：先截图，再读 PNG 左上角那个像素，它就是这一帧真正画出
    // 来的纸色。视觉审核当场发现了那次错位，机器读数没有。
    let painted = "";
    const settle = Bun.nanoseconds() + 40_000_000_000;
    let produced = shoot();
    painted = topLeftPixel(produced);
    while (painted !== expected && Bun.nanoseconds() < settle) {
      if (index > 0) nextTheme();
      await Bun.sleep(400);
      produced = shoot();
      painted = topLeftPixel(produced);
    }
    if (painted !== expected) {
      throw new Error(`${slug} painted #${painted} but the table says #${expected}`);
    }
    if (seen.has(painted)) throw new Error(`${slug} repeated an earlier theme's paper #${painted}`);
    seen.add(painted);

    const bytes = readFileSync(produced);
    // 非空像素：一张全 0 的 PNG 会压得极小，那说明画布没画上去。
    if (bytes.length < 1024) throw new Error(`${slug} rendered only ${bytes.length} bytes`);

    const target = join(outDir, `${index}-${slug}.png`);
    writeFileSync(target, bytes);
    shots.push(target);
    console.log(`  ${slug}  #${painted}  ${bytes.length} bytes  →  ${target}`);
  }
} catch (error) {
  console.error(
    `FAIL  verify:native-theme-pixels: ${error instanceof Error ? error.message : error}`,
  );
  if (runtime.exitCode === null) runtime.kill();
  process.exit(1);
} finally {
  if (runtime.exitCode === null) runtime.kill();
  await runtime.exited;
}

// 平台写进结论里：像素是在哪台机器上画出来的就只能代表哪台。
// 旧文案只印 DISPLAY，而 DISPLAY 在 Windows 上是一个没有含义的字串（":100"），
// 于是一份 Windows 证据读起来像一份 X11 证据。
const where = process.platform === "win32" ? "windows" : `${process.platform} ${display}`;
console.log(
  `PASS  verify:native-theme-pixels  (${shots.length} themes rendered through the real window on ${where})`,
);
