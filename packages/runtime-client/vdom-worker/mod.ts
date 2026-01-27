/**
 * Worker-side VDOM module.
 *
 * This module provides the worker-thread implementation of the VDOM system,
 * where Cell values are accessed synchronously and VDOM operations are
 * emitted for the main thread to apply.
 */

// Types
export type {
  BindingCellRef,
  ChildNodeState,
  NodeState,
  ReconcileContext,
  WorkerJSXElement,
  WorkerProps,
  WorkerReconcilerOptions,
  WorkerRenderNode,
  WorkerVNode,
} from "./types.ts";
export { isWorkerVNode } from "./types.ts";

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

// Keying
export { generateChildKeys, generateKey, keysMatch } from "./keying.ts";

// JSX factory
export type { WorkerComponent, WorkerHFunction } from "./h.ts";
export {
  FRAGMENT_ELEMENT,
  getBindingPropName,
  getEventType,
  h,
  isBindingProp,
  isEventHandler,
  isEventProp,
} from "./h.ts";
export default "./h.ts";

// Reconciler
export { createReconciler, WorkerReconciler } from "./reconciler.ts";
