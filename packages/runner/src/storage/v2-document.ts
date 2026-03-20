import type {
  StorableDatum,
  StorableValue,
} from "@commontools/memory/interface";
import {
  decodeWireEntityDocument,
  encodeWireEntityDocument,
  type EntityDocument,
  isEntityDocument,
  type SourceLink,
  toEntityDocument,
  toSourceLink,
  type WireEntityDocument,
} from "@commontools/memory/v2";
import type { StorageValue } from "./interface.ts";

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

const toTransactionDocument = (value: StorableDatum): EntityDocument => {
  if (!isEntityDocument(value)) {
    throw new Error(
      "memory v2 transactions require explicit full-document roots",
    );
  }
  return value;
};

export const toMemoryV2Document = (value: StorableDatum): WireEntityDocument =>
  encodeWireEntityDocument(toTransactionDocument(value));

export const toMemoryV2DocumentFromTransactionValue = (
  value: StorableDatum,
): WireEntityDocument => toMemoryV2Document(value);

export const toMemoryV2DocumentFromStorageValue = (
  value: StorageValue,
): WireEntityDocument =>
  encodeWireEntityDocument(
    toEntityDocument(
      value.value as StorableValue,
      toDocumentSourceLink(value.source),
    ),
  );

export const fromMemoryV2Document = (
  document: WireEntityDocument,
): StorageValue | undefined => {
  const decoded = decodeWireEntityDocument(document);
  if (decoded.value === undefined) {
    return undefined;
  }

  return {
    value: decoded.value as StorableValue,
    ...(decoded.source !== undefined
      ? { source: decoded.source as StorageValue["source"] }
      : {}),
  };
};

export const toTransactionDocumentValue = (
  document: WireEntityDocument | undefined,
): StorableDatum | undefined => {
  if (document === undefined) {
    return undefined;
  }

  const decoded = decodeWireEntityDocument(document);
  return Object.keys(decoded).length === 0
    ? undefined
    : decoded as StorableDatum;
};

export const fromMemoryV2Value = (
  document: WireEntityDocument | undefined,
): StorableDatum | undefined => {
  if (document === undefined) {
    return undefined;
  }
  return decodeWireEntityDocument(document).value;
};
