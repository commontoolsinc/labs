/**
 * Keeps React Flow's transient node state local while Fabric remains the
 * authoritative source for durable node data.
 */

/** A position in React Flow's canvas coordinate system. */
export interface XYPosition {
  /** Horizontal canvas coordinate. */
  x: number;
  /** Vertical canvas coordinate. */
  y: number;
}

/** Node fields required by the collaborative lifecycle helpers. */
export interface PositionedNode {
  /** Stable durable node identity. */
  id: string;
  /** Current canvas position. */
  position: XYPosition;
}

/** Mutable position drafts captured synchronously from React Flow changes. */
export interface PositionDraftsRef {
  /** Latest unsaved positions, keyed by stable machine-node ID. */
  current: Record<string, XYPosition>;
}

/** Applies one React Flow change batch and records its durable positions. */
export function applyCollaborativeNodeChanges<
  NodeType extends PositionedNode,
  ChangeType extends { type: string },
>(
  changes: ChangeType[],
  nodes: NodeType[],
  draftsRef: PositionDraftsRef,
  applyChanges: (changes: ChangeType[], nodes: NodeType[]) => NodeType[],
): NodeType[] {
  const positions = changes.filter(
    (change): change is ChangeType & {
      id: string;
      position: XYPosition;
    } =>
      change.type === "position" &&
      (change as { position?: XYPosition }).position !== undefined,
  );
  Object.assign(
    draftsRef.current,
    Object.fromEntries(
      positions.map((change) => [change.id, change.position!]),
    ),
  );
  return applyChanges(changes, nodes);
}

/**
 * Reconciles authoritative node data without displacing local position drafts
 * or React Flow's gesture state.
 */
export function reconcileCollaborativeNodes<NodeType extends PositionedNode>(
  nodes: NodeType[],
  authoritativeNodes: NodeType[],
  drafts: Readonly<Record<string, XYPosition>>,
): NodeType[] {
  const currentById = new Map(nodes.map((node) => [node.id, node]));
  return authoritativeNodes.map((authoritative) => {
    const current = currentById.get(authoritative.id);
    return {
      ...current,
      ...authoritative,
      position: drafts[authoritative.id] ?? authoritative.position,
    };
  });
}

/** Clears a position draft only when its matching write completes. */
export function settlePositionDraft(
  draftsRef: PositionDraftsRef,
  nodeId: string,
  committed: XYPosition,
): boolean {
  const latest = draftsRef.current[nodeId];
  if (
    latest === undefined || latest.x !== committed.x ||
    latest.y !== committed.y
  ) {
    return false;
  }
  const next = { ...draftsRef.current };
  delete next[nodeId];
  draftsRef.current = next;
  return true;
}
