import { expect, test } from "bun:test";
import {
  CAPABILITY_TYPED_REQUESTS,
  HEALTH_API_VERSION,
  HEALTH_COMMAND,
  HEALTH_ERROR_PROTOCOL_MISMATCH,
  healthErrorCode,
  healthRequest,
  isHealthResponse,
  PROTOCOL_VERSION,
} from "./protocol.ts";

test("generated health codec separates success, typed failure, and corrupt bytes", () => {
  const request = healthRequest();
  expect(request.length).toBe(8);
  expect(request[4]).toBe(PROTOCOL_VERSION);
  expect(request[6]).toBe(HEALTH_COMMAND);

  const response = new Uint8Array(16);
  response.set(request);
  response[10] = 1;
  response[12] = 1;
  expect(isHealthResponse(response)).toBe(true);
  expect(healthErrorCode(response)).toBe(0);
  expect(PROTOCOL_VERSION).toBe(1);
  expect(HEALTH_API_VERSION).toBe(1);
  expect(CAPABILITY_TYPED_REQUESTS).toBe(1);

  response[8] = HEALTH_ERROR_PROTOCOL_MISMATCH;
  response[10] = 0;
  response[12] = 0;
  expect(isHealthResponse(response)).toBe(false);
  expect(healthErrorCode(response)).toBe(HEALTH_ERROR_PROTOCOL_MISMATCH);

  response[8] = 0;
  response[9] = 1;
  expect(healthErrorCode(response)).toBe(256);

  response[0] = 0;
  expect(healthErrorCode(response)).toBe(0);
});
