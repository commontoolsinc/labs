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
    await harness.writeDocumentValue({
      space,
      id: deriveCfcPolicyStateId({
        kind: "ShareGrant",
        owner: space,
        resourceRef: photo.getAsNormalizedFullLink().id,
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

    const sharedPhoto = await harness.withCommittedEdit((tx) => {
      const persistedPhoto = harness.getCellFromEntityId<{
        id: string;
        title: string;
      }>(
        photo.getAsNormalizedFullLink().id,
        sourceSchema,
        tx,
      );
      const persistedSharedPhoto = harness.getCell<{
        id: string;
        title: string;
      }>(
        "worked-example-share-output",
        undefined,
        tx,
      );
      const value = persistedPhoto.withTx(tx).asSchema(sourceSchema).get();
      persistedSharedPhoto.withTx(tx).asSchema(
        shareGrantSchema(photo.getAsNormalizedFullLink().id),
      ).set(value);
      return persistedSharedPhoto;
    }, {
      prepare: "cfc",
    });

    const labels = await harness.readLabels(
      sharedPhoto.getAsNormalizedFullLink().id,
    );
    expect(labels["/"]?.classification).toEqual([[userBobAtom, userAliceAtom]]);
  });
});
