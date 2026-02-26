import { canonicalHash } from "@commontools/memory/canonical-hash";
import {
  DECONSTRUCT,
  isStorableInstance,
} from "@commontools/memory/storable-protocol";
import type { Activity } from "../storage/interface.ts";
import { canonicalizeStoragePath } from "./canonical-activity.ts";
import { hasInternalVerifierReadMarker } from "./internal-markers.ts";

type NormalizedEntry = {
  keyType: "string" | "symbol";
  key: string;
  value: NormalizedValue;
};

type NormalizedObject = {
  __type: "object";
  id: number;
  entries: NormalizedEntry[];
};

type NormalizedArray = {
  __type: "array";
  id: number;
  items: NormalizedValue[];
};

type NormalizedMap = {
  __type: "map";
  id: number;
  entries: Array<{ key: NormalizedValue; value: NormalizedValue }>;
};

type NormalizedSet = {
  __type: "set";
  id: number;
  values: NormalizedValue[];
};

type NormalizedStorableInstance = {
  __type: "storable-instance";
  id: number;
  typeTag: string;
  state: NormalizedValue;
};

type NormalizedRef = {
  __type: "ref";
  id: number;
};

type NormalizedSpecial = {
  __type:
    | "undefined"
    | "bigint"
    | "symbol"
    | "function"
    | "number"
    | "date"
    | "regexp"
    | "typed-array"
    | "array-buffer";
  value?: string;
  ctor?: string;
};

type NormalizedValue =
  | null
  | boolean
  | number
  | string
  | NormalizedObject
  | NormalizedArray
  | NormalizedMap
  | NormalizedSet
  | NormalizedStorableInstance
  | NormalizedRef
  | NormalizedSpecial;

type NormalizationState = {
  seen: WeakMap<object, number>;
  nextId: number;
};

const isEnumerable = Object.prototype.propertyIsEnumerable;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storableInstanceTypeTag(value: object): string {
  const candidate = (value as { typeTag?: unknown }).typeTag;
  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }
  return value.constructor?.name ?? "StorableInstance";
}

function normalizeUnknown(
  value: unknown,
  state: NormalizationState,
): NormalizedValue {
  if (value === null) return null;

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : { __type: "number", value: String(value) };
  }

  if (typeof value === "undefined") {
    return { __type: "undefined" };
  }

  if (typeof value === "bigint") {
    return { __type: "bigint", value: value.toString() };
  }

  if (typeof value === "symbol") {
    return { __type: "symbol", value: String(value) };
  }

  if (typeof value === "function") {
    return {
      __type: "function",
      value: value.name || "<anonymous>",
    };
  }

  const objectValue = value as object;
  const seenId = state.seen.get(objectValue);
  if (seenId !== undefined) {
    return { __type: "ref", id: seenId };
  }

  const id = state.nextId++;
  state.seen.set(objectValue, id);

  if (isStorableInstance(value)) {
    const instance = value as { [DECONSTRUCT](): unknown };
    try {
      return {
        __type: "storable-instance",
        id,
        typeTag: storableInstanceTypeTag(value),
        state: normalizeUnknown(instance[DECONSTRUCT](), state),
      };
    } catch {
      // Some wrappers are still stubbed; fall back to structural normalization.
    }
  }

  if (Array.isArray(value)) {
    return {
      __type: "array",
      id,
      items: value.map((item) => normalizeUnknown(item, state)),
    };
  }

  if (value instanceof Date) {
    return { __type: "date", value: value.toISOString() };
  }

  if (value instanceof RegExp) {
    return { __type: "regexp", value: value.toString() };
  }

  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, mapValue]) => ({
      key: normalizeUnknown(key, state),
      value: normalizeUnknown(mapValue, state),
    }));
    return {
      __type: "map",
      id,
      entries,
    };
  }

  if (value instanceof Set) {
    return {
      __type: "set",
      id,
      values: [...value].map((entry) => normalizeUnknown(entry, state)),
    };
  }

  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    );
    return {
      __type: "typed-array",
      ctor: value.constructor.name,
      value: toHex(bytes),
    };
  }

  if (value instanceof ArrayBuffer) {
    return {
      __type: "array-buffer",
      value: toHex(new Uint8Array(value)),
    };
  }

  const record = value as Record<PropertyKey, unknown>;
  const stringEntries: NormalizedEntry[] = Object.keys(record)
    .sort()
    .map((key) => ({
      keyType: "string",
      key,
      value: normalizeUnknown(record[key], state),
    }));

  const symbolEntries: NormalizedEntry[] = Object.getOwnPropertySymbols(record)
    .filter((symbolKey) => isEnumerable.call(record, symbolKey))
    .sort((a, b) => String(a).localeCompare(String(b)))
    .map((symbolKey) => ({
      keyType: "symbol",
      key: String(symbolKey),
      value: normalizeUnknown(record[symbolKey], state),
    }));

  return {
    __type: "object",
    id,
    entries: [...stringEntries, ...symbolEntries],
  };
}

function activityWriteChangedFlag(activityWrite: unknown): boolean {
  if (
    activityWrite && typeof activityWrite === "object" &&
    "changed" in activityWrite
  ) {
    return Boolean((activityWrite as { changed?: unknown }).changed);
  }
  return true;
}

function normalizeActivity(
  activity: Iterable<Activity>,
): ReadonlyArray<Record<string, NormalizedValue>> {
  const state: NormalizationState = {
    seen: new WeakMap(),
    nextId: 1,
  };

  const normalized: Array<Record<string, NormalizedValue>> = [];
  for (const item of activity) {
    if ("read" in item && item.read) {
      const read = item.read;
      normalized.push({
        kind: "read",
        space: read.space,
        id: read.id,
        type: read.type,
        path: canonicalizeStoragePath(read.path),
        meta: normalizeUnknown(read.meta ?? {}, state),
        internalVerifierRead: hasInternalVerifierReadMarker(read.meta),
      });
      continue;
    }

    if ("write" in item && item.write) {
      normalized.push({
        kind: "write",
        space: item.write.space,
        id: item.write.id,
        type: item.write.type,
        path: canonicalizeStoragePath(item.write.path),
        changed: activityWriteChangedFlag(item.write),
      });
    }
  }

  return normalized;
}

export function computeCfcActivityDigest(
  activity: Iterable<Activity>,
): Promise<string> {
  return Promise.resolve(
    toHex(canonicalHash(normalizeActivity(activity)).hash),
  );
}
