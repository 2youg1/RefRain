import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface ProtocolError {
  readonly name: string;
  readonly code: number;
}

/** One named wire code shared by TypeScript, Zig, Rust and C. */
type ProtocolCode = ProtocolError;

/**
 * The Native SDK packs a host record as f64 little-endian scalars in field-name
 * order, then the byte array, then any scalar that sorts after it. Declaring the
 * three groups here lets every consumer derive the same offsets.
 */
interface HostRecord {
  readonly scalars: readonly string[];
  readonly bytes: string;
  readonly trailingScalars: readonly string[];
}

interface ProtocolSchema {
  readonly schemaVersion: number;
  readonly magic: string;
  readonly service: string;
  readonly protocolVersion: number;
  readonly apiVersion: number;
  readonly capabilityMask: number;

  readonly layout: {
    readonly projectionBytes: number;
    readonly eventTextBytes: number;
    readonly defaultViewportBlocks: number;
    readonly virtualBlockHeight: number;
    readonly anchorRangeCapacity: number;
  };
  readonly hostRecord: HostRecord;
  readonly actions: readonly ProtocolCode[];
  readonly inputs: readonly ProtocolCode[];
  readonly caretDirections: readonly ProtocolCode[];
  readonly errors: readonly ProtocolError[];

  /** Closed value sets that cross as one byte instead of a word. */
  readonly enums: ReplyEnums;
  /** Fixed-size row shapes a reply's lists are made of. */
  readonly rows: ReplyStructs;
  /** One head shape per `ProjectOutput` variant, keyed by its serde tag. */
  readonly replies: ReplyStructs;
}

/** `[fieldName, type]`; type is `str`, `u32`, `bool`, `rows:<Row>`, or an enum name. */
type ReplyField = readonly [string, string];
type ReplyStructs = Readonly<Record<string, readonly ReplyField[]>>;
type ReplyEnums = Readonly<Record<string, readonly string[]>>;

/** One laid-out member: the generator owns the offsets, both sides read them. */
interface Member {
  readonly name: string;
  readonly type: string;
  readonly bytes: number;
}

const scalarBytes = 8;

/** Byte offset of one leading scalar inside the host record. */
function scalarOffset(record: HostRecord, name: string): number {
  const index = record.scalars.indexOf(name);
  if (index < 0) throw new Error(`host record does not declare scalar ${name}`);
  return index * scalarBytes;
}

/** Byte offset of the length prefix that precedes the record's byte array. */
function bytesLengthOffset(record: HostRecord): number {
  return record.scalars.length * scalarBytes;
}

/** Byte offset where the record's byte array itself starts. */
function bytesOffset(record: HostRecord): number {
  return bytesLengthOffset(record) + 4;
}

/** Trailing scalar offsets are relative to the end of the byte array. */
function trailingOffset(record: HostRecord, name: string): number {
  const index = record.trailingScalars.indexOf(name);
  if (index < 0) throw new Error(`host record does not declare trailing scalar ${name}`);
  return index * scalarBytes;
}

function trailingBytes(record: HostRecord): number {
  return record.trailingScalars.length * scalarBytes;
}

interface Output {
  readonly path: string;
  readonly content: string;
}

const root = resolve(import.meta.dir, "..");
const schemaPath = resolve(root, "apps/native/protocol/host.json");
const raw = readFileSync(schemaPath, "utf8");
const parsed: unknown = JSON.parse(raw);
const schema = protocolSchema(parsed);
const fingerprint = createHash("sha256").update(raw).digest("hex");
const outputs: readonly Output[] = [
  {
    path: resolve(root, "apps/native/host/include/refrain_native.h"),
    content: renderHeader(schema, fingerprint),
  },
  {
    path: resolve(root, "apps/native/host/src/protocol.rs"),
    content: renderRust(schema, fingerprint),
  },
  {
    path: resolve(root, "apps/native/src/generated/protocol.zig"),
    content: renderZig(schema, fingerprint),
  },
  {
    path: resolve(root, "apps/native/src/generated/protocol.ts"),
    content: renderTypeScript(schema, fingerprint),
  },
  {
    path: resolve(root, "apps/native/src/generated/wire.zig"),
    content: renderWireZig(schema, fingerprint),
  },
  {
    path: resolve(root, "apps/native/host/src/wire.rs"),
    content: renderWireRust(schema, fingerprint),
  },
];

const check = process.argv.includes("--check");
let stale = false;
for (const output of outputs) {
  if (check) {
    if (readFileSync(output.path, "utf8") !== output.content) {
      console.error(`stale generated protocol: ${output.path}`);
      stale = true;
    }
  } else {
    writeFileSync(output.path, output.content);
  }
}
if (stale) process.exit(1);

function protocolSchema(value: unknown): ProtocolSchema {
  if (!isRecord(value) || !isRecord(value.layout) || !Array.isArray(value.errors)) {
    throw new Error("native protocol schema must declare layout and errors");
  }
  const layout = value.layout;
  const result: ProtocolSchema = {
    schemaVersion: integer(value.schemaVersion, "schemaVersion"),
    magic: string(value.magic, "magic"),
    service: string(value.service, "service"),
    protocolVersion: integer(value.protocolVersion, "protocolVersion"),
    apiVersion: integer(value.apiVersion, "apiVersion"),
    capabilityMask: integer(value.capabilityMask, "capabilityMask"),

    layout: {
      projectionBytes: integer(layout.projectionBytes, "layout.projectionBytes"),
      eventTextBytes: integer(layout.eventTextBytes, "layout.eventTextBytes"),
      defaultViewportBlocks: integer(layout.defaultViewportBlocks, "layout.defaultViewportBlocks"),
      virtualBlockHeight: integer(layout.virtualBlockHeight, "layout.virtualBlockHeight"),
      anchorRangeCapacity: integer(layout.anchorRangeCapacity, "layout.anchorRangeCapacity"),
    },
    hostRecord: hostRecord(value.hostRecord),
    actions: codes(value.actions, "actions"),
    inputs: codes(value.inputs, "inputs"),
    caretDirections: codes(value.caretDirections, "caretDirections"),
    errors: codes(value.errors, "errors"),
    enums: replyEnums(value.enums),
    rows: replyStructs(value.rows, "rows"),
    replies: replyStructs(value.replies, "replies"),
  };
  if (result.magic.length !== 4) throw new Error("native protocol magic must be four ASCII bytes");
  return result;
}

/**
 * Accept the record only when it matches the SDK's packing rule: every field
 * name sorted, the byte array in its sorted position, trailing scalars after it.
 * A schema that violates this would make every derived offset wrong.
 */
function hostRecord(value: unknown): HostRecord {
  if (!isRecord(value) || !Array.isArray(value.scalars) || !Array.isArray(value.trailingScalars)) {
    throw new Error("hostRecord must declare scalars, bytes and trailingScalars");
  }
  const scalars = value.scalars.map((name: unknown) => string(name, "hostRecord.scalars entry"));
  const trailingScalars = value.trailingScalars.map((name: unknown) =>
    string(name, "hostRecord.trailingScalars entry"),
  );
  const bytes = string(value.bytes, "hostRecord.bytes");
  const ordered = [...scalars, bytes, ...trailingScalars];
  const sorted = [...ordered].sort();
  if (ordered.join("\u0000") !== sorted.join("\u0000")) {
    throw new Error(
      "hostRecord fields must be listed in field-name order; the Native SDK packs them sorted",
    );
  }
  if (new Set(ordered).size !== ordered.length) {
    throw new Error("hostRecord field names must be unique");
  }
  return { scalars, bytes, trailingScalars };
}

function codes(value: unknown, name: string): readonly ProtocolCode[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const parsed: ProtocolCode[] = value.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.code !== "number") {
      throw new Error(`${name} entries require string name and numeric code`);
    }
    return { name: entry.name, code: integer(entry.code, `${name} ${entry.name}`) };
  });
  if (new Set(parsed.map((entry) => entry.code)).size !== parsed.length) {
    throw new Error(`${name} codes must be unique`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function snake(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function upperSnake(name: string): string {
  return snake(name).toUpperCase();
}

function magicBytes(magic: string): string {
  return [...magic].map((character) => character.charCodeAt(0)).join(", ");
}

function renderHeader(schema: ProtocolSchema, hash: string): string {
  const errors = schema.errors
    .map((error) => `#define REFRAIN_ERROR_${upperSnake(error.name)} ${error.code}`)
    .join("\n");
  return `/* @generated by scripts/generate-native-protocol.ts; do not edit. */
#ifndef REFRAIN_NATIVE_H
#define REFRAIN_NATIVE_H
#include <stdint.h>
#define REFRAIN_PROTOCOL_VERSION ${schema.protocolVersion}
#define REFRAIN_API_VERSION ${schema.apiVersion}
#define REFRAIN_CAPABILITY_MASK ${schema.capabilityMask}
#define REFRAIN_PROJECTION_BYTES ${schema.layout.projectionBytes}
#define REFRAIN_EVENT_TEXT_BYTES ${schema.layout.eventTextBytes}
#define REFRAIN_DEFAULT_VIEWPORT_BLOCKS ${schema.layout.defaultViewportBlocks}
#define REFRAIN_VIRTUAL_BLOCK_HEIGHT ${schema.layout.virtualBlockHeight}
#define REFRAIN_ANCHOR_RANGE_CAPACITY ${schema.layout.anchorRangeCapacity}
#define REFRAIN_PROTOCOL_FINGERPRINT "${hash}"
${errors}
typedef struct RefrainNativeRequest {
  uint16_t protocol_version;
  uint16_t action;
  uint16_t input;
  uint16_t flags;
  uint64_t session;
  uint64_t revision;
  uint64_t window_start;
  uint64_t anchor;
  uint64_t focus;
  uint64_t cursor;
  uint64_t viewport_first_block;
  /* Pixel scroll offset; Rust resolves it into a block index. */
  double scroll_offset_y;
  /* 字身 per line, measured from the real font; Rust returns 禁则 breaks. */
  double columns_em;
  uint32_t viewport_block_count;
  uint32_t text_len;
  /* Borrowed for the duration of the call only; the host never stores it. */
  const uint8_t *text;
} RefrainNativeRequest;
/* One anchored range in projection-window byte coordinates: an annotation
   (highlight or comment) or an undecided proposal, resolved by Rust against
   the current manuscript. kind: 1 = highlight, 2 = comment, 3 = proposal.
   Coordinates are u32 because the protocol already caps a document at 4 GiB
   (the overflow rule in encodeDispatchResponse). id is the source's durable
   identity (a 36-byte uuid string): the mark's actions name it. */
typedef struct RefrainNativeAnchorRange {
  uint32_t start;
  uint32_t end;
  uint32_t kind;
  uint8_t id[36];
} RefrainNativeAnchorRange;
typedef struct RefrainNativeResponse {
  uint32_t status;
  uint16_t protocol_version;
  uint16_t api_version;
  uint32_t capabilities;
  uint16_t action;
  uint16_t reserved;
  uint64_t session;
  uint64_t revision;
  uint64_t total_bytes;
  uint64_t total_blocks;
  uint64_t window_start;
  uint64_t first_block;
  uint32_t block_count;
  uint32_t text_len;
  uint32_t composition_len;
  /* Which grammar highlights this document, from Rust's DocumentFormat.
     0 is Markdown prose; the rest follow the enum's declaration order. The
     surface cannot infer it from the bytes: a fenced block inside Markdown
     and a whole .rs file both look like code to a scanner, and only the
     opening path knows which one this is. */
  uint32_t document_format;
  uint64_t selection_anchor;
  uint64_t selection_focus;
  uint64_t composition_start;
  uint64_t composition_end;
  uint64_t document_selection_start;
  uint64_t document_selection_end;
  /* Owned by the Rust session and valid until its next dispatch. */
  const uint8_t *text;
  /* CLREQ line-start offsets into text; same owner, same lifetime. */
  const uint32_t *line_starts;
  uint32_t line_start_count;
  /* Anchored ranges in window coordinates; same owner, same lifetime. */
  const RefrainNativeAnchorRange *anchor_ranges;
  uint32_t anchor_range_count;
} RefrainNativeResponse;
RefrainNativeResponse refrain_native_dispatch(RefrainNativeRequest request);
#endif
`;
}

function renderRust(schema: ProtocolSchema, hash: string): string {
  const errors = schema.errors
    .map((error) => `pub const ERROR_${upperSnake(error.name)}: u32 = ${error.code};`)
    .join("\n");
  return `// @generated by scripts/generate-native-protocol.ts; do not edit.

pub const PROTOCOL_VERSION: u16 = ${schema.protocolVersion};
pub const API_VERSION: u16 = ${schema.apiVersion};
pub const CAPABILITY_MASK: u32 = ${schema.capabilityMask};
pub const PROJECTION_BYTES: usize = ${schema.layout.projectionBytes};
pub const EVENT_TEXT_BYTES: usize = ${schema.layout.eventTextBytes};
pub const DEFAULT_VIEWPORT_BLOCKS: u32 = ${schema.layout.defaultViewportBlocks};
pub const VIRTUAL_BLOCK_HEIGHT: f64 = ${schema.layout.virtualBlockHeight}.0;
pub const ANCHOR_RANGE_CAPACITY: usize = ${schema.layout.anchorRangeCapacity};
#[allow(dead_code)]
pub const PROTOCOL_FINGERPRINT: &str =
    "${hash}";
${errors}
${rustCodes("ACTION", schema.actions)}
${rustCodes("INPUT", schema.inputs)}
${rustCodes("CARET", schema.caretDirections)}
pub const CARET_EXTEND_FLAG: u16 = 0x100;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RefrainNativeRequest {
    pub protocol_version: u16,
    pub action: u16,
    pub input: u16,
    pub flags: u16,
    pub session: u64,
    pub revision: u64,
    pub window_start: u64,
    pub anchor: u64,
    pub focus: u64,
    pub cursor: u64,
    pub viewport_first_block: u64,
    /// Pixel scroll offset. Rust resolves it into a block index because only it
    /// knows the manuscript's block count.
    pub scroll_offset_y: f64,
    /// 字身 per line, measured by the platform from the real font. Rust turns
    /// it into 禁则-correct break offsets; zero means the caller wants no
    /// breaking (a probe, or a viewport with no width yet).
    pub columns_em: f64,
    pub viewport_block_count: u32,
    pub text_len: u32,
    /// Borrowed input bytes, valid only for the duration of one dispatch call.
    /// The host reads them once and never stores the pointer.
    pub text: *const u8,
}

/// One anchored range in projection-window byte coordinates: an annotation
/// (highlight or comment) or an undecided proposal, resolved against the
/// current manuscript. kind: 1 = highlight, 2 = comment, 3 = proposal.
/// Coordinates are u32 because the protocol already caps a document at 4 GiB.
/// id 是来源身份（36 字节 uuid 串）：印点上的动作按它点名。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct AnchorRangeWire {
    pub start: u32,
    pub end: u32,
    pub kind: u32,
    pub id: [u8; 36],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct RefrainNativeResponse {
    pub status: u32,
    pub protocol_version: u16,
    pub api_version: u16,
    pub capabilities: u32,
    pub action: u16,
    pub reserved: u16,
    pub session: u64,
    pub revision: u64,
    pub total_bytes: u64,
    pub total_blocks: u64,
    pub window_start: u64,
    pub first_block: u64,
    pub block_count: u32,
    pub text_len: u32,
    pub composition_len: u32,
    /// Which grammar highlights this document, from DocumentFormat.
    /// The surface cannot infer it from the bytes — a fenced block inside
    /// Markdown and a whole .rs file both scan as code — so the opening
    /// path, which is the only place that knows, sends it across.
    pub document_format: u32,
    pub selection_anchor: u64,
    pub selection_focus: u64,
    pub composition_start: u64,
    pub composition_end: u64,
    pub document_selection_start: u64,
    pub document_selection_end: u64,
    /// Projection bytes owned by the Rust session that produced them. Valid
    /// until that session handles its next dispatch; consumers read, never store.
    pub text: *const u8,
    /// Line-start byte offsets into the projection text, computed under CLREQ
    /// 禁则 by refrain_core::typeset. The SDK cannot wrap Chinese text — its
    /// only break opportunities are space and tab — so the view draws these
    /// rather than wrapping. Borrowed like the text: same owner and lifetime.
    pub line_starts: *const u32,
    pub line_start_count: u32,
    /// Anchored ranges in projection-window byte coordinates (annotations and
    /// undecided proposals), resolved against the current manuscript. Owned by
    /// the session like the text: valid until its next dispatch.
    pub anchor_ranges: *const AnchorRangeWire,
    pub anchor_range_count: u32,
}

impl RefrainNativeResponse {
    pub const fn empty(status: u32, action: u16) -> Self {
        Self {
            status,
            protocol_version: PROTOCOL_VERSION,
            api_version: API_VERSION,
            capabilities: CAPABILITY_MASK,
            action,
            reserved: 0,
            session: 0,
            revision: 0,
            total_bytes: 0,
            total_blocks: 0,
            window_start: 0,
            first_block: 0,
            block_count: 0,
            text_len: 0,
            composition_len: 0,
            document_format: 0,
            selection_anchor: 0,
            selection_focus: 0,
            composition_start: 0,
            composition_end: 0,
            document_selection_start: 0,
            document_selection_end: 0,
            text: std::ptr::null(),
            line_starts: std::ptr::null(),
            line_start_count: 0,
            anchor_ranges: std::ptr::null(),
            anchor_range_count: 0,
        }
    }
}
`;
}

function zigEnum(name: string, codes: readonly ProtocolCode[]): string {
  const members = codes.map((entry) => `${snake(entry.name)} = ${entry.code}`).join(", ");
  return `pub const ${name} = enum(u16) { ${members} };`;
}

function tsCodes(prefix: string, codes: readonly ProtocolCode[]): string {
  return codes
    .map((entry) => `export const ${prefix}_${upperSnake(entry.name)} = ${entry.code};`)
    .join("\n");
}

function rustCodes(prefix: string, codes: readonly ProtocolCode[]): string {
  return codes
    .map((entry) => `pub const ${prefix}_${upperSnake(entry.name)}: u16 = ${entry.code};`)
    .join("\n");
}

function renderZig(schema: ProtocolSchema, hash: string): string {
  const errors = schema.errors.map((error) => `${snake(error.name)} = ${error.code}`).join(", ");
  const record = schema.hostRecord;
  const offsets = record.scalars
    .map((name) => `pub const offset_${snake(name)}: usize = ${scalarOffset(record, name)};`)
    .join("\n");
  const trailing = record.trailingScalars
    .map(
      (name) =>
        `pub const trailing_offset_${snake(name)}: usize = ${trailingOffset(record, name)};`,
    )
    .join("\n");
  return `// @generated by scripts/generate-native-protocol.ts; do not edit.
const std = @import("std");

pub const host_service = "${schema.service}";
pub const protocol_version: u16 = ${schema.protocolVersion};
pub const api_version: u16 = ${schema.apiVersion};
pub const capability_mask: u32 = ${schema.capabilityMask};
pub const projection_bytes: usize = ${schema.layout.projectionBytes};
pub const event_text_bytes: usize = ${schema.layout.eventTextBytes};
pub const default_viewport_blocks: u32 = ${schema.layout.defaultViewportBlocks};
pub const virtual_block_height: f64 = ${schema.layout.virtualBlockHeight}.0;
pub const protocol_fingerprint = "${hash}";
pub const protocol_magic = [4]u8{ ${magicBytes(schema.magic)} };
pub const response_header_bytes: usize = 88;
/// 锚定区间的线容量：区间挂在投影文本之后（计数 u32 + 每条 12 字节三元组），
/// 与投影同一次响应过界。回放从同一段字节重建——印点因此与录制时同真。
/// 锚定区间的线容量：区间挂在行首段之后（计数 u32 + 每条 48 字节：坐标
/// 三元组 + 36 字节身份），与投影同一次响应过界。回放从同一段字节重建——
/// 印点因此与录制时同真。
pub const anchor_range_capacity: usize = ${schema.layout.anchorRangeCapacity};
pub const anchor_range_wire_bytes: usize = 48;
pub const anchor_range_section_bytes: usize = 4 + anchor_range_capacity * anchor_range_wire_bytes;
/// 行首偏移段的上界：每行 4 字节，行数不超投影字节数（理论极值，每字节
/// 一个换行）。视图按行首断行（禁则），回放从线上字节重建同一布局。
pub const line_starts_section_bytes: usize = projection_bytes * 4;
pub const response_bytes: usize = response_header_bytes + projection_bytes + line_starts_section_bytes + anchor_range_section_bytes;

/// The zero-length projection an empty response borrows.
const empty_projection = [_]u8{};
const empty_line_starts = [_]u32{};
const empty_anchor_ranges = [_]AnchorRangeWire{};

pub const ProtocolError = enum(u32) { ${errors} };
${zigEnum("Action", schema.actions)}
${zigEnum("Input", schema.inputs)}
${zigEnum("CaretDirection", schema.caretDirections)}

/// Host-record byte offsets derived from the SDK's field-name packing order.
/// Hand-written offsets would drift silently when a field is renamed.
${offsets}
pub const offset_text_len: usize = ${bytesLengthOffset(record)};
pub const offset_text: usize = ${bytesOffset(record)};
${trailing}
pub const trailing_bytes: usize = ${trailingBytes(record)};

pub const caret_extend_flag: u16 = 0x100;
pub const caret_direction_mask: u16 = 0xff;

pub const RefrainNativeRequest = extern struct {
    protocol_version: u16,
    action: u16,
    input: u16,
    flags: u16,
    session: u64,
    revision: u64,
    window_start: u64,
    anchor: u64,
    focus: u64,
    cursor: u64,
    viewport_first_block: u64,
    /// Pixel scroll offset resolved by Rust into a block index.
    scroll_offset_y: f64,
    /// 字身 per line, measured from the real font; Rust returns 禁则 breaks.
    columns_em: f64,
    viewport_block_count: u32,
    text_len: u32,
    /// Borrowed for one dispatch call: points into the SDK payload buffer.
    text: [*]const u8,
};

/// 一条锚定区间（投影窗口字节坐标）：批注（高亮/评论）或未裁决提案，
/// 由 Rust 按当前稿子解析。kind：1=高亮 2=评论 3=提案。坐标 u32：
/// 协议本身已把文档限在 4 GiB（encodeDispatchResponse 的 overflow 规则）。
/// id 是来源身份（36 字节 uuid 串）：印点上的动作按它点名。
pub const AnchorRangeWire = extern struct {
    start: u32,
    end: u32,
    kind: u32,
    id: [36]u8,
};

pub const RefrainNativeResponse = extern struct {
    status: u32,
    protocol_version: u16,
    api_version: u16,
    capabilities: u32,
    action: u16,
    reserved: u16,
    session: u64,
    revision: u64,
    total_bytes: u64,
    total_blocks: u64,
    window_start: u64,
    first_block: u64,
    block_count: u32,
    text_len: u32,
    composition_len: u32,
    /// Which grammar highlights this document, from Rust's DocumentFormat.
    /// 0 is Markdown prose; the rest follow the enum's declaration order.
    document_format: u32,
    selection_anchor: u64,
    selection_focus: u64,
    composition_start: u64,
    composition_end: u64,
    document_selection_start: u64,
    document_selection_end: u64,
    /// Borrowed from the Rust session; read during this frame only.
    text: [*]const u8,
    /// CLREQ line-start offsets into the text; same owner and lifetime.
    line_starts: [*]const u32,
    line_start_count: u32,
    /// 锚定区间（窗口坐标）：与文本同属 Rust 会话，活到下一次 dispatch。
    anchor_ranges: [*]const AnchorRangeWire,
    anchor_range_count: u32,
};

pub fn encodeDispatchResponse(response: RefrainNativeResponse) [response_bytes]u8 {
    const requested_text_len: usize = response.text_len;
    const invalid_text = requested_text_len > projection_bytes;
    const overflow = response.session > std.math.maxInt(u32) or
        response.revision > std.math.maxInt(u32) or
        response.total_bytes > std.math.maxInt(u32) or
        response.total_blocks > std.math.maxInt(u32) or
        response.window_start > std.math.maxInt(u32) or
        response.first_block > std.math.maxInt(u32) or
        invalid_text;
    const text_len: usize = if (invalid_text) 0 else requested_text_len;
    var out: [response_bytes]u8 = @splat(0);
    @memcpy(out[0..4], &protocol_magic);
    std.mem.writeInt(u16, out[4..6], response.protocol_version, .little);
    std.mem.writeInt(u16, out[6..8], response.action, .little);
    std.mem.writeInt(u32, out[8..12], if (overflow and response.status == 0) @intFromEnum(ProtocolError.host_failure) else response.status, .little);
    std.mem.writeInt(u16, out[12..14], response.api_version, .little);
    std.mem.writeInt(u16, out[14..16], 0, .little);
    std.mem.writeInt(u32, out[16..20], response.capabilities, .little);
    std.mem.writeInt(u32, out[20..24], wireIndex(response.session), .little);
    std.mem.writeInt(u32, out[24..28], wireIndex(response.revision), .little);
    std.mem.writeInt(u32, out[28..32], wireIndex(response.total_bytes), .little);
    std.mem.writeInt(u32, out[32..36], wireIndex(response.total_blocks), .little);
    std.mem.writeInt(u32, out[36..40], wireIndex(response.window_start), .little);
    std.mem.writeInt(u32, out[40..44], wireIndex(response.first_block), .little);
    std.mem.writeInt(u32, out[44..48], response.block_count, .little);
    std.mem.writeInt(u32, out[48..52], @intCast(text_len), .little);
    // 投影的其余状态也要上线，否则录制会话回放时界面是空的：正稿此前只
    // 经 host_bridge 的全局变量传给视图，而那条路绕开了效果通道，
    // journal 里没有它，回放的可访问性树因此与录制时不同。
    // 行首偏移数组不上线——视图只用它的计数 line_count。
    std.mem.writeInt(u32, out[52..56], response.line_start_count, .little);
    std.mem.writeInt(u32, out[56..60], response.document_format, .little);
    std.mem.writeInt(u32, out[60..64], wireIndex(response.selection_anchor), .little);
    std.mem.writeInt(u32, out[64..68], wireIndex(response.selection_focus), .little);
    std.mem.writeInt(u32, out[68..72], wireIndex(response.composition_start), .little);
    std.mem.writeInt(u32, out[72..76], wireIndex(response.composition_end), .little);
    std.mem.writeInt(u32, out[76..80], @intCast(@min(response.composition_len, std.math.maxInt(u32))), .little);
    std.mem.writeInt(u32, out[80..84], wireIndex(response.document_selection_start), .little);
    std.mem.writeInt(u32, out[84..88], wireIndex(response.document_selection_end), .little);
    @memcpy(out[response_header_bytes..][0..text_len], response.text[0..text_len]);
    // 行首偏移挂在文本之后（无长度前缀——计数在头部 [52..56]）：视图按它们
    // 断行（SDK 只认 space/tab，断不了中文），回放从同一段字节重建。
    // 计数为 0 时这一段缺席，健康与错误答复保持 v3 的字节长度。
    var section = response_header_bytes + text_len;
    const line_count: usize = @min(@as(usize, response.line_start_count), projection_bytes);
    if (line_count > 0) {
        for (response.line_starts[0..line_count], 0..) |line_start, index| {
            std.mem.writeInt(u32, out[section + index * 4 ..][0..4], line_start, .little);
        }
        section += line_count * 4;
    }
    // 锚定区间挂在行首之后（计数 + 每条 48 字节：坐标三元组 + 36 字节
    // 身份），只在有区间时出场。容量是协议上界——宿主先按窗口过滤，
    // 实践中到不了这条界。
    const range_count: usize = @min(@as(usize, response.anchor_range_count), anchor_range_capacity);
    if (range_count > 0) {
        std.mem.writeInt(u32, out[section..][0..4], @intCast(range_count), .little);
        for (response.anchor_ranges[0..range_count], 0..) |range, index| {
            const at = section + 4 + index * anchor_range_wire_bytes;
            std.mem.writeInt(u32, out[at..][0..4], range.start, .little);
            std.mem.writeInt(u32, out[at + 4 ..][0..4], range.end, .little);
            std.mem.writeInt(u32, out[at + 8 ..][0..4], range.kind, .little);
            @memcpy(out[at + 12 ..][0..36], &range.id);
        }
    }
    return out;
}

pub fn encodedResponseLen(response: RefrainNativeResponse) usize {
    const line_count: usize = @min(@as(usize, response.line_start_count), projection_bytes);
    const line_bytes: usize = if (line_count > 0) line_count * 4 else 0;
    const range_count: usize = @min(@as(usize, response.anchor_range_count), anchor_range_capacity);
    const section_bytes: usize = if (range_count > 0) 4 + range_count * anchor_range_wire_bytes else 0;
    return response_header_bytes + @min(@as(usize, response.text_len), projection_bytes) + line_bytes + section_bytes;
}

fn wireIndex(value: u64) u32 {
    return std.math.cast(u32, value) orelse 0;
}

pub fn encodeProtocolError(value: ProtocolError, action: u16) [response_header_bytes]u8 {
    var response = emptyResponse(action);
    response.status = @intFromEnum(value);
    const encoded = encodeDispatchResponse(response);
    return encoded[0..response_header_bytes].*;
}

pub fn emptyResponse(action: u16) RefrainNativeResponse {
    return .{
        .status = 0,
        .protocol_version = protocol_version,
        .api_version = api_version,
        .capabilities = capability_mask,
        .action = action,
        .reserved = 0,
        .session = 0,
        .revision = 0,
        .total_bytes = 0,
        .total_blocks = 0,
        .window_start = 0,
        .first_block = 0,
        .block_count = 0,
        .text_len = 0,
        .composition_len = 0,
        .document_format = 0,
        .selection_anchor = 0,
        .selection_focus = 0,
        .composition_start = 0,
        .composition_end = 0,
        .document_selection_start = 0,
        .document_selection_end = 0,
        .text = empty_projection[0..].ptr,
        .line_starts = empty_line_starts[0..].ptr,
        .line_start_count = 0,
        .anchor_ranges = empty_anchor_ranges[0..].ptr,
        .anchor_range_count = 0,
    };
}

/// Rebuild a projection from the bytes that crossed the effect channel.
///
/// **接上哪个功能**：会话录制与回放。text 借用 bytes，所以调用方必须让
/// 那段缓冲活得比投影久。
///
/// **在全局逻辑中负责什么**：回放时主机不被调用，投影只能从 journal 里的
/// 响应字节重建。录制路径也走这里，两条路因此产生同一个投影——
/// 一条路读线上字节、另一条读 FFI 返回值会静默漂移。
///
/// 行首偏移数组不在线上；计数够视图定行数，指针留空。
pub fn decodeDispatchResponse(bytes: []const u8) ?RefrainNativeResponse {
    if (bytes.len < response_header_bytes) return null;
    if (!std.mem.eql(u8, bytes[0..4], &protocol_magic)) return null;
    const text_len: usize = std.mem.readInt(u32, bytes[48..52], .little);
    if (text_len > projection_bytes or bytes.len < response_header_bytes + text_len) return null;
    var out = emptyResponse(std.mem.readInt(u16, bytes[6..8], .little));
    out.protocol_version = std.mem.readInt(u16, bytes[4..6], .little);
    out.status = std.mem.readInt(u32, bytes[8..12], .little);
    out.api_version = std.mem.readInt(u16, bytes[12..14], .little);
    out.capabilities = std.mem.readInt(u32, bytes[16..20], .little);
    out.session = std.mem.readInt(u32, bytes[20..24], .little);
    out.revision = std.mem.readInt(u32, bytes[24..28], .little);
    out.total_bytes = std.mem.readInt(u32, bytes[28..32], .little);
    out.total_blocks = std.mem.readInt(u32, bytes[32..36], .little);
    out.window_start = std.mem.readInt(u32, bytes[36..40], .little);
    out.first_block = std.mem.readInt(u32, bytes[40..44], .little);
    out.block_count = std.mem.readInt(u32, bytes[44..48], .little);
    out.text_len = @intCast(text_len);
    out.line_start_count = std.mem.readInt(u32, bytes[52..56], .little);
    out.document_format = std.mem.readInt(u32, bytes[56..60], .little);
    out.selection_anchor = std.mem.readInt(u32, bytes[60..64], .little);
    out.selection_focus = std.mem.readInt(u32, bytes[64..68], .little);
    out.composition_start = std.mem.readInt(u32, bytes[68..72], .little);
    out.composition_end = std.mem.readInt(u32, bytes[72..76], .little);
    out.composition_len = std.mem.readInt(u32, bytes[76..80], .little);
    out.document_selection_start = std.mem.readInt(u32, bytes[80..84], .little);
    out.document_selection_end = std.mem.readInt(u32, bytes[84..88], .little);
    if (text_len > 0) out.text = bytes[response_header_bytes..].ptr;
    return out;
}
`;
}

function renderTypeScript(schema: ProtocolSchema, hash: string): string {
  const errors = schema.errors
    .map((error) => `export const ERROR_${upperSnake(error.name)} = ${error.code};`)
    .join("\n");
  const magicChecks = [...schema.magic]
    .map((character, index) => `byte(bytes, ${index}) === ${character.charCodeAt(0)}`)
    .join(" &&\n    ");
  return `// @generated by scripts/generate-native-protocol.ts; do not edit.

export const HOST_SERVICE = "${schema.service}";
export const PROTOCOL_VERSION = ${schema.protocolVersion};
export const API_VERSION = ${schema.apiVersion};
export const CAPABILITY_MASK = ${schema.capabilityMask};
export const PROJECTION_BYTES = ${schema.layout.projectionBytes};
export const EVENT_TEXT_BYTES = ${schema.layout.eventTextBytes};
export const DEFAULT_VIEWPORT_BLOCKS = ${schema.layout.defaultViewportBlocks};
export const VIRTUAL_BLOCK_HEIGHT = ${schema.layout.virtualBlockHeight};
export const PROTOCOL_FINGERPRINT =
  "${hash}";
${errors}
${tsCodes("ACTION", schema.actions)}
${tsCodes("INPUT", schema.inputs)}
${tsCodes("CARET", schema.caretDirections)}
export const CARET_EXTEND_FLAG = 0x100;

export const RESPONSE_HEADER_BYTES = 88;
export const ANCHOR_RANGE_CAPACITY = ${schema.layout.anchorRangeCapacity};
export const ANCHOR_RANGE_WIRE_BYTES = 48;

export function isDispatchResponse(bytes: Uint8Array): boolean {
  if (
    bytes.length < RESPONSE_HEADER_BYTES ||
    !hasMagic(bytes) ||
    readU16(bytes, 4) !== PROTOCOL_VERSION
  )
    return false;
  const textLength = readU32(bytes, 48);
  if (textLength > PROJECTION_BYTES || bytes.length < RESPONSE_HEADER_BYTES + textLength) {
    return false;
  }
  let trailing = bytes.length - RESPONSE_HEADER_BYTES - textLength;
  // v4 起响应在文本之后挂两段可选数据：行首偏移（计数在头部 [52..56]，
  // 每行 4 字节）与锚定区间（自带计数的三元组）。旧录制两段都没有。
  if (trailing === 0) return true;
  const lineCount = readU32(bytes, 52);
  if (lineCount > 0) {
    if (trailing < lineCount * 4) return false;
    trailing -= lineCount * 4;
  }
  if (trailing === 0) return true;
  return (
    trailing >= 4 &&
    (trailing - 4) % ANCHOR_RANGE_WIRE_BYTES === 0 &&
    readU32(bytes, bytes.length - trailing) === (trailing - 4) / ANCHOR_RANGE_WIRE_BYTES
  );
}

export function dispatchResponseStatus(bytes: Uint8Array): number {
  return isDispatchResponse(bytes) ? readU32(bytes, 8) : 0;
}

export function dispatchResponseAction(bytes: Uint8Array): number {
  return isDispatchResponse(bytes) ? readU16(bytes, 6) : 0;
}

export function dispatchResponseApiVersion(bytes: Uint8Array): number {
  return isDispatchResponse(bytes) ? readU16(bytes, 12) : 0;
}

export function dispatchResponseCapabilities(bytes: Uint8Array): number {
  return isDispatchResponse(bytes) ? readU32(bytes, 16) : 0;
}

export function dispatchResponseSession(bytes: Uint8Array): number {
  return isDispatchResponse(bytes) ? readU32(bytes, 20) : 0;
}

export function dispatchResponseRevision(bytes: Uint8Array): number {
  return isDispatchResponse(bytes) ? readU32(bytes, 24) : 0;
}

export function dispatchResponseTotalBytes(bytes: Uint8Array): number {
  return isDispatchResponse(bytes) ? readU32(bytes, 28) : 0;
}

export function dispatchResponseTotalBlocks(bytes: Uint8Array): number {
  return isDispatchResponse(bytes) ? readU32(bytes, 32) : 0;
}

export function dispatchResponseWindowStart(bytes: Uint8Array): number {
  return isDispatchResponse(bytes) ? readU32(bytes, 36) : 0;
}

export function dispatchResponseFirstBlock(bytes: Uint8Array): number {
  return isDispatchResponse(bytes) ? readU32(bytes, 40) : 0;
}

export function dispatchResponseBlockCount(bytes: Uint8Array): number {
  return isDispatchResponse(bytes) ? readU32(bytes, 44) : 0;
}

export function dispatchResponseText(bytes: Uint8Array): Uint8Array {
  if (!isDispatchResponse(bytes)) return new Uint8Array(0);
  return bytes.slice(RESPONSE_HEADER_BYTES);
}

function hasMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    ${magicChecks}
  );
}

function byte(bytes: Uint8Array, offset: number): number {
  if (offset >= bytes.length) return 0;
  return bytes[offset] as number;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return byte(bytes, offset) + byte(bytes, offset + 1) * 256;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    byte(bytes, offset) +
    byte(bytes, offset + 1) * 256 +
    byte(bytes, offset + 2) * 65536 +
    byte(bytes, offset + 3) * 16777216
  );
}
`;
}

// ---------------------------------------------------------------- reply wire

/**
 * 一条答复的线上形状：定长 head + 定长行 + 尾部字节。
 *
 * **为什么由这里排布，而不是让两侧各自声明。** `#[repr(C)]` 与 `extern struct`
 * 都跟随同一套 C 规则，所以只要成员序列相同，两边的偏移就相同——难点从来不是
 * 规则，是「两处声明会各自漂开」。生成器把四字节成员排在前、单字节成员排在后、
 * 末尾补到四的倍数，因此**中间不存在隐式 padding**：偏移只由 `host.json` 那张表
 * 决定，改一处两侧一起变。
 *
 * 字符串与名录不进结构体：`Str` 与 `Rows` 都是 `{off,len}`，指向同一段缓冲里
 * 别处的字节。借用因此是免费的，Zig 侧读一列一千行不会先建一份一千行的中间表。
 */
function layout(fields: readonly ReplyField[], enums: ReplyEnums): readonly Member[] {
  const sized = fields.map(
    ([name, type]): Member => ({ name, type, bytes: memberBytes(type, enums) }),
  );
  const wide = sized.filter((member) => member.bytes >= 4);
  const narrow = sized.filter((member) => member.bytes < 4);
  const used = wide.reduce((total, member) => total + member.bytes, 0) + narrow.length;
  const padding = (4 - (used % 4)) % 4;
  return padding === 0
    ? [...wide, ...narrow]
    : [...wide, ...narrow, { name: "_pad", type: `pad:${padding}`, bytes: padding }];
}

function memberBytes(type: string, enums: ReplyEnums): number {
  if (type === "str" || type.startsWith("rows:")) return 8;
  if (type === "u32") return 4;
  if (type === "bool") return 1;
  if (type in enums) return 1;
  throw new Error(`reply member type ${type} is not str, u32, bool, rows:<Row> or an enum`);
}

function structBytes(members: readonly Member[]): number {
  return members.reduce((total, member) => total + member.bytes, 0);
}

function replyEnums(value: unknown): ReplyEnums {
  if (!isRecord(value)) throw new Error("native protocol schema must declare enums");
  const parsed: Record<string, readonly string[]> = {};
  for (const [name, members] of Object.entries(value)) {
    if (!Array.isArray(members) || members.length === 0) {
      throw new Error(`enum ${name} must list at least one member`);
    }
    if (members.length > 256) throw new Error(`enum ${name} does not fit in one byte`);
    parsed[name] = members.map((member: unknown) => string(member, `enum ${name} member`));
  }
  return parsed;
}

function replyStructs(value: unknown, label: string): ReplyStructs {
  if (!isRecord(value)) throw new Error(`native protocol schema must declare ${label}`);
  const parsed: Record<string, readonly ReplyField[]> = {};
  for (const [name, fields] of Object.entries(value)) {
    if (!Array.isArray(fields)) throw new Error(`${label}.${name} must be an array of members`);
    parsed[name] = fields.map((field: unknown) => {
      if (!Array.isArray(field) || field.length !== 2) {
        throw new Error(`${label}.${name} members are [name, type] pairs`);
      }
      return [
        string(field[0], `${label}.${name} member name`),
        string(field[1], `${label}.${name} member type`),
      ] as const;
    });
  }
  return parsed;
}

function pascal(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function zigMemberType(type: string): string {
  if (type === "str") return "Str";
  if (type.startsWith("rows:")) return "Rows";
  if (type.startsWith("pad:")) return `[${type.slice("pad:".length)}]u8`;
  return type;
}

function rustMemberType(type: string): string {
  if (type === "str") return "Str";
  if (type.startsWith("rows:")) return "Rows";
  if (type.startsWith("pad:")) return `[u8; ${type.slice("pad:".length)}]`;
  return type;
}

/** Every kind gets a code; 0 stays free so an unwritten buffer reads as "none". */
function replyKinds(schema: ProtocolSchema): readonly ProtocolCode[] {
  return Object.keys(schema.replies).map((name, index) => ({ name, code: index + 1 }));
}

function zigDefault(type: string): string {
  if (type === "str" || type.startsWith("rows:")) return ".{}";
  if (type === "u32") return "0";
  if (type === "bool") return "false";
  return "@enumFromInt(0)";
}

function zigStruct(name: string, members: readonly Member[]): string {
  const body = members
    .map((member) =>
      member.type.startsWith("pad:")
        ? `    _pad: ${zigMemberType(member.type)} = @splat(0),`
        : `    ${snake(member.name)}: ${zigMemberType(member.type)} = ${zigDefault(member.type)},`,
    )
    .join("\n");
  const size = structBytes(members);
  return `pub const ${name} = extern struct {
${body === "" ? "    unused: u32 = 0," : body}

    comptime {
        std.debug.assert(@sizeOf(${name}) == ${size === 0 ? 4 : size});
    }
};`;
}

function renderWireZig(schema: ProtocolSchema, hash: string): string {
  const enums = Object.entries(schema.enums)
    .map(
      ([name, members]) =>
        `pub const ${name} = enum(u8) { ${members
          .map((member, index) => `${snake(member)} = ${index}`)
          .join(", ")} };`,
    )
    .join("\n");
  const rows = Object.entries(schema.rows)
    .map(([name, fields]) => zigStruct(name, layout(fields, schema.enums)))
    .join("\n\n");
  const heads = Object.entries(schema.replies)
    .map(([name, fields]) => zigStruct(`${pascal(name)}Head`, layout(fields, schema.enums)))
    .join("\n\n");
  const kinds = replyKinds(schema)
    .map((kind) => `${snake(kind.name)} = ${kind.code}`)
    .join(", ");
  const headFor = Object.keys(schema.replies)
    .map((name) => `        .${snake(name)} => ${pascal(name)}Head,`)
    .join("\n");
  return `// @generated by scripts/generate-native-protocol.ts; do not edit.
//! 项目答复的线上形状。Rust 按同一张表填，这里按同一张表读，两边都不解析。
//!
//! 偏移由生成器排布（四字节成员在前、单字节在后、末尾补齐），所以这里的
//! \`extern struct\` 与 Rust 那侧的手写序列化逐字节相同。\`Str\` 与 \`Rows\` 是
//! {off,len}，指向同一段缓冲里别处的字节——借用因此是免费的。
//!
//! 读不出来的一律交出空视图而不是猜一个：一份读错的名录比一份空名录危险得多。
const std = @import("std");

pub const magic: u32 = 0x5257_4652;
pub const protocol_fingerprint = "${hash}";

/// 一段字节：偏移与长度都相对整段缓冲。
pub const Str = extern struct { off: u32 = 0, len: u32 = 0 };

/// 一列定长行：偏移相对整段缓冲，\`len\` 是行数而不是字节数。
pub const Rows = extern struct { off: u32 = 0, len: u32 = 0 };

pub const Header = extern struct {
    magic: u32 = 0,
    kind: u32 = 0,
    /// 整段缓冲的字节数。越界检查按它做，不按调用方递来的切片长度。
    bytes: u32 = 0,
    reserved: u32 = 0,
};

/// 答复的种类。0 空出来：没落过槽的缓冲读成 \`.none\`，而不是第一种答复的空形态。
pub const Kind = enum(u32) { none = 0, ${kinds}, _ };

${enums}

${rows}

${heads}

/// 一段落好槽的答复。
///
/// 每一次取值都对着 \`Header.bytes\` 验界：线上字节可能被截断或写坏，而一个越界的
/// \`Str\` 会让界面读到相邻答复的内容——那比一片空白危险得多。
pub const Reply = struct {
    bytes: []align(4) const u8,

    pub const empty = Reply{ .bytes = &[_]u8{} };

    fn header(self: Reply) ?*const Header {
        if (self.bytes.len < @sizeOf(Header)) return null;
        const stated: *const Header = @ptrCast(self.bytes.ptr);
        if (stated.magic != magic) return null;
        if (stated.bytes > self.bytes.len) return null;
        return stated;
    }

    pub fn kind(self: Reply) Kind {
        const stated = self.header() orelse return .none;
        return @enumFromInt(stated.kind);
    }

    fn span(self: Reply, off: u32, len: u32) ?[]const u8 {
        const stated = self.header() orelse return null;
        if (@as(u64, off) + @as(u64, len) > stated.bytes) return null;
        return self.bytes[off..][0..len];
    }

    /// 一段文本。越界或没填过都是空——空文本与读不出在界面上同形。
    pub fn text(self: Reply, value: Str) []const u8 {
        return self.span(value.off, value.len) orelse "";
    }

    /// 这条答复的头。种类对不上就是 null，调用方据此保留当前状态。
    pub fn head(self: Reply, comptime want: Kind) ?*const headType(want) {
        if (self.kind() != want) return null;
        const Head = headType(want);
        if (self.bytes.len < @sizeOf(Header) + @sizeOf(Head)) return null;
        return @ptrCast(@alignCast(self.bytes.ptr + @sizeOf(Header)));
    }

    /// 一列行。对不齐或越界都交出空列，不交半行。
    pub fn rows(self: Reply, comptime Row: type, value: Rows) []const Row {
        if (value.off % @alignOf(Row) != 0) return &[_]Row{};
        const wanted = @as(u64, value.len) * @sizeOf(Row);
        if (wanted > std.math.maxInt(u32)) return &[_]Row{};
        const bytes = self.span(value.off, @intCast(wanted)) orelse return &[_]Row{};
        const aligned: []align(@alignOf(Row)) const u8 = @alignCast(bytes);
        return std.mem.bytesAsSlice(Row, aligned);
    }

    /// 第 index 行。越界是 null，不是最后一行——把「没有那么多行」读成末行，
    /// 会让一次裁决落在别人身上。
    pub fn row(self: Reply, comptime Row: type, value: Rows, index: usize) ?Row {
        const list = self.rows(Row, value);
        return if (index < list.len) list[index] else null;
    }
};

/// 一段**还没落槽**的线上字节自称的种类。
///
/// 收包缓冲不保证四字节对齐，所以这里逐字节读头，而不是 \`@alignCast\` 一个
/// 指针——那一句在真实的收包缓冲上会 panic，而它只在测试夹具里恰好对齐。
/// 落槽之后的读法走 \`Reply\`（模块缓冲声明成 \`align(4)\`）。
pub fn kindOf(bytes: []const u8) Kind {
    if (bytes.len < @sizeOf(Header)) return .none;
    if (std.mem.readInt(u32, bytes[0..4], .little) != magic) return .none;
    return @enumFromInt(std.mem.readInt(u32, bytes[4..8], .little));
}

/// 种类到头类型。新增一种答复而忘了给它一个头，是编译错误。
pub fn headType(comptime want: Kind) type {
    return switch (want) {
${headFor}
        else => @compileError("this reply kind has no head"),
    };
}
`;
}

function rustStruct(name: string, members: readonly Member[]): string {
  const declared = members.filter((member) => !member.type.startsWith("pad:"));
  const fields = declared
    .map((member) => `    pub ${snake(member.name)}: ${rustMemberType(member.type)},`)
    .join("\n");
  const writes = members
    .map((member) => {
      if (member.type.startsWith("pad:")) {
        return `        out.extend_from_slice(&[0u8; ${member.bytes}]);`;
      }
      if (member.type === "str") return `        push_str_field(out, self.${snake(member.name)});`;
      if (member.type.startsWith("rows:")) {
        return `        push_rows_field(out, self.${snake(member.name)});`;
      }
      if (member.type === "u32") return `        push_u32(out, self.${snake(member.name)});`;
      if (member.type === "bool") {
        return `        out.push(u8::from(self.${snake(member.name)}));`;
      }
      return `        out.push(self.${snake(member.name)} as u8);`;
    })
    .join("\n");
  // The reader walks the same member order the writer wrote, so a member added
  // to the schema moves both halves at once. Anything short or malformed reads
  // as None: a misread row is worse than an absent one.
  let cursor = 0;
  const reads = members
    .filter((member) => !member.type.startsWith("pad:"))
    .map((member) => {
      const at = cursor;
      cursor += member.bytes;
      const field = snake(member.name);
      if (member.type === "str") return `            ${field}: read_str(bytes, ${at})?,`;
      if (member.type.startsWith("rows:")) return `            ${field}: read_rows(bytes, ${at})?,`;
      if (member.type === "u32") return `            ${field}: read_u32(bytes, ${at})?,`;
      if (member.type === "bool") return `            ${field}: read_u8(bytes, ${at})? != 0,`;
      return `            ${field}: ${member.type}::from_code(read_u8(bytes, ${at})?),`;
    })
    .join("\n");
  const size = structBytes(members);
  return `#[derive(Debug, Clone, Copy, Default)]
pub struct ${name} {
${fields === "" ? "    pub unused: u32," : fields}
}

impl WireRow for ${name} {
    const BYTES: usize = ${size === 0 ? 4 : size};

    fn write(&self, out: &mut Vec<u8>) {
${writes === "" ? "        push_u32(out, self.unused);" : writes}
    }

    fn read(bytes: &[u8]) -> Option<Self> {
        Some(Self {
${reads === "" ? "            unused: read_u32(bytes, 0)?," : reads}
        })
    }
}`;
}

function renderWireRust(schema: ProtocolSchema, hash: string): string {
  const enums = Object.entries(schema.enums)
    .map(([name, members]) => {
      const variants = members
        .map((member, index) =>
          index === 0
            ? `    #[default]\n    ${pascal(member)} = ${index},`
            : `    ${pascal(member)} = ${index},`,
        )
        .join("\n");
      const arms = members
        .map((member, index) => `            ${index} => Self::${pascal(member)},`)
        .join("\n");
      return `#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum ${name} {
${variants}
}

impl ${name} {
    /// 认不出的码落到第一个变体（各表的第一个都是「未知」或「默认」）——
    /// 一个读不懂的值被当成某个已知值，比说不出来危险得多。
    #[must_use]
    pub fn from_code(code: u8) -> Self {
        match code {
${arms}
            _ => Self::default(),
        }
    }
}`;
    })
    .join("\n\n");
  const rows = Object.entries(schema.rows)
    .map(([name, fields]) => rustStruct(name, layout(fields, schema.enums)))
    .join("\n\n");
  const heads = Object.entries(schema.replies)
    .map(([name, fields]) => rustStruct(`${pascal(name)}Head`, layout(fields, schema.enums)))
    .join("\n\n");
  const kinds = replyKinds(schema)
    .map((kind) => `    ${pascal(kind.name)} = ${kind.code},`)
    .join("\n");
  return `// @generated by scripts/generate-native-protocol.ts; do not edit.
//! 项目答复的线上形状，Rust 这一侧。
//!
//! 每个成员自己把小端字节推进缓冲，所以这里**不需要 \`unsafe\`，也不需要
//! \`repr(C)\`**：字节顺序由 \`protocol/host.json\` 那张表决定，而 Zig 侧的
//! \`extern struct\` 由同一张表排布——两者一起改，或者一起不改。
#![allow(
    dead_code,
    reason = "generated: not every reply shape has a reader yet"
)]

pub const MAGIC: u32 = 0x5257_4652;
pub const PROTOCOL_FINGERPRINT: &str =
    "${hash}";
pub const HEADER_BYTES: usize = 16;

/// 一段字节在缓冲里的位置。
#[derive(Debug, Clone, Copy, Default)]
pub struct Str {
    pub off: u32,
    pub len: u32,
}

/// 一列定长行在缓冲里的位置。\`len\` 是行数，不是字节数。
#[derive(Debug, Clone, Copy, Default)]
pub struct Rows {
    pub off: u32,
    pub len: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum Kind {
${kinds}
}

${enums}

${rows}

${heads}

/// 一条答复的缓冲。
///
/// 头留在最前面，行与字节追加在它后面，最后头被填回去——所以 \`Rows\` 与 \`Str\`
/// 的偏移在写下它们的那一刻就已经是最终值，不需要第二遍修补。
pub struct Writer {
    buf: Vec<u8>,
    kind: Kind,
}

impl Writer {
    pub fn new(kind: Kind, head_bytes: usize) -> Self {
        let mut buf = vec![0u8; HEADER_BYTES];
        buf.resize(HEADER_BYTES.saturating_add(head_bytes), 0);
        Self { buf, kind }
    }

    /// 追加一段文本。空文本不占缓冲——一个 {0,0} 的 \`Str\` 读出来就是空。
    pub fn text(&mut self, value: &str) -> Str {
        if value.is_empty() {
            return Str::default();
        }
        let off = u32::try_from(self.buf.len()).unwrap_or(0);
        let len = u32::try_from(value.len()).unwrap_or(0);
        if off == 0 || len == 0 {
            return Str::default();
        }
        self.buf.extend_from_slice(value.as_bytes());
        Str { off, len }
    }

    /// 追加一列行，先对齐到四字节——Zig 侧按对齐取切片，对不齐整列作废。
    pub fn rows<T: WireRow>(&mut self, rows: &[T]) -> Rows {
        while !self.buf.len().is_multiple_of(4) {
            self.buf.push(0);
        }
        let off = u32::try_from(self.buf.len()).unwrap_or(0);
        let len = u32::try_from(rows.len()).unwrap_or(0);
        if off == 0 {
            return Rows::default();
        }
        for row in rows {
            row.write(&mut self.buf);
        }
        Rows { off, len }
    }

    /// 填回头并交出整段缓冲。
    pub fn finish<H: WireRow>(mut self, head: &H) -> Vec<u8> {
        let mut encoded = Vec::with_capacity(H::BYTES);
        head.write(&mut encoded);
        let end = HEADER_BYTES.saturating_add(encoded.len());
        if let Some(slot) = self.buf.get_mut(HEADER_BYTES..end) {
            slot.copy_from_slice(&encoded);
        }
        let total = u32::try_from(self.buf.len()).unwrap_or(0);
        let mut header = Vec::with_capacity(HEADER_BYTES);
        push_u32(&mut header, MAGIC);
        push_u32(&mut header, self.kind as u32);
        push_u32(&mut header, total);
        push_u32(&mut header, 0);
        if let Some(slot) = self.buf.get_mut(0..HEADER_BYTES) {
            slot.copy_from_slice(&header);
        }
        self.buf
    }
}

/// 一个能把自己写成线上字节、也能从线上字节读回来的形状。
///
/// 读回来这一半是给**这一侧自己的测试**用的：把编码器的产物读回来断言，
/// 比按字节偏移手抄一份期望值可靠——手抄的那份会在 schema 变动时静默漂开。
pub trait WireRow: Sized {
    const BYTES: usize;
    fn write(&self, out: &mut Vec<u8>);
    fn read(bytes: &[u8]) -> Option<Self>;
}

/// 一段线上答复的读法，与 Zig 的 \`wire.Reply\` 同规。
#[derive(Debug, Clone, Copy)]
pub struct Reply<'a> {
    bytes: &'a [u8],
}

impl<'a> Reply<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    fn stated_len(&self) -> Option<usize> {
        if read_u32(self.bytes, 0)? != MAGIC {
            return None;
        }
        let stated = usize::try_from(read_u32(self.bytes, 8)?).ok()?;
        (stated <= self.bytes.len()).then_some(stated)
    }

    /// 这条答复自称的种类码。读不出就是 0。
    #[must_use]
    pub fn kind_code(&self) -> u32 {
        self.stated_len()
            .and_then(|_| read_u32(self.bytes, 4))
            .unwrap_or(0)
    }

    /// 这条答复的头。
    #[must_use]
    pub fn head<H: WireRow>(&self) -> Option<H> {
        let end = HEADER_BYTES.checked_add(H::BYTES)?;
        (end <= self.stated_len()?).then_some(())?;
        H::read(self.bytes.get(HEADER_BYTES..end)?)
    }

    /// 一段文本。越界交出空，不交相邻答复的内容。
    #[must_use]
    pub fn text(&self, value: Str) -> &'a str {
        let start = usize::try_from(value.off).unwrap_or(0);
        let end = start.saturating_add(usize::try_from(value.len).unwrap_or(0));
        match self.stated_len() {
            Some(stated) if end <= stated => self
                .bytes
                .get(start..end)
                .and_then(|raw| std::str::from_utf8(raw).ok()),
            _ => None,
        }
        .unwrap_or_default()
    }

    /// 一列行。对不齐或越界都交出空列，不交半行。
    #[must_use]
    pub fn rows<R: WireRow>(&self, value: Rows) -> Vec<R> {
        let start = usize::try_from(value.off).unwrap_or(0);
        let count = usize::try_from(value.len).unwrap_or(0);
        let Some(stated) = self.stated_len() else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(count);
        for index in 0..count {
            let Some(at) = index
                .checked_mul(R::BYTES)
                .and_then(|off| start.checked_add(off))
            else {
                return out;
            };
            let Some(end) = at.checked_add(R::BYTES) else {
                return out;
            };
            if end > stated {
                return out;
            }
            match self.bytes.get(at..end).and_then(R::read) {
                Some(row) => out.push(row),
                None => return out,
            }
        }
        out
    }
}

fn read_u8(bytes: &[u8], at: usize) -> Option<u8> {
    bytes.get(at).copied()
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let end = at.checked_add(4)?;
    Some(u32::from_le_bytes(bytes.get(at..end)?.try_into().ok()?))
}

fn read_str(bytes: &[u8], at: usize) -> Option<Str> {
    Some(Str {
        off: read_u32(bytes, at)?,
        len: read_u32(bytes, at.checked_add(4)?)?,
    })
}

fn read_rows(bytes: &[u8], at: usize) -> Option<Rows> {
    Some(Rows {
        off: read_u32(bytes, at)?,
        len: read_u32(bytes, at.checked_add(4)?)?,
    })
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_str_field(out: &mut Vec<u8>, value: Str) {
    push_u32(out, value.off);
    push_u32(out, value.len);
}

fn push_rows_field(out: &mut Vec<u8>, value: Rows) {
    push_u32(out, value.off);
    push_u32(out, value.len);
}
`;
}
