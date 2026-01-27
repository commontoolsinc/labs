/**
 * VDOM protocol types for IPC between worker and main thread.
 *
 * This module exports the message types and utilities for VDOM IPC.
 * The reconciler and rendering logic have moved to @commontools/html.
 */

// Operations
export type {
  CreateElementOp,
  CreateTextOp,
  InsertChildOp,
  MoveChildOp,
  RemoveEventOp,
  RemoveNodeOp,
  RemovePropOp,
  SetAttrsOp,
  SetBindingOp,
  SetEventOp,
  SetPropOp,
  UpdateTextOp,
  VDomBatch,
  VDomOp,
} from "./operations.ts";
export { isVDomBatch, isVDomOp } from "./operations.ts";

// Events
export type {
  DomEventMessage,
  SerializedEvent,
  SerializedEventTarget,
} from "./events.ts";
export {
  ALLOWLISTED_EVENT_PROPERTIES,
  ALLOWLISTED_TARGET_PROPERTIES,
  isDomEventMessage,
  serializeEvent,
} from "./events.ts";
