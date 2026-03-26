import type {
  StorableDatum,
  StorableValue,
} from "@commontools/memory/interface";
import { type EntityDocument, toEntityDocument } from "@commontools/memory/v2";
import type { StorageValue } from "./interface.ts";

const isDocumentRoot = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toTransactionDocument = (value: StorableDatum): EntityDocument => {
  if (!isDocumentRoot(value)) {
    throw new Error(
      "memory v2 transactions require explicit full-document roots",
    );
  }
  return value as EntityDocument;
};

export const toEntityDocumentFromTransactionValue = (
  value: StorableDatum,
): EntityDocument => toTransactionDocument(value);

export const toEntityDocumentFromValue = (
  value: StorableValue,
): EntityDocument => toEntityDocument(value);

export const fromEntityDocument = (
  document: EntityDocument,
): StorageValue | undefined => {
  if (document.value === undefined && document.source === undefined) {
    return undefined;
  }

  return {
    value: document.value as StorableValue,
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

  return Object.keys(document).length === 0
    ? undefined
    : document as StorableDatum;
};

export const fromEntityValue = (
  document: EntityDocument | undefined,
): StorableDatum | undefined => {
  if (document === undefined) {
    return undefined;
  }
  return document.value;
};
