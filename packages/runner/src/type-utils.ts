import { isRecord, type Mutable } from "@commontools/utils/types";
import { isOpaqueRef } from "./builder/types.ts";
import { isDoc } from "./doc.ts";
import { isCell, isCellLink } from "./cell.ts";
import { type CellLink } from "./sigil-types.ts";
import {
  getCellLinkOrThrow,
  isQueryResultForDereferencing,
} from "./query-result-proxy.ts";

export function maybeUnwrapProxy(value: unknown): unknown {
  return isQueryResultForDereferencing(value)
    ? getCellLinkOrThrow(value)
    : value;
}

export function arrayEqual(a?: PropertyKey[], b?: PropertyKey[]): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function isEqualCellLink(a: CellLink, b: CellLink): boolean {
  return isCellLink(a) && isCellLink(b) && a.cell === b.cell &&
    arrayEqual(a.path, b.path);
}

export function containsOpaqueRef(value: unknown): boolean {
  if (isOpaqueRef(value)) return true;
  if (isCell(value) || isCellLink(value) || isDoc(value)) return false;
  if (isRecord(value)) {
    return Object.values(value).some(containsOpaqueRef);
  }
  return false;
}

export function deepCopy<T = unknown>(value: T): Mutable<T> {
  if (isQueryResultForDereferencing(value)) {
    return deepCopy(getCellLinkOrThrow(value)) as unknown as Mutable<T>;
  }
  if (isDoc(value) || isCell(value)) return value as Mutable<T>;
  if (isRecord(value)) {
    return Array.isArray(value)
      ? value.map(deepCopy) as unknown as Mutable<T>
      : Object.fromEntries(
        Object.entries(value).map(([key, value]) => [key, deepCopy(value)]),
      ) as unknown as Mutable<T>;
    // Literal value:
  } else return value as Mutable<T>;
}
