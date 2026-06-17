import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createRef } from "../src/create-ref.ts";
import { isOpaqueRefMarker } from "../src/builder/types.ts";

// Regression guard for createRef fail-closed behavior (audit S14).
//
// When a derivation input is an OpaqueRef with no value (or a Cell with no
// entityId), the id can no longer be derived from real inputs. The pre-fix code
// substituted a random UUID, silently producing a non-deterministic id where a
// stable, content-derived one was expected. createRef must fail closed instead.
describe("createRef fail-closed", () => {
  it("throws when an OpaqueRef derivation input has no value", () => {
    const opaqueRefNoValue = {
      [isOpaqueRefMarker]: true,
      export: () => ({ value: null }),
    };
    expect(() => createRef({ ref: opaqueRefNoValue }, "cause")).toThrow(
      /cannot derive a stable id/,
    );
  });

  it("derives a stable id from concrete inputs (unchanged)", () => {
    const a = createRef({ x: 1, y: "z" }, "cause");
    const b = createRef({ x: 1, y: "z" }, "cause");
    expect(a.taggedHashString).toEqual(b.taggedHashString);
  });

  it("still mints a fresh id when no cause is given (documented behavior)", () => {
    const a = createRef({ x: 1 });
    const b = createRef({ x: 1 });
    expect(a.taggedHashString).not.toEqual(b.taggedHashString);
  });
});
