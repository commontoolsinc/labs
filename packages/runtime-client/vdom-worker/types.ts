/**
 * Worker-side VDOM types for the worker-thread rendering system.
 *
 * These types define the VDOM structure used in the worker thread,
 * where cells are accessed synchronously via cell.get() and cell.sink().
 */

import type { Cancel, Cell, JSONSchema } from "@commontools/runner";
import type { CellRef, JSONValue } from "../protocol/mod.ts";

/**
 * A render node in the worker VDOM tree.
 * Can be a VNode, a Cell that produces VNodes, or primitive values.
 */
export type WorkerRenderNode =
  | WorkerVNode
  | Cell<WorkerVNode>
  | Cell<WorkerRenderNode>
  | Cell<WorkerRenderNode[]>
  | WorkerRenderNode[]
  | string
  | number
  | boolean
  | null
  | undefined;

/**
 * Props for a worker VDOM node.
 * Values can be static or reactive (Cell).
 */
export type WorkerProps = {
  [key: string]:
    | JSONValue
    | Cell<JSONValue>
    | ((event: unknown) => void) // Event handlers
    | Cell<unknown>; // For $prop bindings
};

/**
 * A virtual DOM node in the worker thread.
 */
export interface WorkerVNode {
  type: "vnode";
  name: string;
  props: WorkerProps | Cell<WorkerProps> | null;
  children: WorkerRenderNode[];
}

/**
 * JSX element type for worker components.
 */
export type WorkerJSXElement = WorkerVNode | Cell<WorkerVNode>;

/**
 * Check if a value is a WorkerVNode.
 */
export function isWorkerVNode(value: unknown): value is WorkerVNode {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as WorkerVNode).type === "vnode"
  );
}

/**
 * State tracked for each rendered node in the worker reconciler.
 * This is used to manage subscriptions and track DOM node IDs.
 */
export interface NodeState {
  /** Unique ID for this node, used to reference the DOM element */
  nodeId: number;

  /** Tag name of the element */
  tagName: string;

  /** Cancel function for any subscriptions on this node */
  cancel: Cancel;

  /** Child states, keyed by their stable key */
  children: Map<string, ChildNodeState>;

  /** Props subscriptions */
  propSubscriptions: Map<string, Cancel>;

  /** Event handler IDs registered on this node */
  eventHandlers: Map<string, number>;
}

/**
 * State for a child node, which may be an element or text node.
 */
export interface ChildNodeState {
  /** The node's unique ID */
  nodeId: number;

  /** Whether this is a text node */
  isText: boolean;

  /** Cancel function for subscriptions */
  cancel: Cancel;

  /** For element nodes, the full node state */
  elementState?: NodeState;
}

/**
 * Context passed through the reconciliation process.
 */
export interface ReconcileContext {
  /** Function to emit VDOM operations */
  emit: (ops: import("./operations.ts").VDomOp[]) => void;

  /** Generate a new unique node ID */
  nextNodeId: () => number;

  /** Register an event handler and get its ID */
  registerHandler: (handler: (event: unknown) => void) => number;

  /** Get handler by ID for event dispatch */
  getHandler: (handlerId: number) => ((event: unknown) => void) | undefined;

  /** Optional document for SSR or testing */
  document?: Document;
}

/**
 * Options for the worker reconciler.
 */
export interface WorkerReconcilerOptions {
  /** Callback when operations are ready to send to main thread */
  onOps: (ops: import("./operations.ts").VDomOp[]) => void;

  /** Optional: callback when an error occurs */
  onError?: (error: Error) => void;
}

/**
 * Reference to a cell for bidirectional binding.
 * This is sent to the main thread so it can create a CellHandle.
 */
export interface BindingCellRef {
  cellRef: CellRef;
  schema?: JSONSchema;
}
