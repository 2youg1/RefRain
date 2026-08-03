import { expect, test } from "bun:test";
import * as protocol from "./protocol.ts";
import {
  API_VERSION,
  CAPABILITY_MASK,
  dispatchResponseAction,
  dispatchResponseApiVersion,
  dispatchResponseBlockCount,
  dispatchResponseCapabilities,
  dispatchResponseFirstBlock,
  dispatchResponseRevision,
  dispatchResponseSession,
  dispatchResponseStatus,
  dispatchResponseText,
  dispatchResponseTotalBlocks,
  dispatchResponseTotalBytes,
  dispatchResponseWindowStart,
  ERROR_STALE_REVISION,
  isDispatchResponse,
  PROTOCOL_FINGERPRINT,
  PROTOCOL_VERSION,
  VIRTUAL_BLOCK_HEIGHT,
} from "./protocol.ts";

const MAGIC = new Uint8Array([82, 70, 82, 78]);

test("generated protocol owns layout and errors, not product actions or request transport", () => {
  expect(VIRTUAL_BLOCK_HEIGHT).toBe(36);
  expect("encodeDispatchRequest" in protocol).toBe(false);
  expect(
    Object.keys(protocol).some((name) => name.startsWith("ACTION_") || name.startsWith("INPUT_")),
  ).toBe(false);
});

test("generated response codec exposes projection metadata and typed failure", () => {
  const response = responseBytes(105, ERROR_STALE_REVISION);
  writeU16(response, 12, API_VERSION);
  writeU32(response, 16, CAPABILITY_MASK);
  writeU32(response, 20, 23);
  writeU32(response, 24, 9);
  writeU32(response, 28, 11_953_766);
  writeU32(response, 32, 100_000);
  writeU32(response, 36, 5_976_883);
  writeU32(response, 40, 50_000);
  writeU32(response, 44, 96);

  expect(isDispatchResponse(response)).toBe(true);
  expect(dispatchResponseAction(response)).toBe(105);
  expect(dispatchResponseStatus(response)).toBe(ERROR_STALE_REVISION);
  expect(dispatchResponseApiVersion(response)).toBe(API_VERSION);
  expect(dispatchResponseCapabilities(response)).toBe(CAPABILITY_MASK);
  expect(dispatchResponseSession(response)).toBe(23);
  expect(dispatchResponseRevision(response)).toBe(9);
  expect(dispatchResponseTotalBytes(response)).toBe(11_953_766);
  expect(dispatchResponseTotalBlocks(response)).toBe(100_000);
  expect(dispatchResponseWindowStart(response)).toBe(5_976_883);
  expect(dispatchResponseFirstBlock(response)).toBe(50_000);
  expect(dispatchResponseBlockCount(response)).toBe(96);

  response[0] = 0;
  expect(isDispatchResponse(response)).toBe(false);
  expect(dispatchResponseStatus(response)).toBe(0);
});

test("generated response codec carries a bounded opaque use-case payload", () => {
  const response = new Uint8Array(54);
  response.set(MAGIC, 0);
  writeU16(response, 4, PROTOCOL_VERSION);
  writeU16(response, 6, 106);
  writeU32(response, 48, 2);
  response[52] = 123;
  response[53] = 125;

  expect(isDispatchResponse(response)).toBe(true);
  expect(dispatchResponseText(response)).toEqual(new Uint8Array([123, 125]));

  writeU32(response, 48, 3);
  expect(isDispatchResponse(response)).toBe(false);
  expect(dispatchResponseText(response)).toEqual(new Uint8Array(0));
});

test("protocol fingerprint is a generated SHA-256 identity", () => {
  expect(PROTOCOL_VERSION).toBe(2);
  expect(PROTOCOL_FINGERPRINT.length).toBe(64);
  expect(/^[0-9a-f]+$/.test(PROTOCOL_FINGERPRINT)).toBe(true);
});

function responseBytes(action: number, status: number): Uint8Array {
  const response = new Uint8Array(52);
  response.set(MAGIC, 0);
  writeU16(response, 4, PROTOCOL_VERSION);
  writeU16(response, 6, action);
  writeU32(response, 8, status);
  return response;
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
