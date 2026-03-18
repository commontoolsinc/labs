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
    await harness.writeCellValue({
      id: "safe-probing-report",
      schema: reportSchema,
      value: "Malicious instructions hidden in a report",
      prepare: "cfc",
    });

    const wordCount = await harness.withCommittedEdit((tx) => {
      const reportInTx = harness.getCell<string>(
        "safe-probing-report",
        reportSchema,
        tx,
      );
      const wordCount = harness.getCell<number>(
        "safe-probing-word-count",
        wordCountSchema,
        tx,
      );
      reportInTx.withTx(tx).get();
      wordCount.withTx(tx).set(42);
      return wordCount;
    }, {
      prepare: "cfc",
    });

    const labels = await harness.readLabels(
      wordCount.getAsNormalizedFullLink().id,
    );
    expect(labels["/"]?.classification).toEqual(
      expect.arrayContaining([
        [userAliceAtom],
        [promptInfluenceAtom],
      ]),
    );
    expect(labels["/"]?.classification).toHaveLength(2);
    expect(labels["/"]?.integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining(injectionSafeAtom),
      ]),
    );
  });
});
