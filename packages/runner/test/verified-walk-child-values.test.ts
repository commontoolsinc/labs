import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { verifiedWalkChildValues } from "../src/harness/executable-registry.ts";

// Regression for CT-1623.
//
// The verified-value walks (recordVerifiedFunctions / annotateVerifiedPatterns /
// collectAssociatedFunctions) recurse through `verifiedWalkChildValues`. The
// AMD/CommonJS bundle exposes exports as data properties; the ESM module-record
// loader exposes them as SES module-namespace *live-binding accessors* (no
// `value`). The walk must follow those accessors, otherwise verified functions
// and their binding metadata (`__cfVerifiedBindingIdentity`) defined by
// ESM-loaded modules are never registered, leaving the writer's verified
// binding identity unresolved and breaking CFC `writeAuthorizedBy` for
// trusted-action writes.

const collect = (
  value: object,
): unknown[] => [...verifiedWalkChildValues(value)];

describe("verifiedWalkChildValues (CT-1623)", () => {
  it("yields data property values (AMD/CommonJS export shape)", () => {
    const fn = () => {};
    const exportsObj = { a: fn, b: 7, c: { nested: true } };
    const yielded = collect(exportsObj);
    expect(yielded).toContain(fn);
    expect(yielded).toContain(7);
    expect(yielded.length).toBe(3);
  });

  it("follows live-binding accessors on module namespaces (ESM export shape)", () => {
    const handler = () => {};
    // Mimic a SES module namespace: tagged `[object Module]` with exports
    // exposed as getters (live bindings) rather than data properties.
    const ns: Record<PropertyKey, unknown> = {};
    Object.defineProperty(ns, Symbol.toStringTag, {
      value: "Module",
      configurable: false,
    });
    Object.defineProperty(ns, "commit", {
      get: () => handler,
      enumerable: true,
    });
    Object.defineProperty(ns, "__esModule", {
      get: () => true,
      enumerable: true,
    });

    expect(Object.prototype.toString.call(ns)).toBe("[object Module]");
    const yielded = collect(ns);
    expect(yielded).toContain(handler);
  });

  it("does NOT invoke getters on ordinary (non-module) objects", () => {
    let invoked = false;
    const obj = {};
    Object.defineProperty(obj, "trap", {
      get: () => {
        invoked = true;
        return {};
      },
      enumerable: true,
    });
    const yielded = collect(obj);
    expect(invoked).toBe(false);
    expect(yielded.length).toBe(0);
  });

  it("ignores a live binding that throws on read", () => {
    const ns: Record<PropertyKey, unknown> = {};
    Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
    Object.defineProperty(ns, "boom", {
      get: () => {
        throw new Error("unreadable");
      },
      enumerable: true,
    });
    const good = () => {};
    Object.defineProperty(ns, "ok", { get: () => good, enumerable: true });
    const yielded = collect(ns);
    expect(yielded).toContain(good);
  });
});
