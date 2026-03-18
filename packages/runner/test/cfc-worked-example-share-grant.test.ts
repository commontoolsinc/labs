import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import { deriveCfcPolicyStateId } from "../src/cfc/policy-state.ts";
import type { Labels } from "../src/storage/interface.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example share grant test",
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

function shareGrantSchema(resourceRef: string) {
  return {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
    },
    required: ["id", "title"],
    ifc: {
      declassify: {
        preCondition: {
          confidentiality: [{
            type: "https://commonfabric.org/cfc/atom/User",
            subject: { var: "$owner" },
          }],
        },
        guard: {
          policyState: [{
            kind: "ShareGrant",
            owner: { var: "$owner" },
            resourceRef,
            recipient: bobDid,
            scope: "read",
          }],
        },
        postCondition: {
          confidentiality: [
            {
              type: "https://commonfabric.org/cfc/atom/User",
              subject: { var: "$owner" },
            },
            userBobAtom,
          ],
        },
      },
    },
  } as const satisfies JSONSchema;
}

const shareGrantInputSchema = {
  type: "object",
  properties: {
    photo: sourceSchema,
  },
  required: ["photo"],
} as const satisfies JSONSchema;

describe("CFC worked example: durable share grant", () => {
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

  it("consults persisted ShareGrant policy state after a fresh runtime starts", async () => {
    const photo = await harness.seedLabeledValue({
      id: "worked-example-share-photo",
      schema: sourceSchema,
      value: {
        id: "photo-42",
        title: "Alice private photo",
      },
      labels: {
        classification: [userAliceAtom],
        integrity: [],
      } satisfies Labels,
    });
    const resourceRef = photo.getAsNormalizedFullLink().id;
    await harness.writeDocumentValue({
      space,
      id: deriveCfcPolicyStateId({
        kind: "ShareGrant",
        owner: space,
        resourceRef,
        recipient: bobDid,
        scope: "read",
      }),
      type: "application/json",
      path: ["value"],
    }, {
      kind: "ShareGrant",
      owner: space,
      resourceRef: photo.getAsNormalizedFullLink().id,
      recipient: bobDid,
      scope: "read",
    });

    await harness.restart();

    const persistedPhoto = harness.getCellFromEntityId<{
      id: string;
      title: string;
    }>(
      resourceRef,
      sourceSchema,
    );
    const sharedPhotoPattern = harness.pattern(
      ({ photo }) =>
        harness.lift(
          sourceSchema,
          shareGrantSchema(resourceRef),
          (value) => ({
            id: value.id,
            title: value.title,
          }),
        )(photo),
      shareGrantInputSchema,
      shareGrantSchema(resourceRef),
    );
    const run = await harness.runPattern({
      id: "worked-example-share-output",
      pattern: sharedPhotoPattern,
      inputs: { photo: persistedPhoto },
      outputSchema: shareGrantSchema(resourceRef),
      prepare: "cfc",
    });
    expect(await run.result.pull()).toEqual({
      id: "photo-42",
      title: "Alice private photo",
    });

    await harness.restart();

    const persistedSharedPhoto = harness.getCell<{
      id: string;
      title: string;
    }>(
      "worked-example-share-output",
      shareGrantSchema(resourceRef),
    );
    const labels = await harness.readEffectiveLabel(
      persistedSharedPhoto,
      shareGrantSchema(resourceRef),
    );
    expect(labels?.classification).toHaveLength(1);
    expect(labels?.classification?.[0]).toHaveLength(2);
    expect(labels?.classification?.[0]).toEqual(
      expect.arrayContaining([userAliceAtom, userBobAtom]),
    );
  });
});
