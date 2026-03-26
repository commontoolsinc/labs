import type {
  StorableDatum,
  StorableValue,
} from "@commontools/memory/interface";
import {
  decodeWireEntityDocument,
  encodeWireEntityDocument,
  type SourceLink,
  toSourceLink,
  type WireEntityDocument,
} from "@commontools/memory/v2";
import type { StorageValue } from "./interface.ts";

type EncodableDocument = Parameters<typeof encodeWireEntityDocument>[0];

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

const isDocumentRoot = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toTransactionDocument = (value: StorableDatum): EncodableDocument => {
  if (!isDocumentRoot(value)) {
    throw new Error(
      "memory v2 transactions require explicit full-document roots",
    );
  }
  return value as EncodableDocument;
};

export const toMemoryV2Document = (value: StorableDatum): WireEntityDocument =>
  encodeWireEntityDocument(toTransactionDocument(value));

export const toMemoryV2DocumentFromTransactionValue = (
  value: StorableDatum,
): WireEntityDocument => toMemoryV2Document(value);

export const toMemoryV2DocumentFromValue = (
  value: StorableValue,
): WireEntityDocument =>
  encodeWireEntityDocument({ value } as EncodableDocument);

export const toMemoryV2DocumentFromStorageValue = (
  value: StorageValue,
): WireEntityDocument => {
  const document: Record<string, StorableDatum | SourceLink> = {
    ...(value.value !== undefined
      ? { value: value.value as StorableValue }
      : {}),
  };
  const source = toDocumentSourceLink(value.source);
  if (source !== undefined) {
    document.source = source;
  }
  return encodeWireEntityDocument(document as EncodableDocument);
};

export const fromMemoryV2Document = (
  document: WireEntityDocument,
): StorageValue | undefined => {
  const decoded = decodeWireEntityDocument(document);
  if (decoded.value === undefined && decoded.source === undefined) {
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
