import { asciiBytes, Cmd } from "@native-sdk/core";
import {
  CAPABILITY_TYPED_REQUESTS,
  HEALTH_API_VERSION,
  HEALTH_ERROR_INVALID_REQUEST,
  HEALTH_ERROR_PROTOCOL_MISMATCH,
  HEALTH_ERROR_UNKNOWN_REQUEST,
  healthErrorCode,
  healthRequest,
  isHealthResponse,
  PROTOCOL_VERSION,
} from "./generated/protocol.ts";

export interface Model {
  readonly hostReady: boolean;
  readonly status: Uint8Array;
  readonly protocolVersion: number;
  readonly apiVersion: number;
  readonly capabilities: number;
}

export type Msg =
  | { readonly kind: "check_health" }
  | { readonly kind: "health_ok"; readonly bytes: Uint8Array }
  | { readonly kind: "health_err"; readonly bytes: Uint8Array };

export const viewUnbound = ["health_ok", "health_err"] as const;

function checkingModel(): Model {
  return {
    hostReady: false,
    status: asciiBytes("Checking the typed Rust boundary..."),
    protocolVersion: 0,
    apiVersion: 0,
    capabilities: 0,
  };
}

export function initialModel(): [Model, Cmd<Msg>] {
  const model = checkingModel();
  return [
    model,
    Cmd.request(/* @generated:host-service */ "refrain.host", healthRequest(), {
      key: "native-health",
      ok: "health_ok",
      err: "health_err",
    }),
  ];
}

export function update(model: Model, msg: Msg): Model | [Model, Cmd<Msg>] {
  switch (msg.kind) {
    case "check_health":
      return [
        { ...model, hostReady: false, status: asciiBytes("Checking the typed Rust boundary...") },
        Cmd.request(/* @generated:host-service */ "refrain.host", healthRequest(), {
          key: "native-health",
          ok: "health_ok",
          err: "health_err",
        }),
      ];
    case "health_ok":
      if (!isHealthResponse(msg.bytes)) {
        return {
          ...model,
          hostReady: false,
          status: asciiBytes("Native host returned an invalid contract."),
        };
      }
      return {
        hostReady: true,
        status: asciiBytes("Rust -> C ABI -> Zig -> Native core is connected."),
        protocolVersion: PROTOCOL_VERSION,
        apiVersion: HEALTH_API_VERSION,
        capabilities: CAPABILITY_TYPED_REQUESTS,
      };
    case "health_err": {
      const code = healthErrorCode(msg.bytes);
      if (code === HEALTH_ERROR_PROTOCOL_MISMATCH) {
        return { ...model, hostReady: false, status: asciiBytes("Native protocol mismatch.") };
      }
      if (code === HEALTH_ERROR_INVALID_REQUEST) {
        return {
          ...model,
          hostReady: false,
          status: asciiBytes("Native health request was invalid."),
        };
      }
      if (code === HEALTH_ERROR_UNKNOWN_REQUEST) {
        return {
          ...model,
          hostReady: false,
          status: asciiBytes("Native host request was unknown."),
        };
      }
      return { ...model, hostReady: false, status: asciiBytes("Native host request failed.") };
    }
  }
}
