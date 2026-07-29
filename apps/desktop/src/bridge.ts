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
