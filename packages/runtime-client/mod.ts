/**
 * Module for interacting with a runtime over some IPC, currently a web worker thread.
 */

export * from "./cell-handle.ts";
export * from "./page-handle.ts";
export * from "./runtime-client.ts";
export * from "./favorites-manager.ts";
export * from "./client/emitter.ts";
export * from "./client/transport.ts";
export * from "./client/connection.ts";
export * from "./protocol/mod.ts";
export * from "./vnode-types.ts";
export * from "@commontools/runner/shared";

// VDOM event types and utilities (DomEventMessage is not in protocol)
export type { DomEventMessage, SerializedEvent } from "./vdom-worker/events.ts";
export { isDomEventMessage, serializeEvent } from "./vdom-worker/events.ts";

// VDOM operation type guards and detailed interfaces (VDomOp union is in protocol)
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
} from "./vdom-worker/operations.ts";
export { isVDomBatch, isVDomOp } from "./vdom-worker/operations.ts";
