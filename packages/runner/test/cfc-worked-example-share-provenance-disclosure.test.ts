import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { createCfcIntentEventEnvelope } from "../src/cfc/intent-event.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
} from "../src/cfc/shared.ts";
import { deriveCfcPolicyStateId } from "../src/cfc/policy-state.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import {
  deriveCfcShareGrantFromIntent,
  deriveCfcShareGrantPolicyKey,
} from "../src/cfc/share-grant-intent.ts";
import type {
  IExtendedStorageTransaction,
  Labels,
} from "../src/storage/interface.ts";

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
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let phaseOneRuntime: Runtime | undefined;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    if (phaseOneRuntime && phaseOneRuntime !== runtime) {
      phaseOneRuntime.runner.stopAll();
      phaseOneRuntime.moduleRegistry.clear();
      phaseOneRuntime.scheduler.dispose();
      phaseOneRuntime.harness.dispose();
      phaseOneRuntime = undefined;
    }
    await tx.abort();
    await runtime.dispose();
  });

  async function readPersistedLabels(id: string) {
    const readTx = runtime.edit();
    const raw = readTx.readOrThrow(cfcLabelsAddress({
      space,
      id: id as `${string}:${string}`,
      type: "application/json",
    }));
    await readTx.abort();
    return normalizePersistedLabels(raw);
  }

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
    const photo = runtime.getCell<{ id: string; title: string }>(
      space,
      "worked-example-share-provenance-photo",
      undefined,
      tx,
    );
    const sharedPhoto = runtime.getCell<{ id: string; title: string }>(
      space,
      "worked-example-share-provenance-output",
      undefined,
      tx,
    );
    photo.set({
      id: "photo-42",
      title: "Alice private photo",
    });
    tx.writeOrThrow(
      cfcLabelsAddress({
        space,
        id: photo.getAsNormalizedFullLink().id,
        type: "application/json",
      }),
      {
        "/": {
          classification: [userAliceAtom],
          integrity: [],
        } satisfies Labels,
      },
    );
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

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

    tx = runtime.edit();
    const persistedShareGrant = { ...shareGrant };
    const policyKey = deriveCfcShareGrantPolicyKey(shareGrant);
    tx.writeOrThrow({
      space,
      id: deriveCfcPolicyStateId(policyKey),
      type: "application/json",
      path: ["value"],
    }, persistedShareGrant);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    phaseOneRuntime = runtime;
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();

    const persistedPhoto = runtime.getCellFromEntityId<{
      id: string;
      title: string;
    }>(
      space,
      photo.getAsNormalizedFullLink().id,
      [],
      sourceSchema,
      tx,
    );
    const persistedSharedPhoto = runtime.getCellFromEntityId<{
      id: string;
      title: string;
    }>(
      space,
      sharedPhoto.getAsNormalizedFullLink().id,
      [],
      undefined,
      tx,
    );
    const value = persistedPhoto.withTx(tx).asSchema(sourceSchema).get();
    persistedSharedPhoto.withTx(tx).asSchema(
      shareGrantSchema(resourceRef),
    ).set(value);

    await prepareCfcCommitIfNeeded(tx);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const labels = await readPersistedLabels(
      persistedSharedPhoto.getAsNormalizedFullLink().id,
    );
    expect(labels["/"]?.classification).toEqual([[userBobAtom, userAliceAtom]]);
  });
});
