import type { Cell } from "../cell.ts";
import { isCell } from "../cell.ts";
import { getCellOrThrow, isCellResult } from "../query-result-proxy.ts";
import type { Runtime } from "../runtime.ts";
import { UI, type VNode } from "../builder/types.ts";
import { debugVDOMSchema } from "../schemas.ts";
import {
  type CfcAtom,
  joinIntegrityLabels,
  normalizeConfidentialityLabel,
  normalizeIntegrityLabel,
} from "./label-algebra.ts";
import {
  cfcLabelsAddress,
  normalizePersistedPathLabels,
  resolveObservationLabel,
} from "./shared.ts";
import {
  type CfcEventEnvelope,
  createCfcEventEnvelope,
} from "./event-envelope.ts";

export interface UiEventAttributeSelector {
  readonly name: string;
  readonly value?: string;
}

export interface UiEventSelector {
  readonly path?: string;
  readonly attr?: UiEventAttributeSelector;
  readonly occurrence?: number;
}

export interface ResolveUiEventOptions extends UiEventSelector {
  readonly rootPath?: string;
  readonly schema?: unknown;
  readonly event?: string;
  readonly payload?: unknown;
  readonly sourceGestureId?: string;
  readonly evidence?: Record<string, unknown>;
}

export interface ResolvedUiEventTarget {
  readonly eventStream: Cell<unknown>;
  readonly envelope: CfcEventEnvelope<unknown>;
  readonly eventProp: string;
  readonly nodePath: string;
  readonly integrity: readonly CfcAtom[];
  readonly trace: readonly {
    readonly id: string;
    readonly path: string;
  }[];
}

interface UiTraversalFrame {
  readonly rootCell: Cell<unknown>;
  readonly path: string;
}

interface UiNodeMatch {
  readonly nodeCell: Cell<unknown>;
  readonly rootCell: Cell<unknown>;
  readonly path: string;
  readonly node: VNode;
  readonly trace: readonly UiTraversalFrame[];
}

function parsePath(path: string): string[] {
  if (path === "/") {
    return [];
  }
  return path.replace(/^\//, "").split("/").filter((segment) =>
    segment.length > 0
  );
}

function joinRelativePath(
  basePath: readonly string[],
  relativePath: string | undefined,
): string {
  const relative = relativePath ?? "/";
  const relativeSegments = relative === "/"
    ? []
    : relative.replace(/^\//, "").split("/").filter((segment) =>
      segment.length > 0
    );
  const allSegments = [...basePath, ...relativeSegments];
  return allSegments.length === 0 ? "/" : `/${allSegments.join("/")}`;
}

function pathToSegments(path: string): Array<string | number> {
  return parsePath(path).map((segment) =>
    /^\d+$/.test(segment) ? Number(segment) : segment
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVNode(value: unknown): value is VNode {
  return isRecord(value) &&
    (
      value.type === "vnode" ||
      typeof value.name === "string" ||
      "props" in value ||
      "children" in value
    );
}

function resolveRenderableValue(value: unknown): unknown {
  if (isCell(value)) {
    return value.getAsQueryResult();
  }
  if (isCellResult(value)) {
    return getCellOrThrow(value).getAsQueryResult();
  }
  return value;
}

function extractVNodeish(value: unknown): VNode | null {
  value = resolveRenderableValue(value);
  if (isVNode(value)) {
    return value;
  }

  const visited = new Set<object>();
  let current: unknown = value;
  while (isRecord(current) && UI in current) {
    if (visited.has(current)) {
      return null;
    }
    visited.add(current);
    current = current[UI];
    if (isVNode(current)) {
      return current;
    }
  }

  return null;
}

function isUiRenderable(value: unknown): value is Record<string, unknown> {
  value = resolveRenderableValue(value);
  return isRecord(value) && UI in value && !isVNode(value);
}

function getCellAtPath(rootCell: Cell<unknown>, path: string): Cell<unknown> {
  let current = rootCell.resolveAsCell();
  for (const segment of pathToSegments(path)) {
    current = current.key(segment as never).resolveAsCell();
  }
  return current;
}

function rootPathForTraversal(options: ResolveUiEventOptions): string {
  return options.rootPath ?? `/${UI}`;
}

function eventPropName(event: string | undefined): string {
  if (!event || event === "click") {
    return "onClick";
  }
  if (event.startsWith("on") && event.length > 2) {
    return event;
  }
  return `on${event.charAt(0).toUpperCase()}${event.slice(1)}`;
}

function matchesAttr(
  node: VNode,
  selector: UiEventAttributeSelector | undefined,
): boolean {
  if (!selector) {
    return false;
  }
  if (!isRecord(node.props)) {
    return false;
  }
  if (!(selector.name in node.props)) {
    return false;
  }
  if (selector.value === undefined) {
    return true;
  }
  return node.props[selector.name] === selector.value;
}

function normalizeChildren(
  children: VNode["children"] | undefined,
): Array<{ value: unknown; segment: string }> {
  if (children === undefined || children === null) {
    return [];
  }
  if (Array.isArray(children)) {
    return children.map((value, index) => ({
      value,
      segment: `children/${index}`,
    }));
  }
  return [{ value: children, segment: "children" }];
}

async function resolveNodeChildren(
  currentCell: Cell<unknown>,
  node: VNode,
): Promise<Array<{ value: unknown; segment: string }>> {
  const directChildren = normalizeChildren(node.children);
  if (directChildren.length > 0) {
    return directChildren;
  }
  try {
    const queryChildren = (currentCell.key("children")
      .getAsQueryResult() as {
        children?: VNode["children"];
      }) ?? currentCell.key("children").getAsQueryResult();
    const normalized = normalizeChildren(
      Array.isArray(queryChildren) ? queryChildren : queryChildren.children,
    );
    if (normalized.length > 0) {
      return normalized;
    }
  } catch {
    // Fall through to direct cell pull below.
  }
  try {
    const lazyChildren = await currentCell.key("children")
      .asSchema(true)
      .pull() as
        | VNode["children"]
        | undefined;
    return normalizeChildren(lazyChildren);
  } catch {
    return [];
  }
}

function resolveLocalSchemaLabel(
  runtime: Runtime,
  schema: unknown,
  observationPath: string,
): {
  integrity?: readonly CfcAtom[];
} | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const schemaAtPath = runtime.cfc.getSchemaAtPath(
    schema as never,
    parsePath(observationPath),
  );
  if (
    !schemaAtPath || typeof schemaAtPath !== "object" ||
    Array.isArray(schemaAtPath)
  ) {
    return undefined;
  }
  const rawIfc = (schemaAtPath as { ifc?: unknown }).ifc;
  if (!rawIfc || typeof rawIfc !== "object" || Array.isArray(rawIfc)) {
    return undefined;
  }

  normalizeConfidentialityLabel(
    (rawIfc as { classification?: unknown }).classification,
  );
  const integrity = joinIntegrityLabels(
    normalizeIntegrityLabel((rawIfc as { integrity?: unknown }).integrity),
    normalizeIntegrityLabel(
      (rawIfc as { addIntegrity?: unknown }).addIntegrity,
    ),
  );

  if (!integrity) {
    return undefined;
  }
  return { integrity };
}

async function loadPersistedLabels(
  runtime: Runtime,
  cell: Cell<unknown>,
  cache: Map<string, ReturnType<typeof normalizePersistedPathLabels>>,
): Promise<ReturnType<typeof normalizePersistedPathLabels> | undefined> {
  const link = cell.getAsNormalizedFullLink();
  const cacheKey = `${link.space}:${link.id}:${link.type}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const tx = runtime.edit();
  try {
    const value = tx.readOrThrow(cfcLabelsAddress({
      space: link.space,
      id: link.id,
      type: link.type,
    }));
    const { error } = await tx.commit();
    if (error) {
      return undefined;
    }
    const normalized = normalizePersistedPathLabels(value);
    cache.set(cacheKey, normalized);
    return normalized;
  } catch {
    tx.abort();
    return undefined;
  }
}

function resolveFrameSchema(
  frameRootCell: Cell<unknown>,
  rootLink: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>,
  fallbackSchema: unknown,
): unknown {
  const frameLink = frameRootCell.getAsNormalizedFullLink();
  if (
    frameLink.id === rootLink.id &&
    frameLink.space === rootLink.space &&
    frameLink.type === rootLink.type &&
    fallbackSchema !== undefined
  ) {
    return fallbackSchema;
  }

  const linkedSchema = frameLink.schema;
  if (linkedSchema !== undefined) {
    return linkedSchema;
  }
  if (frameRootCell.schema !== undefined) {
    return frameRootCell.schema;
  }
  try {
    return frameRootCell.asSchemaFromLinks().schema;
  } catch {
    return undefined;
  }
}

async function resolveTraceIntegrity(
  runtime: Runtime,
  trace: readonly UiTraversalFrame[],
  rootCell: Cell<unknown>,
  fallbackSchema: unknown,
): Promise<readonly CfcAtom[]> {
  const labelsCache = new Map<
    string,
    ReturnType<typeof normalizePersistedPathLabels>
  >();
  let joined: readonly CfcAtom[] | undefined;
  const rootLink = rootCell.getAsNormalizedFullLink();

  for (const frame of trace) {
    const persisted = await loadPersistedLabels(
      runtime,
      frame.rootCell,
      labelsCache,
    );
    const fromPersisted = persisted
      ? resolveObservationLabel(persisted, frame.path, "shape")
      : undefined;
    const fromSchema = resolveLocalSchemaLabel(
      runtime,
      resolveFrameSchema(frame.rootCell, rootLink, fallbackSchema),
      frame.path,
    );
    joined = joinIntegrityLabels(
      joined,
      fromPersisted?.integrity ?? fromSchema?.integrity,
    );
  }

  return joined ?? [];
}

function buildPayload(
  options: ResolveUiEventOptions,
  eventName: string,
): unknown {
  if (options.payload !== undefined) {
    return options.payload;
  }
  return { type: eventName };
}

function selectorDescription(
  options: ResolveUiEventOptions,
): Record<string, unknown> {
  if (options.path) {
    return { path: options.path };
  }
  if (options.attr) {
    return {
      attr: {
        name: options.attr.name,
        ...(options.attr.value !== undefined
          ? { value: options.attr.value }
          : {}),
      },
      ...(options.occurrence !== undefined
        ? { occurrence: options.occurrence }
        : {}),
    };
  }
  return {};
}

function absoluteSelectorPath(
  options: ResolveUiEventOptions,
): string | undefined {
  if (!options.path) {
    return undefined;
  }
  const rootPath = rootPathForTraversal(options);
  if (
    options.path === "/" || options.path.startsWith(`${rootPath}/`) ||
    options.path === rootPath
  ) {
    return options.path;
  }
  if (options.path.startsWith(`/${UI}/`)) {
    return options.path;
  }
  return joinRelativePath(parsePath(rootPath), options.path);
}

async function findUiNodeMatch(
  currentCell: Cell<unknown>,
  rootCell: Cell<unknown>,
  path: string,
  value: unknown,
  options: ResolveUiEventOptions,
  matches: UiNodeMatch[],
  visited: Array<{ path: string; propKeys: readonly string[] }>,
  trace: readonly UiTraversalFrame[] = [],
): Promise<void> {
  value = resolveRenderableValue(value);
  if (Array.isArray(value)) {
    const fullTrace = [...trace, { rootCell, path }];
    for (let index = 0; index < value.length; index++) {
      const childPath = `${path}/${index}`;
      let childCell = currentCell;
      let childValue = value[index];
      try {
        childCell = currentCell.key(index).resolveAsCell();
        childValue = childCell.getAsQueryResult();
      } catch {
        childValue = value[index];
      }
      await findUiNodeMatch(
        childCell,
        rootCell,
        childPath,
        childValue,
        options,
        matches,
        visited,
        fullTrace,
      );
    }
    return;
  }

  if (isUiRenderable(value)) {
    const childRootCell = currentCell.resolveAsCell();
    const childUiCell = childRootCell.key(UI).asSchema(debugVDOMSchema);
    await findUiNodeMatch(
      childUiCell,
      childRootCell,
      `/${UI}`,
      value[UI],
      options,
      matches,
      visited,
      [...trace, { rootCell, path }],
    );
    return;
  }

  const node = extractVNodeish(value);
  if (!node) {
    return;
  }

  const fullTrace = [...trace, { rootCell, path }];
  visited.push({
    path,
    propKeys: isRecord(node.props) ? Object.keys(node.props) : [],
  });
  const targetPath = absoluteSelectorPath(options);

  if (
    (targetPath && path === targetPath) ||
    (!targetPath && matchesAttr(node, options.attr))
  ) {
    matches.push({
      nodeCell: currentCell,
      rootCell,
      path,
      node,
      trace: fullTrace,
    });
  }

  for (const child of await resolveNodeChildren(currentCell, node)) {
    const childPath = `${path}/${child.segment}`;
    let childValue = child.value;
    try {
      const childSegments = child.segment.split("/");
      let childCell = currentCell;
      for (const segment of childSegments) {
        childCell = childCell.key(
          /^\d+$/.test(segment) ? Number(segment) : segment,
        )
          .resolveAsCell();
      }
      childValue = childCell.getAsQueryResult();
      await findUiNodeMatch(
        childCell,
        rootCell,
        childPath,
        childValue,
        options,
        matches,
        visited,
        fullTrace,
      );
      continue;
    } catch {
      childValue = child.value;
    }
    await findUiNodeMatch(
      currentCell,
      rootCell,
      childPath,
      childValue,
      options,
      matches,
      visited,
      fullTrace,
    );
  }
}

export async function resolveUiEventTarget(
  runtime: Runtime,
  targetCell: Cell<unknown>,
  options: ResolveUiEventOptions = {},
): Promise<ResolvedUiEventTarget> {
  const rootCell = targetCell.resolveAsCell();
  const rootPath = rootPathForTraversal(options);
  const rootUiCell = getCellAtPath(rootCell, rootPath).asSchema(
    debugVDOMSchema,
  );
  const rootValue = rootUiCell.getAsQueryResult();
  const matches: UiNodeMatch[] = [];
  const visited: Array<{ path: string; propKeys: readonly string[] }> = [];
  await findUiNodeMatch(
    rootUiCell,
    rootCell,
    rootPath,
    rootValue,
    options,
    matches,
    visited,
  );

  if (matches.length === 0) {
    throw new Error(
      `No UI node matched selector ${
        JSON.stringify(selectorDescription(options))
      } under ${rootPath}; visited=${JSON.stringify(visited.slice(0, 20))}`,
    );
  }

  const occurrence = options.occurrence ?? 0;
  const match = matches[occurrence];
  if (!match) {
    throw new Error(
      `UI selector matched ${matches.length} node(s); no node at occurrence ${occurrence}`,
    );
  }

  const eventName = options.event ?? "click";
  const eventProp = eventPropName(eventName);
  const eventStream = match.nodeCell.key("props").key(eventProp)
    .resolveAsCell();

  const integrity = await resolveTraceIntegrity(
    runtime,
    match.trace,
    rootCell,
    options.schema,
  );

  return {
    eventStream,
    eventProp,
    nodePath: match.path,
    integrity,
    trace: match.trace.map((frame) => ({
      id: frame.rootCell.getAsNormalizedFullLink().id,
      path: frame.path,
    })),
    envelope: createCfcEventEnvelope({
      id: crypto.randomUUID(),
      payload: buildPayload(options, eventName),
      integrity,
      sourceGestureId: options.sourceGestureId,
      evidence: {
        uiEvent: eventName,
        uiNodePath: match.path,
        ...selectorDescription(options),
        ...(options.evidence ?? {}),
      },
    }),
  };
}

export async function dispatchUiEvent(
  runtime: Runtime,
  targetCell: Cell<unknown>,
  options: ResolveUiEventOptions = {},
): Promise<ResolvedUiEventTarget> {
  const resolved = await resolveUiEventTarget(runtime, targetCell, options);
  resolved.eventStream.send(resolved.envelope);
  return resolved;
}
