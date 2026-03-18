import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Labels } from "../src/storage/interface.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc pattern root policy rewrite test",
);
const space = signer.did();
const bobDid = "did:key:bob-share-recipient";

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const userBobAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: bobDid,
} as const;

const sourceSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
  },
  required: ["id", "title"],
  ifc: {
    classification: [userAliceAtom],
  },
} as const satisfies JSONSchema;

const copyInputSchema = {
  type: "object",
  properties: {
    source: sourceSchema,
  },
  required: ["source"],
} as const satisfies JSONSchema;

const sharedObjectSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
  },
  required: ["id", "title"],
  ifc: {
    declassify: {
      confidentialityPre: [userAliceAtom],
      integrityPre: ["proof-token"],
      addAlternatives: [userBobAtom],
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

describe("CFC pattern root policy rewrites", () => {
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

  it("applies a root object declassify rewrite to descendant writes of a materializing lift", async () => {
    const source = await harness.seedLabeledValue({
      id: "cfc-pattern-root-policy-source",
      schema: sourceSchema,
      value: {
        id: "photo-42",
        title: "Alice private photo",
      },
      labels: {
        classification: [userAliceAtom],
        integrity: ["proof-token"],
      } satisfies Labels,
    });

    const copyPattern = harness.pattern(
      ({ source }) =>
        harness.lift(
          sourceSchema,
          sharedObjectSchema,
          (value) => ({
            id: value.id,
            title: value.title,
          }),
        )(source),
      copyInputSchema,
      sharedObjectSchema,
    );

    const run = await harness.runPattern({
      id: "cfc-pattern-root-policy-result",
      pattern: copyPattern,
      inputs: { source },
      outputSchema: sharedObjectSchema,
      prepare: "cfc",
    });

    expect(await run.result.pull()).toEqual({
      id: "photo-42",
      title: "Alice private photo",
    });

    await harness.restart();

    const persisted = harness.getCell<{
      id: string;
      title: string;
    }>(
      "cfc-pattern-root-policy-result",
      sharedObjectSchema,
    );
    const labels = await harness.readEffectiveLabel(
      persisted,
      sharedObjectSchema,
    );

    expect(labels?.classification).toHaveLength(1);
    expect(labels?.classification?.[0]).toHaveLength(2);
    expect(labels?.classification?.[0]).toEqual(
      expect.arrayContaining([userAliceAtom, userBobAtom]),
    );
  });
});
