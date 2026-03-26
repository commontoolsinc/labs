import type { Runtime } from "../runtime.ts";
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
    const fromSchema = frame.link.schema
      ? normalizeSchemaLabels(schemaAtPath(frame.link.schema, frame.path))
      : undefined;
    joined = joinIntegrityLabels(
      joined,
      fromPersisted?.integrity ?? fromSchema?.integrity,
    );
  }

  return joined ?? [];
}

export async function mintUiEventEnvelopeFromProvenance<T>(
  runtime: Runtime,
  frames: readonly UiProvenanceFrame[],
  options: MintUiEventEnvelopeOptions<T>,
): Promise<CfcEventEnvelope<T>> {
  const integrity = await resolveUiProvenanceIntegrity(runtime, frames);
  return createCfcEventEnvelope({
    id: options.id ?? crypto.randomUUID(),
    payload: options.payload,
    integrity,
    sourceGestureId: options.sourceGestureId,
    evidence: options.evidence,
    delivery: options.delivery,
  });
}
