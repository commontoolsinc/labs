import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example safe probing test",
);
const space = signer.did();

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const promptInjectionRiskAtom = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "PROMPT_INJECTION_RISK_UNSCREENED",
  source: "ref:report-1",
} as const;

const promptInfluenceAtom = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "PROMPT_INFLUENCE",
  source: "ref:report-1",
} as const;

const injectionSafeAtom = {
  type: "https://commonfabric.org/cfc/atom/InjectionSafe",
  stage: "value",
  detectorProfile: "pi-screen-v3",
} as const;

const reportSchema = {
  type: "string",
  ifc: {
    classification: [
      [userAliceAtom],
      [promptInjectionRiskAtom],
      [promptInfluenceAtom],
    ],
  },
} as const satisfies JSONSchema;

const wordCountSchema = {
  type: "number",
  ifc: {
    integrity: [injectionSafeAtom],
    declassify: {
      confidentialityPre: [promptInjectionRiskAtom],
      integrityPre: [injectionSafeAtom],
      removeMatchedClauses: true,
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

const probeInputSchema = {
  type: "object",
  properties: {
    report: reportSchema,
  },
  required: ["report"],
} as const satisfies JSONSchema;

const probeOutputSchema = {
  type: "object",
  properties: {
    count: wordCountSchema,
  },
  required: ["count"],
} as const satisfies JSONSchema;

describe("CFC worked example: safe probing", () => {
  let harness: ReturnType<typeof createCfcPatternTestHarness>;

  beforeEach(() => {
    harness = createCfcPatternTestHarness({
      signer,
      apiUrl: new URL(import.meta.url),
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("clears material-risk caveats for a numeric probe while preserving prompt influence", async () => {
    const report = await harness.writeCellValue({
      id: "safe-probing-report",
      schema: reportSchema,
      value: "Malicious instructions hidden in a report",
      prepare: "cfc",
    });

    const safeProbePattern = harness.pattern(
      ({ report }) => ({
        count: harness.lift(reportSchema, wordCountSchema, (_value) => 42)(
          report,
        ),
      }),
      probeInputSchema,
      probeOutputSchema,
    );
    const run = await harness.runPattern({
      id: "safe-probing-word-count",
      pattern: safeProbePattern,
      inputs: { report },
      outputSchema: probeOutputSchema,
      initialOutput: { count: 0 },
      prepare: "cfc",
    });
    expect(await run.result.pull()).toEqual({ count: 42 });

    await harness.restart();

    const persistedOutput = harness.getCell<{ count: number }>(
      "safe-probing-word-count",
      probeOutputSchema,
    );
    const labels = await harness.readEffectiveLabel(
      persistedOutput.key("count"),
      wordCountSchema,
    );

    expect(labels?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [promptInfluenceAtom],
      ]),
    );
    expect(labels?.classification).toHaveLength(2);
    expect(labels?.integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining(injectionSafeAtom),
      ]),
    );
  });
});
