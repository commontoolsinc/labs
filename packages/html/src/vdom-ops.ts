/**
 * VDOM operation types for IPC between worker and main thread.
 *
 * These operations describe DOM mutations that need to be applied
 * on the main thread. They are batched and sent as a single message.
 */

import type { CellRef, JSONValue } from "@commontools/runtime-client";

/**
 * Create a new DOM element.
 */
export interface CreateElementOp {
  op: "create-element";
  nodeId: number;
  tagName: string;
}

/**
 * Create a new text node.
 */
export interface CreateTextOp {
  op: "create-text";
  nodeId: number;
  text: string;
}

/**
 * Update the text content of a text node.
 */
export interface UpdateTextOp {
  op: "update-text";
  nodeId: number;
  text: string;
}

/**
 * Set a property on an element.
 */
export interface SetPropOp {
  op: "set-prop";
  nodeId: number;
  key: string;
  value: JSONValue;
}

/**
 * Remove a property from an element.
 */
export interface RemovePropOp {
  op: "remove-prop";
  nodeId: number;
  key: string;
}

/**
 * Set up an event listener on an element.
 * Events will be serialized and sent back to the worker.
 */
export interface SetEventOp {
  op: "set-event";
  nodeId: number;
  eventType: string;
  handlerId: number;
}

/**
 * Remove an event listener from an element.
 */
export interface RemoveEventOp {
  op: "remove-event";
  nodeId: number;
  eventType: string;
}

/**
 * Set up a bidirectional binding on an element.
 * The main thread will create a CellHandle from the cellRef
 * and pass it to the element's property.
 */
export interface SetBindingOp {
  op: "set-binding";
  nodeId: number;
  propName: string;
  cellRef: CellRef;
}

/**
 * Insert a child node into a parent.
 * If beforeId is null, appends to the end.
 */
export interface InsertChildOp {
  op: "insert-child";
  parentId: number;
  childId: number;
  beforeId: number | null;
}

/**
 * Move an existing child to a new position.
 * If beforeId is null, moves to the end.
 */
export interface MoveChildOp {
  op: "move-child";
  parentId: number;
  childId: number;
  beforeId: number | null;
}

/**
 * Remove a node from the DOM.
 */
export interface RemoveNodeOp {
  op: "remove-node";
  nodeId: number;
}

/**
 * Set multiple attributes at once (optimization for initial render).
 */
export interface SetAttrsOp {
  op: "set-attrs";
  nodeId: number;
  attrs: Record<string, JSONValue>;
}

/**
 * Union of all VDOM operations.
 */
export type VDomOp =
  | CreateElementOp
  | CreateTextOp
  | UpdateTextOp
  | SetPropOp
  | RemovePropOp
  | SetEventOp
  | RemoveEventOp
  | SetBindingOp
  | InsertChildOp
  | MoveChildOp
  | RemoveNodeOp
  | SetAttrsOp;

/**
 * A batch of VDOM operations to be applied atomically.
 */
export interface VDomBatch {
  /** Identifier for this batch (for debugging/logging) */
  batchId: number;

  /** The operations to apply, in order */
  ops: VDomOp[];

  /** Optional: the root node ID for this render tree */
  rootId?: number;
}

/**
 * Type guard for VDomOp.
 */
export function isVDomOp(value: unknown): value is VDomOp {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const op = (value as VDomOp).op;
  return (
    op === "create-element" ||
    op === "create-text" ||
    op === "update-text" ||
    op === "set-prop" ||
    op === "remove-prop" ||
    op === "set-event" ||
    op === "remove-event" ||
    op === "set-binding" ||
    op === "insert-child" ||
    op === "move-child" ||
    op === "remove-node" ||
    op === "set-attrs"
  );
}

/**
 * Type guard for VDomBatch.
 */
export function isVDomBatch(value: unknown): value is VDomBatch {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const batch = value as VDomBatch;
  return (
    typeof batch.batchId === "number" &&
    Array.isArray(batch.ops) &&
    batch.ops.every(isVDomOp)
  );
}
