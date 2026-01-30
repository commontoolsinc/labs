/**
 * Worker-side VDOM reconciler.
 *
 * This reconciler runs in the worker thread where Cell values can be
 * accessed synchronously. It emits VDomOp operations that are batched
 * and sent to the main thread for DOM application.
 *
 * Key differences from main-thread render.ts:
 * - Uses Cell directly instead of CellHandle
 * - Uses cell.sink() instead of effect() for subscriptions
 * - Emits VDomOp operations instead of DOM mutations
 * - Batches operations using queueMicrotask()
 */

import {
  type Cancel,
  type Cell,
  convertCellsToLinks,
  isCell,
  isStream,
  type Stream,
  UI,
  useCancelGroup,
} from "@commontools/runner";
import type {
  ChildNodeState,
  NodeState,
  ReconcileContext,
  WorkerProps,
  WorkerReconcilerOptions,
  WorkerRenderNode,
  WorkerVNode,
} from "./types.ts";
import { isWorkerVNode } from "./types.ts";
import type { VDomOp } from "../vdom-ops.ts";
import { generateChildKeys } from "./keying.ts";
import {
  getBindingPropName,
  getEventType,
  isBindingProp,
  isEventHandler,
  isEventProp,
} from "../render-utils.ts";

/**
 * Reserved node ID for the container element.
 * The main thread registers the actual container DOM element with this ID.
 */
export const CONTAINER_NODE_ID = 0;

/**
 * Main reconciler class for worker-side VDOM rendering.
 */
export class WorkerReconciler {
  private nodeIdCounter = 0;
  private handlerIdCounter = 0;
  private handlers = new Map<number, (event: unknown) => void>();
  private batchIdCounter = 0;

  private pendingOps: VDomOp[] = [];
  private flushScheduled = false;

  // Track the actual root child node (not the container)
  private rootChildId: number | null = null;
  private rootCancel: Cancel | null = null;

  private readonly onOps: (ops: VDomOp[]) => void;
  private readonly onError?: (error: Error) => void;

  constructor(options: WorkerReconcilerOptions) {
    this.onOps = options.onOps;
    this.onError = options.onError;
  }

  /**
   * Create a reconciliation context for this reconciler instance.
   */
  private createContext(): ReconcileContext {
    return {
      emit: (ops) => this.queueOps(ops),
      nextNodeId: () => ++this.nodeIdCounter,
      registerHandler: (handler) => {
        const id = ++this.handlerIdCounter;
        this.handlers.set(id, handler);
        return id;
      },
      unregisterHandler: (id) => {
        this.handlers.delete(id);
      },
      getHandler: (id) => this.handlers.get(id),
    };
  }

  /**
   * Mount a VDOM tree, starting the reconciliation process.
   * Children are inserted directly into the container (CONTAINER_NODE_ID).
   *
   * @param vnode - The root VNode, Cell<VNode>, or Cell<unknown> to mount
   * @returns A cancel function to unmount the tree
   */
  mount(vnode: WorkerVNode | Cell<WorkerVNode> | Cell<unknown>): Cancel {
    if (this.rootCancel) {
      this.rootCancel();
    }

    const ctx = this.createContext();
    const [cancel, addCancel] = useCancelGroup();

    // Handle Cell<VNode> at the root
    if (isCell(vnode)) {
      // Create a wrapper state that tracks the current child in the container
      const wrapperState = this.createWrapperState(ctx, CONTAINER_NODE_ID);

      addCancel(
        vnode.sink((resolvedVnode: unknown) => {
          if (!resolvedVnode) return;
          // Validate that the resolved value is a valid render node
          if (!this.isValidRenderNode(resolvedVnode)) {
            this.onError?.(
              new Error(
                `Invalid VDOM content: expected WorkerVNode, string, or number, got ${typeof resolvedVnode}`,
              ),
            );
            return;
          }
          this.reconcileIntoWrapper(
            ctx,
            wrapperState,
            resolvedVnode as WorkerRenderNode,
          );
          // Track the root child for cleanup
          this.rootChildId = wrapperState.currentChild?.nodeId ?? null;
        }),
      );
    } else {
      // Static VNode - render directly into container
      const state = this.renderNode(ctx, vnode, new Set());
      if (state) {
        addCancel(state.cancel);
        this.rootChildId = state.nodeId;
        this.queueOps([
          {
            op: "insert-child",
            parentId: CONTAINER_NODE_ID,
            childId: state.nodeId,
            beforeId: null,
          },
        ]);
      }
    }

    // Flush any pending operations
    this.scheduleFlush();

    this.rootCancel = cancel;
    return cancel;
  }

  /**
   * Check if a value is a valid render node (VNode, string, number, object with [UI], or null/undefined).
   */
  private isValidRenderNode(value: unknown): value is WorkerRenderNode {
    if (value === null || value === undefined) return true;
    if (typeof value === "string" || typeof value === "number") return true;
    if (typeof value === "boolean") return true;
    if (isWorkerVNode(value)) return true;
    if (Array.isArray(value)) {
      return value.every((item) => this.isValidRenderNode(item));
    }
    if (isCell(value)) return true;
    // Accept objects with [UI] property - will be unwrapped in renderNode
    if (typeof value === "object" && UI in value) return true;
    return false;
  }

  /**
   * Unmount the current VDOM tree.
   */
  unmount(): void {
    if (this.rootCancel) {
      this.rootCancel();
      this.rootCancel = null;
    }
    if (this.rootChildId !== null) {
      this.queueOps([{ op: "remove-node", nodeId: this.rootChildId }]);
      this.rootChildId = null;
    }
    this.flushOps();
  }

  /**
   * Dispatch a DOM event to its handler.
   */
  dispatchEvent(handlerId: number, event: unknown): void {
    const handler = this.handlers.get(handlerId);
    if (handler) {
      try {
        handler(event);
      } catch (error) {
        this.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  /**
   * Get the root child node ID (the actual rendered content).
   */
  getRootNodeId(): number | null {
    return this.rootChildId;
  }

  // ============== Private Methods ==============

  /**
   * Queue operations to be sent to the main thread.
   */
  private queueOps(ops: VDomOp[]): void {
    this.pendingOps.push(...ops);
    this.scheduleFlush();
  }

  /**
   * Schedule a flush of pending operations.
   */
  private scheduleFlush(): void {
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flushOps());
    }
  }

  /**
   * Flush all pending operations to the main thread.
   */
  private flushOps(): void {
    this.flushScheduled = false;
    if (this.pendingOps.length > 0) {
      const ops = this.pendingOps;
      this.pendingOps = [];
      this.onOps(ops);
    }
  }

  /**
   * Clean up event handlers for a node and its descendants.
   */
  private cleanupNodeHandlers(state: NodeState | ChildNodeState): void {
    // Clean up element state handlers if present
    const elementState = "elementState" in state ? state.elementState : state;
    if (elementState && "eventHandlers" in elementState) {
      for (const handlerId of elementState.eventHandlers.values()) {
        this.handlers.delete(handlerId);
      }
      elementState.eventHandlers.clear();

      // Recursively clean up children
      if (elementState.children) {
        for (const child of elementState.children.values()) {
          this.cleanupNodeHandlers(child);
        }
      }
    }
  }

  /**
   * Create a wrapper state for reactive roots.
   */
  private createWrapperState(_ctx: ReconcileContext, nodeId: number): {
    nodeId: number;
    currentChild: NodeState | ChildNodeState | null;
    cancel: Cancel;
  } {
    return {
      nodeId,
      currentChild: null,
      cancel: () => {},
    };
  }

  /**
   * Extract the underlying VNode from a WorkerRenderNode.
   * Follows [UI] chains and returns the VNode, or null if not a VNode.
   */
  private extractVNode(node: WorkerRenderNode): WorkerVNode | null {
    if (isWorkerVNode(node)) return node;

    // Follow [UI] chain
    let current: unknown = node;
    while (current && typeof current === "object" && UI in current) {
      // deno-lint-ignore no-explicit-any
      current = (current as any)[UI];
    }

    return isWorkerVNode(current) ? current : null;
  }

  /**
   * Reconcile a VNode into a wrapper (for reactive roots).
   * Diffs old vs new VNodes and updates in place when possible.
   */
  private reconcileIntoWrapper(
    ctx: ReconcileContext,
    wrapper: {
      nodeId: number;
      currentChild: NodeState | ChildNodeState | null;
      cancel: Cancel;
    },
    node: WorkerRenderNode,
  ): void {
    const newVNode = this.extractVNode(node);
    const oldState = wrapper.currentChild;

    // Get old element's tag name (if it exists and is an element)
    const oldTagName = oldState && "tagName" in oldState
      ? oldState.tagName
      : null;
    const newTagName = newVNode?.name ?? null;

    // Case 1: Same element type AND we have a full NodeState - update in place
    if (
      oldState &&
      oldTagName &&
      newTagName &&
      oldTagName === newTagName &&
      "children" in oldState // Has full NodeState (not just ChildNodeState)
    ) {
      const elementState = oldState as NodeState;

      // Save the children map before cancel clears it
      const savedChildren = new Map(elementState.children);

      // Cancel old subscriptions
      wrapper.cancel();

      // Restore the children map so keyed reconciliation can work
      elementState.children = savedChildren;

      // Clear old event handlers (they'll be re-registered by bindProps)
      for (const handlerId of elementState.eventHandlers.values()) {
        ctx.unregisterHandler(handlerId);
      }
      elementState.eventHandlers.clear();

      // Set up new subscriptions
      const [cancel, addCancel] = useCancelGroup();

      // Update props
      const sanitized = this.sanitizeNode(newVNode!);
      if (sanitized) {
        addCancel(this.bindProps(ctx, elementState, sanitized.props));

        // Update children using existing keyed reconciliation
        // This will reuse existing children where possible via keying
        if (sanitized.children !== undefined) {
          addCancel(
            this.bindChildren(ctx, elementState, sanitized.children, new Set()),
          );
        }
      }

      wrapper.cancel = cancel;
      return;
    }

    // Case 2: Different type, text node, array, or no previous - destroy and recreate
    if (wrapper.currentChild) {
      wrapper.cancel();
      this.cleanupNodeHandlers(wrapper.currentChild);
      this.queueOps([{
        op: "remove-node",
        nodeId: wrapper.currentChild.nodeId,
      }]);
    }

    // Render new node - renderNode handles all render node types
    const state = this.renderNode(ctx, node, new Set());

    if (state) {
      this.queueOps([
        {
          op: "insert-child",
          parentId: wrapper.nodeId,
          childId: state.nodeId,
          beforeId: null,
        },
      ]);
      wrapper.currentChild = state;
      // Use the state's cancel function directly - it owns all child subscriptions
      wrapper.cancel = state.cancel;
    }
  }

  /**
   * Render any render node type and return its state.
   */
  private renderNode(
    ctx: ReconcileContext,
    inputNode: WorkerRenderNode,
    visited: Set<object>,
  ): NodeState | null {
    // Handle null/undefined
    if (inputNode === null || inputNode === undefined) {
      return null;
    }

    // Handle text nodes (strings and numbers)
    if (typeof inputNode === "string" || typeof inputNode === "number") {
      return this.createTextNode(ctx, String(inputNode));
    }

    // Handle arrays - render as fragment wrapper
    if (Array.isArray(inputNode)) {
      return this.renderArrayAsFragment(ctx, inputNode, visited);
    }

    const [cancel, addCancel] = useCancelGroup();

    // Follow [UI] chain (for objects with $UI property)
    let node: unknown = inputNode;
    while (
      node &&
      typeof node === "object" &&
      UI in node &&
      // deno-lint-ignore no-explicit-any
      (node as any)[UI]
    ) {
      if (visited.has(node as object)) {
        return this.createCyclePlaceholder(ctx);
      }
      visited.add(node as object);
      // deno-lint-ignore no-explicit-any
      node = (node as any)[UI];
    }

    // After following [UI] chain, node may have become a primitive
    if (typeof node === "string" || typeof node === "number") {
      return this.createTextNode(ctx, String(node));
    }
    if (node === null || node === undefined || typeof node === "boolean") {
      return null;
    }
    if (Array.isArray(node)) {
      return this.renderArrayAsFragment(
        ctx,
        node as WorkerRenderNode[],
        visited,
      );
    }

    // Handle Cell<VNode> - this path should be unreachable in practice
    // since Cell children go through renderChild → renderCellChild
    if (isCell(node)) {
      throw new Error(
        "Unexpected Cell in renderNode - this code path was thought to be unreachable. " +
          "Please report this issue.",
      );
    }

    // Now node must be an object (WorkerVNode)
    if (typeof node !== "object") {
      return null;
    }

    // Check for cycles
    if (visited.has(node as object)) {
      return this.createCyclePlaceholder(ctx);
    }
    visited.add(node as object);

    // Sanitize node
    const sanitized = this.sanitizeNode(node as WorkerVNode);
    if (!sanitized) {
      return null;
    }

    // Create element
    const nodeId = ctx.nextNodeId();
    this.queueOps([{ op: "create-element", nodeId, tagName: sanitized.name }]);

    // Create state
    const state: NodeState = {
      nodeId,
      tagName: sanitized.name,
      cancel,
      children: new Map(),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
    };

    // Bind props
    addCancel(this.bindProps(ctx, state, sanitized.props));

    // Bind children
    if (sanitized.children !== undefined) {
      addCancel(this.bindChildren(ctx, state, sanitized.children, visited));
    }

    return state;
  }

  /**
   * Create a placeholder for circular references.
   */
  private createCyclePlaceholder(ctx: ReconcileContext): NodeState {
    const nodeId = ctx.nextNodeId();
    this.queueOps([
      { op: "create-element", nodeId, tagName: "span" },
      { op: "set-prop", nodeId, key: "textContent", value: "\uD83D\uDD04" }, // 🔄
      {
        op: "set-prop",
        nodeId,
        key: "title",
        value: "Circular reference detected",
      },
    ]);

    return {
      nodeId,
      tagName: "span",
      cancel: () => {},
      children: new Map(),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
    };
  }

  /**
   * Create a text node.
   */
  private createTextNode(ctx: ReconcileContext, text: string): NodeState {
    const nodeId = ctx.nextNodeId();
    this.queueOps([{ op: "create-text", nodeId, text }]);

    return {
      nodeId,
      tagName: "#text",
      cancel: () => {},
      children: new Map(),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
    };
  }

  /**
   * Render an array of nodes as a fragment wrapper.
   */
  private renderArrayAsFragment(
    ctx: ReconcileContext,
    nodes: WorkerRenderNode[],
    visited: Set<object>,
  ): NodeState | null {
    const nodeId = ctx.nextNodeId();
    this.queueOps([
      { op: "create-element", nodeId, tagName: "ct-fragment" },
    ]);

    const [cancel, addCancel] = useCancelGroup();

    const state: NodeState = {
      nodeId,
      tagName: "ct-fragment",
      cancel,
      children: new Map(),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
    };

    // Render each child and insert it
    for (const childNode of nodes) {
      const childState = this.renderNode(ctx, childNode, new Set(visited));
      if (childState) {
        addCancel(childState.cancel);
        this.queueOps([
          {
            op: "insert-child",
            parentId: nodeId,
            childId: childState.nodeId,
            beforeId: null,
          },
        ]);
      }
    }

    return state;
  }

  /**
   * Sanitize a VNode, ensuring it has valid structure.
   */
  private sanitizeNode(node: WorkerVNode): WorkerVNode | null {
    if (node.type !== "vnode" || node.name === "script") {
      return null;
    }

    // Fragments appear as VNodes with no name property
    let result = node;
    if (!result.name) {
      result = { ...result, name: "ct-fragment" };
    }

    // Ensure props is an object or Cell
    if (
      !isCell(result.props) &&
      (typeof result.props !== "object" || result.props === null)
    ) {
      result = { ...result, props: {} };
    }

    // Ensure children is an array or Cell
    if (!isCell(result.children) && !Array.isArray(result.children)) {
      result = { ...result, children: [] };
    }

    return result;
  }

  /**
   * Bind props to an element, handling reactive values and events.
   */
  private bindProps(
    ctx: ReconcileContext,
    state: NodeState,
    props: WorkerProps | Cell<WorkerProps> | null,
  ): Cancel {
    if (!props) return () => {};

    const [cancel, addCancel] = useCancelGroup();

    // Handle Cell<Props>
    if (isCell(props)) {
      let currentPropsCancel: Cancel | undefined;
      addCancel(
        props.sink((resolvedProps) => {
          if (currentPropsCancel) {
            currentPropsCancel();
            currentPropsCancel = undefined;
          }
          if (resolvedProps) {
            currentPropsCancel = this.bindProps(
              ctx,
              state,
              resolvedProps as WorkerProps,
            );
            addCancel(currentPropsCancel);
          }
        }),
      );
      return cancel;
    }

    // Handle static props
    if (typeof props !== "object") {
      return cancel;
    }

    for (const [key, value] of Object.entries(props)) {
      if (isEventProp(key)) {
        const eventType = getEventType(key);

        // Handle Streams (actions) - wrap in a handler that calls .send()
        if (isStream(value)) {
          const stream = value as Stream<unknown>;
          const handlerId = ctx.registerHandler((event: unknown) => {
            stream.send(event);
          });
          state.eventHandlers.set(eventType, handlerId);
          this.queueOps([{
            op: "set-event",
            nodeId: state.nodeId,
            eventType,
            handlerId,
          }]);
        } else if (isEventHandler(value)) {
          // Plain function event handler
          const handlerId = ctx.registerHandler(value);
          state.eventHandlers.set(eventType, handlerId);
          this.queueOps([{
            op: "set-event",
            nodeId: state.nodeId,
            eventType,
            handlerId,
          }]);
        } else if (isCell(value)) {
          // Cell containing event handler - not common but handle it
          const eventType = getEventType(key);
          addCancel(
            (value as Cell<(event: unknown) => void>).sink((handler) => {
              if (handler) {
                // Cast handler to mutable function type for registration
                const handlerId = ctx.registerHandler(
                  handler as (event: unknown) => void,
                );
                state.eventHandlers.set(eventType, handlerId);
                this.queueOps([{
                  op: "set-event",
                  nodeId: state.nodeId,
                  eventType,
                  handlerId,
                }]);
              }
            }),
          );
        }
      } else if (isBindingProp(key)) {
        // Bidirectional binding ($prop)
        const propName = getBindingPropName(key);
        if (isCell(value)) {
          const cellRef = value.getAsNormalizedFullLink();
          this.queueOps([{
            op: "set-binding",
            nodeId: state.nodeId,
            propName,
            cellRef,
          }]);
        }
      } else if (isCell(value)) {
        // Reactive prop value
        addCancel(
          (value as Cell<unknown>).sink((resolvedValue) => {
            const propValue = this.transformPropValue(key, resolvedValue);
            this.queueOps([{
              op: "set-prop",
              nodeId: state.nodeId,
              key,
              value: propValue,
            }]);
          }),
        );
      } else {
        // Static prop value
        const propValue = this.transformPropValue(key, value);
        this.queueOps([{
          op: "set-prop",
          nodeId: state.nodeId,
          key,
          value: propValue,
        }]);
      }
    }

    return cancel;
  }

  /**
   * Transform a prop value for sending over IPC.
   * Ensures the value can be cloned via postMessage.
   */
  // deno-lint-ignore no-explicit-any
  private transformPropValue(key: string, value: unknown): any {
    if (
      key === "style" && value && typeof value === "object" &&
      !Array.isArray(value)
    ) {
      return this.styleObjectToCssString(value as Record<string, unknown>);
    }
    // Use convertCellsToLinks to handle Cells, circular refs, and non-JSON values.
    // Pass doNotConvertCellResults to prevent already-resolved values (from .sink())
    // from being converted back to links - we want the actual data for props.
    return convertCellsToLinks(value, {
      doNotConvertCellResults: true,
      includeSchema: true,
      keepStreams: true,
    });
  }

  /**
   * Convert a style object to a CSS string.
   */
  private styleObjectToCssString(styleObject: Record<string, unknown>): string {
    const unitlessProperties = new Set([
      "animation-iteration-count",
      "column-count",
      "fill-opacity",
      "flex",
      "flex-grow",
      "flex-shrink",
      "font-weight",
      "line-height",
      "opacity",
      "order",
      "orphans",
      "stroke-opacity",
      "widows",
      "z-index",
      "zoom",
    ]);

    return Object.entries(styleObject)
      .map(([key, value]) => {
        if (value == null) return "";

        let cssKey = key;
        if (!key.startsWith("--")) {
          if (/^(webkit|moz|ms|o)[A-Z]/.test(key)) {
            cssKey = "-" + key;
          }
          cssKey = cssKey.replace(/([A-Z])/g, "-$1").toLowerCase();
        }

        let cssValue = value;
        if (
          typeof value === "number" &&
          !cssKey.startsWith("--") &&
          !unitlessProperties.has(cssKey) &&
          value !== 0
        ) {
          cssValue = `${value}px`;
        } else {
          cssValue = String(value);
        }

        return `${cssKey}: ${cssValue}`;
      })
      .filter((s) => s !== "")
      .join("; ");
  }

  /**
   * Bind children to an element with keyed reconciliation.
   */
  private bindChildren(
    ctx: ReconcileContext,
    state: NodeState,
    children: WorkerRenderNode | WorkerRenderNode[],
    visited: Set<object>,
  ): Cancel {
    const [cancel, addCancel] = useCancelGroup();

    // Handle Cell<children>
    if (isCell(children)) {
      addCancel(
        (children as Cell<WorkerRenderNode | WorkerRenderNode[]>).sink(
          (resolvedChildren) => {
            this.updateChildren(ctx, state, resolvedChildren, visited);
          },
        ),
      );
    } else {
      // Static children
      this.updateChildren(ctx, state, children, visited);
    }

    // When this cancel is called, also cancel all current children.
    // This ensures child sinks are cleaned up when the parent render tree
    // is torn down (e.g., during reconcileIntoWrapper).
    addCancel(() => {
      for (const [, childState] of state.children) {
        childState.cancel();
      }
      state.children.clear();
    });

    return cancel;
  }

  /**
   * Find the nodeId of the next sibling after the given key.
   * Used for position-aware insertion of reactive children.
   */
  private findNextSiblingId(
    children: Map<string, ChildNodeState>,
    afterKey: string,
  ): number | null {
    const entries = Array.from(children.entries());
    const myIndex = entries.findIndex(([key]) => key === afterKey);
    if (myIndex === -1) return null;

    // Look for next sibling with valid nodeId
    for (let i = myIndex + 1; i < entries.length; i++) {
      const [, sibling] = entries[i];
      if (sibling.nodeId !== -1) return sibling.nodeId;
    }
    return null;
  }

  /**
   * Update children with keyed reconciliation.
   */
  private updateChildren(
    ctx: ReconcileContext,
    state: NodeState,
    childrenValue:
      | WorkerRenderNode
      | WorkerRenderNode[]
      | Readonly<WorkerRenderNode | WorkerRenderNode[]>
      | null
      | undefined,
    visited: Set<object>,
  ): void {
    // Normalize to array
    const newChildren = Array.isArray(childrenValue)
      ? childrenValue
      : childrenValue
      ? [childrenValue]
      : [];

    // Generate keys for new children
    const newKeys = generateChildKeys(newChildren);
    const newMapping = new Map<string, ChildNodeState>();
    const newKeyOrder: string[] = [];

    // Process each new child
    for (let i = 0; i < newChildren.length; i++) {
      const child = newChildren[i];
      const key = newKeys[i];
      newKeyOrder.push(key);

      if (state.children.has(key)) {
        // Reuse existing child
        const existingState = state.children.get(key)!;
        newMapping.set(key, existingState);
        state.children.delete(key);

        // Update if it's an element with new data
        // (For now, we trust the key - updates happen through Cell subscriptions)
      } else {
        // Create new child, passing parent state and key for position tracking
        const childState = this.renderChild(ctx, child, visited, state, key);
        if (childState) {
          newMapping.set(key, childState);
        }
      }
    }

    // Remove obsolete children
    for (const [_, oldState] of state.children) {
      oldState.cancel();
      this.cleanupNodeHandlers(oldState);
      this.queueOps([{ op: "remove-node", nodeId: oldState.nodeId }]);
    }

    // Update children order by inserting from END to BEGINNING.
    // This ensures each insertBefore has a valid reference node.
    // Processing in reverse means each child is inserted before the
    // previously processed child (which is already in the DOM).
    let nextNodeId: number | null = null;
    for (let i = newKeyOrder.length - 1; i >= 0; i--) {
      const key = newKeyOrder[i];
      const childState = newMapping.get(key);
      if (!childState) continue;

      // Insert this child before the next one (or append if it's the last)
      this.queueOps([
        {
          op: "insert-child",
          parentId: state.nodeId,
          childId: childState.nodeId,
          beforeId: nextNodeId,
        },
      ]);

      nextNodeId = childState.nodeId;
    }

    // Update state
    state.children = newMapping;
  }

  /**
   * Render a child node (which may be a VNode, text, or Cell).
   * For Cell children, uses position-aware insertion instead of wrapper elements.
   */
  private renderChild(
    ctx: ReconcileContext,
    child: unknown,
    visited: Set<object>,
    parentState: NodeState,
    childKey: string,
  ): ChildNodeState | null {
    // Handle Cell children - no wrapper, track position dynamically
    if (isCell(child)) {
      return this.renderCellChild(
        ctx,
        child as Cell<unknown>,
        visited,
        parentState,
        childKey,
      );
    }

    // Handle non-Cell content
    return this.renderChildContent(ctx, child, visited);
  }

  /**
   * Render a Cell child with position-aware updates (no wrapper element).
   */
  private renderCellChild(
    ctx: ReconcileContext,
    cell: Cell<unknown>,
    visited: Set<object>,
    parentState: NodeState,
    childKey: string,
  ): ChildNodeState {
    const [cancel, addCancel] = useCancelGroup();

    // Create child state that will track the current node
    // nodeId will be set synchronously when sink fires
    const childState: ChildNodeState = {
      nodeId: -1,
      isText: false,
      cancel,
    };

    let currentCancel: Cancel | undefined;

    addCancel(
      cell.sink((resolvedChild) => {
        const isInitialRender = childState.nodeId === -1;

        // Clean up previous (skip if initial render - nothing to clean)
        if (!isInitialRender) {
          if (currentCancel) {
            currentCancel();
            currentCancel = undefined;
          }
          // Clean up event handlers before removing node
          this.cleanupNodeHandlers(childState);
          this.queueOps([{ op: "remove-node", nodeId: childState.nodeId }]);
        }

        // Reset nodeId
        childState.nodeId = -1;
        childState.elementState = undefined;

        if (resolvedChild === null || resolvedChild === undefined) {
          return;
        }

        // Render new content
        const newState = this.renderChildContent(
          ctx,
          resolvedChild,
          new Set(visited),
        );
        if (newState) {
          childState.nodeId = newState.nodeId;
          childState.elementState = newState.elementState;
          currentCancel = newState.cancel;

          // Only insert on subsequent updates, not initial render.
          // Initial render is handled by updateChildren's backward iteration
          // which ensures correct ordering of all children.
          if (!isInitialRender) {
            const beforeId = this.findNextSiblingId(
              parentState.children,
              childKey,
            );
            this.queueOps([
              {
                op: "insert-child",
                parentId: parentState.nodeId,
                childId: newState.nodeId,
                beforeId,
              },
            ]);
          }
        }
      }),
    );

    // When the cancel group fires (parent teardown), also cancel the current
    // rendered content. Without this, deeper sinks (e.g. children/props of the
    // rendered content) leak because currentCancel is only called on re-fire
    // inside the sink callback, not on teardown.
    addCancel(() => {
      if (currentCancel) {
        currentCancel();
        currentCancel = undefined;
      }
    });

    return childState;
  }

  /**
   * Render non-Cell child content (VNode, array, text, etc).
   */
  private renderChildContent(
    ctx: ReconcileContext,
    child: unknown,
    visited: Set<object>,
  ): ChildNodeState | null {
    // Handle arrays - wrap in a span with display:contents
    if (Array.isArray(child)) {
      const wrapperVNode: WorkerVNode = {
        type: "vnode",
        name: "span",
        props: { style: "display:contents" },
        children: child,
      };
      const state = this.renderNode(ctx, wrapperVNode, new Set(visited));
      if (!state) return null;

      return {
        nodeId: state.nodeId,
        isText: false,
        cancel: state.cancel,
        elementState: state,
      };
    }

    // Handle VNode
    if (isWorkerVNode(child)) {
      const state = this.renderNode(ctx, child, new Set(visited));
      if (!state) return null;

      return {
        nodeId: state.nodeId,
        isText: false,
        cancel: state.cancel,
        elementState: state,
      };
    }

    // Handle objects with [UI] property (pattern outputs)
    // deno-lint-ignore no-explicit-any
    if (
      child && typeof child === "object" && UI in child && (child as any)[UI]
    ) {
      const state = this.renderNode(
        ctx,
        child as WorkerRenderNode,
        new Set(visited),
      );
      if (!state) return null;

      return {
        nodeId: state.nodeId,
        isText: false,
        cancel: state.cancel,
        elementState: state,
      };
    }

    // Cell<Cell<X>> shouldn't happen - Cell chains are resolved by runtime.
    // If we hit this, it's likely a bug - throw to surface it.
    if (isCell(child)) {
      throw new Error(
        "Unexpected Cell in renderChildContent - Cell chains should be resolved by runtime. " +
          "Please report this issue.",
      );
    }

    // Handle primitive values (text nodes)
    const text = this.stringifyText(child);
    const nodeId = ctx.nextNodeId();
    this.queueOps([{ op: "create-text", nodeId, text }]);

    return {
      nodeId,
      isText: true,
      cancel: () => {},
    };
  }

  /**
   * Convert a primitive value to text content.
   */
  private stringifyText(value: unknown): string {
    if (typeof value === "string") {
      return value;
    } else if (value === null || value === undefined || value === false) {
      return "";
    } else if (typeof value === "object") {
      // Handle unresolved alias objects
      if (value && "$alias" in value) {
        return "";
      } else {
        console.warn("unexpected object when value was expected", value);
        return JSON.stringify(value);
      }
    }
    return String(value);
  }
}

/**
 * Create a new reconciler instance.
 */
export function createReconciler(
  options: WorkerReconcilerOptions,
): WorkerReconciler {
  return new WorkerReconciler(options);
}
