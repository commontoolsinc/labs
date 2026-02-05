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
  areLinksSame,
  type Cancel,
  type Cell,
  convertCellsToLinks,
  isCell,
  isStream,
  type Stream,
  UI,
  useCancelGroup,
} from "@commontools/runner";
import { getLogger } from "@commontools/utils/logger";
import type {
  ChildNodeState,
  NodeState,
  PropState,
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

const logger = getLogger("worker-reconciler", {
  enabled: false,
  level: "debug",
});

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
    logger.debug(
      "mount",
      () => ({
        vnodeType: isCell(vnode) ? this.getCellDebugId(vnode) : typeof vnode,
      }),
    );
    if (this.rootCancel) {
      this.rootCancel();
    }

    const ctx = this.createContext();
    const [cancel, addCancel] = useCancelGroup();

    // Handle Cell<VNode> at the root
    if (isCell(vnode)) {
      // Create a wrapper state that tracks the current child in the container
      const wrapperState = this.createWrapperState(ctx, CONTAINER_NODE_ID);

      // Ensure the current child is cancelled when the root is cancelled
      addCancel(() => wrapperState.cancel());

      addCancel(
        vnode.sink((resolvedVnode: unknown) => {
          logger.debug("root-cell-update", () => ({ resolvedVnode }));
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
    logger.debug("unmount", () => ({ rootChildId: this.rootChildId }));
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
      logger.debug("flush-ops", () => ({ count: ops.length, ops }));
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
   * Check if new children are structurally the same as existing children.
   * Used by Cell child VNode in-place update to decide whether to skip
   * children reconciliation (same children have active sinks) or do a
   * full replace (children changed).
   */
  private areChildrenSame(
    state: NodeState,
    newChildren: WorkerRenderNode | WorkerRenderNode[],
  ): boolean {
    // Cell<children>: same Cell link means same subscription
    if (isCell(newChildren)) {
      return !!(
        state.childrenState?.cell &&
        areLinksSame(state.childrenState.cell, newChildren)
      );
    }

    // Static children: compare keys
    const childArray = Array.isArray(newChildren) ? newChildren : [newChildren];
    const newKeys = generateChildKeys(childArray);

    if (newKeys.length !== state.childOrder.length) return false;
    return newKeys.every((key, i) => key === state.childOrder[i]);
  }

  /**
   * Create a wrapper state for reactive roots.
   */
  private createWrapperState(_ctx: ReconcileContext, nodeId: number): {
    nodeId: number;
    currentChild: NodeState | null;
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
   * Includes cycle detection to prevent infinite loops.
   */
  private extractVNode(node: WorkerRenderNode): WorkerVNode | null {
    if (isWorkerVNode(node)) return node;

    // Follow [UI] chain with cycle detection
    const visited = new Set<object>();
    let current: unknown = node;
    while (current && typeof current === "object" && UI in current) {
      if (visited.has(current as object)) {
        // Cycle detected, return null
        return null;
      }
      visited.add(current as object);
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
      currentChild: NodeState | null;
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

    logger.debug("reconcile-check", () => ({
      oldId: oldState?.nodeId,
      oldTagName,
      newTagName,
      match: Boolean(
        oldState && oldTagName && newTagName && oldTagName === newTagName,
      ),
      newVNodeName: newVNode?.name,
      oldStateHasTagName: oldState && "tagName" in oldState,
      isOldStateText: oldState?.tagName === "#text",
    }));

    // Case 1: Same element type - update in place
    if (oldState && oldTagName && newTagName && oldTagName === newTagName) {
      const sanitized = this.sanitizeNode(newVNode!);
      if (sanitized) {
        logger.debug("reconcile-node", () => ({
          id: wrapper.nodeId,
          strategy: "update-in-place",
          tagName: newTagName,
        }));
        // Update props in place with proper diffing
        this.updatePropsInPlace(ctx, oldState, sanitized.props);

        // Update children in place with proper diffing
        if (sanitized.children !== undefined) {
          this.updateChildrenInPlace(
            ctx,
            oldState,
            sanitized.children,
            new Set(),
          );
        }
        return;
      }
      // sanitized is null (e.g., script tag) - fall through to Case 2 to remove
    }

    // Case 2: Different type, text node, array, or no previous - destroy and recreate
    if (wrapper.currentChild) {
      logger.debug("reconcile-node", () => ({
        id: wrapper.nodeId,
        strategy: "replace",
        oldTag: oldTagName,
        newTag: newTagName,
      }));
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
   * Update props in place with proper diffing.
   * - Same Cell (via areLinksSame) → leave subscription alone
   * - Different Cell → cancel old subscription, set up new one
   * - Missing prop → cancel subscription, remove prop from DOM
   */
  private updatePropsInPlace(
    ctx: ReconcileContext,
    state: NodeState,
    newProps: WorkerProps | Cell<WorkerProps> | null,
  ): void {
    // Handle Cell<Props> - if same cell, do nothing; otherwise re-subscribe
    if (isCell(newProps)) {
      const existingState = state.propSubscriptions.get("__cellProps__");
      if (existingState?.cell && areLinksSame(existingState.cell, newProps)) {
        // Same Cell, leave subscription in place
        logger.debug("props-same-cell", () => ({ nodeId: state.nodeId }));
        return;
      }
      // Different Cell - cancel old and set up new
      if (existingState) {
        existingState.cancel();
        state.propSubscriptions.delete("__cellProps__");
      }
      // Clear all individual prop subscriptions since we're switching to Cell<Props>
      for (const [key, propState] of state.propSubscriptions) {
        if (key !== "__cellProps__") {
          propState.cancel();
        }
      }
      state.propSubscriptions.clear();

      // Set up new Cell<Props> subscription
      let currentPropsCancel: Cancel | undefined;
      const cancel = newProps.sink((resolvedProps) => {
        logger.debug(
          "cell-props-update",
          () => ({ nodeId: state.nodeId, props: resolvedProps }),
        );
        if (currentPropsCancel) {
          currentPropsCancel();
          currentPropsCancel = undefined;
        }
        if (resolvedProps) {
          // When Cell<Props> emits, update individual props
          this.updatePropsInPlace(ctx, state, resolvedProps as WorkerProps);
        }
      });
      state.propSubscriptions.set("__cellProps__", {
        cell: newProps as Cell<unknown>,
        cancel,
      });
      return;
    }

    // Handle static props object
    if (!newProps || typeof newProps !== "object") {
      // No props - remove all existing
      this.removeAllProps(ctx, state);
      return;
    }

    const newPropKeys = new Set(Object.keys(newProps));

    // Find props to remove (exist in old but not in new)
    for (const [key, propState] of state.propSubscriptions) {
      if (key === "__cellProps__") continue;
      if (!newPropKeys.has(key)) {
        // Prop removed - cancel subscription and remove from DOM
        propState.cancel();
        state.propSubscriptions.delete(key);
        // Unregister event handler if it was an event
        if (state.eventHandlers.has(key)) {
          ctx.unregisterHandler(state.eventHandlers.get(key)!);
          state.eventHandlers.delete(key);
        }
        // Send remove op
        this.queueOps([{
          op: "remove-prop",
          nodeId: state.nodeId,
          key,
        }]);
      }
    }

    // Update or add props
    for (const [key, value] of Object.entries(newProps)) {
      const existingState = state.propSubscriptions.get(key);

      if (isEventProp(key)) {
        // Event handlers - always re-register (they don't have Cell diffing)
        this.updateEventProp(ctx, state, key, value, existingState);
      } else if (isBindingProp(key)) {
        // Bindings - check if Cell is same
        this.updateBindingProp(state, key, value, existingState);
      } else if (isCell(value)) {
        // Reactive prop - check if Cell is same
        if (existingState?.cell && areLinksSame(existingState.cell, value)) {
          // Same Cell, leave subscription in place
          logger.debug("prop-same-cell", () => ({ nodeId: state.nodeId, key }));
          continue;
        }
        // Different Cell - cancel old and set up new
        if (existingState) {
          existingState.cancel();
        }
        const cancel = (value as Cell<unknown>).sink((resolvedValue) => {
          logger.debug(
            "prop-update",
            () => ({ nodeId: state.nodeId, key, value: resolvedValue }),
          );
          const propValue = this.transformPropValue(key, resolvedValue);
          this.queueOps([{
            op: "set-prop",
            nodeId: state.nodeId,
            key,
            value: propValue,
          }]);
        });
        state.propSubscriptions.set(key, {
          cell: value as Cell<unknown>,
          cancel,
        });
      } else {
        // Static prop - just set it (cancel any existing subscription)
        if (existingState) {
          existingState.cancel();
        }
        const propValue = this.transformPropValue(key, value);
        this.queueOps([{
          op: "set-prop",
          nodeId: state.nodeId,
          key,
          value: propValue,
        }]);
        state.propSubscriptions.set(key, {
          cell: undefined,
          cancel: () => {},
        });
      }
    }
  }

  /**
   * Remove all props from a node.
   */
  private removeAllProps(ctx: ReconcileContext, state: NodeState): void {
    for (const [key, propState] of state.propSubscriptions) {
      propState.cancel();
      if (state.eventHandlers.has(key)) {
        ctx.unregisterHandler(state.eventHandlers.get(key)!);
        state.eventHandlers.delete(key);
      }
      if (key !== "__cellProps__") {
        this.queueOps([{
          op: "remove-prop",
          nodeId: state.nodeId,
          key,
        }]);
      }
    }
    state.propSubscriptions.clear();
  }

  /**
   * Update an event prop.
   */
  /**
   * Helper to get a debug ID for a cell (space/id or similar).
   */
  private getCellDebugId(cell: Cell<unknown>): string {
    try {
      // Accessing internal link info for debugging
      const link = cell.getAsNormalizedFullLink();
      const path = link.path.length > 0 ? `:${link.path.join("/")}` : "";
      return `cell:${link.space?.toString() ?? "?"}/${link.id ?? "?"}${path}`;
    } catch {
      return "cell:unknown";
    }
  }

  private updateEventProp(
    ctx: ReconcileContext,
    state: NodeState,
    key: string,
    value: unknown,
    existingState: PropState | undefined,
  ): void {
    const eventType = getEventType(key);

    // Equality check: if value is same as current, do nothing
    if (existingState && existingState.currentValue === value) {
      return;
    }

    // Special check for Cell equality if both are cells
    if (
      isCell(value) && existingState?.currentValue &&
      isCell(existingState.currentValue)
    ) {
      if (
        areLinksSame(value, existingState.currentValue)
      ) {
        // Same cell link, no update needed
        return;
      }
    }

    // Log for debugging
    let valueId = "";
    if (isCell(value)) {
      valueId = this.getCellDebugId(value as Cell<unknown>);
    }

    let oldValueId = "";
    const oldValue = existingState?.currentValue;
    if (isCell(oldValue)) {
      oldValueId = this.getCellDebugId(oldValue as Cell<unknown>);
    }

    logger.debug(
      "update-event-prop",
      () => ({
        nodeId: state.nodeId,
        key,
        valueId,
        oldValueId: oldValueId || (oldValue ? String(oldValue) : undefined),
        isCell: isCell(value),
      }),
    );

    // Cancel existing subscription
    if (existingState) {
      existingState.cancel();
    }

    // Unregister old handler
    if (state.eventHandlers.has(eventType)) {
      ctx.unregisterHandler(state.eventHandlers.get(eventType)!);
      state.eventHandlers.delete(eventType);
    }

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
      state.propSubscriptions.set(key, {
        cell: undefined,
        cancel: () => {},
        currentValue: value,
      });
    } else if (isEventHandler(value)) {
      const handlerId = ctx.registerHandler(value);
      state.eventHandlers.set(eventType, handlerId);
      this.queueOps([{
        op: "set-event",
        nodeId: state.nodeId,
        eventType,
        handlerId,
      }]);
      state.propSubscriptions.set(key, {
        cell: undefined,
        cancel: () => {},
        currentValue: value,
      });
    } else if (isCell(value)) {
      // For Cells, we don't store currentValue to compare the Cell itself here
      // because the value passed to updateEventProp is usually the Cell itself.
      // If updatePropsInPlace passed the Cell, then `currentValue === value` check above covers it.

      const cancel = (value as Cell<(event: unknown) => void>).sink(
        (handler) => {
          if (handler) {
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
        },
      );
      state.propSubscriptions.set(key, {
        cell: value as Cell<unknown>,
        cancel,
        currentValue: value,
      });
    }
  }

  /**
   * Update a binding prop ($prop).
   */
  private updateBindingProp(
    state: NodeState,
    key: string,
    value: unknown,
    existingState: PropState | undefined,
  ): void {
    const propName = getBindingPropName(key);

    if (isCell(value)) {
      // Check if same Cell
      if (existingState?.cell && areLinksSame(existingState.cell, value)) {
        logger.debug(
          "binding-same-cell",
          () => ({ nodeId: state.nodeId, key }),
        );
        return; // Same binding, leave it alone
      }

      // Different Cell - update binding
      if (existingState) {
        existingState.cancel();
      }
      const cellRef = (value as Cell<unknown>).getAsNormalizedFullLink();
      this.queueOps([{
        op: "set-binding",
        nodeId: state.nodeId,
        propName,
        cellRef,
      }]);
      state.propSubscriptions.set(key, {
        cell: value as Cell<unknown>,
        cancel: () => {},
      });
    }
  }

  /**
   * Update children in place with proper diffing.
   * If children Cell is the same, leave subscription in place.
   */
  private updateChildrenInPlace(
    ctx: ReconcileContext,
    state: NodeState,
    children: WorkerRenderNode | WorkerRenderNode[],
    visited: Set<object>,
  ): void {
    // Handle Cell<children> - check if same Cell
    if (isCell(children)) {
      const existingState = state.childrenState;
      if (existingState?.cell && areLinksSame(existingState.cell, children)) {
        // Same Cell, leave subscription in place
        logger.debug("children-same-cell", () => ({ nodeId: state.nodeId }));
        return;
      }

      // Different Cell - cancel old subscription
      if (existingState) {
        existingState.cancel();
      }

      // Set up new subscription
      const cancel = (children as Cell<WorkerRenderNode | WorkerRenderNode[]>)
        .sink(
          (resolvedChildren) => {
            logger.debug("children-update", () => ({
              nodeId: state.nodeId,
              count: Array.isArray(resolvedChildren)
                ? resolvedChildren.length
                : 1,
            }));
            this.updateChildren(ctx, state, resolvedChildren, visited);
          },
        );

      state.childrenState = {
        cell: children as Cell<unknown>,
        cancel,
      };
    } else {
      // Static children - cancel any existing Cell subscription
      if (state.childrenState) {
        state.childrenState.cancel();
        state.childrenState = undefined;
      }
      // Update children directly
      this.updateChildren(ctx, state, children, visited);
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
      childOrder: [],
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
      childOrder: [],
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
      childOrder: [],
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
      childOrder: [],
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
   * Tracks Cell references in propSubscriptions for later diffing.
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
      const sinkCancel = props.sink((resolvedProps) => {
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
      });
      addCancel(sinkCancel);
      // Track the Cell<Props> for diffing
      state.propSubscriptions.set("__cellProps__", {
        cell: props as Cell<unknown>,
        cancel: sinkCancel,
      });
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
          state.propSubscriptions.set(key, {
            cell: undefined,
            cancel: () => {},
            currentValue: value,
          });
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
          state.propSubscriptions.set(key, {
            cell: undefined,
            cancel: () => {},
            currentValue: value,
          });
        } else if (isCell(value)) {
          // Cell containing event handler - not common but handle it
          const eventType = getEventType(key);
          const sinkCancel = (value as Cell<(event: unknown) => void>).sink(
            (handler) => {
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
            },
          );
          addCancel(sinkCancel);
          state.propSubscriptions.set(key, {
            cell: value as Cell<unknown>,
            cancel: sinkCancel,
            currentValue: value,
          });
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
          state.propSubscriptions.set(key, {
            cell: value as Cell<unknown>,
            cancel: () => {},
          });
        }
      } else if (isCell(value)) {
        // Reactive prop value
        const sinkCancel = (value as Cell<unknown>).sink((resolvedValue) => {
          const propValue = this.transformPropValue(key, resolvedValue);
          this.queueOps([{
            op: "set-prop",
            nodeId: state.nodeId,
            key,
            value: propValue,
          }]);
        });
        addCancel(sinkCancel);
        state.propSubscriptions.set(key, {
          cell: value as Cell<unknown>,
          cancel: sinkCancel,
        });
      } else {
        // Static prop value
        const propValue = this.transformPropValue(key, value);
        this.queueOps([{
          op: "set-prop",
          nodeId: state.nodeId,
          key,
          value: propValue,
        }]);
        state.propSubscriptions.set(key, { cell: undefined, cancel: () => {} });
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
   * Tracks the children Cell for later diffing.
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
      const sinkCancel = (
        children as Cell<WorkerRenderNode | WorkerRenderNode[]>
      ).sink((resolvedChildren) => {
        this.updateChildren(ctx, state, resolvedChildren, visited);
      });
      addCancel(sinkCancel);
      // Track the children Cell for diffing
      state.childrenState = {
        cell: children as Cell<unknown>,
        cancel: sinkCancel,
      };
    } else {
      // Static children
      this.updateChildren(ctx, state, children, visited);
      state.childrenState = undefined;
    }

    // When this cancel is called, also cancel all current children.
    // This ensures child sinks are cleaned up when the parent render tree
    // is torn down (e.g., during reconcileIntoWrapper).
    addCancel(() => {
      for (const [, childState] of state.children) {
        childState.cancel();
      }
      state.children.clear();
      state.childrenState = undefined;
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
    let hasNewChildren = false;
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
        hasNewChildren = true;
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

    // Check if order needs update - only skip inserts when ALL children were
    // reused (no new children created). New children need insert-child ops
    // even if the key order is identical.
    const isOrderSame = !hasNewChildren &&
      newKeyOrder.length === state.childOrder.length &&
      newKeyOrder.every((key, i) => key === state.childOrder[i]);

    if (isOrderSame) {
      // Order is identical and all children were reused from previous state
      state.children = newMapping;
      return;
    }

    state.childOrder = newKeyOrder;

    // Update children order by inserting from END to BEGINNING.
    // This ensures each insertBefore has a valid reference node.
    // Processing in reverse means each child is inserted before the
    // previously processed child (which is already in the DOM).
    // Skip children with nodeId === -1 (pending Cell children that haven't
    // resolved yet). Using -1 as a beforeId would break the ordering chain
    // because the applicator can't find the node and falls back to appendChild.
    // Pending children will self-insert via renderCellChild when they resolve.
    let nextNodeId: number | null = null;
    for (let i = newKeyOrder.length - 1; i >= 0; i--) {
      const key = newKeyOrder[i];
      const childState = newMapping.get(key);
      if (!childState || childState.nodeId === -1) continue;

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

        // Dedupe updates
        if (!isInitialRender && resolvedChild === childState.currentValue) {
          return;
        }
        childState.currentValue = resolvedChild;

        // Try to update in place if not initial render
        if (
          !isInitialRender &&
          childState.nodeId !== -1
        ) {
          // Case 1: Text update
          if (
            childState.isText &&
            (typeof resolvedChild === "string" ||
              typeof resolvedChild === "number")
          ) {
            this.queueOps([{
              op: "update-text",
              nodeId: childState.nodeId,
              text: String(resolvedChild),
            }]);
            return;
          }

          // Case 2: VNode in-place update (same tag)
          if (childState.elementState) {
            const newVNode = this.extractVNode(
              resolvedChild as WorkerRenderNode,
            );
            if (newVNode) {
              const sanitized = this.sanitizeNode(newVNode);
              if (
                sanitized &&
                sanitized.name === childState.elementState.tagName
              ) {
                // Same tag - update props in place
                this.updatePropsInPlace(
                  ctx,
                  childState.elementState,
                  sanitized.props,
                );

                // Check children: if same, do nothing (sinks active);
                // if different, tear down and rebuild
                if (sanitized.children !== undefined) {
                  const childrenSame = this.areChildrenSame(
                    childState.elementState,
                    sanitized.children,
                  );
                  if (!childrenSame) {
                    this.updateChildrenInPlace(
                      ctx,
                      childState.elementState,
                      sanitized.children,
                      new Set(),
                    );
                  }
                }
                return;
              }
            }
          }
        }

        // Fallback: Replace (existing logic)
        // Clean up previous (skip if initial render - nothing to clean)
        if (!isInitialRender) {
          if (currentCancel) {
            currentCancel();
            currentCancel = undefined;
          }
          // Clean up event handlers before removing node
          this.cleanupNodeHandlers(childState);
          // Log replacement
          logger.debug(
            "reconcile-cell-child",
            () => ({
              id: childState.nodeId,
              cellId: this.getCellDebugId(cell),
              type: "replace",
              reason: "fallback",
            }),
          );
          this.queueOps([{ op: "remove-node", nodeId: childState.nodeId }]);
        }

        // Reset nodeId
        childState.nodeId = -1;
        childState.elementState = undefined;
        childState.isText = false;

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
          childState.isText = newState.isText;
          currentCancel = newState.cancel;

          // Always insert the child into its parent. On initial render,
          // updateChildren also emits insert-child but may see nodeId=-1
          // (Cell hasn't resolved yet), making that op a no-op. This
          // ensures the node is inserted once it actually exists.
          // Double inserts are harmless (DOM appendChild/insertBefore is idempotent).
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
