import { assertEquals } from "@std/assert";
import { writeDetailValueForTarget } from "../src/cfc/prepare.ts";
import { normalizeCellScope } from "../src/scope.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
  TransactionWriteDetail,
} from "../src/storage/interface.ts";
import type { URI } from "@commonfabric/memory/interface";

// `writeDetailValueForTarget` reconstructs "the value this transaction wrote
// at a path" from the recorded write-details. A value may be recorded either
// as a single coarse write (whole object) OR split across granular writes (an
// envelope `{}` at the path plus per-field writes at deeper paths) — e.g. when
// the value is deep-frozen and therefore written field-by-field. Both shapes
// MUST reconstruct to the same value; otherwise CFC's writeAuthorizedBy
// enforcement evaluates an item's policy against an incomplete value (e.g. the
// bare envelope `{}`) and mis-authorizes it.

const SPACE = "did:key:test-space" as MemorySpace;
const ID = "of:fid1:test-entity" as URI;
const SCOPE = normalizeCellScope(undefined);

const txWith = (
  details: TransactionWriteDetail[],
): IExtendedStorageTransaction =>
  ({
    getWriteDetails: (_space: MemorySpace) => details,
  }) as unknown as IExtendedStorageTransaction;

const detail = (
  path: readonly string[],
  value: unknown,
): TransactionWriteDetail => ({
  address: { space: SPACE, id: ID, scope: SCOPE, path },
  // deno-lint-ignore no-explicit-any
  value: value as any,
});

const target = (path: readonly string[]) => ({
  space: SPACE,
  id: ID,
  scope: SCOPE,
  path,
});

Deno.test("writeDetailValueForTarget: coarse whole-object write reconstructs as-is", () => {
  const tx = txWith([
    detail(["value"], { origin: "imported", body: "allowed" }),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "value"), {
    origin: "imported",
    body: "allowed",
  });
});

Deno.test("writeDetailValueForTarget: granular envelope + field writes reconstruct the full object", () => {
  // This is the shape produced when an object is written field-by-field (e.g.
  // a deep-frozen value): an empty envelope at the root plus per-field writes.
  // The pre-fix behavior returned just the `{}` envelope, dropping the fields.
  const tx = txWith([
    detail(["value"], {}),
    detail(["value", "origin"], "imported"),
    detail(["value", "body"], "allowed"),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "value"), {
    origin: "imported",
    body: "allowed",
  });
});

Deno.test("writeDetailValueForTarget: deeper writes win over a stale envelope field", () => {
  const tx = txWith([
    detail(["value"], { origin: "stale" }),
    detail(["value", "origin"], "imported"),
    detail(["value", "body"], "allowed"),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "value"), {
    origin: "imported",
    body: "allowed",
  });
});

Deno.test("writeDetailValueForTarget: granular writes with no envelope reconstruct an object", () => {
  const tx = txWith([
    detail(["value", "origin"], "imported"),
    detail(["value", "body"], "allowed"),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "value"), {
    origin: "imported",
    body: "allowed",
  });
});

Deno.test("writeDetailValueForTarget: array-index granular writes reconstruct an array", () => {
  const tx = txWith([
    detail(["value"], []),
    detail(["value", "0"], "a"),
    detail(["value", "1"], "b"),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "value"), ["a", "b"]);
});

Deno.test("writeDetailValueForTarget: reconstructs nested target path", () => {
  const tx = txWith([
    detail(["value", "item"], {}),
    detail(["value", "item", "origin"], "imported"),
  ]);
  assertEquals(writeDetailValueForTarget(tx, target(["item"]), "value"), {
    origin: "imported",
  });
});

Deno.test("writeDetailValueForTarget: previousValue uses the coarse ancestor snapshot", () => {
  // The previousValue of the longest ancestor write already captures the whole
  // pre-write subtree, so per-field previous-values are not composed.
  const tx = txWith([
    {
      address: { space: SPACE, id: ID, scope: SCOPE, path: ["value"] },
      // deno-lint-ignore no-explicit-any
      value: {} as any,
      // deno-lint-ignore no-explicit-any
      previousValue: { origin: "old", body: "old-body" } as any,
    },
    {
      address: {
        space: SPACE,
        id: ID,
        scope: SCOPE,
        path: ["value", "origin"],
      },
      // deno-lint-ignore no-explicit-any
      value: "new" as any,
    },
  ]);
  assertEquals(writeDetailValueForTarget(tx, target([]), "previousValue"), {
    origin: "old",
    body: "old-body",
  });
});

Deno.test("writeDetailValueForTarget: no matching write returns undefined", () => {
  const tx = txWith([
    detail(["value", "other"], "x"),
  ]);
  // A different entity entirely.
  assertEquals(
    writeDetailValueForTarget(
      tx,
      { space: SPACE, id: "of:fid1:nope" as URI, scope: SCOPE, path: [] },
      "value",
    ),
    undefined,
  );
});
