import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  INITIAL_SINK_INVENTORY,
  isInitialSinkInventoryName,
} from "../src/cfc/mod.ts";

describe("CFC sink inventory", () => {
  it("includes the initial sink rollout set", () => {
    expect(INITIAL_SINK_INVENTORY).toEqual([
      "fetchData",
      "fetchProgram",
      "streamData",
      "llm",
      "llmDialog",
      "generateText",
      "generateObject",
    ]);
    expect(isInitialSinkInventoryName("fetchData")).toBe(true);
    expect(isInitialSinkInventoryName("generateObject")).toBe(true);
    expect(isInitialSinkInventoryName("navigateTo")).toBe(false);
  });
});
