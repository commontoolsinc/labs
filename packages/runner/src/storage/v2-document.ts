import {
  jsonFromValue,
  valueFromJson,
} from "@commontools/memory/json-encoding-dispatch";
import type {
  JSONValue,
  StorableDatum,
  StorableValue,
} from "@commontools/memory/interface";
import type { ReconstructionContext } from "@commontools/memory/storable-protocol";
import {
  type EntityDocument,
  type EntityDocumentField,
  getEntityDocumentMetadata,
  isEntityDocument,
  isSourceLink,
  type SourceLink,
  toEntityDocument,
  toSourceLink,
} from "@commontools/memory/v2";
import type { StorageValue } from "./interface.ts";

const storageReconstructionContext: ReconstructionContext = {
  getCell() {
    throw new Error(
      "getCell is not available at the storage boundary (memory-v2)",
    );
  },
};

const encodeDocumentValue = (value: StorableValue): JSONValue =>
  JSON.parse(jsonFromValue(value)) as JSONValue;

const decodeDocumentValue = (value: JSONValue): StorableValue =>
  valueFromJson(JSON.stringify(value), storageReconstructionContext);

const toDocumentSourceLink = (
  source: StorageValue["source"] | undefined,
): SourceLink | undefined => {
  if (source === undefined) {
    return undefined;
  }

  const shortId = typeof source.toJSON === "function"
    ? source.toJSON()["/"]
    : source["/"];
  if (typeof shortId !== "string") {
    throw new Error("memory v2 source ids must serialize to a string");
  }

  return toSourceLink(shortId);
};

const encodeDocumentMetadata = (
  metadata: Record<string, unknown>,
): Record<string, EntityDocumentField> =>
  Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== undefined)
      .map((
        [key, value],
      ) => [key, encodeDocumentValue(value as StorableValue)]),
  ) as Record<string, EntityDocumentField>;

const toTransactionSourceLink = (value: unknown): SourceLink | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return isSourceLink(value) ? value : undefined;
};

export const toMemoryV2Document = (value: StorableDatum): EntityDocument => {
  if (!isEntityDocument(value)) {
    return toEntityDocument(encodeDocumentValue(value));
  }

  const metadata = getEntityDocumentMetadata(value);
  const { source, ...extraMetadata } = metadata;
  return toEntityDocument(
    value.value === undefined ? undefined : encodeDocumentValue(value.value),
    source as SourceLink | undefined,
    encodeDocumentMetadata(extraMetadata),
  );
};

export const toMemoryV2DocumentFromTransactionValue = (
  value: StorableDatum,
): EntityDocument => {
  if (isEntityDocument(value)) {
    return toMemoryV2Document(value);
  }

  if (
    value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.hasOwn(value, "value") || Object.hasOwn(value, "source"))
  ) {
    const {
      value: payload,
      source,
      ...metadata
    } = value as Record<string, StorableDatum>;
    return toEntityDocument(
      payload === undefined ? undefined : encodeDocumentValue(payload),
      toTransactionSourceLink(source),
      encodeDocumentMetadata(metadata),
    );
  }

  return toMemoryV2Document(value);
};

export const toMemoryV2DocumentFromStorageValue = (
  value: StorageValue,
): EntityDocument =>
  toEntityDocument(
    encodeDocumentValue(value.value as StorableValue),
    toDocumentSourceLink(value.source),
  );

export const fromMemoryV2Document = (
  document: EntityDocument,
): StorageValue | undefined => {
  if (document.value === undefined) {
    return undefined;
  }

  return {
    value: decodeDocumentValue(document.value),
    ...(document.source !== undefined
      ? { source: document.source as StorageValue["source"] }
      : {}),
  };
};

export const toTransactionDocumentValue = (
  document: EntityDocument | undefined,
): StorableDatum | undefined => {
  if (document === undefined) {
    return undefined;
  }

  const metadata = getEntityDocumentMetadata(document);
  const { source, ...extraMetadata } = metadata;
  const transactionValue: Record<string, StorableDatum> = {};

  if (document.value !== undefined) {
    transactionValue.value = decodeDocumentValue(
      document.value,
    ) as StorableDatum;
  }
  if (source !== undefined) {
    transactionValue.source = source as StorableDatum;
  }
  for (const [key, value] of Object.entries(extraMetadata)) {
    if (value !== undefined) {
      transactionValue[key] = isSourceLink(value)
        ? value as unknown as StorableDatum
        : decodeDocumentValue(value) as StorableDatum;
    }
  }

  return Object.keys(transactionValue).length === 0
    ? undefined
    : transactionValue;
};

export const fromMemoryV2Value = (
  document: EntityDocument | undefined,
): StorableDatum | undefined =>
  document?.value === undefined
    ? undefined
    : decodeDocumentValue(document.value) as StorableDatum;
