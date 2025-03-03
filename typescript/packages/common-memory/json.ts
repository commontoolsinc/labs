import * as JSON from "@ipld/dag-json";
import { isLink } from "multiformats/link";
export * from "@ipld/dag-json";

type ToJSON = {
  toJSON: () => unknown;
};

const prepare = (data: unknown, seen: Set<unknown>): unknown => {
  if (seen.has(data)) {
    throw new TypeError("Can not encode circular structure");
  }
  // top level undefined is ok
  if (data === undefined && seen.size === 0) {
    return null;
  }

  if (data === null) {
    return null;
  }

  if (typeof data === "symbol" && seen.size === 0) {
    return null;
  }

  if (isLink(data)) {
    return data;
  }

  if (ArrayBuffer.isView(data)) {
    return data;
  }

  if (Array.isArray(data)) {
    seen.add(data);
    const items = [];
    for (const item of data) {
      items.push(
        item === undefined || typeof item === "symbol"
          ? null
          : prepare(item, seen),
      );
    }
    return items;
  }

  if (typeof (data as ToJSON).toJSON === "function") {
    seen.add(data);
    const json = (data as ToJSON).toJSON();
    return prepare(json, seen);
  }

  if (typeof data === "object") {
    seen.add(data);
    const object: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && typeof value !== "symbol") {
        object[key] = prepare(value, new Set(seen));
      }
    }
    return object;
  }

  return data;
};

const SEEN = new Set();

// Override encode and serialize so we can sanitize data.

export const encode = <T>(data: T) => {
  SEEN.clear();
  return JSON.encode(prepare(data, SEEN));
};

export const stringify = <T>(data: T) => {
  SEEN.clear();
  return JSON.stringify(prepare(data, SEEN));
};
