import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import type { JSONSchema } from "../src/builder/types.ts";
import { deriveCfcPolicyStateId } from "../src/cfc/policy-state.ts";
import {
  deriveCfcShareGrantFromIntent,
  deriveCfcShareGrantPolicyKey,
} from "../src/cfc/share-grant-intent.ts";
import type { Labels } from "../src/storage/interface.ts";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import { createCfcPatternTestHarness } from "./helpers/cfc-pattern-harness.ts";

const signer = await Identity.fromPassphrase(
  "cfc worked example share provenance disclosure test",
);
const space = signer.did();
const bobDid = "did:key:bob-share-provenance";

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

function createShareIntent(
  resourceRef: string,
  additionalIntegrity: readonly unknown[] = [],
) {
  return createCfcIntentEventEnvelope({
    action: "ShareWithUser",
    sourceGestureId: "gesture-share-photo-42",
    conditionHash: "Cond.ShareClicked",
    parameters: {
      owner: space,
      resourceRef,
      recipient: bobDid,
      scope: "read",
    },
    integrity: [
      {
        type: "https://commonfabric.org/cfc/atom/GestureProvenance",
        renderRef: { seq: 88, rootRef: { space: "share-ui", id: "render-88" } },
        snapshot: "share-ui-snapshot",
        targetPath: "/children/5",
      },
      {
        type: "https://commonfabric.org/cfc/atom/IntentSurfaceTrusted",
        action: "ShareWithUser",
      },
      ...additionalIntegrity,
    ],
  });
}

describe("CFC worked example: provenance disclosure before sharing", () => {
  let harness: ReturnType<typeof createCfcPatternTestHarness>;

  beforeEach(() => {
    harness = createCfcPatternTestHarness({
      signer,
      apiUrl: new URL(import.meta.url),
      disablePullMode: true,
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it("refuses to mint a durable ShareGrant when disclosure evidence is missing", () => {
    const shareIntent = createShareIntent(
      "worked-example-share-provenance-photo",
    );
    const shareGrant = deriveCfcShareGrantFromIntent(shareIntent, {
      owner: space,
      resourceRef: "worked-example-share-provenance-photo",
      recipient: bobDid,
      scope: "read",
      grantedAt: 123,
    });

    expect(shareGrant).toBeNull();
  });

  it("persists a disclosed ShareGrant and authorizes the later shared read after restart", async () => {
    const photo = await harness.seedLabeledValue({
      id: "worked-example-share-provenance-photo",
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
    const shareIntent = createShareIntent(resourceRef, [
      {
        type: "https://commonfabric.org/cfc/atom/DisclosureRendered",
        kind: "SelectionInfluence",
        resourceRef,
        recipient: bobDid,
      },
      {
        type: "https://commonfabric.org/cfc/atom/DisclosureRendered",
        kind: "SelectionNotShared",
        resourceRef,
        recipient: bobDid,
      },
    ]);
    const shareGrant = deriveCfcShareGrantFromIntent(shareIntent, {
      owner: space,
      resourceRef,
      recipient: bobDid,
      scope: "read",
      grantedAt: 456,
    });
    expect(shareGrant).not.toBeNull();
    if (shareGrant === null) {
      throw new Error("Expected share grant to be derived");
    }

    const policyKey = deriveCfcShareGrantPolicyKey(shareGrant);
    await harness.writeDocumentValue({
      space,
      id: deriveCfcPolicyStateId(policyKey),
      type: "application/json",
      path: ["value"],
    }, { ...shareGrant });

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
      id: "worked-example-share-provenance-output",
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
      "worked-example-share-provenance-output",
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
