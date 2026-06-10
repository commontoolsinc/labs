import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  prefersReducedMotion,
  SEAL_GLOW_PERIOD_MS,
  SEAL_SPIN_PERIOD_MS,
  sealGlowDelay,
  sealSpinDelay,
} from "./seal-liveness.ts";

describe("seal-liveness", () => {
  it("seeds spin/glow phases as negative ms delays within their period", () => {
    // The delays seed a CSS animation into the shared epoch's phase, so they are
    // always ≤ 0 and never older than one full period.
    const spin = sealSpinDelay();
    expect(spin.endsWith("ms")).toBe(true);
    const spinMs = parseFloat(spin);
    expect(spinMs).toBeLessThanOrEqual(0);
    expect(spinMs).toBeGreaterThan(-SEAL_SPIN_PERIOD_MS);

    const glow = sealGlowDelay();
    const glowMs = parseFloat(glow);
    expect(glowMs).toBeLessThanOrEqual(0);
    expect(glowMs).toBeGreaterThan(-SEAL_GLOW_PERIOD_MS);
  });

  it("reports a boolean for reduced-motion preference without throwing", () => {
    expect(typeof prefersReducedMotion()).toBe("boolean");
  });
});
