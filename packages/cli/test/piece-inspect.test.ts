import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { readWithPropertyScope } from "../lib/piece.ts";

/**
 * Unit tests for `readWithPropertyScope`, the helper used by
 * `cf piece inspect` to read top-level object properties via `cell.key()`
 * rather than via the parent's flat `.get()` value.
 *
 * The fix this exercises (CT-1598): when a pattern declares a property as
 * `PerUser<…>` (or any other scope-shifted shape), the value stored inline in
 * the parent space-scoped document is the default — the per-user value lives
 * in a separate scoped instance. `cell.key(prop).get()` carries the property
 * schema's scope into the read and resolves the scoped instance; the parent
 * `cell.get()` does not. So `inspectPiece` descends one level via `cell.key()`
 * so the caller sees their own per-user values.
 *
 * These tests model just enough of the `Cell` interface to verify the
 * descent contract.
 */

interface FakeCell {
  get(): unknown;
  key(prop: string | number): FakeCell;
}

function makeFakeCell(opts: {
  parentValue: unknown;
  childValues?: Record<string, unknown>;
}): FakeCell {
  return {
    get: () => opts.parentValue,
    key: (prop) => {
      const k = String(prop);
      // Override values for children when supplied — this models the runtime
      // behavior where `cell.key(prop)` returns a child cell whose `.get()`
      // resolves the property at the property schema's scope (which can
      // differ from the parent's flat inline value).
      const override = opts.childValues?.[k];
      return makeFakeCell({ parentValue: override });
    },
  };
}

describe("readWithPropertyScope", () => {
  it("returns primitive values unchanged", () => {
    const cell = makeFakeCell({ parentValue: "hello" });
    expect(readWithPropertyScope(cell as never)).toBe("hello");
  });

  it("returns null/undefined unchanged", () => {
    expect(readWithPropertyScope(
      makeFakeCell({ parentValue: null }) as never,
    )).toBe(null);
    expect(readWithPropertyScope(
      makeFakeCell({ parentValue: undefined }) as never,
    )).toBe(undefined);
  });

  it("returns arrays unchanged (no per-element descent)", () => {
    const arr = [1, 2, 3];
    const cell = makeFakeCell({ parentValue: arr });
    expect(readWithPropertyScope(cell as never)).toEqual(arr);
  });

  it("reads each top-level property via cell.key() (CT-1598)", () => {
    // Models the cozy-poll-scoped argument document, where myName is declared
    // PerUser<string> — the inline value at scope=space is the default "",
    // but the per-user instance contains the actual value.
    const cell = makeFakeCell({
      parentValue: {
        adminName: "Alex",
        myName: "", // inline value at scope=space (the default)
        users: [{ name: "Alex" }],
      },
      childValues: {
        // What cell.key(prop).get() would return for each property — for
        // PerUser fields this differs from the inline parent value.
        adminName: "Alex",
        myName: "Alex", // resolved per-user value
        users: [{ name: "Alex" }],
      },
    });

    const out = readWithPropertyScope(cell as never) as Record<string, unknown>;
    expect(out.adminName).toBe("Alex");
    expect(out.myName).toBe("Alex");
    expect(out.users).toEqual([{ name: "Alex" }]);
  });

  it("different identities see different per-user values", () => {
    const cellAsAlex = makeFakeCell({
      parentValue: { myName: "", adminName: "Alex" },
      childValues: { myName: "Alex", adminName: "Alex" },
    });
    const cellAsBeth = makeFakeCell({
      parentValue: { myName: "", adminName: "Alex" },
      childValues: { myName: "Beth", adminName: "Alex" },
    });
    expect(
      (readWithPropertyScope(cellAsAlex as never) as Record<string, unknown>)
        .myName,
    ).toBe("Alex");
    expect(
      (readWithPropertyScope(cellAsBeth as never) as Record<string, unknown>)
        .myName,
    ).toBe("Beth");
  });
});
