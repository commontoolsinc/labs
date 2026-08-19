/**
 * VDOM operation types for IPC between worker and main thread.
 *
 * These operations describe DOM mutations that need to be applied
 * on the main thread. They are batched and sent as a single message.
 */

import type { CellRef, JSONValue } from "@commonfabric/runtime-client";

/**
 * Create a new DOM element.
 */
export interface CreateElementOp {
  op: "create-element";
  nodeId: number;
  tagName: string;
  /**
   * The space of the cell whose render produced this element, present
   * only when it differs from the nearest ancestor element that
   * carried one. The applicator turns it into the element's context
   * space, so components inside a rendered pattern act in the PIECE's
   * space — correct across cross-space transclusion.
   */
  space?: string;
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
  // TODO(danfuzz): a prop is whatever a pattern put on a render node, so its
  // value is a `FabricValue`, and `JSONValue` narrows that to the
  // JSON-compatible subset. The producer (`transformPropValue()` in
  // `worker/reconciler.ts`) does not narrow to match: it hands over a
  // `FabricPrimitive` whole, and structured clone strips one to `{}` on the
  // way here. `codec-realm` is the mechanism, this batch crossing by
  // `postMessage` rather than as JSON text.
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

/** Associate a rendered nested pattern root with its whole result cell. */
export interface SetPieceBoundaryOp {
  op: "set-piece-boundary";
  nodeId: number;
  cellRef: CellRef;
}

/** Remove a nested pattern association from a reused root element. */
export interface ClearPieceBoundaryOp {
  op: "clear-piece-boundary";
  nodeId: number;
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
 * Remove a node from the DOM.
 */
export interface RemoveNodeOp {
  op: "remove-node";
  nodeId: number;
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
  | SetPieceBoundaryOp
  | ClearPieceBoundaryOp
  | InsertChildOp
  | RemoveNodeOp;

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
