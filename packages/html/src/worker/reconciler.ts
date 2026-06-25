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
  ContextualFlowControl,
  convertCellsToLinks,
  isCell,
  isStream,
  type JSONSchema,
  parseLink,
  type Stream,
  UI,
  useCancelGroup,
} from "@commonfabric/runner";
import type { CellRef } from "@commonfabric/runtime-client";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { getLogger } from "@commonfabric/utils/logger";
import { isRecord } from "@commonfabric/utils/types";
import type {
  ChildNodeState,
  NodeState,
  PropState,
  ReconcileContext,
  RenderDeclassificationPolicy,
  RenderPolicy,
  WorkerProps,
  WorkerReconcilerOptions,
  WorkerRenderNode,
  WorkerVNode,
} from "./types.ts";
import {
  isWorkerVNode,
  normalizeRenderConfidentialityCeiling,
  normalizeRenderDeclassificationPolicy,
} from "./types.ts";
import {
  CFC_LABEL_READ_FAILED_ATOM,
  type CfcLabelView,
  cfcLabelViewForCell,
  markRendererTrustedEvent,
} from "@commonfabric/runner/cfc";
import type { VDomOp } from "../vdom-ops.ts";
import { generateChildKeys } from "./keying.ts";
import {
  getBindingPropName,
  getEventType,
  isBindingProp,
  isEventHandler,
  isEventProp,
} from "../render-utils.ts";

/** Sentinel key in propSubscriptions for the Cell<Props> subscription itself. */
const CELL_PROPS_KEY = "__cellProps__";
const CFC_RENDER_BOUNDARY_TAG = "cf-cfc-render-boundary";
const CFC_AUTHORSHIP_TAG = "cf-cfc-authorship";
const CFC_BLOCKED_PLACEHOLDER_TAG = "cf-cfc-blocked";
const CFC_TEXT_INTEGRITY_PLACEHOLDER = "Content hidden by integrity policy";
const TEXT_INTEGRITY_PROP_SINKS: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    ["cf-chat-message", new Set(["name", "content"])],
  ]);
const DEFAULT_RENDER_POLICY: RenderPolicy = {
  declassifyConfidentiality: [],
};
// Mirrors CFC_ATOM_TYPE.Caveat in @commonfabric/api/cfc (not a dependency of
// this package).
const CFC_CAVEAT_ATOM_TYPE = "https://commonfabric.org/cfc/atom/Caveat";

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
  private handlers = new Map<
    number,
    (event: unknown) => void
  >();
  private retiredHandlers = new Map<number, number>();
  private pendingRetiredHandlers = new Set<number>();
  private batchIdCounter = 0;
  private pendingOps: VDomOp[] = [];
  private flushScheduled = false;

  // Track the actual root child node (not the container)
  private rootChildId: number | null = null;
  private rootCancel: Cancel | null = null;

  private readonly onOps: (ops: VDomOp[]) => number | void;
  private readonly onError?: (error: Error) => void;
  private readonly renderDeclassificationPolicy: RenderDeclassificationPolicy;
  // Root-of-tree render policy: the host's default ceiling when configured
  // (spec §8.10.6), otherwise the historical unbounded policy. Authored
  // boundaries can only narrow from here.
  private readonly rootRenderPolicy: RenderPolicy;

  constructor(options: WorkerReconcilerOptions) {
    this.onOps = options.onOps;
    this.onError = options.onError;
    // Security knob: a present-but-unknown value fails closed to "deny";
    // only an absent option keeps the documented "allow" default.
    this.renderDeclassificationPolicy = normalizeRenderDeclassificationPolicy(
      options.renderDeclassificationPolicy,
    );
    // Same seam discipline: malformed ceilings normalize to the empty
    // (public-only) ceiling rather than crashing or failing open.
    const ceiling = normalizeRenderConfidentialityCeiling(
      options.renderConfidentialityCeiling,
    );
    this.rootRenderPolicy = ceiling === undefined ? DEFAULT_RENDER_POLICY : {
      declassifyConfidentiality: [],
      maxConfidentiality: [...(ceiling.atoms ?? [])],
      caveatKindAllow: [...(ceiling.caveatKinds ?? [])],
    };
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
  /** Best-effort space of a cell; undefined when it can't name one. */
  private spaceOfCell(cell: Cell<unknown>): string | undefined {
    try {
      return cell.space;
    } catch {
      return undefined;
    }
  }

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

    let ctx = this.createContext();
    if (isCell(vnode)) {
      const rootSpace = this.spaceOfCell(vnode);
      if (rootSpace) ctx = { ...ctx, space: rootSpace };
    }
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
          // The mounted cell is an egress like any descendant cell: gate its
          // own label against the root policy (the host ceiling when
          // configured) before rendering its resolved content. Checked per
          // update so label changes re-evaluate, mirroring renderCellChild.
          if (
            !this.canRenderCellUnderPolicy(
              vnode as Cell<unknown>,
              this.rootRenderPolicy,
            )
          ) {
            this.reconcileIntoWrapper(
              ctx,
              wrapperState,
              this.blockedPlaceholderVNode(),
              this.rootRenderPolicy,
            );
            this.rootChildId = wrapperState.currentChild?.nodeId ?? null;
            return;
          }
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
            this.rootRenderPolicy,
          );
          // Track the root child for cleanup
          this.rootChildId = wrapperState.currentChild?.nodeId ?? null;
        }),
      );
    } else {
      // Static VNode - render directly into container
      const state = this.renderNode(
        ctx,
        vnode,
        new Set(),
        this.rootRenderPolicy,
      );
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

  acknowledgeBatchApplied(batchId: number): void {
    for (const [handlerId, retiredAtBatch] of this.retiredHandlers) {
      if (retiredAtBatch > batchId) {
        continue;
      }
      this.retiredHandlers.delete(handlerId);
      this.handlers.delete(handlerId);
    }
  }

  /**
   * Dispatch a DOM event to its handler.
   */
  dispatchEvent(handlerId: number, event: unknown): boolean {
    const handler = this.handlers.get(handlerId);
    if (handler) {
      try {
        markRendererTrustedEvent(event);
        handler(event);
      } catch (error) {
        this.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return true;
    }
    return false;
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
      const batchId = this.onOps(ops) ?? this.batchIdCounter++;
      this.assignPendingRetiredHandlers(batchId);
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
        this.retireHandlerId(handlerId);
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

  private retireHandlerId(handlerId: number): void {
    if (!this.handlers.has(handlerId)) {
      return;
    }
    if (
      !this.retiredHandlers.has(handlerId) &&
      !this.pendingRetiredHandlers.has(handlerId)
    ) {
      this.pendingRetiredHandlers.add(handlerId);
    }
  }

  private assignPendingRetiredHandlers(batchId: number): void {
    for (const handlerId of this.pendingRetiredHandlers) {
      this.retiredHandlers.set(handlerId, batchId);
    }
    this.pendingRetiredHandlers.clear();
  }

  private retireEventHandler(
    state: NodeState,
    eventType: string,
  ): number | undefined {
    const handlerId = state.eventHandlers.get(eventType);
    if (handlerId === undefined) {
      return undefined;
    }

    state.eventHandlers.delete(eventType);
    this.retireHandlerId(handlerId);
    return handlerId;
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

  private childRenderPolicyForNode(
    node: WorkerVNode,
    parentPolicy: RenderPolicy,
    nodeId: number,
  ): RenderPolicy {
    let policy = parentPolicy;

    if (node.name === CFC_RENDER_BOUNDARY_TAG) {
      const props = this.propsForRenderPolicy(node);
      const localMax = this.normalizeAtomBound(
        this.staticPropAsAtomList(props, "maxConfidentiality") ??
          this.staticPropAsAtomList(props, "data-cfc-max-confidentiality"),
      );
      // Author-supplied declassification is a fail-open capability (it releases
      // a secret upward). Honor it only when the render policy allows; under
      // "deny" the boundary keeps its fail-closed power to NARROW the bound but
      // cannot declassify (audit S15). Narrowing below is unaffected.
      const declassifyConfidentiality =
        this.renderDeclassificationPolicy === "deny" ? [] : (
          this.staticPropAsAtomList(
            props,
            "declassifyConfidentiality",
          ) ??
            this.staticPropAsAtomList(
              props,
              "data-cfc-declassify-confidentiality",
            ) ??
            []
        );

      policy = {
        maxConfidentiality: this.narrowMaxConfidentiality(
          parentPolicy.maxConfidentiality,
          localMax,
        ),
        // The host's caveat-kind allowance is part of the default ceiling
        // profile; boundaries narrow maxConfidentiality but never widen or
        // shed the kind allowance.
        caveatKindAllow: parentPolicy.caveatKindAllow,
        declassifyConfidentiality: [
          ...parentPolicy.declassifyConfidentiality,
          ...declassifyConfidentiality,
        ],
        textIntegrity: parentPolicy.textIntegrity,
      };
    }

    if (node.name !== CFC_AUTHORSHIP_TAG) {
      return policy;
    }

    const verifyTextIntegrity = this.nodePropAsBoolean(node, [
      "verifyTextIntegrity",
      "verify-text-integrity",
      "data-cfc-verify-text-integrity",
    ]) ?? false;
    if (!verifyTextIntegrity) {
      return policy;
    }

    const allowLiteralText = this.nodePropAsBoolean(node, [
      "allowLiteralText",
      "allow-literal-text",
      "data-cfc-allow-literal-text",
    ]) ?? false;
    const explicitRequiredIntegrity = this.nodePropAsAtomList(node, [
      "requiredTextIntegrity",
      "requiredIntegrity",
      "data-cfc-required-text-integrity",
    ]);
    // Without an explicit requirement, a cell-backed author that represents a
    // principal makes the text boundary require authored-by for that principal.
    const requiredIntegrity = explicitRequiredIntegrity ??
      this.requiredAuthorshipIntegrityFromAuthor(node) ??
      [];

    return {
      ...policy,
      textIntegrity: {
        requiredIntegrity,
        allowLiteralText,
        boundaryNodeId: nodeId,
      },
    };
  }

  private propsForRenderPolicy(
    node: WorkerVNode,
  ): WorkerProps | null | undefined {
    if (!isCell(node.props)) {
      return node.props;
    }
    try {
      const rawProps = node.props.getRawUntyped({ frozen: false });
      return rawProps !== null && typeof rawProps === "object" &&
          !Array.isArray(rawProps)
        ? rawProps as WorkerProps
        : undefined;
    } catch {
      return undefined;
    }
  }

  private staticPropAsAtomList(
    props: WorkerProps | null | undefined,
    key: string,
  ): readonly unknown[] | undefined {
    if (!props || typeof props !== "object" || !(key in props)) {
      return undefined;
    }
    const value = props[key];
    if (isCell(value) || typeof value === "function") {
      return undefined;
    }
    if (value === undefined) {
      return undefined;
    }
    if (Array.isArray(value)) {
      return value;
    }
    return [value];
  }

  private nodePropForRenderPolicy(
    node: WorkerVNode,
    key: string,
  ): unknown {
    const props = this.propsForRenderPolicy(node);
    if (!props || typeof props !== "object" || !(key in props)) {
      return undefined;
    }
    const value = props[key];
    if (!isCell(node.props)) {
      return value;
    }
    try {
      return this.resolveCellPropsBindingTarget(
        node.props as Cell<WorkerProps>,
        key,
        value,
      );
    } catch {
      return value;
    }
  }

  private nodePropAsBoolean(
    node: WorkerVNode,
    keys: readonly string[],
  ): boolean | undefined {
    for (const key of keys) {
      const rawValue = this.nodePropForRenderPolicy(node, key);
      if (typeof rawValue === "function") {
        continue;
      }
      const value = isCell(rawValue)
        ? this.readCellPolicyValue(rawValue as Cell<unknown>)
        : rawValue;
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "string") {
        if (value === "" || value.toLowerCase() === "true") {
          return true;
        }
        if (value.toLowerCase() === "false") {
          return false;
        }
      }
    }
    return undefined;
  }

  private nodePropAsAtomList(
    node: WorkerVNode,
    keys: readonly string[],
  ): readonly unknown[] | undefined {
    for (const key of keys) {
      const value = this.nodePropForRenderPolicy(node, key);
      if (typeof value === "function") {
        continue;
      }
      const resolved = isCell(value)
        ? this.readCellPolicyValue(value as Cell<unknown>)
        : value;
      if (resolved === undefined) {
        continue;
      }
      return Array.isArray(resolved) ? resolved : [resolved];
    }
    return undefined;
  }

  private requiredAuthorshipIntegrityFromAuthor(
    node: WorkerVNode,
  ): readonly unknown[] | undefined {
    const author = this.nodePropForRenderPolicy(node, "author") ??
      this.nodePropForRenderPolicy(node, "$author");
    if (!isCell(author)) {
      return undefined;
    }
    const subject = this.representsPrincipalSubjectForCell(
      author as Cell<unknown>,
    );
    return subject === undefined
      ? undefined
      : [{ kind: "authored-by", subject }];
  }

  private bindingOpsForCell(
    state: NodeState,
    propName: string,
    cell: Cell<unknown>,
  ): VDomOp[] {
    return [{
      op: "set-binding",
      nodeId: state.nodeId,
      propName,
      cellRef: this.cellRefForBinding(cell),
    }];
  }

  private cellRefForBinding(cell: Cell<unknown>): CellRef {
    const link = cell.getAsNormalizedFullLink();
    let labelView: CfcLabelView | undefined;
    try {
      labelView = cfcLabelViewForCell(cell);
      if (labelView === undefined) {
        labelView = cfcLabelViewForCell(cell.resolveAsCell());
      }
    } catch {
      labelView = undefined;
    }
    return {
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: [...link.path],
      schema: this.bindingSchema(link.schema),
      ...(link.overwrite !== undefined && { overwrite: link.overwrite }),
      ...(labelView !== undefined && { cfcLabelView: labelView }),
    };
  }

  private bindingSchema(schema: CellRef["schema"] | undefined): CellRef[
    "schema"
  ] {
    if (
      schema === undefined ||
      (typeof schema === "object" && schema !== null &&
        Object.keys(schema).length === 0)
    ) {
      return true;
    }
    return schema;
  }

  private representsPrincipalSubjectForCell(
    cell: Cell<unknown>,
  ): string | undefined {
    let labelView: CfcLabelView | undefined;
    try {
      labelView = cfcLabelViewForCell(cell);
      if (labelView === undefined) {
        labelView = cfcLabelViewForCell(cell.resolveAsCell());
      }
    } catch {
      return undefined;
    }
    if (labelView === undefined) {
      return undefined;
    }
    for (const atom of this.integrityLabels(labelView)) {
      if (typeof atom !== "object" || atom === null || Array.isArray(atom)) {
        continue;
      }
      const record = atom as Record<string, unknown>;
      if (record.kind !== "represents-principal") {
        continue;
      }
      if (typeof record.subject === "string") {
        return record.subject;
      }
    }
    return undefined;
  }

  private staticCellProp(
    props: WorkerProps | null | undefined,
    key: string,
  ): Cell<unknown> | undefined {
    if (!props || typeof props !== "object" || !(key in props)) {
      return undefined;
    }
    const value = props[key];
    return isCell(value) ? value as Cell<unknown> : undefined;
  }

  private childrenForRenderPolicy(
    node: WorkerVNode,
    policy: RenderPolicy,
  ): {
    children:
      | WorkerRenderNode[]
      | Cell<WorkerRenderNode | WorkerRenderNode[]>
      | undefined;
    blocked: boolean;
  } {
    if (node.children === undefined) {
      return { children: undefined, blocked: false };
    }
    if (!this.shouldBlockBoundaryChildren(node, policy)) {
      return { children: node.children, blocked: false };
    }
    return { children: [this.blockedPlaceholderVNode()], blocked: true };
  }

  private shouldBlockBoundaryChildren(
    node: WorkerVNode,
    policy: RenderPolicy,
  ): boolean {
    if (node.name !== CFC_RENDER_BOUNDARY_TAG) {
      return false;
    }
    const protectedValue = this.boundaryProtectedValueCell(node);
    return protectedValue !== undefined &&
      !this.canRenderCellUnderPolicy(protectedValue, policy);
  }

  private boundaryProtectedValueCell(
    node: WorkerVNode,
  ): Cell<unknown> | undefined {
    if (isCell(node.props)) {
      const propsCell = node.props as Cell<WorkerProps>;
      let rawProps: unknown;
      try {
        rawProps = propsCell.getRawUntyped({ frozen: false });
      } catch {
        return undefined;
      }
      if (
        rawProps === null || typeof rawProps !== "object" ||
        !("$value" in rawProps)
      ) {
        return undefined;
      }
      try {
        return this.resolveCellPropsBindingTarget(
          propsCell,
          "$value",
          (rawProps as Record<string, unknown>)["$value"],
        );
      } catch {
        return undefined;
      }
    }
    return this.staticCellProp(node.props, "$value");
  }

  private blockedPlaceholderVNode(
    reason: "policy" | "integrity" = "policy",
  ): WorkerVNode {
    const integrityBlocked = reason === "integrity";
    return {
      type: "vnode",
      name: CFC_BLOCKED_PLACEHOLDER_TAG,
      props: {
        "data-cfc-blocked": "true",
        "data-cfc-blocked-reason": reason,
        title: integrityBlocked
          ? "CFC text integrity policy blocked this content"
          : "CFC render policy blocked this content",
      },
      children: [
        integrityBlocked
          ? CFC_TEXT_INTEGRITY_PLACEHOLDER
          : "Content hidden by policy",
      ],
    };
  }

  private normalizeAtomBound(
    labels: readonly unknown[] | undefined,
  ): readonly unknown[] | undefined {
    if (labels === undefined) {
      return undefined;
    }
    return ContextualFlowControl.uniqueAtoms(labels);
  }

  private narrowMaxConfidentiality(
    parentMax: readonly unknown[] | undefined,
    localMax: readonly unknown[] | undefined,
  ): readonly unknown[] | undefined {
    if (parentMax === undefined) {
      return localMax;
    }
    if (localMax === undefined) {
      return parentMax;
    }
    return parentMax.filter((atom) =>
      localMax.some((localAtom) => deepEqual(atom, localAtom))
    );
  }

  private renderPolicyEquals(
    left: RenderPolicy,
    right: RenderPolicy,
  ): boolean {
    const maxConfidentialityEquals = left.maxConfidentiality === undefined ||
        right.maxConfidentiality === undefined
      ? left.maxConfidentiality === right.maxConfidentiality
      : this.atomListsEqual(
        left.maxConfidentiality,
        right.maxConfidentiality,
      );

    const caveatKindsEqual = (left.caveatKindAllow ?? []).length ===
        (right.caveatKindAllow ?? []).length &&
      (left.caveatKindAllow ?? []).every((kind, index) =>
        kind === (right.caveatKindAllow ?? [])[index]
      );

    return maxConfidentialityEquals && caveatKindsEqual &&
      this.atomListsEqual(
        left.declassifyConfidentiality,
        right.declassifyConfidentiality,
      ) &&
      this.textIntegrityPolicyEquals(left, right);
  }

  private textIntegrityPolicyEquals(
    left: RenderPolicy,
    right: RenderPolicy,
  ): boolean {
    const leftPolicy = left.textIntegrity;
    const rightPolicy = right.textIntegrity;
    if (leftPolicy === undefined || rightPolicy === undefined) {
      return leftPolicy === rightPolicy;
    }
    return this.atomListsEqual(
      leftPolicy.requiredIntegrity,
      rightPolicy.requiredIntegrity,
    ) &&
      leftPolicy.allowLiteralText === rightPolicy.allowLiteralText &&
      leftPolicy.boundaryNodeId === rightPolicy.boundaryNodeId;
  }

  private atomListsEqual(
    left: readonly unknown[],
    right: readonly unknown[],
  ): boolean {
    return left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }

  private canRenderCellUnderPolicy(
    cell: Cell<unknown>,
    policy: RenderPolicy,
  ): boolean {
    if (
      policy.maxConfidentiality === undefined &&
      policy.declassifyConfidentiality.length === 0
    ) {
      return true;
    }

    let labelView: CfcLabelView | undefined;
    try {
      labelView = cfcLabelViewForCell(cell);
      if (labelView === undefined) {
        labelView = cfcLabelViewForCell(cell.resolveAsCell());
      }
    } catch {
      return false;
    }
    if (labelView === undefined) {
      // Schema IFC is a constraint, not the data label. Use it only as a
      // conservative fallback when no stored/read label metadata is available.
      const schemaLabels = this.confidentialityLabelsFromCellSchema(cell);
      if (schemaLabels.length === 0) {
        return true;
      }
      return schemaLabels.every((atom) =>
        this.atomRenderableUnderPolicy(atom, policy)
      );
    }

    for (const atom of this.confidentialityLabels(labelView)) {
      if (!this.atomRenderableUnderPolicy(atom, policy)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Per-atom admission under a render policy. The read-failure marker is
   * UNGRANTABLE (audit item 22): it means "the label could not be read", so
   * neither author declassification nor a ceiling entry — even one naming
   * the exported marker string — may admit it. Every other atom checks
   * declassification first, then the ceiling.
   */
  private atomRenderableUnderPolicy(
    atom: unknown,
    policy: RenderPolicy,
  ): boolean {
    if (deepEqual(atom, CFC_LABEL_READ_FAILED_ATOM)) {
      return false;
    }
    if (
      policy.declassifyConfidentiality.some((declassified) =>
        deepEqual(declassified, atom)
      )
    ) {
      return true;
    }
    return this.canRenderConfidentialityAtom(atom, policy);
  }

  private confidentialityLabels(labelView: CfcLabelView): readonly unknown[] {
    return ContextualFlowControl.uniqueAtoms(
      labelView.entries.flatMap((entry) => [
        ...(entry.label.confidentiality ?? []),
      ]),
    );
  }

  private confidentialityLabelsFromCellSchema(
    cell: Cell<unknown>,
  ): readonly unknown[] {
    const schema = (cell as { schema?: JSONSchema }).schema;
    if (schema === undefined) {
      return [];
    }
    const joined = new Set<unknown>();
    try {
      ContextualFlowControl.joinSchema(joined, schema);
    } catch {
      return ["__unknown_cfc_schema_label__"];
    }
    return ContextualFlowControl.uniqueAtoms(joined);
  }

  private canRenderConfidentialityAtom(
    atom: unknown,
    policy: RenderPolicy,
  ): boolean {
    const max = this.normalizeAtomBound(policy.maxConfidentiality);
    if (max === undefined) {
      return true;
    }
    if (max.some((allowed) => deepEqual(allowed, atom))) {
      return true;
    }
    // Default-ceiling caveat-kind allowance (spec §8.10.6): Caveat-type
    // atoms of an allow-listed kind render — these are the
    // display-dischargeable classes (e.g. prompt influence), admitted by
    // kind rather than by enumerating every (kind, source) instance.
    const kinds = policy.caveatKindAllow;
    if (
      kinds !== undefined && kinds.length > 0 &&
      isRecord(atom) && atom.type === CFC_CAVEAT_ATOM_TYPE &&
      typeof atom.kind === "string" && kinds.includes(atom.kind)
    ) {
      return true;
    }
    return false;
  }

  private refreshTextIntegrityBoundary(
    ctx: ReconcileContext,
    state: NodeState,
  ): void {
    if (
      state.tagName !== CFC_AUTHORSHIP_TAG ||
      state.sourceProps === undefined ||
      state.sourceChildren === undefined ||
      state.children.size === 0
    ) {
      return;
    }

    this.refreshBoundaryPolicyFromProps(ctx, state, state.sourceProps);
  }

  private isTextIntegrityPolicyProp(key: string): boolean {
    return key === "requiredTextIntegrity" ||
      key === "requiredIntegrity" ||
      key === "data-cfc-required-text-integrity" ||
      key === "author" ||
      key === "$author" ||
      key === "verifyTextIntegrity" ||
      key === "verify-text-integrity" ||
      key === "data-cfc-verify-text-integrity" ||
      key === "allowLiteralText" ||
      key === "allow-literal-text" ||
      key === "data-cfc-allow-literal-text";
  }

  private initializeTextIntegrityBoundary(
    policy: RenderPolicy,
    nodeId: number,
  ): void {
    if (policy.textIntegrity?.boundaryNodeId !== nodeId) {
      return;
    }
    this.queueOps([{
      op: "set-prop",
      nodeId,
      key: "textIntegrityState",
      value: "ok",
    }]);
  }

  private refreshTextIntegrityBoundaryState(
    state: NodeState,
    policy: RenderPolicy,
  ): void {
    if (state.tagName !== CFC_AUTHORSHIP_TAG) {
      return;
    }
    if (
      policy.textIntegrity !== undefined &&
      policy.textIntegrity.boundaryNodeId !== state.nodeId
    ) {
      return;
    }
    const value = policy.textIntegrity === undefined
      ? "ok"
      : this.hasTextIntegrityBlockForBoundary(state, state.nodeId)
      ? "blocked"
      : "ok";
    this.queueOps([{
      op: "set-prop",
      nodeId: state.nodeId,
      key: "textIntegrityState",
      value,
    }]);
  }

  private hasTextIntegrityBlockForBoundary(
    state: NodeState,
    boundaryNodeId: number,
  ): boolean {
    if (state.textIntegrityBlockedFor === boundaryNodeId) {
      return true;
    }
    if (
      state.textIntegrityBlockedProps !== undefined &&
      [...state.textIntegrityBlockedProps.values()].some((id) =>
        id === boundaryNodeId
      )
    ) {
      return true;
    }
    for (const child of state.children.values()) {
      if (
        child.elementState &&
        this.hasTextIntegrityBlockForBoundary(
          child.elementState,
          boundaryNodeId,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  private markTextIntegrityBlocked(policy: RenderPolicy): number | undefined {
    const boundaryNodeId = policy.textIntegrity?.boundaryNodeId;
    if (boundaryNodeId === undefined) {
      return undefined;
    }
    this.queueOps([{
      op: "set-prop",
      nodeId: boundaryNodeId,
      key: "textIntegrityState",
      value: "blocked",
    }]);
    return boundaryNodeId;
  }

  private canRenderCellTextUnderPolicy(
    cell: Cell<unknown>,
    policy: RenderPolicy,
  ): boolean {
    const textIntegrity = policy.textIntegrity;
    if (textIntegrity === undefined) {
      return true;
    }
    if (textIntegrity.requiredIntegrity.length === 0) {
      return false;
    }

    let labelView: CfcLabelView | undefined;
    try {
      labelView = cfcLabelViewForCell(cell);
      if (labelView === undefined) {
        labelView = cfcLabelViewForCell(cell.resolveAsCell());
      }
    } catch {
      return false;
    }
    if (labelView === undefined) {
      return false;
    }

    const integrity = this.integrityLabels(labelView);
    return textIntegrity.requiredIntegrity.every((required) =>
      integrity.some((atom) => deepEqual(atom, required))
    );
  }

  private integrityLabels(labelView: CfcLabelView): readonly unknown[] {
    return ContextualFlowControl.uniqueAtoms(
      labelView.entries.flatMap((entry) =>
        entry.path.length === 0 ? [...(entry.label.integrity ?? [])] : []
      ),
    );
  }

  private readCellValue(cell: Cell<unknown>): unknown {
    const readableCell = cell as Cell<unknown> & {
      get?: (options?: { traverseCells?: boolean }) => unknown;
      getRawUntyped?: (options?: { frozen?: false }) => unknown;
    };
    try {
      if (typeof readableCell.get === "function") {
        return readableCell.get({ traverseCells: true });
      }
    } catch {
      // Fall back to the raw read below.
    }
    try {
      return readableCell.getRawUntyped?.({ frozen: false });
    } catch {
      return undefined;
    }
  }

  private readCellPolicyValue(cell: Cell<unknown>): unknown {
    const readableCell = cell as Cell<unknown> & {
      get?: (options?: { traverseCells?: boolean }) => unknown;
      getRawUntyped?: (options?: { frozen?: false }) => unknown;
    };
    try {
      return readableCell.getRawUntyped?.({ frozen: false });
    } catch {
      // Fall back to the schema-shaped read below.
    }
    try {
      if (typeof readableCell.get === "function") {
        return readableCell.get({ traverseCells: true });
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private shouldBlockLiteralText(
    value: unknown,
    policy: RenderPolicy,
  ): boolean {
    const textIntegrity = policy.textIntegrity;
    if (textIntegrity === undefined || textIntegrity.allowLiteralText) {
      return false;
    }
    return this.hasVisibleTextValue(value);
  }

  private shouldBlockTextFromCell(
    value: unknown,
    cell: Cell<unknown>,
    policy: RenderPolicy,
  ): boolean {
    if (policy.textIntegrity === undefined) {
      return false;
    }
    if (isWorkerVNode(value) || this.isRenderableObject(value)) {
      return false;
    }
    if (!this.hasVisibleTextValue(value)) return false;
    return !this.canRenderCellTextUnderPolicy(cell, policy);
  }

  private isRenderableObject(value: unknown): boolean {
    return value !== null && typeof value === "object" && UI in value;
  }

  private hasVisibleTextValue(value: unknown): boolean {
    if (value === null || value === undefined || value === false) {
      return false;
    }
    if (typeof value === "string") {
      return value.length > 0;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return true;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return typeof value === "object";
  }

  private isTextIntegrityProp(state: NodeState, key: string): boolean {
    return TEXT_INTEGRITY_PROP_SINKS.get(state.tagName)?.has(key) ?? false;
  }

  private transformPropValueForState(
    state: NodeState,
    key: string,
    value: unknown,
    sourceCell?: Cell<unknown>,
    // deno-lint-ignore no-explicit-any
  ): any {
    if (this.isTextIntegrityProp(state, key)) {
      const shouldBlock = sourceCell
        ? this.shouldBlockTextFromCell(value, sourceCell, state.renderPolicy)
        : this.shouldBlockLiteralText(value, state.renderPolicy);
      if (!shouldBlock) {
        state.textIntegrityBlockedProps?.delete(key);
        return this.transformPropValue(key, value);
      }
      const boundaryNodeId = this.markTextIntegrityBlocked(state.renderPolicy);
      if (boundaryNodeId !== undefined) {
        if (state.textIntegrityBlockedProps === undefined) {
          state.textIntegrityBlockedProps = new Map();
        }
        state.textIntegrityBlockedProps.set(key, boundaryNodeId);
      }
      this.queueOps([{
        op: "set-prop",
        nodeId: state.nodeId,
        key: "data-cfc-blocked-props",
        value: key,
      }]);
      return CFC_TEXT_INTEGRITY_PLACEHOLDER;
    }
    return this.transformPropValue(key, value);
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
  private extractVNode(node: unknown): WorkerVNode | null {
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
    policy: RenderPolicy,
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
        const childPolicy = this.childRenderPolicyForNode(
          sanitized,
          policy,
          oldState.nodeId,
        );
        const policyChildren = this.childrenForRenderPolicy(
          sanitized,
          childPolicy,
        );
        const policyChanged = !this.renderPolicyEquals(
          oldState.childRenderPolicy,
          childPolicy,
        ) || oldState.childrenBlockedByPolicy !== policyChildren.blocked;
        logger.debug("reconcile-node", () => ({
          id: wrapper.nodeId,
          strategy: "update-in-place",
          tagName: newTagName,
        }));
        oldState.renderPolicy = policy;
        oldState.childRenderPolicy = childPolicy;
        oldState.childrenBlockedByPolicy = policyChildren.blocked;
        oldState.sourceChildren = sanitized.children;
        oldState.sourceProps = sanitized.props;
        // Update props in place with proper diffing
        this.updatePropsInPlace(ctx, oldState, sanitized.props);

        // Update children in place with proper diffing
        if (policyChildren.children !== undefined) {
          const childrenSame = this.areChildrenSame(
            oldState,
            policyChildren.children,
          );
          this.updateChildrenInPlace(
            ctx,
            oldState,
            policyChildren.children,
            new Set(),
            childPolicy,
            policyChanged,
          );
          if (!childrenSame || policyChanged) {
            this.refreshTextIntegrityBoundaryState(oldState, childPolicy);
          }
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
      wrapper.currentChild = null;
      wrapper.cancel = () => {};
    }

    // Render new node - renderNode handles all render node types
    const state = this.renderNode(ctx, node, new Set(), policy);

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
    } else {
      wrapper.currentChild = null;
      wrapper.cancel = () => {};
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
    newProps: WorkerProps | Cell<WorkerProps> | null | undefined,
  ): void {
    // Handle Cell<Props> - if same cell, do nothing; otherwise re-subscribe
    if (isCell(newProps)) {
      const existingState = state.propSubscriptions.get(CELL_PROPS_KEY);
      if (existingState?.cell && areLinksSame(existingState.cell, newProps)) {
        // Same Cell, leave subscription in place
        logger.debug("props-same-cell", () => ({ nodeId: state.nodeId }));
        return;
      }
      // Different Cell - cancel all old subscriptions
      this.removeAllProps(state);

      // Set up new Cell<Props> binding
      this.bindCellProps(ctx, state, newProps as Cell<WorkerProps>);
      return;
    }

    // Handle static props object
    if (!newProps || typeof newProps !== "object") {
      // No props - remove all existing
      this.removeAllProps(state);
      return;
    }

    const newPropKeys = new Set(Object.keys(newProps));

    // Find props to remove (exist in old but not in new)
    for (const [key, propState] of state.propSubscriptions) {
      if (key === CELL_PROPS_KEY) continue;
      if (!newPropKeys.has(key)) {
        // Prop removed - cancel subscription and remove from DOM
        propState.cancel();
        state.propSubscriptions.delete(key);
        this.removeSingleProp(state, key);
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
          const propValue = this.transformPropValueForState(
            state,
            key,
            resolvedValue,
            value as Cell<unknown>,
          );
          this.queueOps([{
            op: "set-prop",
            nodeId: state.nodeId,
            key,
            value: propValue,
          }]);
          if (this.isTextIntegrityPolicyProp(key)) {
            this.refreshTextIntegrityBoundary(ctx, state);
          }
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
        const propValue = this.transformPropValueForState(state, key, value);
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
  private removeAllProps(state: NodeState): void {
    for (const [key, propState] of state.propSubscriptions) {
      propState.cancel();
      if (key === CELL_PROPS_KEY) continue;
      this.removeSingleProp(state, key);
    }
    state.propSubscriptions.clear();
    state.textIntegrityBlockedProps?.clear();
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

    if (this.retireEventHandler(state, eventType) !== undefined) {
      this.queueOps([{
        op: "remove-event",
        nodeId: state.nodeId,
        eventType,
      }]);
    }

    if (isStream(value)) {
      const stream = value as Stream<unknown>;
      const handlerId = ctx.registerHandler((event) => {
        stream.withTx(undefined).send(event);
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
          if (this.retireEventHandler(state, eventType) !== undefined) {
            this.queueOps([{
              op: "remove-event",
              nodeId: state.nodeId,
              eventType,
            }]);
          }

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
      this.queueOps(
        this.bindingOpsForCell(state, propName, value as Cell<unknown>),
      );
      state.propSubscriptions.set(key, {
        cell: value as Cell<unknown>,
        cancel: () => {},
      });
    }
  }

  /**
   * Bind Cell<Props> with per-prop handling strategy.
   *
   * - Event props: resolved via .key().resolveAsCell() → stream/handler registration
   * - Binding props: resolved via .key().resolveAsCell() → cell reference
   * - Object/array props: per-prop sink via .key().asSchema(true) for deep values
   * - Primitive props: set directly from resolved Cell<Props> value
   */
  private bindCellProps(
    ctx: ReconcileContext,
    state: NodeState,
    propsCell: Cell<WorkerProps>,
  ): Cancel {
    const [cancel, addCancel] = useCancelGroup();
    let hasSeenInitialProps = false;
    const refreshPolicyAfterPropsUpdate = () => {
      const childrenAlreadyBound = state.children.size > 0 ||
        state.childrenState !== undefined ||
        state.childOrder.length > 0;
      if (hasSeenInitialProps || childrenAlreadyBound) {
        this.refreshBoundaryPolicyFromProps(ctx, state, propsCell);
      } else {
        this.refreshInitialBoundaryPolicyFromProps(state, propsCell);
      }
      hasSeenInitialProps = true;
    };

    const sinkCancel = propsCell.sink((resolvedProps) => {
      logger.debug("cell-props-emit", () => ({
        nodeId: state.nodeId,
        props: resolvedProps,
      }));

      if (!resolvedProps || typeof resolvedProps !== "object") {
        // Props cleared - remove everything
        for (const [key, propState] of state.propSubscriptions) {
          if (key === CELL_PROPS_KEY) continue;
          propState.cancel();
          this.removeSingleProp(state, key);
        }
        // Keep only the Cell<Props> subscription itself
        const cellPropsSub = state.propSubscriptions.get(CELL_PROPS_KEY);
        state.propSubscriptions.clear();
        if (cellPropsSub) {
          state.propSubscriptions.set(CELL_PROPS_KEY, cellPropsSub);
        }
        refreshPolicyAfterPropsUpdate();
        return;
      }

      const props = resolvedProps as Record<string, unknown>;
      const newKeys = new Set(Object.keys(props));

      // Remove props that no longer exist
      for (const [key, propState] of state.propSubscriptions) {
        if (key === CELL_PROPS_KEY) continue;
        if (!newKeys.has(key)) {
          propState.cancel();
          this.removeSingleProp(state, key);
          state.propSubscriptions.delete(key);
        }
      }

      // Process each prop
      for (const [key, value] of Object.entries(props)) {
        if (isEventProp(key)) {
          // Event prop - resolve target via Cell navigation
          let resolvedTarget: Cell<unknown>;
          try {
            // Event handlers outlive the render transaction that resolved the
            // props cell, so avoid capturing a tx-bound cell here.
            resolvedTarget = propsCell.key(key).resolveAsCell().withTx();
          } catch (e) {
            logger.error(
              "resolveAsCell failed for event prop",
              () => ({ nodeId: state.nodeId, key, error: e }),
            );
            continue;
          }
          const existingState = state.propSubscriptions.get(key);

          // Skip if same target Cell
          if (
            existingState?.cell &&
            areLinksSame(existingState.cell, resolvedTarget)
          ) {
            continue;
          }

          const eventType = getEventType(key);

          if (this.retireEventHandler(state, eventType) !== undefined) {
            this.queueOps([{
              op: "remove-event",
              nodeId: state.nodeId,
              eventType,
            }]);
          }
          if (existingState) existingState.cancel();

          const handlerId = ctx.registerHandler((event) =>
            resolvedTarget.withTx(undefined).send(event)
          );
          state.eventHandlers.set(eventType, handlerId);
          this.queueOps([{
            op: "set-event",
            nodeId: state.nodeId,
            eventType,
            handlerId,
          }]);
          state.propSubscriptions.set(key, {
            cell: resolvedTarget,
            cancel: () => {},
          });
        } else if (isBindingProp(key)) {
          // Binding prop - prefer a serialized cell link in the prop value.
          // Cell<Props> VDOM props can store links to the original target cell;
          // resolving the props slot itself would bind an internal VDOM cell.
          let resolvedTarget: Cell<unknown>;
          try {
            resolvedTarget = this.resolveCellPropsBindingTarget(
              propsCell,
              key,
              value,
            );
          } catch (e) {
            logger.error(
              "resolveAsCell failed for binding prop",
              () => ({ nodeId: state.nodeId, key, error: e }),
            );
            continue;
          }
          const existingState = state.propSubscriptions.get(key);

          // Skip if same Cell
          if (
            existingState?.cell &&
            areLinksSame(existingState.cell, resolvedTarget)
          ) {
            continue;
          }
          if (existingState) existingState.cancel();

          const propName = getBindingPropName(key);
          this.queueOps(
            this.bindingOpsForCell(state, propName, resolvedTarget),
          );
          state.propSubscriptions.set(key, {
            cell: resolvedTarget,
            cancel: () => {},
          });
        } else if (
          value !== null && value !== undefined && typeof value === "object"
        ) {
          // Object/array value - needs per-prop sink for deep resolution
          const existingState = state.propSubscriptions.get(key);
          if (existingState?.cell) continue; // Already has active per-prop sink

          // Cancel any existing primitive subscription for this key
          if (existingState) existingState.cancel();

          // Schema `true` = accept everything → enables deep traversal of this prop
          const propKeyCell = propsCell.key(key).asSchema(true);
          const propSinkCancel = propKeyCell.sink((deepValue: unknown) => {
            const propValue = this.transformPropValueForState(
              state,
              key,
              deepValue,
              this.resolveTextPropSourceCell(state, propsCell, key, value),
            );
            this.queueOps([{
              op: "set-prop",
              nodeId: state.nodeId,
              key,
              value: propValue,
            }]);
          });
          addCancel(propSinkCancel);
          state.propSubscriptions.set(key, {
            cell: propKeyCell as Cell<unknown>,
            cancel: propSinkCancel,
          });
        } else {
          // Primitive value - set directly
          const existingState = state.propSubscriptions.get(key);

          // Cancel per-prop sink if value transitioned from object to primitive
          if (existingState?.cell) {
            existingState.cancel();
          }

          // Skip only when a previous primitive value is unchanged. Object/cell
          // prop states do not track currentValue, so they must still emit a
          // set-prop when transitioning to a primitive such as undefined.
          if (
            existingState && !existingState.cell &&
            existingState.currentValue === value
          ) continue;

          const propValue = this.transformPropValueForState(
            state,
            key,
            value,
            this.resolveTextPropSourceCell(state, propsCell, key, value),
          );
          this.queueOps([{
            op: "set-prop",
            nodeId: state.nodeId,
            key,
            value: propValue,
          }]);
          state.propSubscriptions.set(key, {
            cell: undefined,
            cancel: () => {},
            currentValue: value,
          });
        }
      }
      refreshPolicyAfterPropsUpdate();
    });

    addCancel(sinkCancel);
    state.propSubscriptions.set(CELL_PROPS_KEY, {
      cell: propsCell as Cell<unknown>,
      cancel: sinkCancel,
    });

    return cancel;
  }

  private refreshBoundaryPolicyFromProps(
    ctx: ReconcileContext,
    state: NodeState,
    props: WorkerVNode["props"],
  ): void {
    if (
      state.tagName !== CFC_RENDER_BOUNDARY_TAG &&
      state.tagName !== CFC_AUTHORSHIP_TAG
    ) {
      return;
    }
    if (state.sourceChildren === undefined) {
      return;
    }

    const node: WorkerVNode = {
      type: "vnode",
      name: state.tagName,
      props,
      children: state.sourceChildren,
    };
    const childPolicy = this.childRenderPolicyForNode(
      node,
      state.renderPolicy,
      state.nodeId,
    );
    const policyChildren = this.childrenForRenderPolicy(node, childPolicy);
    const policyChanged = !this.renderPolicyEquals(
      state.childRenderPolicy,
      childPolicy,
    ) || state.childrenBlockedByPolicy !== policyChildren.blocked;

    state.sourceProps = props;
    state.childRenderPolicy = childPolicy;
    state.childrenBlockedByPolicy = policyChildren.blocked;
    if (policyChildren.children === undefined) {
      return;
    }

    const childrenSame = this.areChildrenSame(state, policyChildren.children);
    if (!childrenSame || policyChanged) {
      this.updateChildrenInPlace(
        ctx,
        state,
        policyChildren.children,
        new Set(),
        childPolicy,
        policyChanged,
      );
      this.refreshTextIntegrityBoundaryState(state, childPolicy);
    }
  }

  private refreshInitialBoundaryPolicyFromProps(
    state: NodeState,
    props: WorkerVNode["props"],
  ): void {
    if (
      state.tagName !== CFC_RENDER_BOUNDARY_TAG &&
      state.tagName !== CFC_AUTHORSHIP_TAG
    ) {
      return;
    }
    if (state.sourceChildren === undefined) {
      return;
    }

    const node: WorkerVNode = {
      type: "vnode",
      name: state.tagName,
      props,
      children: state.sourceChildren,
    };
    const childPolicy = this.childRenderPolicyForNode(
      node,
      state.renderPolicy,
      state.nodeId,
    );
    const policyChildren = this.childrenForRenderPolicy(node, childPolicy);

    state.sourceProps = props;
    state.childRenderPolicy = childPolicy;
    state.childrenBlockedByPolicy = policyChildren.blocked;
    this.initializeTextIntegrityBoundary(childPolicy, state.nodeId);
  }

  private resolveTextPropSourceCell(
    state: NodeState,
    propsCell: Cell<WorkerProps>,
    key: string,
    value: unknown,
  ): Cell<unknown> | undefined {
    if (!this.isTextIntegrityProp(state, key)) {
      return undefined;
    }
    try {
      return this.resolveCellPropsBindingTarget(propsCell, key, value);
    } catch {
      try {
        return propsCell.key(key).asSchema(true) as Cell<unknown>;
      } catch {
        return undefined;
      }
    }
  }

  private resolveCellPropsBindingTarget(
    propsCell: Cell<WorkerProps>,
    key: string,
    value: unknown,
  ): Cell<unknown> {
    const propCell = propsCell.key(key).asSchema(true);
    const rawValue = this.readRawBindingPropValue(propsCell, propCell, key);
    let base:
      | ReturnType<Cell<WorkerProps>["getAsNormalizedFullLink"]>
      | undefined;
    try {
      base = propsCell.getAsNormalizedFullLink();
    } catch {
      base = undefined;
    }
    const link = base
      ? parseLink(rawValue, base) ?? parseLink(value, base)
      : parseLink(rawValue) ?? parseLink(value);
    if (link?.id && link.space) {
      return propsCell.runtime.getCellFromLink(link);
    }
    if (isCell(value)) {
      return value as Cell<unknown>;
    }
    return propCell.resolveAsCell();
  }

  private readRawBindingPropValue(
    propsCell: Cell<WorkerProps>,
    propCell: Cell<unknown>,
    key: string,
  ): unknown {
    try {
      const rawProps = propsCell.getRawUntyped({ frozen: false });
      if (
        rawProps !== null && typeof rawProps === "object" && key in rawProps
      ) {
        return (rawProps as Record<string, unknown>)[key];
      }
    } catch {
      // Fall through to the prop cell: older/mock cells may not expose parent raw props.
    }
    try {
      return propCell.getRawUntyped({ frozen: false });
    } catch {
      return undefined;
    }
  }

  /**
   * Remove a single prop from a node (DOM side + handler cleanup).
   */
  private removeSingleProp(state: NodeState, key: string): void {
    state.textIntegrityBlockedProps?.delete(key);
    if (isEventProp(key)) {
      const eventType = getEventType(key);
      this.retireEventHandler(state, eventType);
      this.queueOps([{
        op: "remove-event",
        nodeId: state.nodeId,
        eventType,
      }]);
    } else if (isBindingProp(key)) {
      this.queueOps([{
        op: "remove-prop",
        nodeId: state.nodeId,
        key: getBindingPropName(key),
      }]);
    } else {
      this.queueOps([{
        op: "remove-prop",
        nodeId: state.nodeId,
        key,
      }]);
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
    policy: RenderPolicy,
    forceReplace = false,
  ): void {
    // Handle Cell<children> - check if same Cell
    if (isCell(children)) {
      const existingState = state.childrenState;
      if (
        !forceReplace && existingState?.cell &&
        areLinksSame(existingState.cell, children)
      ) {
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
            this.updateChildren(
              ctx,
              state,
              resolvedChildren,
              visited,
              policy,
              forceReplace,
            );
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
      this.updateChildren(ctx, state, children, visited, policy, forceReplace);
    }
  }

  /**
   * Render any render node type and return its state.
   */
  private renderNode(
    ctx: ReconcileContext,
    inputNode: WorkerRenderNode,
    visited: Set<object>,
    policy: RenderPolicy,
  ): NodeState | null {
    // Handle null/undefined
    if (inputNode === null || inputNode === undefined) {
      return null;
    }

    // Handle text nodes (strings and numbers)
    if (typeof inputNode === "string" || typeof inputNode === "number") {
      return this.createTextNode(ctx, String(inputNode), policy);
    }

    // Handle arrays - render as fragment wrapper
    if (Array.isArray(inputNode)) {
      return this.renderArrayAsFragment(ctx, inputNode, visited, policy);
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
        return this.createCyclePlaceholder(ctx, policy);
      }
      visited.add(node as object);
      // deno-lint-ignore no-explicit-any
      node = (node as any)[UI];
    }

    // After following [UI] chain, node may have become a primitive
    if (typeof node === "string" || typeof node === "number") {
      return this.createTextNode(ctx, String(node), policy);
    }
    if (node === null || node === undefined || typeof node === "boolean") {
      return null;
    }
    if (Array.isArray(node)) {
      return this.renderArrayAsFragment(
        ctx,
        node as WorkerRenderNode[],
        visited,
        policy,
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
      return this.createCyclePlaceholder(ctx, policy);
    }
    visited.add(node as object);

    // Sanitize node
    const sanitized = this.sanitizeNode(node as WorkerVNode);
    if (!sanitized) {
      return null;
    }

    // Create element. Stamp the producing cell's space when it differs
    // from the nearest ancestor element that carried one — descendants
    // inherit, so transcluded subtrees re-stamp at their boundary.
    const stampSpace = ctx.space !== undefined &&
        ctx.space !== ctx.emittedSpace
      ? ctx.space
      : undefined;
    const nodeId = ctx.nextNodeId();
    this.queueOps([{
      op: "create-element",
      nodeId,
      tagName: sanitized.name,
      ...(stampSpace !== undefined ? { space: stampSpace } : {}),
    }]);
    if (stampSpace !== undefined) {
      ctx = { ...ctx, emittedSpace: stampSpace };
    }
    const childPolicy = this.childRenderPolicyForNode(
      sanitized,
      policy,
      nodeId,
    );
    const policyChildren = this.childrenForRenderPolicy(
      sanitized,
      childPolicy,
    );

    // Create state
    const state: NodeState = {
      nodeId,
      tagName: sanitized.name,
      cancel,
      children: new Map(),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
      childOrder: [],
      renderPolicy: policy,
      childRenderPolicy: childPolicy,
      childrenBlockedByPolicy: policyChildren.blocked,
      sourceChildren: sanitized.children,
      sourceProps: sanitized.props,
    };
    addCancel(() => this.cleanupNodeHandlers(state));
    this.initializeTextIntegrityBoundary(childPolicy, nodeId);

    // Bind props. Cell<Props> can synchronously resolve boundary policy props;
    // bind children from the current state policy after props are bound.
    addCancel(this.bindProps(ctx, state, sanitized.props));

    // Bind children
    const activePolicyChildren = this.childrenForRenderPolicy(
      sanitized,
      state.childRenderPolicy,
    );
    state.childrenBlockedByPolicy = activePolicyChildren.blocked;
    if (activePolicyChildren.children !== undefined) {
      addCancel(
        this.bindChildren(
          ctx,
          state,
          activePolicyChildren.children,
          visited,
          state.childRenderPolicy,
        ),
      );
    }

    return state;
  }

  /**
   * Create a placeholder for circular references.
   */
  private createCyclePlaceholder(
    ctx: ReconcileContext,
    policy: RenderPolicy = DEFAULT_RENDER_POLICY,
  ): NodeState {
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
      renderPolicy: policy,
      childRenderPolicy: policy,
      childrenBlockedByPolicy: false,
    };
  }

  private createBlockedPlaceholder(
    ctx: ReconcileContext,
    policy: RenderPolicy,
    reason: "policy" | "integrity" = "policy",
  ): NodeState {
    const nodeId = ctx.nextNodeId();
    const textId = ctx.nextNodeId();
    const integrityBlocked = reason === "integrity";
    const text = integrityBlocked
      ? CFC_TEXT_INTEGRITY_PLACEHOLDER
      : "Content hidden by policy";
    if (integrityBlocked) {
      this.markTextIntegrityBlocked(policy);
    }
    this.queueOps([
      { op: "create-element", nodeId, tagName: CFC_BLOCKED_PLACEHOLDER_TAG },
      { op: "set-prop", nodeId, key: "data-cfc-blocked", value: "true" },
      {
        op: "set-prop",
        nodeId,
        key: "data-cfc-blocked-reason",
        value: reason,
      },
      {
        op: "set-prop",
        nodeId,
        key: "title",
        value: integrityBlocked
          ? "CFC text integrity policy blocked this content"
          : "CFC render policy blocked this content",
      },
      { op: "create-text", nodeId: textId, text },
      {
        op: "insert-child",
        parentId: nodeId,
        childId: textId,
        beforeId: null,
      },
    ]);

    return {
      nodeId,
      tagName: CFC_BLOCKED_PLACEHOLDER_TAG,
      cancel: () => {},
      children: new Map([[
        "__blocked_text__",
        {
          nodeId: textId,
          isText: true,
          cancel: () => {},
          currentValue: text,
        },
      ]]),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
      childOrder: ["__blocked_text__"],
      renderPolicy: policy,
      childRenderPolicy: policy,
      childrenBlockedByPolicy: false,
      textIntegrityBlockedFor: integrityBlocked
        ? policy.textIntegrity?.boundaryNodeId
        : undefined,
    };
  }

  /**
   * Create a text node.
   */
  private createTextNode(
    ctx: ReconcileContext,
    text: string,
    policy: RenderPolicy = DEFAULT_RENDER_POLICY,
    options?: { trustedText?: boolean },
  ): NodeState {
    if (!options?.trustedText && this.shouldBlockLiteralText(text, policy)) {
      return this.createBlockedPlaceholder(ctx, policy, "integrity");
    }

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
      renderPolicy: policy,
      childRenderPolicy: policy,
      childrenBlockedByPolicy: false,
    };
  }

  /**
   * Render an array of nodes as a fragment wrapper.
   */
  private renderArrayAsFragment(
    ctx: ReconcileContext,
    nodes: WorkerRenderNode[],
    visited: Set<object>,
    policy: RenderPolicy,
  ): NodeState | null {
    const nodeId = ctx.nextNodeId();
    this.queueOps([
      { op: "create-element", nodeId, tagName: "cf-fragment" },
    ]);

    const [cancel, addCancel] = useCancelGroup();

    const state: NodeState = {
      nodeId,
      tagName: "cf-fragment",
      cancel,
      children: new Map(),
      propSubscriptions: new Map(),
      eventHandlers: new Map(),
      childOrder: [],
      renderPolicy: policy,
      childRenderPolicy: policy,
      childrenBlockedByPolicy: false,
    };
    addCancel(() => this.cleanupNodeHandlers(state));

    // Render each child and insert it
    for (const childNode of nodes) {
      const childState = this.renderNode(
        ctx,
        childNode,
        new Set(visited),
        policy,
      );
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
      result = { ...result, name: "cf-fragment" };
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
    props: WorkerProps | Cell<WorkerProps> | null | undefined,
  ): Cancel {
    if (!props) return () => {};

    const [cancel, addCancel] = useCancelGroup();

    // Handle Cell<Props>
    if (isCell(props)) {
      const cellPropsCancel = this.bindCellProps(
        ctx,
        state,
        props as Cell<WorkerProps>,
      );
      addCancel(cellPropsCancel);
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
          const handlerId = ctx.registerHandler((event) => {
            stream.withTx(undefined).send(event);
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
              if (this.retireEventHandler(state, eventType) !== undefined) {
                this.queueOps([{
                  op: "remove-event",
                  nodeId: state.nodeId,
                  eventType,
                }]);
              }

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
          this.queueOps(
            this.bindingOpsForCell(state, propName, value as Cell<unknown>),
          );
          state.propSubscriptions.set(key, {
            cell: value as Cell<unknown>,
            cancel: () => {},
          });
        }
      } else if (isCell(value)) {
        // Reactive prop value
        const sinkCancel = (value as Cell<unknown>).sink((resolvedValue) => {
          const propValue = this.transformPropValueForState(
            state,
            key,
            resolvedValue,
            value as Cell<unknown>,
          );
          this.queueOps([{
            op: "set-prop",
            nodeId: state.nodeId,
            key,
            value: propValue,
          }]);
          if (this.isTextIntegrityPolicyProp(key)) {
            this.refreshTextIntegrityBoundary(ctx, state);
          }
        });
        addCancel(sinkCancel);
        state.propSubscriptions.set(key, {
          cell: value as Cell<unknown>,
          cancel: sinkCancel,
        });
      } else {
        // Static prop value
        const propValue = this.transformPropValueForState(state, key, value);
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
    policy: RenderPolicy,
  ): Cancel {
    const [cancel, addCancel] = useCancelGroup();

    // Handle Cell<children>
    if (isCell(children)) {
      const sinkCancel = (
        children as Cell<WorkerRenderNode | WorkerRenderNode[]>
      ).sink((resolvedChildren) => {
        this.updateChildren(ctx, state, resolvedChildren, visited, policy);
      });
      addCancel(sinkCancel);
      // Track the children Cell for diffing
      state.childrenState = {
        cell: children as Cell<unknown>,
        cancel: sinkCancel,
      };
    } else {
      // Static children
      this.updateChildren(ctx, state, children, visited, policy);
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
    policy: RenderPolicy,
    forceReplace = false,
  ): void {
    // Normalize to array
    const newChildren = Array.isArray(childrenValue)
      ? childrenValue
      : (childrenValue === null || childrenValue === undefined)
      ? []
      : [childrenValue];

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

      if (!forceReplace && state.children.has(key)) {
        // Reuse existing child
        const existingState = state.children.get(key)!;
        const canReuse = this.reconcileReusedChild(
          ctx,
          existingState,
          child,
          visited,
          policy,
        );
        state.children.delete(key);
        if (canReuse) {
          newMapping.set(key, existingState);
        } else {
          existingState.cancel();
          this.cleanupNodeHandlers(existingState);
          this.queueOps([{ op: "remove-node", nodeId: existingState.nodeId }]);
          hasNewChildren = true;
          const childState = this.renderChild(
            ctx,
            child,
            visited,
            state,
            key,
            policy,
          );
          if (childState) {
            newMapping.set(key, childState);
          }
        }
      } else {
        // Create new child, passing parent state and key for position tracking
        hasNewChildren = true;
        const childState = this.renderChild(
          ctx,
          child,
          visited,
          state,
          key,
          policy,
        );
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
   * Reconcile a reused keyed child. A stable key preserves DOM identity and
   * ordering, but the VNode payload may still have fresh captured values from a
   * parent recomputation, so same-key reuse cannot blindly skip descendants.
   */
  private reconcileReusedChild(
    ctx: ReconcileContext,
    childState: ChildNodeState,
    child: unknown,
    visited: Set<object>,
    policy: RenderPolicy,
  ): boolean {
    if (isCell(child)) {
      return childState.cell !== undefined &&
        this.sameCellForReuse(childState.cell, child);
    }

    if (
      childState.isText &&
      childState.cell === undefined &&
      (typeof child === "string" || typeof child === "number" ||
        typeof child === "boolean" || child === null || child === undefined)
    ) {
      const text = this.stringifyText(child);
      if (text !== childState.currentValue) {
        childState.currentValue = text;
        this.queueOps([{
          op: "update-text",
          nodeId: childState.nodeId,
          text,
        }]);
      }
      return true;
    }

    if (!childState.elementState) return false;

    const newVNode = this.extractVNode(child);
    if (!newVNode) return false;

    const sanitized = this.sanitizeNode(newVNode);
    if (!sanitized || sanitized.name !== childState.elementState.tagName) {
      return false;
    }

    const childPolicy = this.childRenderPolicyForNode(
      sanitized,
      policy,
      childState.elementState.nodeId,
    );
    const policyChildren = this.childrenForRenderPolicy(
      sanitized,
      childPolicy,
    );
    const policyChanged = !this.renderPolicyEquals(
      childState.elementState.childRenderPolicy,
      childPolicy,
    ) || childState.elementState.childrenBlockedByPolicy !==
        policyChildren.blocked;

    childState.currentValue = child;
    childState.elementState.renderPolicy = policy;
    childState.elementState.childRenderPolicy = childPolicy;
    childState.elementState.childrenBlockedByPolicy = policyChildren.blocked;
    childState.elementState.sourceChildren = sanitized.children;
    childState.elementState.sourceProps = sanitized.props;

    this.updatePropsInPlace(ctx, childState.elementState, sanitized.props);

    if (policyChildren.children !== undefined) {
      const childrenSame = this.areChildrenSame(
        childState.elementState,
        policyChildren.children,
      );
      this.updateChildrenInPlace(
        ctx,
        childState.elementState,
        policyChildren.children,
        new Set(visited),
        childPolicy,
        policyChanged,
      );
      if (!childrenSame || policyChanged) {
        this.refreshTextIntegrityBoundaryState(
          childState.elementState,
          childPolicy,
        );
      }
    }
    return true;
  }

  private sameCellForReuse(left: Cell<unknown>, right: Cell<unknown>): boolean {
    try {
      return areLinksSame(left, right);
    } catch {
      return left === right;
    }
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
    policy: RenderPolicy,
  ): ChildNodeState | null {
    // Handle Cell children - no wrapper, track position dynamically
    if (isCell(child)) {
      return this.renderCellChild(
        ctx,
        child as Cell<unknown>,
        visited,
        parentState,
        childKey,
        policy,
      );
    }

    // Handle non-Cell content
    return this.renderChildContent(ctx, child, visited, policy);
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
    policy: RenderPolicy,
  ): ChildNodeState {
    // A followed cell is a (potential) transclusion boundary: its
    // subtree renders in the CELL's space, not the surrounding one.
    const cellSpace = this.spaceOfCell(cell);
    if (cellSpace !== undefined && cellSpace !== ctx.space) {
      ctx = { ...ctx, space: cellSpace };
    }
    const [cancel, addCancel] = useCancelGroup();

    // Create child state that will track the current node
    // nodeId will be set synchronously when sink fires
    const childState: ChildNodeState = {
      nodeId: -1,
      isText: false,
      cancel,
      cell,
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

        if (!this.canRenderCellUnderPolicy(cell, policy)) {
          if (!isInitialRender) {
            if (currentCancel) {
              currentCancel();
              currentCancel = undefined;
            }
            this.cleanupNodeHandlers(childState);
            this.queueOps([{ op: "remove-node", nodeId: childState.nodeId }]);
          }

          childState.nodeId = -1;
          childState.elementState = undefined;
          childState.isText = false;

          const blockedState = this.createBlockedPlaceholder(ctx, policy);
          childState.nodeId = blockedState.nodeId;
          childState.elementState = blockedState;
          childState.isText = false;
          currentCancel = blockedState.cancel;

          const beforeId = this.findNextSiblingId(
            parentState.children,
            childKey,
          );
          this.queueOps([{
            op: "insert-child",
            parentId: parentState.nodeId,
            childId: blockedState.nodeId,
            beforeId,
          }]);
          return;
        }

        if (this.shouldBlockTextFromCell(resolvedChild, cell, policy)) {
          if (!isInitialRender) {
            if (currentCancel) {
              currentCancel();
              currentCancel = undefined;
            }
            this.cleanupNodeHandlers(childState);
            this.queueOps([{ op: "remove-node", nodeId: childState.nodeId }]);
          }

          childState.nodeId = -1;
          childState.elementState = undefined;
          childState.isText = false;

          const blockedState = this.createBlockedPlaceholder(
            ctx,
            policy,
            "integrity",
          );
          childState.nodeId = blockedState.nodeId;
          childState.elementState = blockedState;
          childState.isText = false;
          currentCancel = blockedState.cancel;

          const beforeId = this.findNextSiblingId(
            parentState.children,
            childKey,
          );
          this.queueOps([{
            op: "insert-child",
            parentId: parentState.nodeId,
            childId: blockedState.nodeId,
            beforeId,
          }]);
          return;
        }

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
                const childPolicy = this.childRenderPolicyForNode(
                  sanitized,
                  policy,
                  childState.elementState.nodeId,
                );
                const policyChildren = this.childrenForRenderPolicy(
                  sanitized,
                  childPolicy,
                );
                const policyChanged = !this.renderPolicyEquals(
                  childState.elementState.childRenderPolicy,
                  childPolicy,
                ) ||
                  childState.elementState.childrenBlockedByPolicy !==
                    policyChildren.blocked;
                childState.elementState.renderPolicy = policy;
                childState.elementState.childRenderPolicy = childPolicy;
                childState.elementState.childrenBlockedByPolicy =
                  policyChildren.blocked;
                childState.elementState.sourceChildren = sanitized.children;
                childState.elementState.sourceProps = sanitized.props;
                // Same tag - update props in place
                this.updatePropsInPlace(
                  ctx,
                  childState.elementState,
                  sanitized.props,
                );

                if (policyChildren.children !== undefined) {
                  const childrenSame = this.areChildrenSame(
                    childState.elementState,
                    policyChildren.children,
                  );
                  this.updateChildrenInPlace(
                    ctx,
                    childState.elementState,
                    policyChildren.children,
                    new Set(),
                    childPolicy,
                    policyChanged,
                  );
                  if (!childrenSame || policyChanged) {
                    this.refreshTextIntegrityBoundaryState(
                      childState.elementState,
                      childPolicy,
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

        // Render new content. Primitive text from a Cell has already passed
        // source-cell text integrity verification above, so do not reclassify
        // it as an untrusted literal.
        const newState = this.hasVisibleTextValue(resolvedChild) &&
            (typeof resolvedChild === "string" ||
              typeof resolvedChild === "number" ||
              typeof resolvedChild === "boolean")
          ? {
            nodeId: this.createTextNode(
              ctx,
              this.stringifyText(resolvedChild),
              policy,
              { trustedText: true },
            ).nodeId,
            isText: true,
            cancel: () => {},
          }
          : this.renderChildContent(
            ctx,
            resolvedChild,
            new Set(visited),
            policy,
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
    policy: RenderPolicy,
  ): ChildNodeState | null {
    // Handle arrays - wrap in a span with display:contents
    if (Array.isArray(child)) {
      const wrapperVNode: WorkerVNode = {
        type: "vnode",
        name: "span",
        props: { style: "display:contents" },
        children: child,
      };
      const state = this.renderNode(
        ctx,
        wrapperVNode,
        new Set(visited),
        policy,
      );
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
      const state = this.renderNode(ctx, child, new Set(visited), policy);
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
        policy,
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
    const state = this.createTextNode(ctx, text, policy);

    return {
      nodeId: state.nodeId,
      isText: state.tagName === "#text",
      cancel: state.cancel,
      elementState: state.tagName === "#text" ? undefined : state,
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
