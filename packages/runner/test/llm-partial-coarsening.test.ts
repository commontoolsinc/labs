// Channel 6 (builtin progress) coarsening: the LLM partial-streaming batch
// window is one second (>=1s), so an untrusted pattern cannot watch the partial
// cell for a sub-second token-arrival cadence. See
// docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md.
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { PARTIAL_BATCH_MS } from "../src/builtins/llm.ts";

describe("LLM partial batch coarsening (channel 6)", () => {
  it("batches partial writes at >=1s so the cadence is <=1 Hz", () => {
    expect(PARTIAL_BATCH_MS).toBeGreaterThanOrEqual(1000);
  });
});
