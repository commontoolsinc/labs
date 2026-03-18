import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { canonicalHash } from "@commontools/memory/canonical-hash";
import { storableFromNativeValue } from "@commontools/memory/storable-value";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
  toHex,
} from "../src/cfc/shared.ts";
import type { Labels, URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc policy state test");
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
  type: "number",
  ifc: {
    classification: [userAliceAtom],
  },
} as const satisfies JSONSchema;

function derivePolicyStateId(record: unknown): URI {
  const hash = canonicalHash(storableFromNativeValue(record));
  return `cfc:policy-state:${toHex(hash.hash)}` as URI;
}

function shareGrantSchema(resourceRef: string) {
  return {
    type: "number",
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

describe("CFC policyState guards", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function seedValueWithLabels(
    id: URI,
    value: unknown,
    labels: Labels,
  ): Promise<void> {
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["value"],
    }, value as never);
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": labels,
    });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  async function seedPolicyState(record: unknown): Promise<void> {
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id: derivePolicyStateId(record),
      type: "application/json",
      path: ["value"],
    }, record as never);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  async function readPersistedLabels(id: URI) {
    const readTx = runtime.edit();
    const raw = readTx.readOrThrow(cfcLabelsAddress({
      space,
      id,
      type: "application/json",
    }));
    await readTx.abort();
    return normalizePersistedLabels(raw);
  }

  it("allows a share-style declassification when a matching policyState grant exists", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-policy-state-share-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-policy-state-share-target",
      undefined,
      tx,
    );
    source.set(7);
    target.set(0);
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const sourceId = source.getAsNormalizedFullLink().id;
    await seedValueWithLabels(sourceId, 7, {
      classification: [userAliceAtom],
      integrity: [],
    });
    await seedPolicyState({
      kind: "ShareGrant",
      owner: space,
      resourceRef: sourceId,
      recipient: bobDid,
      scope: "read",
    });

    tx = runtime.edit();
    const value = Number(source.withTx(tx).asSchema(sourceSchema).get() ?? 0);
    target.withTx(tx).asSchema(shareGrantSchema(sourceId)).set(value + 1);

    await expect(prepareCfcCommitIfNeeded(tx)).resolves.toBeUndefined();
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const labels = await readPersistedLabels(target.getAsNormalizedFullLink().id);
    expect(labels["/"]?.classification).toEqual([[userAliceAtom, userBobAtom]]);
  });

  it("rejects a share-style declassification when the policyState grant is absent", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-policy-state-share-miss-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-policy-state-share-miss-target",
      undefined,
      tx,
    );
    source.set(8);
    target.set(0);
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    await seedValueWithLabels(source.getAsNormalizedFullLink().id, 8, {
      classification: [userAliceAtom],
      integrity: [],
    });

    tx = runtime.edit();
    const value = Number(source.withTx(tx).asSchema(sourceSchema).get() ?? 0);
    target.withTx(tx).asSchema(
      shareGrantSchema(source.getAsNormalizedFullLink().id),
    ).set(value + 1);

    await expect(prepareCfcCommitIfNeeded(tx)).rejects.toMatchObject({
      name: "CfcOutputTransitionViolationError",
      requirement: "confidentialityMonotonicity",
    });
  });
});
