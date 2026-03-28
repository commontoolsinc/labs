import type { Runtime } from "../runtime.ts";
import { UI } from "../builder/types.ts";
import type { Labels } from "../storage/interface.ts";
import {
  type CfcEventEnvelope,
  createCfcEventEnvelope,
} from "./event-envelope.ts";
import type { CfcEventDeliveryMode } from "./event-envelope.ts";
import type { CfcAtom } from "./label-algebra.ts";
import { joinIntegrityLabels } from "./label-algebra.ts";
import {
  cfcEntityKey,
  cfcLabelsAddress,
  normalizePersistedPathLabels,
  resolveObservationLabel,
} from "./shared.ts";

export interface UiProvenanceFrameLink {
  readonly space: string;
  readonly id: string;
  readonly type: string;
  readonly schema?: unknown;
}

export interface UiProvenanceFrame {
  readonly link: UiProvenanceFrameLink;
  readonly path: readonly string[];
}

export interface MintUiEventEnvelopeOptions<T> {
  readonly id?: string;
  readonly payload: T;
  readonly evidence?: Record<string, unknown>;
  readonly sourceGestureId?: string;
  readonly delivery?: CfcEventDeliveryMode;
}

type PersistedLabelsCache = Map<
  string,
  ReturnType<typeof normalizePersistedPathLabels> | undefined
>;
type RootSchemaCache = Map<string, unknown>;

type UiContractLikeAtom = CfcAtom & {
  readonly type?: string;
  readonly surface?: string;
  readonly role?: string;
  readonly kind?: string;
};

function normalizeFramePath(path: readonly string[]): readonly string[] {
  return path.map((segment) => String(segment));
}

function frameKey(frame: UiProvenanceFrame): string {
  return JSON.stringify([
    frame.link.space,
    frame.link.id,
    frame.link.type,
    [...frame.path],
  ]);
}

function uiRootPathForFrame(frame: UiProvenanceFrame): string | undefined {
  const uiIndex = frame.path.findIndex((segment) => segment === UI);
  if (uiIndex === -1) {
    return undefined;
  }
  const rootPath = frame.path.slice(0, uiIndex + 1);
  return rootPath.length === 0 ? "/" : `/${rootPath.join("/")}`;
}

function pathWithinUiRoot(path: string, uiRootPath: string): boolean {
  return path === uiRootPath || path.startsWith(`${uiRootPath}/`);
}

function deriveUiContextEventAtoms(
  integrity: readonly CfcAtom[] | undefined,
): readonly CfcAtom[] {
  if (!integrity || integrity.length === 0) {
    return [];
  }

  const derived = new Map<string, CfcAtom>();
  for (const atom of integrity) {
    if (!atom || typeof atom !== "object" || Array.isArray(atom)) {
      continue;
    }
    const contract = atom as UiContractLikeAtom;
    if (
      contract.type ===
        "https://commonfabric.org/cfc/atom/UiPromptSlotContract" &&
      typeof contract.surface === "string" &&
      typeof contract.role === "string"
    ) {
      const derivedAtom: CfcAtom = {
        type: "https://commonfabric.org/cfc/atom/PromptSlotBound",
        surface: contract.surface,
        role: contract.role,
      };
      derived.set(JSON.stringify(derivedAtom), derivedAtom);
      continue;
    }
    if (
      contract.type ===
          "https://commonfabric.org/cfc/atom/UiDisclosureContract" &&
      typeof contract.kind === "string"
    ) {
      const derivedAtom: CfcAtom = {
        type: "https://commonfabric.org/cfc/atom/DisclosureRendered",
        kind: contract.kind,
      };
      derived.set(JSON.stringify(derivedAtom), derivedAtom);
    }
  }

  return [...derived.values()];
}

function normalizeSchemaLabels(schema: unknown): Labels | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const rawIfc = (schema as { ifc?: unknown }).ifc;
  if (!rawIfc || typeof rawIfc !== "object" || Array.isArray(rawIfc)) {
    return undefined;
  }

  const integrity = (rawIfc as { integrity?: unknown }).integrity;
  const addIntegrity = (rawIfc as { addIntegrity?: unknown }).addIntegrity;

  const normalizeAtoms = (value: unknown): readonly CfcAtom[] | undefined => {
    if (!Array.isArray(value)) {
      return undefined;
    }
    return value.filter((entry): entry is CfcAtom =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry))
    );
  };

  const joinedIntegrity = joinIntegrityLabels(
    normalizeAtoms(integrity),
    normalizeAtoms(addIntegrity),
  );
  if (!joinedIntegrity) {
    return undefined;
  }
  return { integrity: joinedIntegrity };
}

function schemaAtPath(
  rootSchema: unknown,
  path: readonly string[],
): unknown {
  let current = rootSchema;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    const properties = (current as { properties?: Record<string, unknown> })
      .properties;
    if (properties && segment in properties) {
      current = properties[segment];
      continue;
    }
    const prefixItems = (current as { prefixItems?: unknown[] }).prefixItems;
    if (Array.isArray(prefixItems) && /^\d+$/.test(segment)) {
      current = prefixItems[Number(segment)];
      continue;
    }
    const items = (current as { items?: unknown }).items;
    if (items !== undefined && /^\d+$/.test(segment)) {
      current = items;
      continue;
    }
    return undefined;
  }
  return current;
}

function walkSchemaTree(
  schema: unknown,
  visitor: (node: unknown) => void,
): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return;
  }
  visitor(schema);

  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (properties && typeof properties === "object") {
    for (const child of Object.values(properties)) {
      walkSchemaTree(child, visitor);
    }
  }

  const prefixItems = (schema as { prefixItems?: unknown[] }).prefixItems;
  if (Array.isArray(prefixItems)) {
    for (const child of prefixItems) {
      walkSchemaTree(child, visitor);
    }
  }

  const items = (schema as { items?: unknown }).items;
  if (items !== undefined) {
    walkSchemaTree(items, visitor);
  }
}

async function loadPersistedLabels(
  runtime: Runtime,
  link: UiProvenanceFrameLink,
  cache: PersistedLabelsCache,
): Promise<ReturnType<typeof normalizePersistedPathLabels> | undefined> {
  const key = cfcEntityKey(link);
  if (cache.has(key)) {
    return cache.get(key);
  }

  const tx = runtime.edit();
  try {
    const raw = tx.readOrThrow(cfcLabelsAddress({
      space: link.space as never,
      id: link.id as never,
      type: link.type as never,
    }));
    const { error } = await tx.commit();
    if (error) {
      cache.set(key, undefined);
      return undefined;
    }
    const normalized = normalizePersistedPathLabels(raw);
    cache.set(key, normalized);
    return normalized;
  } catch {
    tx.abort();
    cache.set(key, undefined);
    return undefined;
  }
}

function rootSchemaCacheKey(link: UiProvenanceFrameLink): string {
  return JSON.stringify([link.space, link.id, link.type]);
}

function loadRootSchemaFromRuntime(
  runtime: Runtime,
  link: UiProvenanceFrameLink,
  cache: RootSchemaCache,
): unknown {
  const key = rootSchemaCacheKey(link);
  if (cache.has(key)) {
    return cache.get(key);
  }

  let resolved: unknown;
  try {
    resolved = runtime.getCellFromLink({
      space: link.space as never,
      id: link.id as never,
      type: link.type as never,
      path: [],
    }).asSchemaFromLinks().schema;
  } catch {
    resolved = undefined;
  }

  cache.set(key, resolved);
  return resolved;
}

export function frameFromLink(
  link: UiProvenanceFrameLink,
  path: readonly string[],
): UiProvenanceFrame {
  return {
    link: {
      space: link.space,
      id: link.id,
      type: link.type,
      ...(link.schema !== undefined ? { schema: link.schema } : {}),
    },
    path: normalizeFramePath(path),
  };
}

export async function resolveUiProvenanceIntegrity(
  runtime: Runtime,
  frames: readonly UiProvenanceFrame[],
): Promise<readonly CfcAtom[]> {
  const cache: PersistedLabelsCache = new Map();
  const rootSchemaCache: RootSchemaCache = new Map();
  const seen = new Set<string>();
  let joined: readonly CfcAtom[] | undefined;

  for (const frame of frames) {
    const dedupeKey = frameKey(frame);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    const persisted = await loadPersistedLabels(runtime, frame.link, cache);
    const fromPersisted = persisted
      ? resolveObservationLabel(persisted, `/${frame.path.join("/")}`, "shape")
      : undefined;
    const runtimeRootSchema = loadRootSchemaFromRuntime(
      runtime,
      frame.link,
      rootSchemaCache,
    );
    const schemaSource = runtimeRootSchema ?? frame.link.schema;
    const fromSchema = schemaSource
      ? normalizeSchemaLabels(schemaAtPath(schemaSource, frame.path))
      : undefined;
    joined = joinIntegrityLabels(
      joined,
      fromPersisted?.integrity ?? fromSchema?.integrity,
    );
  }

  return joined ?? [];
}

async function resolveUiContextEventIntegrity(
  runtime: Runtime,
  frames: readonly UiProvenanceFrame[],
): Promise<readonly CfcAtom[]> {
  const persistedCache: PersistedLabelsCache = new Map();
  const rootSchemaCache: RootSchemaCache = new Map();
  const seenRoots = new Set<string>();
  const derived = new Map<string, CfcAtom>();

  for (const frame of frames) {
    const uiRootPath = uiRootPathForFrame(frame);
    if (!uiRootPath) {
      continue;
    }
    const rootKey = `${cfcEntityKey(frame.link)}:${uiRootPath}`;
    if (seenRoots.has(rootKey)) {
      continue;
    }
    seenRoots.add(rootKey);

    const persisted = await loadPersistedLabels(runtime, frame.link, persistedCache);
    if (persisted) {
      for (const path of Object.keys(persisted)) {
        if (!pathWithinUiRoot(path, uiRootPath)) {
          continue;
        }
        const integrity = resolveObservationLabel(persisted, path, "shape")?.integrity;
        for (const atom of deriveUiContextEventAtoms(integrity)) {
          derived.set(JSON.stringify(atom), atom);
        }
      }
    }

    const runtimeRootSchema = loadRootSchemaFromRuntime(
      runtime,
      frame.link,
      rootSchemaCache,
    );
    const schemaSource = runtimeRootSchema ?? frame.link.schema;
    if (!schemaSource) {
      continue;
    }
    const uiRootSegments = uiRootPath === "/"
      ? []
      : uiRootPath.slice(1).split("/").filter(Boolean);
    const uiSchemaRoot = schemaAtPath(schemaSource, uiRootSegments);
    walkSchemaTree(uiSchemaRoot, (node) => {
      const integrity = normalizeSchemaLabels(node)?.integrity;
      for (const atom of deriveUiContextEventAtoms(integrity)) {
        derived.set(JSON.stringify(atom), atom);
      }
    });
  }

  return [...derived.values()];
}

export async function mintUiEventEnvelopeFromProvenance<T>(
  runtime: Runtime,
  frames: readonly UiProvenanceFrame[],
  options: MintUiEventEnvelopeOptions<T>,
): Promise<CfcEventEnvelope<T>> {
  const provenanceIntegrity = await resolveUiProvenanceIntegrity(runtime, frames);
  const contextualIntegrity = await resolveUiContextEventIntegrity(runtime, frames);
  const integrity = joinIntegrityLabels(
    provenanceIntegrity,
    contextualIntegrity,
  ) ?? [];
  return createCfcEventEnvelope({
    id: options.id ?? crypto.randomUUID(),
    payload: options.payload,
    integrity,
    sourceGestureId: options.sourceGestureId,
    evidence: options.evidence,
    delivery: options.delivery,
  });
}
