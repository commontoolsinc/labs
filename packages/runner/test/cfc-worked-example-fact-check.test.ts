import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import type { JSONSchema } from "../src/builder/types.ts";
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

const factCheckOutputSchema = {
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

  it("adds structured confidentiality and integrity evidence through policy rewrite", async () => {
    const source = await harness.seedLabeledValue<string>({
      id: "fact-check-worked-example-source",
      labels: {
        classification: [userAliceAtom],
        integrity: ["fact-check-proof"],
      },
      schema: sourceSchema,
      value: "Claim text",
    });
    const factCheckPattern = harness.pattern<{ source: string }>(
      ({ source }: { source: string }) => source,
      {
        type: "object",
        properties: {
          source: sourceSchema,
        },
        required: ["source"],
      } as const satisfies JSONSchema,
      factCheckOutputSchema,
    );
    const { outputLink, value } = await harness.runPattern({
      id: "fact-check-worked-example-target",
      pattern: factCheckPattern,
      inputs: { source },
    });

    expect(value).toBe("Claim text");
    const labels = await harness.readLabels(outputLink.id);
    expect(labels["/"]?.classification).toEqual([[publicAudienceAtom]]);
    expect(labels["/"]?.integrity).toEqual(
      expect.arrayContaining([
        "fact-check-proof",
        factCheckedAtom,
        sourcesDisclosedAtom,
      ]),
    );
  });
});
