// W6 structural-barrier regression: the gated Date/Math injected into pattern
// compartments must not be escapable to a real (ungated) clock or entropy via
// the constructor or prototype chain. Runs a compartment built with the real
// module globals and NO pattern frame, so every ambient read must be denied and
// no escape may yield a number (a real clock).
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  ensureSESLockdown,
  evaluateFunctionSourceInSES,
} from "../src/sandbox/ses-runtime.ts";
import { createModuleCompartmentGlobals } from "../src/sandbox/compartment-globals.ts";

const SRC = `function () {
  const out = {};
  const probe = (name, fn) => {
    try { out[name] = typeof fn(); } catch (e) { out[name] = "threw:" + (e && e.name); }
  };
  probe("dateNow", () => Date.now());
  probe("newDate", () => new Date().getTime());
  probe("instanceCtorNow", () => (new Date(0)).constructor.now());
  probe("protoCtorNow", () => Date.prototype.constructor.now());
  probe("protoProtoCtorNow", () => Object.getPrototypeOf(Date.prototype).constructor.now());
  probe("instanceCtorCall", () => new ((new Date(0)).constructor)().getTime());
  probe("mathRandom", () => Math.random());
  probe("newDateWithArg", () => new Date(0).getTime());
  out.instanceOf = (new Date(0)) instanceof Date;
  out.ctorIsDate = (new Date(0)).constructor === Date;
  return out;
}`;

describe("W6 intrinsic escape / structural barrier", () => {
  it("gated Date/Math cannot be escaped to a real clock or entropy", () => {
    ensureSESLockdown();
    const globals = createModuleCompartmentGlobals();
    const fn = evaluateFunctionSourceInSES(SRC, { lockdown: true, globals });
    const r = (fn as () => Record<string, unknown>)();

    // No pattern frame: every ambient read is denied by the gate.
    expect(r.dateNow).toBe("threw:TimeCapabilityError");
    expect(r.newDate).toBe("threw:TimeCapabilityError");
    expect(r.mathRandom).toBe("threw:TimeCapabilityError");

    // The prototype/constructor escapes must NOT return a number (a real clock);
    // they reach the SES-tamed shared Date and throw.
    for (
      const key of [
        "instanceCtorNow",
        "protoCtorNow",
        "protoProtoCtorNow",
        "instanceCtorCall",
      ]
    ) {
      expect(typeof r[key]).toBe("string");
      expect(String(r[key]).startsWith("threw:")).toBe(true);
    }

    // Deterministic formatting and instanceof still work.
    expect(r.newDateWithArg).toBe("number");
    expect(r.instanceOf).toBe(true);
    // A gated-Date instance reports the gated Date as its constructor, so
    // `(new Date()).constructor` is gated (the escape route above throws) rather
    // than exposing an ungated Date.
    expect(r.ctorIsDate).toBe(true);
  });
});
