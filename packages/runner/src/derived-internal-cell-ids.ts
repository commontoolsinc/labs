import type { JSONValue } from "@commonfabric/api";
import { LRUCache } from "@commonfabric/utils/cache";
import { isPlainObject } from "@commonfabric/utils/types";

import type { AnyCell } from "./cell.ts";
import { createRef, type EntityId } from "./create-ref.ts";

/**
 * How many ids an instance keeps unless told otherwise. A piece asks for the id of each cell it
 * owns many times over while it starts, and seldom after, so the bound is
 * sized for the pieces starting at one time rather than for every piece a
 * runtime ever ran.
 */
const ID_LIMIT = 65_536;

/**
 * The ids of derived internal cells: the cells a pattern owns on a result
 * cell, each named by a partial cause. An id is the hash of the result
 * cell's entity and the partial cause, so it is a function of the two, and
 * an instance keeps the ids it has hashed most recently: a piece's start
 * asks for the id of each cell it owns once per node that binds it and once
 * more per action whose scheduler summary lists it.
 *
 * A partial cause is told apart by its content, read when the id is asked
 * for. An id is hashed on every call for a partial cause that is not JSON
 * data, and for one that holds the same object twice, which `createRef()`
 * reads as a cycle.
 */
export class DerivedInternalCellIds {
  #ids: LRUCache<string, EntityId>;
  #mintRecorder:
    | ((resultId: string, partialCause: JSONValue) => void)
    | undefined;

  /** Constructs an instance which keeps at most `capacity` ids. */
  constructor(capacity: number = ID_LIMIT) {
    this.#ids = new LRUCache<string, EntityId>({ capacity });
  }

  /**
   * The observer of every id this instance mints, by the result cell's id
   * and the partial cause, which a test counts.
   */
  get accessForTestingOnly(): {
    mintRecorder:
      | ((resultId: string, partialCause: JSONValue) => void)
      | undefined;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get mintRecorder() {
        return outerThis.#mintRecorder;
      },
      set mintRecorder(value) {
        outerThis.#mintRecorder = value;
      },
    };
  }

  /**
   * Returns the id of the derived internal cell `partialCause` names on
   * `resultCell`. The id carries no entity kind: the caller applies one when
   * it writes the id as a URI.
   */
  idFor(resultCell: AnyCell<unknown>, partialCause: JSONValue): EntityId {
    const resultId = resultCell.getAsNormalizedFullLink().id;
    const cause = causeKey(partialCause, []);
    if (cause === undefined) return this.#mint(resultCell, partialCause);
    // A cause key holds no line break, so the first one ends it.
    const key = `${cause}\n${resultId}`;
    let id = this.#ids.get(key);
    if (id === undefined) {
      id = this.#mint(resultCell, partialCause);
      this.#ids.put(key, id);
    }
    return id;
  }

  /** Hashes the id `partialCause` names on `resultCell`. */
  #mint(resultCell: AnyCell<unknown>, partialCause: JSONValue): EntityId {
    this.#mintRecorder?.(
      resultCell.getAsNormalizedFullLink().id,
      partialCause,
    );
    return createRef(
      {},
      {
        parent: resultCell.entityId ?? resultCell,
        type: "internal",
        cause: partialCause,
      },
    );
  }
}

/**
 * The key component standing for the partial cause `cause`: a string two
 * causes share only where `createRef()` derives one id from both. Each kind
 * of value is written apart, so `1`, `"1"` and `true` share no key.
 * `undefined` for a value no id is kept for: one that is not JSON data, or
 * holds an object already in `seen`, the objects above it and before it.
 */
function causeKey(cause: unknown, seen: object[]): string | undefined {
  switch (typeof cause) {
    case "string":
      return JSON.stringify(cause);
    case "number":
      return Object.is(cause, -0) ? "-0" : String(cause);
    case "boolean":
      return String(cause);
    case "object": {
      if (cause === null) return "null";
      if (seen.includes(cause)) return undefined;
      seen.push(cause);
      if (Array.isArray(cause)) {
        const items: string[] = [];
        for (const item of cause) {
          const key = causeKey(item, seen);
          if (key === undefined) return undefined;
          items.push(key);
        }
        return `[${items.join(",")}]`;
      }
      if (!isPlainObject(cause)) return undefined;
      const members: string[] = [];
      for (const name of Object.keys(cause)) {
        const key = causeKey(cause[name], seen);
        if (key === undefined) return undefined;
        members.push(`${JSON.stringify(name)}:${key}`);
      }
      return `{${members.join(",")}}`;
    }
    default:
      return undefined;
  }
}
