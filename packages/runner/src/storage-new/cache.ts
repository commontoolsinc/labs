import type { JSONValue } from "../storage/interface.ts";

/** Minimal per-space/doc cache for composed JSON views. */
export class DocCache {
  #map = new Map<string, { json: JSONValue | undefined; epoch: number }>();

  key(space: string, docId: string): string {
    return `${space}\u0001${docId}`;
  }

  read(space: string, docId: string): {
    json: JSONValue | undefined;
    epoch: number;
  } {
    const v = this.#map.get(this.key(space, docId));
    return v ?? { json: undefined, epoch: -1 };
  }

  write(space: string, docId: string, json: JSONValue | undefined, epoch = -1) {
    this.#map.set(this.key(space, docId), { json, epoch });
  }

  clear(space: string, docId: string) {
    this.#map.delete(this.key(space, docId));
  }
}
