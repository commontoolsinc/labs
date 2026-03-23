import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Labels } from "../src/storage/interface.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example fact check test",
);
const space = signer.did();

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const publicAudienceAtom = {
  type: "https://commonfabric.org/cfc/atom/Audience",
  kind: "public",
} as const;

const factCheckedAtom = {
  type: "https://commonfabric.org/cfc/atom/FactChecked",
  checker: "Builtin(fact-check)",
  version: "test-v1",
} as const;

const sourcesDisclosedAtom = {
  type: "https://commonfabric.org/cfc/atom/SourcesDisclosed",
  sourceSetHash: "sha256:source-set-1",
} as const;

const sourceSchema = {
  type: "string",
  ifc: { classification: [userAliceAtom] },
} as const satisfies JSONSchema;

const factCheckInputSchema = {
  type: "object",
  properties: {
    source: sourceSchema,
  },
  required: ["source"],
} as const satisfies JSONSchema;

const factCheckOutputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      ifc: {
        classification: [publicAudienceAtom],
        declassify: {
          confidentialityPre: [userAliceAtom],
          integrityPre: ["fact-check-proof"],
          addAlternatives: [publicAudienceAtom],
          addIntegrity: [factCheckedAtom, sourcesDisclosedAtom],
          releaseCondition: true,
        },
      },
    },
  },
  required: ["text"],
} as const satisfies JSONSchema;

const publishedFactCheckInputSchema = {
  type: "object",
  properties: {
    report: {
      type: "object",
      properties: {
        text: {
          type: "string",
          ifc: {
            classification: [publicAudienceAtom],
            requiredIntegrity: [factCheckedAtom, sourcesDisclosedAtom],
          },
        },
      },
      required: ["text"],
    },
  },
  required: ["report"],
} as const satisfies JSONSchema;

const publishedFactCheckOutputSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      ifc: {
        classification: [publicAudienceAtom],
      },
    },
  },
  required: ["text"],
} as const satisfies JSONSchema;

const factCheckTextSchema = {
  type: "string",
  ifc: {
    classification: [publicAudienceAtom],
    declassify: {
      confidentialityPre: [userAliceAtom],
      integrityPre: ["fact-check-proof"],
      addAlternatives: [publicAudienceAtom],
      addIntegrity: [factCheckedAtom, sourcesDisclosedAtom],
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

describe("CFC worked example: fact-check assurance", () => {
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

  it("adds structured confidentiality and integrity evidence through a pattern output rewrite", async () => {
    const source = await harness.seedLabeledValue({
      id: "fact-check-worked-example-source",
      schema: sourceSchema,
      value: "Claim text",
      labels: {
        classification: [userAliceAtom],
        integrity: ["fact-check-proof"],
      } satisfies Labels,
    });

    const factCheckPattern = harness.pattern(
      ({ source }) => ({
        text: harness.lift(sourceSchema, factCheckTextSchema, (value) => value)(
          source,
        ),
      }),
      factCheckInputSchema,
      factCheckOutputSchema,
    );
    const run = await harness.runPattern({
      id: "fact-check-worked-example-target",
      pattern: factCheckPattern,
      inputs: { source },
      outputSchema: factCheckOutputSchema,
      initialOutput: { text: "" },
      prepare: "cfc",
    });
    expect(await run.result.pull()).toEqual({ text: "Claim text" });

    await harness.restart();

    const publishedReport = harness.getCell<{ text: string }>(
      "fact-check-worked-example-target",
      factCheckOutputSchema,
    );
    const publishPattern = harness.pattern(
      ({ report }) => ({ text: report.text }),
      publishedFactCheckInputSchema,
      publishedFactCheckOutputSchema,
    );
    const publishedRun = await harness.runPattern({
      id: "fact-check-worked-example-published",
      pattern: publishPattern,
      inputs: { report: publishedReport },
      outputSchema: publishedFactCheckOutputSchema,
      initialOutput: { text: "" },
      prepare: "cfc",
    });
    expect(await publishedRun.result.pull()).toEqual({ text: "Claim text" });

    await harness.runtime.scheduler.idle();
    const publishedLabels = await harness.readLabels(
      publishedRun.outputLink.id,
    );
    expect(publishedLabels["/text"]?.label?.classification).toEqual([
      [publicAudienceAtom],
    ]);
  });
});
