import { asciiBytes, Cmd } from "@native-sdk/core";
import type { ScrollState } from "@native-sdk/core/events";
import type { TextCaretDirection, TextInputEvent } from "@native-sdk/core/text";
import {
  API_VERSION,
  CAPABILITY_MASK,
  DEFAULT_VIEWPORT_BLOCKS,
  dispatchResponseAction,
  dispatchResponseApiVersion,
  dispatchResponseCapabilities,
  dispatchResponseFirstBlock,
  dispatchResponseRevision,
  dispatchResponseSession,
  dispatchResponseStatus,
  dispatchResponseTotalBlocks,
  dispatchResponseTotalBytes,
  dispatchResponseWindowStart,
  ERROR_DOMAIN_REFUSAL,
  ERROR_HOST_FAILURE,
  ERROR_INVALID_REQUEST,
  ERROR_PROTOCOL_MISMATCH,
  ERROR_STALE_REVISION,
  ERROR_UNKNOWN_SESSION,
  EVENT_TEXT_BYTES,
  isDispatchResponse,
  PROTOCOL_VERSION,
} from "./generated/protocol.ts";

const BRIDGE_HEALTH = 101;
const BRIDGE_OPEN_MANUSCRIPT = 102;
const BRIDGE_TEXT_EVENT = 103;
const BRIDGE_VIEWPORT = 104;
const BRIDGE_UNDO = 105;

const EVENT_INSERT_TEXT = 1;
const EVENT_DELETE_BACKWARD = 2;
const EVENT_DELETE_FORWARD = 3;
const EVENT_DELETE_WORD_BACKWARD = 4;
const EVENT_DELETE_WORD_FORWARD = 5;
const EVENT_CLEAR = 6;
const EVENT_MOVE_CARET = 7;
const EVENT_SET_SELECTION = 8;
const EVENT_SET_COMPOSITION = 9;
const EVENT_COMMIT_COMPOSITION = 10;
const EVENT_CANCEL_COMPOSITION = 11;

export interface Model {
  readonly hostReady: boolean;
  readonly status: Uint8Array;
  readonly protocolVersion: number;
  readonly documentSession: number;
  readonly documentRevision: number;
  readonly documentBytes: number;
  readonly documentBlocks: number;
  readonly documentScroll: number;
  readonly viewportFirstBlock: number;
  readonly projectionWindowStart: number;
}

export type Msg =
  | { readonly kind: "dispatch_ok"; readonly bytes: Uint8Array }
  | { readonly kind: "dispatch_err"; readonly bytes: Uint8Array }
  | { readonly kind: "document_input"; readonly event: TextInputEvent }
  | { readonly kind: "document_scroll"; readonly scroll: ScrollState }
  | { readonly kind: "document_undo" };

export const viewUnbound = [
  "documentSession",
  "documentScroll",
  "viewportFirstBlock",
  "projectionWindowStart",
  "dispatch_ok",
  "dispatch_err",
  "document_input",
  "document_scroll",
] as const;

function checkingModel(): Model {
  return {
    hostReady: false,
    status: asciiBytes("Checking the typed Rust boundary..."),
    protocolVersion: 0,
    documentSession: 0,
    documentRevision: 0,
    documentBytes: 0,
    documentBlocks: 0,
    documentScroll: 0,
    viewportFirstBlock: 0,
    projectionWindowStart: 0,
  };
}

export function initialModel(): [Model, Cmd<Msg>] {
  const model = checkingModel();
  return [
    model,
    Cmd.request(
      /* @generated:host-service */ "refrain.host",
      {
        action: BRIDGE_HEALTH,
        anchor: 0,
        cursor: 0,
        flags: 0,
        focus: 0,
        input: 0,
        protocolVersion: PROTOCOL_VERSION,
        revision: model.documentRevision,
        scrollOffsetY: model.documentScroll,
        session: model.documentSession,
        text: new Uint8Array(0),
        viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
        viewportFirstBlock: model.viewportFirstBlock,
        windowStart: model.projectionWindowStart,
      },
      {
        key: "native-dispatch",
        ok: "dispatch_ok",
        err: "dispatch_err",
      },
    ),
  ];
}

export function update(model: Model, msg: Msg): Model | [Model, Cmd<Msg>] {
  switch (msg.kind) {
    case "dispatch_ok": {
      const bytes = msg.bytes;
      if (!isDispatchResponse(bytes) || dispatchResponseStatus(bytes) !== 0) {
        return { ...model, hostReady: false, status: asciiBytes("Native host returned an invalid contract.") };
      }
      const action = dispatchResponseAction(bytes);
      if (action === BRIDGE_HEALTH) {
        if (
          dispatchResponseApiVersion(bytes) !== API_VERSION ||
          (dispatchResponseCapabilities(bytes) & CAPABILITY_MASK) !== CAPABILITY_MASK
        ) {
          return { ...model, hostReady: false, status: asciiBytes("Native host capability mismatch.") };
        }
        const ready: Model = {
          ...model,
          hostReady: true,
          status: asciiBytes("Opening the Rust manuscript projection..."),
          protocolVersion: PROTOCOL_VERSION,
        };
        return [
          ready,
          Cmd.request(
            /* @generated:host-service */ "refrain.host",
            {
              action: BRIDGE_OPEN_MANUSCRIPT,
              anchor: 0,
              cursor: 0,
              flags: 0,
              focus: 0,
              input: 0,
              protocolVersion: PROTOCOL_VERSION,
              revision: ready.documentRevision,
              scrollOffsetY: ready.documentScroll,
              session: ready.documentSession,
              text: new Uint8Array(0),
              viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
              viewportFirstBlock: ready.viewportFirstBlock,
              windowStart: ready.projectionWindowStart,
            },
            {
              key: "native-dispatch",
              ok: "dispatch_ok",
              err: "dispatch_err",
            },
          ),
        ];
      }
      if (
        action !== BRIDGE_OPEN_MANUSCRIPT &&
        action !== BRIDGE_TEXT_EVENT &&
        action !== BRIDGE_VIEWPORT &&
        action !== BRIDGE_UNDO
      ) {
        return { ...model, status: asciiBytes("Native host returned an unknown dispatch action.") };
      }
      return {
        ...model,
        hostReady: true,
        status: asciiBytes("100,000 blocks · viewport projection · Rust document authority"),
        documentSession: dispatchResponseSession(bytes),
        documentRevision: dispatchResponseRevision(bytes),
        documentBytes: dispatchResponseTotalBytes(bytes),
        documentBlocks: dispatchResponseTotalBlocks(bytes),
        viewportFirstBlock: dispatchResponseFirstBlock(bytes),
        projectionWindowStart: dispatchResponseWindowStart(bytes),
      };
    }
    case "dispatch_err":
      return rejectDispatch(model, msg.bytes);
    case "document_input": {
      if (model.documentSession === 0) return model;
      const event = textEventRequest(msg.event);
      if (event === null) {
        return { ...model, status: asciiBytes("The text event exceeded the fixed ABI bound.") };
      }
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          {
            action: BRIDGE_TEXT_EVENT,
            anchor: event.anchor,
            cursor: event.cursor,
            flags: event.flags,
            focus: event.focus,
            input: event.input,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: event.text,
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          },
          {
            key: "native-dispatch",
            ok: "dispatch_ok",
            err: "dispatch_err",
          },
        ),
      ];
    }
    case "document_scroll": {
      const scrolled: Model = { ...model, documentScroll: msg.scroll.offsetY };
      if (model.documentSession === 0 || msg.scroll.offsetY === model.documentScroll) {
        return scrolled;
      }
      return [
        scrolled,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          {
            action: BRIDGE_VIEWPORT,
            anchor: 0,
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: scrolled.documentRevision,
            scrollOffsetY: scrolled.documentScroll,
            session: scrolled.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: scrolled.viewportFirstBlock,
            windowStart: scrolled.projectionWindowStart,
          },
          {
            key: "native-dispatch",
            ok: "dispatch_ok",
            err: "dispatch_err",
          },
        ),
      ];
    }
    case "document_undo": {
      if (model.documentSession === 0) return model;
      return [
        model,
        Cmd.request(
          /* @generated:host-service */ "refrain.host",
          {
            action: BRIDGE_UNDO,
            anchor: 0,
            cursor: 0,
            flags: 0,
            focus: 0,
            input: 0,
            protocolVersion: PROTOCOL_VERSION,
            revision: model.documentRevision,
            scrollOffsetY: model.documentScroll,
            session: model.documentSession,
            text: new Uint8Array(0),
            viewportBlockCount: DEFAULT_VIEWPORT_BLOCKS,
            viewportFirstBlock: model.viewportFirstBlock,
            windowStart: model.projectionWindowStart,
          },
          {
            key: "native-dispatch",
            ok: "dispatch_ok",
            err: "dispatch_err",
          },
        ),
      ];
    }
  }
}

function rejectDispatch(model: Model, bytes: Uint8Array): Model {
  if (!isDispatchResponse(bytes)) {
    return { ...model, status: asciiBytes("Native host returned a corrupt failure.") };
  }
  const code = dispatchResponseStatus(bytes);
  if (code === ERROR_PROTOCOL_MISMATCH) {
    return { ...model, hostReady: false, status: asciiBytes("Native protocol mismatch.") };
  }
  if (code === ERROR_INVALID_REQUEST) {
    return { ...model, status: asciiBytes("Native dispatch request was invalid.") };
  }
  if (code === ERROR_UNKNOWN_SESSION) {
    return { ...model, status: asciiBytes("Native document session was unknown.") };
  }
  if (code === ERROR_DOMAIN_REFUSAL) {
    return { ...model, status: asciiBytes("Rust refused the document input.") };
  }
  if (code === ERROR_HOST_FAILURE) {
    return { ...model, status: asciiBytes("Native Rust host failed.") };
  }
  if (code === ERROR_STALE_REVISION) {
    return {
      ...model,
      documentRevision: dispatchResponseRevision(bytes),
      status: asciiBytes("Document input raced a newer Rust revision; retry from the current view."),
    };
  }
  return { ...model, status: asciiBytes("Native dispatch returned an unknown failure.") };
}

interface EncodedTextEvent {
  readonly input: number;
  readonly flags: number;
  readonly anchor: number;
  readonly focus: number;
  readonly cursor: number;
  readonly text: Uint8Array;
}

function textEventRequest(event: TextInputEvent): EncodedTextEvent | null {
  let input = 0;
  let flags = 0;
  let anchor = 0;
  let focus = 0;
  let cursor = 0;
  let text: Uint8Array = new Uint8Array(0);
  switch (event.kind) {
    case "insert_text":
      input = EVENT_INSERT_TEXT;
      text = event.text;
      break;
    case "delete_backward":
      input = EVENT_DELETE_BACKWARD;
      break;
    case "delete_forward":
      input = EVENT_DELETE_FORWARD;
      break;
    case "delete_word_backward":
      input = EVENT_DELETE_WORD_BACKWARD;
      break;
    case "delete_word_forward":
      input = EVENT_DELETE_WORD_FORWARD;
      break;
    case "clear":
      input = EVENT_CLEAR;
      break;
    case "move_caret":
      input = EVENT_MOVE_CARET;
      flags = caretFlags(event.move.direction, event.move.extend);
      break;
    case "set_selection":
      input = EVENT_SET_SELECTION;
      anchor = event.selection.anchor;
      focus = event.selection.focus;
      break;
    case "set_composition":
      input = EVENT_SET_COMPOSITION;
      text = event.text;
      cursor = event.cursor ?? event.text.length;
      break;
    case "commit_composition":
      input = EVENT_COMMIT_COMPOSITION;
      break;
    case "cancel_composition":
      input = EVENT_CANCEL_COMPOSITION;
      break;
  }
  if (text.length > EVENT_TEXT_BYTES) return null;
  return { input, flags, anchor, focus, cursor, text };
}

function caretFlags(
  direction: TextCaretDirection,
  extend: boolean,
): number {
  let flags = 0;
  switch (direction) {
    case "previous":
      flags = 1;
      break;
    case "next":
      flags = 2;
      break;
    case "previous_word":
      flags = 3;
      break;
    case "next_word":
      flags = 4;
      break;
    case "start":
      flags = 5;
      break;
    case "end":
      flags = 6;
      break;
  }
  return extend ? flags + 256 : flags;
}
