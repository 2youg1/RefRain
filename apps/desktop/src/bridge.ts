/**
 * The typed-error envelope generated bindings return (INV-15: the interface
 * renders codes, it never parses prose). `unwrap` restores the try/catch
 * shape at exactly the call sites, and `describe` is the one place a
 * RefrainError becomes a sentence.
 */
import type { RefrainError } from "./generated/bindings.gen";

type Envelope<T> = { status: "ok"; data: T } | { status: "error"; error: RefrainError };

export async function unwrap<T>(envelope: Promise<Envelope<T>>): Promise<T> {
  const result = await envelope;
  if (result.status === "error") throw result.error;
  return result.data;
}

export function describe(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const failure = error as RefrainError;
    return `${failure.action}：${failure.subject}（${failure.code}）`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 桥的第二条路：原件字节。
 *
 * 生成绑定走 JSON，字节只能表示成 `number[]`——128 MiB 的原件要先序列化成
 * 十进制文本再逐元素重建，至少 4.57× 内存放大（F-10）。所以字节走进程内注册的
 * `refrain-artifact://`，由 Rust 在同一进程里应答，交回 `ArrayBuffer`。
 *
 * 这个函数存在，是为了让「桥怎么取字节」在整个前端只有一处实现。传入的是
 * 三个标识符，不是 URL：调用方拼不出别的地址，也就无法把这条路径变成一个
 * 通用的请求出口。`verify:no-network` 断言的正是这一点——除本文件外，
 * 全部前端源码不得出现任何请求原语。
 *
 * `null` 是一个值，不是错误：早于 schema v10 导入的 ARTIFACT，或克隆件已被
 * 移走。调用方显示手上已有的文本。
 */
export async function readArtifactBytes(
  rootId: string,
  digest: string,
  format: string,
): Promise<Uint8Array | null> {
  const response = await globalThis.fetch(`refrain-artifact://${rootId}/${digest}.${format}`);
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}
