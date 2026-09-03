/**
 * A `FabricSpecialObject` survives the runner's structural walks.
 *
 * Every walk here used to ask `isObjectOrArray()` -- "is this an object?" --
 * as a stand-in for "may I read this by property name?". A special object
 * answers yes to the first and no to the second: its state lives in private
 * fields and it has no own properties at all. So each walk saw an empty
 * record, and each lost the value in its own way -- merged it to `{}`, rebuilt
 * it as `{}`, descended into it and found nothing, or wrote a property onto
 * it. They now ask `isWalkableObjectOrArray()`, and the cases below are that
 * one predicate observed from each walk's own doorstep.
 *
 * The suite runs over every special-object kind rather than a representative
 * one, because the kinds differ in what a naive walk does to them: a
 * `FabricBytes` answers to `"slice"` through its prototype where a
 * `FabricEpochNsec` does not, and a `FabricError` answers to `"message"`. A
 * walk fixed only for the kind it was reported against would keep passing a
 * one-kind test.
 *
 * Two axes cut across the kinds and decide what a case may assert. A walk that
 * only carries a value asserts identity. A walk that runs the value through
 * schema interning gets a deep-frozen copy of an unfrozen instance, so it
 * asserts the class instead -- which is the whole of what was being lost.
 * `FabricMap` and `FabricSet` have stub codecs and cannot be frozen or hashed
 * at all, so they take part only in the walks that touch neither.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  FabricError,
  FabricLink,
  FabricMap,
  FabricSet,
} from "@commonfabric/data-model/fabric-instances";
import {
  FabricBytes,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricRegExp,
} from "@commonfabric/data-model/fabric-primitives";
import type {
  FabricSpecialObject,
  FabricValue,
} from "@commonfabric/data-model";

import { mergeDefaults } from "../src/schema.ts";
import { mergeAnyOfMatches } from "../src/traverse.ts";
import { snapshotQueryResult } from "../src/query-result-proxy.ts";
import { extractDefaultValues } from "../src/runner-utils.ts";
import { sanitizeSchemaForLinks } from "../src/link-utils.ts";
import {
  getValueAtPath,
  hasValueAtPath,
  setValueAtPath,
} from "../src/path-utils.ts";
import {
  hasValueAtPath as hasStoredValueAtPath,
  readValueAtPath,
} from "../src/storage/v2-path.ts";
import type { JSONSchema } from "../src/builder/types.ts";

interface SpecialObjectKind {
  /** Class name, so a failure says which kind broke. */
  readonly name: string;
  /** The class itself, for the cases that can only assert the class. */
  // deno-lint-ignore no-explicit-any
  readonly cls: new (...args: any[]) => FabricSpecialObject;
  readonly make: () => FabricValue;
  /** Whether the kind's codec can freeze and hash it. */
  readonly storable: boolean;
  /**
   * Whether the kind is a `FabricInstance`. A walk carries a
   * `FabricPrimitive` through as the leaf it is, and refuses an instance,
   * which is a container it cannot descend yet.
   */
  readonly isInstance: boolean;
}

const SPECIAL_OBJECTS: readonly SpecialObjectKind[] = [
  {
    name: "FabricBytes",
    cls: FabricBytes,
    make: () => new FabricBytes(new Uint8Array([1, 2, 3])),
    storable: true,
    isInstance: false,
  },
  {
    name: "FabricEpochNsec",
    cls: FabricEpochNsec,
    make: () => new FabricEpochNsec(1_700n),
    storable: true,
    isInstance: false,
  },
  {
    name: "FabricEpochDay",
    cls: FabricEpochDay,
    make: () => new FabricEpochDay(20_000n),
    storable: true,
    isInstance: false,
  },
  {
    name: "FabricRegExp",
    cls: FabricRegExp,
    make: () => new FabricRegExp("es2025", "a+", "g"),
    storable: true,
    isInstance: false,
  },
  {
    name: "FabricHash",
    cls: FabricHash,
    make: () => new FabricHash(new Uint8Array([9, 9]), "fid1"),
    storable: true,
    isInstance: false,
  },
  {
    name: "FabricError",
    cls: FabricError,
    make: () =>
      new FabricError({
        type: "Error",
        name: "Error",
        message: "boom",
        stack: undefined,
        cause: undefined,
      }),
    storable: true,
    isInstance: true,
  },
  {
    name: "FabricLink",
    cls: FabricLink,
    make: () => new FabricLink({ id: "of:fid1:aaa" }),
    storable: true,
    isInstance: true,
  },
  {
    name: "FabricMap",
    cls: FabricMap,
    make: () => new FabricMap(new Map([["a", 1]])),
    storable: false,
    isInstance: true,
  },
  {
    name: "FabricSet",
    cls: FabricSet,
    make: () => new FabricSet(new Set([1, 2])),
    storable: false,
    isInstance: true,
  },
];

/**
 * The walks below carry a leaf through and refuse a container, so every case
 * that asserts carrying runs over the primitives. The instances get one suite
 * of their own, at the bottom, asserting the refusal instead.
 */
const FABRIC_PRIMITIVES = SPECIAL_OBJECTS.filter((k) => !k.isInstance);
const FABRIC_INSTANCES = SPECIAL_OBJECTS.filter((k) => k.isInstance);
const STORABLE_PRIMITIVES = FABRIC_PRIMITIVES.filter((k) => k.storable);

/** Runs `body` once per kind in `kinds`, naming the kind in the case. */
function forEachSpecialObject(
  kinds: readonly SpecialObjectKind[],
  description: (name: string) => string,
  body: (kind: SpecialObjectKind, special: FabricValue) => void,
): void {
  for (const kind of kinds) {
    it(description(kind.name), () => body(kind, kind.make()));
  }
}

describe("fabric special objects through the runner's walks", () => {
  describe("mergeDefaults()", () => {
    forEachSpecialObject(
      STORABLE_PRIMITIVES,
      (name) => `keeps a \`${name}\` default rather than merging it to \`{}\``,
      (kind, special) => {
        const merged = mergeDefaults(
          { type: "object", default: { a: 1 } },
          special,
        );
        expect((merged as { default: unknown }).default)
          .toBeInstanceOf(kind.cls);
      },
    );

    forEachSpecialObject(
      STORABLE_PRIMITIVES,
      (name) => `keeps a \`${name}\` on both sides of the merge`,
      (kind, special) => {
        // Both sides are `type: "object"` shaped, which is what the schema
        // generator emits for the fabric-backed natives, so this is the arm a
        // `Cell` of one of those with an object default actually takes.
        const merged = mergeDefaults(
          { type: "object", default: special as never },
          special,
        );
        expect((merged as { default: unknown }).default)
          .toBeInstanceOf(kind.cls);
      },
    );

    it("still merges two plain-record defaults", () => {
      const merged = mergeDefaults(
        { type: "object", default: { a: 1, b: 2 } },
        { b: 3, c: 4 } as FabricValue,
      );
      expect((merged as { default: unknown }).default).toEqual({
        a: 1,
        b: 3,
        c: 4,
      });
    });
  });

  describe("mergeAnyOfMatches()", () => {
    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `returns a \`${name}\` matched by two branches whole`,
      (_kind, special) => {
        expect(mergeAnyOfMatches([special, special])).toBe(special);
      },
    );

    it("still merges the properties of two plain-record matches", () => {
      expect(mergeAnyOfMatches([{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 });
    });
  });

  describe("snapshotQueryResult()", () => {
    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `snapshots a \`${name}\` by identity`,
      (_kind, special) => {
        expect(snapshotQueryResult(special)).toBe(special);
      },
    );

    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `snapshots a \`${name}\` held under a key by identity`,
      (_kind, special) => {
        const snapshot = snapshotQueryResult({ a: [{ b: special }] });
        expect(snapshot.a[0].b).toBe(special);
      },
    );

    it("still detaches a plain container", () => {
      const source = { a: [1, 2] };
      const snapshot = snapshotQueryResult(source);
      expect(snapshot).toEqual(source);
      expect(snapshot).not.toBe(source);
      expect(snapshot.a).not.toBe(source.a);
    });
  });

  describe("extractDefaultValues()", () => {
    forEachSpecialObject(
      STORABLE_PRIMITIVES,
      (name) => `returns a \`${name}\` default under a property schema`,
      (kind, special) => {
        // The property-defaults assembly below this return would clone the
        // default and assign to it, which a frozen special object refuses
        // outright and an unfrozen instance accepts as a graft its codec
        // never reads.
        const schema = {
          type: "object",
          properties: { a: { type: "string", default: "x" } },
          default: special as never,
        } as const satisfies JSONSchema;
        expect(extractDefaultValues(schema)).toBeInstanceOf(kind.cls);
      },
    );

    it("still assembles property defaults over a plain-record default", () => {
      const schema = {
        type: "object",
        properties: { a: { type: "string", default: "x" } },
        default: { b: 1 },
      } as const satisfies JSONSchema;
      expect(extractDefaultValues(schema)).toEqual({ a: "x", b: 1 });
    });
  });

  describe("sanitizeSchemaForLinks()", () => {
    forEachSpecialObject(
      STORABLE_PRIMITIVES,
      (name) => `carries a \`${name}\` schema default by reference`,
      (_kind, special) => {
        const sanitized = sanitizeSchemaForLinks({
          type: "object",
          default: special as never,
        }) as { default: unknown };
        expect(sanitized.default).toBe(special);
      },
    );

    it("still strips `asCell` from a subschema", () => {
      const sanitized = sanitizeSchemaForLinks({
        type: "object",
        properties: { a: { type: "string", asCell: ["cell"] } },
      }) as { properties: { a: Record<string, unknown> } };
      expect(sanitized.properties.a.asCell).toBeUndefined();
    });
  });

  describe("setValueAtPath()", () => {
    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `replaces a \`${name}\` spine slot rather than writing into it`,
      (_kind, special) => {
        const obj: Record<string, unknown> = { a: special };
        expect(setValueAtPath(obj, ["a", "b"], 1)).toBe(true);
        expect(obj).toEqual({ a: { b: 1 } });
      },
    );

    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `writes a \`${name}\` into a leaf slot`,
      (_kind, special) => {
        const obj: Record<string, unknown> = {};
        expect(setValueAtPath(obj, ["a", "b"], special)).toBe(true);
        expect((obj.a as Record<string, unknown>).b).toBe(special);
      },
    );
  });

  describe("path reads", () => {
    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `report no path inside a \`${name}\``,
      (_kind, special) => {
        const root = { a: special };
        // `"slice"` and `"message"` resolve through the prototype of some of
        // these; a path names data, and none of that is data.
        for (const segment of ["slice", "message", "length", "source"]) {
          expect(hasValueAtPath(root, ["a", segment])).toBe(false);
          expect(getValueAtPath(root, ["a", segment])).toBeUndefined();
          expect(hasStoredValueAtPath(root as FabricValue, ["a", segment]))
            .toBe(false);
          expect(readValueAtPath(root as FabricValue, ["a", segment]))
            .toBeUndefined();
        }
      },
    );

    forEachSpecialObject(
      FABRIC_PRIMITIVES,
      (name) => `read a \`${name}\` at its own path`,
      (_kind, special) => {
        const root = { a: special };
        expect(hasValueAtPath(root, ["a"])).toBe(true);
        expect(getValueAtPath(root, ["a"])).toBe(special);
        expect(hasStoredValueAtPath(root as FabricValue, ["a"])).toBe(true);
        expect(readValueAtPath(root as FabricValue, ["a"])).toBe(special);
      },
    );
  });

  describe("a `FabricInstance` in any of them", () => {
    // The refusal is the whole point of separating the two kinds. A
    // `FabricPrimitive` is a leaf and every walk above carries one through; an
    // instance is a container the walks cannot descend yet, so answering at all
    // would be answering wrongly, in one direction or the other. When the
    // codec-mediated descent lands, these are the cases that change.

    for (const kind of FABRIC_INSTANCES) {
      it(`is refused by \`mergeAnyOfMatches()\` for a \`${kind.name}\``, () => {
        const special = kind.make();
        expect(() => mergeAnyOfMatches([special, special])).toThrow(
          "`FabricInstance`) in a structural walk",
        );
      });

      it(`is refused by \`snapshotQueryResult()\` for a \`${kind.name}\``, () => {
        expect(() => snapshotQueryResult({ a: kind.make() })).toThrow(
          "`FabricInstance`) in a structural walk",
        );
      });

      it(`is refused by \`setValueAtPath()\` for a \`${kind.name}\``, () => {
        const obj: Record<string, unknown> = { a: kind.make() };
        expect(() => setValueAtPath(obj, ["a", "b"], 1)).toThrow(
          "`FabricInstance`) in a structural walk",
        );
      });

      it(`is refused by the stored path read for a \`${kind.name}\``, () => {
        const root = { a: kind.make() } as FabricValue;
        expect(() => hasStoredValueAtPath(root, ["a", "b"])).toThrow(
          "`FabricInstance`) in a structural walk",
        );
        expect(() => readValueAtPath(root, ["a", "b"])).toThrow(
          "`FabricInstance`) in a structural walk",
        );
      });
    }
  });
});
