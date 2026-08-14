/**
 * 一个真窗进程，操作系统怎么说它。
 *
 * **接上哪个功能**：原生文档性能证据车道（`run-native-document-performance.ts`
 * 与它调用的两个采集器）。那条车道的每一项断言最终都要问操作系统三件事：
 * 这个 pid 跑的是哪个可执行文件、它现在占多少常驻内存、起一个真窗要哪些
 * 环境变量。
 *
 * **在全局逻辑中负责什么**：把那三个问题的**平台答案**收在一处。此前它们
 * 散在三个脚本里，写法只有 Linux 一种（`/proc/<pid>/exe`、`/proc/<pid>/status`
 * 的 VmRSS、硬要求 `DISPLAY`），于是这条车道在 RefRain **唯一的发布平台**上
 * 一次也没有跑过——与主题像素门禁曾经的同一类缺陷，只是那一处已经修好。
 *
 * **能复用什么**：调用方只说「这个 pid」，不写任何平台分支；新增一个平台
 * 只改这一个文件。可执行文件名的规则与 `release-assets.test.ts`、
 * `verify-native-theme-pixels.ts` 同源。
 */

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * 一份环境。写成普通记录而不是 `NodeJS.ProcessEnv`：本文件被一个 tier A
 * 门禁引用，而 tier A 由 ScriptC 编成原生二进制，那条车道里没有 Node 的
 * 全局类型。形状与 `process.env` 相容，调用方不必换写法。
 */
export type Environment = Record<string, string | undefined>;

/** 这台机器上的常驻内存读数（KiB）。峰值在两个平台上都拿得到。 */
export interface ProcessMemoryKiB {
  readonly rssKiB: number;
  readonly peakKiB: number;
}

/**
 * 构建产物的路径。Windows 上叫 `refrain.exe`——少了这个后缀，任何一道门禁
 * 在发布平台上都停在「no executable」，而看上去只是「没跑」。
 */
export function nativeExecutablePath(nativeDir: string): string {
  return join(
    nativeDir,
    process.platform === "win32" ? "zig-out/bin/refrain.exe" : "zig-out/bin/refrain",
  );
}

/**
 * 真窗需不需要一个 X11 显示。只有 Linux 需要；Windows 与 macOS 的窗口由
 * 系统合成器直接给，`DISPLAY` 在那里是一个没有含义的字串。
 */
export function requiresDisplay(): boolean {
  return process.platform === "linux";
}

/**
 * 起真窗要的环境。Linux 那三个变量（`DISPLAY`／`GDK_BACKEND`／
 * `XDG_RUNTIME_DIR`）只在 Linux 上设：在 Windows 上设它们既无效，又会让
 * 一份 Windows 证据读起来像一份 X11 证据。
 */
export function windowEnvironment(
  base: Readonly<Environment>,
  options: { readonly display: string | undefined; readonly runtimeDir: string | undefined },
): Environment {
  const environment = { ...base };
  if (process.platform !== "linux") return environment;
  if (options.display !== undefined) environment.DISPLAY = options.display;
  environment.GDK_BACKEND = "x11";
  if (options.runtimeDir !== undefined) environment.XDG_RUNTIME_DIR = options.runtimeDir;
  return environment;
}

/** 证据落款里写清楚像素是在哪种窗口上取的。 */
export function windowPlatformLabel(display: string | undefined): string {
  switch (process.platform) {
    case "win32":
      return "windows-desktop-window";
    case "darwin":
      return "macos-desktop-window";
    default:
      return `linux-x11-window${display === undefined ? "" : ` (${display})`}`;
  }
}

/**
 * 这个 pid 真正在跑的可执行文件，按系统自己的记录（不是按我们以为启动了
 * 什么）。这一条是整条车道的身份锚：没有它，报告可以是任何一个进程的。
 */
export function processImagePath(pid: number): string {
  if (process.platform === "linux") return realpathSync(`/proc/${pid}/exe`);
  return realpathSync(windowsProcess(pid).path);
}

/**
 * 这个 pid 的工作目录，拿不到时是 `null`。
 *
 * Linux 从 `/proc/<pid>/cwd` 读。Windows 没有等价的公开通道——工作目录住在
 * 进程的 PEB 里，读它要跨进程内存读取。**报 `null` 而不是猜**：调用方据此
 * 跳过这一条，而不是拿一个编出来的值去比对。身份仍由映像路径与 pid 钉住。
 */
export function processWorkingDirectory(pid: number): string | null {
  if (process.platform === "linux") return realpathSync(`/proc/${pid}/cwd`);
  return null;
}

/**
 * 常驻内存与它的历史峰值（KiB）。
 *
 * Linux 读 `/proc/<pid>/status` 的 `VmRSS`／`VmHWM`。Windows 读
 * `Get-Process` 的 `WorkingSet64`／`PeakWorkingSet64`——工作集就是 Windows
 * 对同一件事的说法。整数直接过来，不经任何按区域设置分节的文本
 * （`tasklist` 的「12,345 K」正是那种会随机器语言变的读数）。
 */
export function processMemoryKiB(pid: number): ProcessMemoryKiB {
  if (process.platform === "linux") {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return {
      rssKiB: kilobytes(status, /^VmRSS:\s+([0-9]+)\s+kB$/m, pid, "VmRSS"),
      peakKiB: kilobytes(status, /^VmHWM:\s+([0-9]+)\s+kB$/m, pid, "VmHWM"),
    };
  }
  const observed = windowsProcess(pid);
  return {
    rssKiB: Math.round(observed.workingSet / 1024),
    peakKiB: Math.round(observed.peakWorkingSet / 1024),
  };
}

interface WindowsProcess {
  readonly path: string;
  readonly workingSet: number;
  readonly peakWorkingSet: number;
}

/**
 * 一次 PowerShell 往返取回身份与内存两件事。合成一次而不是两次：这条
 * 采集器在每个样本上都要跑，而进程创建是这套读数里最贵的一步。
 */
function windowsProcess(pid: number): WindowsProcess {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction Stop; ` +
        "[pscustomobject]@{ path = $p.Path; workingSet = $p.WorkingSet64; peakWorkingSet = $p.PeakWorkingSet64 } | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `Get-Process ${pid} failed (${result.status}): ${(result.stderr ?? "").trim()}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout ?? "");
  } catch (error: unknown) {
    throw new Error(
      `Get-Process ${pid} did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { path: unknown }).path !== "string" ||
    typeof (value as { workingSet: unknown }).workingSet !== "number" ||
    typeof (value as { peakWorkingSet: unknown }).peakWorkingSet !== "number"
  ) {
    throw new Error(`Get-Process ${pid} returned no image path and working set`);
  }
  return value as unknown as WindowsProcess;
}

function kilobytes(status: string, pattern: RegExp, pid: number, label: string): number {
  const value = status.match(pattern)?.[1];
  if (value === undefined) throw new Error(`Native runtime process ${pid} has no ${label}`);
  return Number(value);
}
