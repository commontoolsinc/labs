import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { lift } from "../src/builder/module.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { setVerifiedFunctionRegistrar } from "../src/sandbox/function-hardening.ts";

/**
 * `ensureImplementationRef` minting (see builder/module.ts).
 *
 * The attached (and serialized) ref is purely content-derived
 * (`{kind, source, preview}`) — the build-order `ordinal` was removed
 * (transformer hoisting + the SES verifier guarantee one builder call per
 * module-scope declaration, so the ordinal only added build-order
 * sensitivity).
 *
 * Transition shim: graphs persisted BEFORE the ordinal removal carry
 * ordinal-bearing refs, and `moduleToJSON` omits the function body for
 * admitted (verified) modules — so those stored refs only resolve if a fresh
 * evaluation re-registers the implementation under the legacy ordinal form
 * too. These tests pin that dual registration and the order-independence of
 * the attached ref; the shim is removed together with `implementationRef`
 * itself (docs/specs/content-addressed-action-identity.md).
 */
describe("ensureImplementationRef minting", () => {
  // Source-identical but distinct function objects (same text, same (lack
  // of) src), built fresh per call so no attached ref is carried over.
  const makeImpl = () => (x: { value: number }) => x.value + 1;

  it("attaches a content-derived ref and registers a legacy ordinal alias", () => {
    const registered: string[] = [];
    const restore = setVerifiedFunctionRegistrar((ref) => {
      registered.push(ref);
    });
    const frame = pushFrame();
    try {
      const impl = makeImpl();
      lift(impl);
      const attached = (impl as { implementationRef?: string })
        .implementationRef;
      expect(typeof attached).toBe("string");
      const distinct = new Set(registered);
      // Dual registration: the content-derived ref (the attached one) plus
      // exactly one legacy ordinal-bearing alias.
      expect(distinct.size).toBe(2);
      expect(distinct.has(attached!)).toBe(true);
    } finally {
      popFrame(frame);
      restore();
    }
  });

  it("attached ref is build-order independent; the legacy alias is not", () => {
    const mintInFreshFrame = (counterStart: number) => {
      const registered: string[] = [];
      const restore = setVerifiedFunctionRegistrar((ref) => {
        registered.push(ref);
      });
      const frame = pushFrame();
      frame.generatedIdCounter = counterStart;
      try {
        const impl = makeImpl();
        lift(impl);
        const attached = (impl as { implementationRef?: string })
          .implementationRef!;
        const legacy = [...new Set(registered)].find((r) => r !== attached)!;
        return { attached, legacy };
      } finally {
        popFrame(frame);
        restore();
      }
    };

    const a = mintInFreshFrame(0);
    const b = mintInFreshFrame(7);
    // Content-derived: identical source text mints the identical ref no
    // matter how much of the frame's id counter prior builds consumed.
    expect(b.attached).toBe(a.attached);
    // The legacy alias reproduces the old ordinal-bearing form, so it DOES
    // vary with the counter — that variance is exactly what old persisted
    // graphs encode and what the alias re-registers.
    expect(b.legacy).not.toBe(a.legacy);
  });
});
