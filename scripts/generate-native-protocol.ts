#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type ErrorCode = {
  readonly name: string;
  readonly code: number;
};

type Command = {
  readonly name: string;
  readonly code: number;
  readonly apiVersion: number;
  readonly capabilities: Readonly<Record<string, number>>;
  readonly errors: readonly ErrorCode[];
};

type Protocol = {
  readonly schemaVersion: number;
  readonly magic: string;
  readonly service: string;
  readonly commands: readonly Command[];
};

type HealthErrors = {
  readonly protocolMismatch: number;
  readonly invalidRequest: number;
  readonly unknownRequest: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function uint(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} must be an integer from 1 through ${max}`);
  }
  return value;
}

function readProtocol(value: unknown): Protocol {
  if (
    !isRecord(value) ||
    typeof value.magic !== "string" ||
    typeof value.service !== "string" ||
    value.service.length === 0 ||
    !Array.isArray(value.commands)
  ) {
    throw new Error("native protocol must declare schemaVersion, magic, service, and commands");
  }
  const commands = value.commands.map((entry: unknown): Command => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      !isRecord(entry.capabilities) ||
      !Array.isArray(entry.errors)
    ) {
      throw new Error(
        "each native protocol command must declare name, code, apiVersion, capabilities, and errors",
      );
    }
    const capabilities: Record<string, number> = {};
    for (const [name, bit] of Object.entries(entry.capabilities)) {
      if (name.length === 0) throw new Error(`command ${entry.name} has an empty capability name`);
      capabilities[name] = uint(bit, `capability ${entry.name}.${name}`, 0xffff_ffff);
    }
    const errors = entry.errors.map((value: unknown): ErrorCode => {
      if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
        throw new Error(`command ${entry.name} has an invalid error`);
      }
      return {
        name: value.name,
        code: uint(value.code, `error ${entry.name}.${value.name}`, 0xffff),
      };
    });
    if (new Set(errors.map((error) => error.name)).size !== errors.length)
      throw new Error(`command ${entry.name} repeats an error name`);
    if (new Set(errors.map((error) => error.code)).size !== errors.length)
      throw new Error(`command ${entry.name} repeats an error code`);
    return {
      name: entry.name,
      code: uint(entry.code, `command ${entry.name} code`, 0xffff),
      apiVersion: uint(entry.apiVersion, `command ${entry.name} apiVersion`, 0xffff),
      capabilities,
      errors,
    };
  });
  if (new Set(commands.map((command) => command.name)).size !== commands.length)
    throw new Error("native protocol repeats a command name");
  if (new Set(commands.map((command) => command.code)).size !== commands.length)
    throw new Error("native protocol repeats a command code");
  return {
    schemaVersion: uint(value.schemaVersion, "native protocol schemaVersion", 0xffff),
    magic: value.magic,
    service: value.service,
    commands,
  };
}

function exactCommand(protocol: Protocol, name: string): Command {
  const matches = protocol.commands.filter((command) => command.name === name);
  if (matches.length !== 1)
    throw new Error(`native protocol must declare exactly one ${name} command`);
  const command = matches[0];
  if (command === undefined) throw new Error(`native protocol command ${name} vanished`);
  return command;
}

function exactCapability(command: Command, name: string): number {
  const bit = command.capabilities[name];
  if (bit === undefined) throw new Error(`native protocol command ${command.name} lacks ${name}`);
  return bit;
}

function exactError(command: Command, name: string): number {
  const matches = command.errors.filter((error) => error.name === name);
  if (matches.length !== 1)
    throw new Error(`command ${command.name} must declare one ${name} error`);
  const error = matches[0];
  if (error === undefined) throw new Error(`command ${command.name} error ${name} vanished`);
  return error.code;
}

function generatedTs(
  protocol: Protocol,
  health: Command,
  magic: readonly number[],
  capability: number,
  errors: HealthErrors,
): string {
  const versionBytes = [protocol.schemaVersion & 0xff, (protocol.schemaVersion >>> 8) & 0xff];
  const commandBytes = [health.code & 0xff, (health.code >>> 8) & 0xff];
  const apiBytes = [health.apiVersion & 0xff, (health.apiVersion >>> 8) & 0xff];
  const capabilityBytes = [
    capability & 0xff,
    (capability >>> 8) & 0xff,
    (capability >>> 16) & 0xff,
    (capability >>> 24) & 0xff,
  ];
  return `// @generated by scripts/generate-native-protocol.ts; do not edit.\n\nexport const HEALTH_SERVICE = ${JSON.stringify(protocol.service)};\nexport const PROTOCOL_VERSION = ${protocol.schemaVersion};\nexport const HEALTH_COMMAND = ${health.code};\nexport const HEALTH_API_VERSION = ${health.apiVersion};\nexport const CAPABILITY_TYPED_REQUESTS = ${capability};\nexport const HEALTH_ERROR_PROTOCOL_MISMATCH = ${errors.protocolMismatch};\nexport const HEALTH_ERROR_INVALID_REQUEST = ${errors.invalidRequest};\nexport const HEALTH_ERROR_UNKNOWN_REQUEST = ${errors.unknownRequest};\n\nexport function healthRequest(): Uint8Array {\n  const bytes = new Uint8Array(8);\n  bytes[0] = ${magic[0]};\n  bytes[1] = ${magic[1]};\n  bytes[2] = ${magic[2]};\n  bytes[3] = ${magic[3]};\n  bytes[4] = ${versionBytes[0]};\n  bytes[5] = ${versionBytes[1]};\n  bytes[6] = ${commandBytes[0]};\n  bytes[7] = ${commandBytes[1]};\n  return bytes;\n}\n\nexport function isHealthResponse(bytes: Uint8Array): boolean {\n  return (\n    bytes.length === 16 &&\n    bytes[0] === ${magic[0]} &&\n    bytes[1] === ${magic[1]} &&\n    bytes[2] === ${magic[2]} &&\n    bytes[3] === ${magic[3]} &&\n    bytes[4] === ${versionBytes[0]} &&\n    bytes[5] === ${versionBytes[1]} &&\n    bytes[6] === ${commandBytes[0]} &&\n    bytes[7] === ${commandBytes[1]} &&\n    bytes[8] === 0 &&\n    bytes[9] === 0 &&\n    bytes[10] === ${apiBytes[0]} &&\n    bytes[11] === ${apiBytes[1]} &&\n    bytes[12] === ${capabilityBytes[0]} &&\n    bytes[13] === ${capabilityBytes[1]} &&\n    bytes[14] === ${capabilityBytes[2]} &&\n    bytes[15] === ${capabilityBytes[3]}\n  );\n}\n\nexport function healthErrorCode(bytes: Uint8Array): number {\n  if (\n    bytes.length !== 16 ||\n    bytes[0] !== ${magic[0]} ||\n    bytes[1] !== ${magic[1]} ||\n    bytes[2] !== ${magic[2]} ||\n    bytes[3] !== ${magic[3]} ||\n    bytes[4] !== ${versionBytes[0]} ||\n    bytes[5] !== ${versionBytes[1]} ||\n    bytes[6] !== ${commandBytes[0]} ||\n    bytes[7] !== ${commandBytes[1]}\n  ) {\n    return 0;\n  }\n  const low: number = bytes[8];\n  const high: number = bytes[9];\n  return low + high * 256;\n}\n`;
}

function generatedZig(
  protocol: Protocol,
  health: Command,
  magic: readonly number[],
  capability: number,
  errors: HealthErrors,
): string {
  return `// @generated by scripts/generate-native-protocol.ts; do not edit.\nconst std = @import("std");\n\npub const health_service = ${JSON.stringify(protocol.service)};\npub const protocol_version: u16 = ${protocol.schemaVersion};\npub const health_command: u16 = ${health.code};\npub const health_api_version: u16 = ${health.apiVersion};\npub const capability_typed_requests: u32 = ${capability};\npub const protocol_magic = [4]u8{ ${magic.join(", ")} };\n\npub const HealthError = enum(u16) {\n    protocol_mismatch = ${errors.protocolMismatch},\n    invalid_request = ${errors.invalidRequest},\n    unknown_request = ${errors.unknownRequest},\n};\n\npub const RefrainNativeHealthResult = extern struct {\n    status: u32,\n    protocol_version: u16,\n    api_version: u16,\n    capabilities: u32,\n};\n\npub fn healthRequest() [8]u8 {\n    var out: [8]u8 = undefined;\n    @memcpy(out[0..4], &protocol_magic);\n    std.mem.writeInt(u16, out[4..6], protocol_version, .little);\n    std.mem.writeInt(u16, out[6..8], health_command, .little);\n    return out;\n}\n\npub fn isHealthRequest(bytes: []const u8) bool {\n    return bytes.len == 8 and std.mem.eql(u8, bytes[0..4], &protocol_magic) and std.mem.readInt(u16, bytes[6..8], .little) == health_command;\n}\n\npub fn healthRequestProtocolVersion(bytes: []const u8) u16 {\n    return if (isHealthRequest(bytes)) std.mem.readInt(u16, bytes[4..6], .little) else 0;\n}\n\npub fn encodeHealthResult(result: RefrainNativeHealthResult) [16]u8 {\n    var out: [16]u8 = undefined;\n    @memcpy(out[0..4], &protocol_magic);\n    std.mem.writeInt(u16, out[4..6], result.protocol_version, .little);\n    std.mem.writeInt(u16, out[6..8], health_command, .little);\n    std.mem.writeInt(u16, out[8..10], @intCast(result.status), .little);\n    std.mem.writeInt(u16, out[10..12], result.api_version, .little);\n    std.mem.writeInt(u32, out[12..16], result.capabilities, .little);\n    return out;\n}\n\npub fn encodeHealthError(value: HealthError) [16]u8 {\n    return encodeHealthResult(.{\n        .status = @intFromEnum(value),\n        .protocol_version = protocol_version,\n        .api_version = 0,\n        .capabilities = 0,\n    });\n}\n\npub fn isHealthResponse(bytes: []const u8) bool {\n    return bytes.len == 16 and std.mem.eql(u8, bytes[0..4], &protocol_magic) and healthProtocolVersion(bytes) == protocol_version and std.mem.readInt(u16, bytes[6..8], .little) == health_command and std.mem.readInt(u16, bytes[8..10], .little) == 0;\n}\n\npub fn healthError(bytes: []const u8) ?HealthError {\n    if (bytes.len != 16 or !std.mem.eql(u8, bytes[0..4], &protocol_magic) or healthProtocolVersion(bytes) != protocol_version or std.mem.readInt(u16, bytes[6..8], .little) != health_command) return null;\n    return switch (std.mem.readInt(u16, bytes[8..10], .little)) {\n        ${errors.protocolMismatch} => .protocol_mismatch,\n        ${errors.invalidRequest} => .invalid_request,\n        ${errors.unknownRequest} => .unknown_request,\n        else => null,\n    };\n}\n\npub fn healthProtocolVersion(bytes: []const u8) u16 {\n    return if (bytes.len == 16) std.mem.readInt(u16, bytes[4..6], .little) else 0;\n}\n\npub fn healthApiVersion(bytes: []const u8) u16 {\n    return if (bytes.len == 16) std.mem.readInt(u16, bytes[10..12], .little) else 0;\n}\n\npub fn healthCapabilities(bytes: []const u8) u32 {\n    return if (bytes.len == 16) std.mem.readInt(u32, bytes[12..16], .little) else 0;\n}\n`;
}

function generatedRust(
  protocol: Protocol,
  health: Command,
  capability: number,
  errors: HealthErrors,
): string {
  return `// @generated by scripts/generate-native-protocol.ts; do not edit.\n\npub const PROTOCOL_VERSION: u16 = ${protocol.schemaVersion};\npub const HEALTH_API_VERSION: u16 = ${health.apiVersion};\npub const CAPABILITY_TYPED_REQUESTS: u32 = ${capability};\npub const HEALTH_ERROR_PROTOCOL_MISMATCH: u32 = ${errors.protocolMismatch};\n\n#[repr(C)]\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub struct RefrainNativeHealth {\n    pub protocol_version: u16,\n    pub api_version: u16,\n    pub capabilities: u32,\n}\n\n#[repr(C)]\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub struct RefrainNativeHealthResult {\n    pub status: u32,\n    pub protocol_version: u16,\n    pub api_version: u16,\n    pub capabilities: u32,\n}\n\npub const fn health() -> RefrainNativeHealth {\n    RefrainNativeHealth {\n        protocol_version: PROTOCOL_VERSION,\n        api_version: HEALTH_API_VERSION,\n        capabilities: CAPABILITY_TYPED_REQUESTS,\n    }\n}\n\npub const fn health_result(status: u32) -> RefrainNativeHealthResult {\n    let health = health();\n    RefrainNativeHealthResult {\n        status,\n        protocol_version: health.protocol_version,\n        api_version: if status == 0 { health.api_version } else { 0 },\n        capabilities: if status == 0 { health.capabilities } else { 0 },\n    }\n}\n`;
}

function generatedHeader(
  protocol: Protocol,
  health: Command,
  capability: number,
  errors: HealthErrors,
): string {
  return `/* @generated by scripts/generate-native-protocol.ts; do not edit. */\n#ifndef REFRAIN_NATIVE_H\n#define REFRAIN_NATIVE_H\n\n#include <stdint.h>\n\n#define REFRAIN_PROTOCOL_VERSION ${protocol.schemaVersion}\n#define REFRAIN_HEALTH_API_VERSION ${health.apiVersion}\n#define REFRAIN_CAPABILITY_TYPED_REQUESTS ${capability}\n#define REFRAIN_HEALTH_ERROR_PROTOCOL_MISMATCH ${errors.protocolMismatch}\n\ntypedef struct RefrainNativeHealthResult {\n  uint32_t status;\n  uint16_t protocol_version;\n  uint16_t api_version;\n  uint32_t capabilities;\n} RefrainNativeHealthResult;\n\nRefrainNativeHealthResult refrain_native_health(uint16_t requested_protocol);\n\n#endif\n`;
}

const root = resolve(import.meta.dir, "..");
const schemaPath = resolve(root, "apps/native/protocol/host.json");
const protocolSource: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
const protocol = readProtocol(protocolSource);
if (protocol.magic.length !== 4 || [...protocol.magic].some((char) => char.charCodeAt(0) > 127)) {
  throw new Error("native protocol magic must be four ASCII bytes");
}
const magic = [...protocol.magic].map((char) => char.charCodeAt(0));
const health = exactCommand(protocol, "health");
const capability = exactCapability(health, "typedRequests");
const errors: HealthErrors = {
  protocolMismatch: exactError(health, "protocolMismatch"),
  invalidRequest: exactError(health, "invalidRequest"),
  unknownRequest: exactError(health, "unknownRequest"),
};
const outputs: Readonly<Record<string, string>> = {
  "apps/native/src/generated/protocol.ts": generatedTs(protocol, health, magic, capability, errors),
  "apps/native/src/generated/protocol.zig": generatedZig(
    protocol,
    health,
    magic,
    capability,
    errors,
  ),
  "apps/native/host/src/protocol.rs": generatedRust(protocol, health, capability, errors),
  "apps/native/host/include/refrain_native.h": generatedHeader(
    protocol,
    health,
    capability,
    errors,
  ),
};

const check = process.argv.includes("--check");
const stale: string[] = [];
for (const [relative, content] of Object.entries(outputs)) {
  const path = resolve(root, relative);
  if (check) {
    let actual = "";
    try {
      actual = readFileSync(path, "utf8");
    } catch {
      stale.push(relative);
      continue;
    }
    if (actual !== content) stale.push(relative);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

// Native SDK 0.7.2's emitter requires Cmd.request's service to be a direct
// string literal (emitter.ts:2380). Keep those literals generated projections
// of host.json rather than a second authority.
const corePath = resolve(root, "apps/native/src/core.ts");
const core = readFileSync(corePath, "utf8");
const serviceProjection = /(Cmd\.request\(\/\* @generated:host-service \*\/ )"[^"]+"/g;
const matches = [...core.matchAll(serviceProjection)];
if (matches.length === 0) throw new Error("native core has no generated host-service projection");
const projectedCore = core.replace(serviceProjection, `$1${JSON.stringify(protocol.service)}`);
if (check) {
  if (projectedCore !== core) stale.push("apps/native/src/core.ts#host-service");
} else if (projectedCore !== core) {
  writeFileSync(corePath, projectedCore);
}

if (stale.length > 0) {
  console.error(`FAIL  native protocol drift: ${stale.join(", ")}`);
  process.exit(1);
}
console.log(
  `${check ? "PASS" : "WROTE"}  native protocol (${Object.keys(outputs).length} generated files)`,
);
