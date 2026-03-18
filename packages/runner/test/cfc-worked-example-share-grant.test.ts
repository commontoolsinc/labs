import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
} from "../src/cfc/shared.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import { deriveCfcPolicyStateId } from "../src/cfc/policy-state.ts";
import type {
  IExtendedStorageTransaction,
  Labels,
} from "../src/storage/interface.ts";

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

  it("consults persisted ShareGrant policy state after a fresh runtime starts", async () => {
    const photo = runtime.getCell<{ id: string; title: string }>(
      space,
      "worked-example-share-photo",
      undefined,
      tx,
    );
    const sharedPhoto = runtime.getCell<{ id: string; title: string }>(
      space,
      "worked-example-share-output",
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

    tx = runtime.edit();
    tx.writeOrThrow({
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
      shareGrantSchema(photo.getAsNormalizedFullLink().id),
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
