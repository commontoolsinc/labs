/**
 * Leaf-scan precision (resolveLeafImpls structural pattern-instantiation gate).
 *
 * The bare-identifier-call gate in `liveLeafCanInstantiatePattern` cannot tell a
 * call to a closed-over PURE HELPER (`(i) => sanitize(i.x)`) from a call to a
 * closed-over PATTERN factory (`({v}) => childPattern({v})`) by SOURCE alone —
 * both are `helper(args)` returned. The discriminator is the leaf module's
 * declared `resultSchema`: the builder leaves a pattern-returning lift's schema
 * EMPTY/absent/`true` (a Pattern has no statically-known value shape) but types a
 * pure value-lift with a concrete `type`/`enum`/`$ref`/`anyOf` schema. So:
 *
 *  - a bare-call leaf with a CONCRETE value resultSchema RESOLVES (it provably
 *    produces a value — freeing the corpus's pure `compute*`/`sanitize*`/`format*`
 *    helper lifts that previously fell back as `unresolved_leaf`);
 *  - a bare-call leaf with an EMPTY/absent resultSchema STILL falls back (the
 *    pattern-return shape — conservative default, preserving the real R5
 *    pattern-instantiation detection);
 *  - an `async` body or an `.inSpace(`/`.asScope(` member call STILL falls back
 *    REGARDLESS of the resultSchema (an async lift may declare its awaited value
 *    type yet still return a Promise; a cross-space child is permanent fallback).
 *
 * These cases run through `resolveLeafImpls` with the runner's `liveLeafTrustCheck`
 * supplied (the production gate), against hand-built leaf modules so the
 * resultSchema is controlled exactly.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { setGlobalLogFloor } from "@commonfabric/utils/logger";
import {
  liveLeafWritesCellInput,
  resolveLeafImpls,
} from "../../src/reactive-interpreter/extract.ts";
import type { Op, OpId, Rog } from "../../src/reactive-interpreter/rog.ts";
import type { JSONSchema } from "../../src/builder/types.ts";

setGlobalLogFloor("error");

const T = true as unknown as Rog["resultSchema"];

/** A single-leaf ROG (op0 = leaf reading the argument). */
function singleLeafRog(): Rog {
  const ops: Op[] = [
    {
      id: 0,
      kind: "leaf",
      inputs: [{ kind: "argument", path: [] }],
      outSchema: T,
      detail: { kind: "leaf" },
    },
  ];
  return {
    argumentSchema: T,
    resultSchema: T,
    result: { kind: "opOut", op: 0, path: [] },
    ops,
  };
}

/** A RawPattern whose node 0 is a `javascript` leaf with the given live impl and
 * declared resultSchema. */
function leafPattern(
  impl: (input: unknown) => unknown,
  resultSchema: unknown,
): { nodes: Array<{ module: Record<string, unknown> }> } {
  return {
    nodes: [{
      module: { type: "javascript", implementation: impl, resultSchema },
    }],
  };
}

// The runner's eligibility probe ALWAYS passes the trust check (production gate),
// so model that here: every live function is trusted. This activates the
// structural pattern-instantiation gates (they are gated on a supplied check).
const trustAll = () => true;

describe("leaf-scan precision: resultSchema discriminates pure-helper vs pattern call", () => {
  it("RESOLVES a bare-helper-call leaf with a concrete value resultSchema", () => {
    // `(i) => sanitizeAmount(i.value, 0)` — a closed-over PURE helper call. With a
    // concrete `{type:"number"}` resultSchema this provably produces a value.
    const sanitizeAmount = (v: unknown, d: number) =>
      typeof v === "number" ? v : d;
    const impl = (i: unknown) =>
      sanitizeAmount((i as { value?: number }).value, 0);
    const pattern = leafPattern(impl, { type: "number" } satisfies JSONSchema);

    const { leafImpls, unresolvedLeafOps } = resolveLeafImpls(
      // deno-lint-ignore no-explicit-any
      pattern as any,
      singleLeafRog(),
      undefined,
      trustAll,
    );
    expect(unresolvedLeafOps).toEqual([]);
    expect(leafImpls.has(0)).toBe(true);
  });

  it("RESOLVES typed bare-helper leaves across object/array/string/enum/anyOf schemas", () => {
    const helper = (i: unknown) => i; // a closed-over bare-call identifier
    const concreteSchemas: JSONSchema[] = [
      { type: "object", properties: { a: { type: "number" } } },
      { type: "array", items: { type: "string" } },
      { type: "string" },
      { type: "boolean" },
      { enum: ["a", "b"] } as unknown as JSONSchema,
      {
        anyOf: [{ type: "object" }, { type: "null" }],
      } as unknown as JSONSchema,
      { $ref: "#/$defs/Thing" } as unknown as JSONSchema,
      { type: ["number", "null"] } as unknown as JSONSchema,
    ];
    for (const rs of concreteSchemas) {
      const impl = (i: unknown) => helper(i);
      const { unresolvedLeafOps } = resolveLeafImpls(
        // deno-lint-ignore no-explicit-any
        leafPattern(impl, rs) as any,
        singleLeafRog(),
        undefined,
        trustAll,
      );
      expect(unresolvedLeafOps, JSON.stringify(rs)).toEqual([]);
    }
  });

  it("FALLS BACK a bare-call leaf with an EMPTY resultSchema (pattern-return shape)", () => {
    // `({value}) => childPattern({value})` — the genuine R5 pattern-instantiation
    // shape. The builder leaves such a lift's resultSchema EMPTY (`{}`), so the
    // bare-call gate stays armed and it must fall back (NOT be resolved as a leaf).
    const childPattern = (a: unknown) => a; // stand-in factory identifier
    const impl = (i: unknown) =>
      childPattern({ value: (i as { value?: number }).value });

    for (const emptyish of [{}, true, undefined]) {
      const { leafImpls, unresolvedLeafOps } = resolveLeafImpls(
        // deno-lint-ignore no-explicit-any
        leafPattern(impl, emptyish) as any,
        singleLeafRog(),
        undefined,
        trustAll,
      );
      expect(unresolvedLeafOps, JSON.stringify(emptyish)).toEqual([0]);
      expect(leafImpls.has(0)).toBe(false);
    }
  });

  it("FALLS BACK an async leaf EVEN WITH a concrete value resultSchema", () => {
    // An async lift may declare its AWAITED value type, but it still returns a
    // Promise the interpreter cannot store — the concrete schema must NOT free it.
    const impl = async (i: unknown) =>
      (await Promise.resolve((i as { value?: number }).value)) ?? 0;
    const { unresolvedLeafOps, leafImpls } = resolveLeafImpls(
      // deno-lint-ignore no-explicit-any
      leafPattern(impl as (i: unknown) => unknown, { type: "number" }) as any,
      singleLeafRog(),
      undefined,
      trustAll,
    );
    expect(unresolvedLeafOps).toEqual([0]);
    expect(leafImpls.has(0)).toBe(false);
  });

  it("FALLS BACK an .inSpace(/.asScope( cross-space child EVEN WITH a concrete schema", () => {
    const child = { inSpace: (_s: string) => (a: unknown) => a };
    const implInSpace = (i: unknown) =>
      child.inSpace("other")({ value: (i as { value?: number }).value });
    const implAsScope = (i: unknown) =>
      ({ asScope: (_s: string) => (a: unknown) => a }).asScope("user")({
        value: (i as { value?: number }).value,
      });
    for (const impl of [implInSpace, implAsScope]) {
      const { unresolvedLeafOps } = resolveLeafImpls(
        // deno-lint-ignore no-explicit-any
        leafPattern(impl, { type: "object" }) as any,
        singleLeafRog(),
        undefined,
        trustAll,
      );
      expect(unresolvedLeafOps).toEqual([0]);
    }
  });

  it("RESOLVES a member-call / pure-global leaf regardless of schema (never gated)", () => {
    // `(arr) => arr.map((x) => x * 2)` — a member call, not a bare call: it never
    // tripped the gate. Confirm it still resolves under the typed-schema path.
    const impl = (arr: unknown) => (arr as number[]).map((x) => x * 2);
    const { unresolvedLeafOps } = resolveLeafImpls(
      // deno-lint-ignore no-explicit-any
      leafPattern(impl, { type: "array", items: { type: "number" } }) as any,
      singleLeafRog(),
      undefined,
      trustAll,
    );
    expect(unresolvedLeafOps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Read-only context-leaf split (`readOnlyCellLeafOps`): a leaf whose argument
// schema needs cell context (asCell/asStream INPUT) resolves as a read-only
// context leaf ONLY when the runner proved it eligible (its op id is in the set)
// AND its source does not write the input. Otherwise it stays UNRESOLVED.
// ---------------------------------------------------------------------------

/** A RawPattern whose node 0 is a `javascript` leaf with an asCell argument
 * schema (so `schemaNeedsCellContext` is true) and the given live impl. */
function asCellLeafPattern(
  impl: (input: unknown) => unknown,
): { nodes: Array<{ module: Record<string, unknown> }> } {
  return {
    nodes: [{
      module: {
        type: "javascript",
        implementation: impl,
        resultSchema: { type: "boolean" } satisfies JSONSchema,
        argumentSchema: {
          type: "object",
          properties: {
            input: { type: "boolean", asCell: ["readonly"] },
          },
          required: ["input"],
        } satisfies JSONSchema,
      },
    }],
  };
}

describe("read-only context-leaf split (readOnlyCellLeafOps)", () => {
  const eligible: ReadonlySet<OpId> = new Set<OpId>([0]);

  it("RESOLVES a read-only asCell leaf when its op id is in the eligible set", () => {
    // `({input}) => input.get() === true` — reads the handle, never writes it.
    const impl = (i: unknown) =>
      (i as { input: { get(): unknown } }).input.get() === true;
    const { leafImpls, unresolvedLeafOps } = resolveLeafImpls(
      // deno-lint-ignore no-explicit-any
      asCellLeafPattern(impl) as any,
      singleLeafRog(),
      undefined,
      trustAll,
      eligible,
    );
    expect(unresolvedLeafOps).toEqual([]);
    expect(leafImpls.has(0)).toBe(true);
  });

  it("FALLS BACK a WRITE-capable asCell leaf even when in the eligible set", () => {
    // `({input}) => { input.set(true); return true; }` — mutates the handle. A
    // write-capable context leaf is EFFECTFUL and must stay a legacy boundary.
    const impl = (i: unknown) => {
      (i as { input: { set(v: unknown): void } }).input.set(true);
      return true;
    };
    const { leafImpls, unresolvedLeafOps } = resolveLeafImpls(
      // deno-lint-ignore no-explicit-any
      asCellLeafPattern(impl) as any,
      singleLeafRog(),
      undefined,
      trustAll,
      eligible,
    );
    expect(unresolvedLeafOps).toEqual([0]);
    expect(leafImpls.has(0)).toBe(false);
  });

  it("FALLS BACK any asCell leaf when the eligible set is EMPTY (every existing caller)", () => {
    // No set supplied / empty set ⇒ byte-for-byte the prior behavior: ALL
    // context-requiring leaves stay UNRESOLVED.
    const impl = (i: unknown) =>
      (i as { input: { get(): unknown } }).input.get() === true;
    for (const set of [undefined, new Set<OpId>()]) {
      const { leafImpls, unresolvedLeafOps } = resolveLeafImpls(
        // deno-lint-ignore no-explicit-any
        asCellLeafPattern(impl) as any,
        singleLeafRog(),
        undefined,
        trustAll,
        set,
      );
      expect(unresolvedLeafOps).toEqual([0]);
      expect(leafImpls.has(0)).toBe(false);
    }
  });

  it("liveLeafWritesCellInput detects each write method on the handle", () => {
    const writes = [
      (i: { c: { set(v: unknown): void } }) => i.c.set(1),
      (i: { c: { send(v: unknown): void } }) => i.c.send(1),
      (i: { c: { update(v: unknown): void } }) => i.c.update({}),
      (i: { c: { push(v: unknown): void } }) => i.c.push(1),
      (i: { c: { setRaw(v: unknown): void } }) => i.c.setRaw(1),
      (i: { c: { setRawUntyped(v: unknown): void } }) => i.c.setRawUntyped(1),
      (i: { c: { setMetaRaw(k: string, v: unknown): void } }) =>
        i.c.setMetaRaw("argument", 1),
      (i: { c: { exec(s: string): void } }) => i.c.exec("INSERT"),
    ];
    for (const fn of writes) {
      expect(liveLeafWritesCellInput(fn as (i: unknown) => unknown)).toBe(true);
    }
    // Pure reads do NOT match.
    const reads = [
      (i: { c: { get(): unknown } }) => i.c.get(),
      (i: { c: { sample(): unknown } }) => i.c.sample(),
      (i: { c: { key(k: string): { get(): unknown } } }) => i.c.key("x").get(),
    ];
    for (const fn of reads) {
      expect(liveLeafWritesCellInput(fn as (i: unknown) => unknown)).toBe(false);
    }
  });
});
