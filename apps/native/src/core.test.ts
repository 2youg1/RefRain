import { expect, test } from "bun:test";
import type { ScrollState } from "@native-sdk/core/events";
import { type Model, update } from "./core.ts";
import { ERROR_UNKNOWN_SESSION, PROTOCOL_VERSION } from "./generated/protocol.ts";

const decoder = new TextDecoder();
const model: Model = {
  hostReady: true,
  status: new Uint8Array(0),
  protocolVersion: PROTOCOL_VERSION,
  documentSession: 7,
  documentRevision: 4,
  documentBytes: 11_953_418,
  documentBlocks: 99_997,
  documentScroll: 0,
  viewportFirstBlock: 0,
  projectionWindowStart: 0,
  projectResult: new Uint8Array(0),
};

test("undo enters the one host dispatch without optimistic document state", () => {
  const result = update(model, { kind: "document_undo" });
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) throw new Error("document undo did not return an effect");
  expect(result[0]).toBe(model);
});

test("text input enters the host dispatch without a TypeScript body copy", () => {
  const text = new TextEncoder().encode("確定入力");
  const result = update(model, {
    kind: "document_input",
    event: { kind: "set_composition", text, cursor: text.length },
  });
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) throw new Error("composition did not return an effect");
  expect(result[0]).toBe(model);
  expect(Object.keys(result[0])).not.toContain("text");
  expect(Object.keys(result[0])).not.toContain("selection");
  expect(Object.keys(result[0])).not.toContain("composition");
});

test("scroll sends the real offset without optimistic viewport authority", () => {
  const offsetY = 1_799_675;
  const result = update(
    { ...model, documentBlocks: 100_000 },
    { kind: "document_scroll", scroll: scroll(offsetY, 650, 3_600_000) },
  );
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) throw new Error("document scroll did not return an effect");
  expect(result[0].documentScroll).toBe(offsetY);
  expect(result[0].viewportFirstBlock).toBe(0);
  const command = result[1];
  if (command.op !== "request") throw new Error("document scroll did not issue the host request");
  expect(readF64(command.payload, 64)).toBe(offsetY);
});

test("the host projection response supplies the authoritative first block", () => {
  const response = responseBytes(104, 0);
  writeU32(response, 20, model.documentSession);
  writeU32(response, 24, model.documentRevision);
  writeU32(response, 28, 11_953_766);
  writeU32(response, 32, 100_000);
  writeU32(response, 36, 5_976_883);
  writeU32(response, 40, 50_000);
  const result = update(model, { kind: "dispatch_ok", bytes: response });
  if (Array.isArray(result)) throw new Error("projection response unexpectedly returned an effect");
  expect(result.viewportFirstBlock).toBe(50_000);
  expect(result.projectionWindowStart).toBe(5_976_883);
});

test("one opaque Project input enters one group dispatch", () => {
  const input = new TextEncoder().encode('{"kind":"chooseAndAdoptRoot","value":{"kind":"folder"}}');
  const result = update(model, { kind: "project_request", input });
  expect(Array.isArray(result)).toBe(true);
  if (!Array.isArray(result)) throw new Error("project input did not return an effect");
  expect(result[0]).toBe(model);
  if (result[1].op !== "request") throw new Error("project input did not issue the host request");
  expect(readF64(result[1].payload, 0)).toBe(106);
  expect(result[1].payload.slice(84, 84 + input.length)).toEqual(input);
});

test("one Project response remains an immutable Rust projection", () => {
  const payload = new TextEncoder().encode('{"kind":"cancelled"}');
  const result = update(model, { kind: "dispatch_ok", bytes: responseBytes(106, 0, payload) });
  if (Array.isArray(result)) throw new Error("project response unexpectedly returned an effect");
  expect(result.projectResult).toEqual(payload);
  expect(result.documentRevision).toBe(model.documentRevision);
  expect(result.documentBytes).toBe(model.documentBytes);
});

test("typed dispatch failure keeps the Rust boundary visible", () => {
  const response = responseBytes(105, ERROR_UNKNOWN_SESSION);
  const result = update(model, { kind: "dispatch_err", bytes: response });
  if (Array.isArray(result)) throw new Error("dispatch failure returned an effect");
  expect(decoder.decode(result.status)).toBe("Native document session was unknown.");
});

function scroll(offsetY: number, viewportExtentY: number, contentExtentY: number): ScrollState {
  return {
    offsetX: 0,
    offsetY,
    velocityX: 0,
    velocityY: 0,
    viewportExtentX: 1000,
    viewportExtentY,
    contentExtentX: 1000,
    contentExtentY,
  };
}

function responseBytes(
  action: number,
  status: number,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const response = new Uint8Array(52 + payload.length);
  response.set(new Uint8Array([82, 70, 82, 78]), 0);
  writeU16(response, 4, PROTOCOL_VERSION);
  writeU16(response, 6, action);
  writeU32(response, 8, status);
  writeU32(response, 48, payload.length);
  response.set(payload, 52);
  return response;
}

function readF64(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat64(offset, true);
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = Math.floor(value / 256) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  let remaining = value;
  for (let index = 0; index < 4; index += 1) {
    bytes[offset + index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
}
