import { assertEquals } from "@std/assert";
import { readHarnessRunReport } from "../src/artifacts.ts";
import { createHarnessRunReport } from "../src/contracts/run-report.ts";

Deno.test("legacy run reports remain readable without provider metadata", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const path = `${directory}/run-report.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        type: "cf-harness.run-report",
        runId: "legacy-run",
        generatedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        model: "legacy-model",
        modelTurns: 1,
        cfcEnforcementMode: "disabled",
        policyEventCounts: { total: 0, warnings: 0, denied: 0 },
        policyDecisionCounts: { total: 0, allowed: 0, warned: 0, denied: 0 },
        policyEvents: [],
        policyDecisions: [],
        timeline: [],
        toolActivity: [],
        toolOutputs: [],
      }),
    );

    const report = await readHarnessRunReport(path);
    assertEquals(report.modelProvider, undefined);
    assertEquals(report.modelAuthSource, undefined);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("run reports do not invent API-key auth for legacy run state", () => {
  const report = createHarnessRunReport({
    runState: {
      runId: "legacy-state",
      status: "completed",
      updatedAt: "2026-01-01T00:00:00.000Z",
      cfcEnforcementMode: "disabled",
      policyEvents: [],
      policyDecisions: [],
      toolOutputs: [],
    },
    model: "legacy-model",
    modelTurns: 1,
    toolActivity: [],
  });

  assertEquals(report.modelProvider, undefined);
  assertEquals(report.modelAuthSource, undefined);
});
