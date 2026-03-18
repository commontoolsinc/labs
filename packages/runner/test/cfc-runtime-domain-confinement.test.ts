import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare-engine.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
} from "../src/cfc/shared.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type {
  CfcConfidentialityLabel,
  CfcIntegrityLabel,
} from "../src/cfc/label-algebra.ts";
import type { Labels } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc runtime domain confinement test",
);
const space = signer.did();

const userAliceAtom = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: space,
} as const;

const alicePhoneDeviceAtom = {
  type: "https://commonfabric.org/cfc/atom/DeviceIdentity",
  device: "did:key:alice-phone-1",
} as const;

const tabletDeviceAtom = {
  type: "https://commonfabric.org/cfc/atom/DeviceIdentity",
  device: "did:key:alice-tablet-1",
} as const;

const runtimeProfileAtom = {
  type: "https://commonfabric.org/cfc/atom/RuntimeProfile",
  profile: "calendar-intersection-v1",
} as const;

const runtimeTeeAtom = {
  type: "https://commonfabric.org/cfc/atom/RuntimeTEE",
  tee: "approved-tee-class",
} as const;

const runtimeProviderAtom = {
  type: "https://commonfabric.org/cfc/atom/RuntimeProvider",
  provider: "approved-provider",
} as const;

const runtimeImageAtom = {
  type: "https://commonfabric.org/cfc/atom/RuntimeImage",
  imageHash: "sha256:approved-image",
} as const;

const promptInfluenceCaveatAtom = {
  type: "https://commonfabric.org/cfc/atom/Caveat",
  kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
} as const;

function exactCopySchema(classification: CfcConfidentialityLabel) {
  return {
    type: "string",
    ifc: {
      classification,
    },
  } as const satisfies JSONSchema;
}

describe("CFC runtime domain confinement", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let executionIntegrity: CfcIntegrityLabel | undefined;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    executionIntegrity = undefined;
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
      cfcExecutionIntegrity: () => executionIntegrity,
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function seedSource(
    id: `${string}:${string}`,
    value: string,
    labels: Record<string, Labels>,
  ) {
    const tx = runtime.edit();
    const cell = runtime.getCell<string>(space, id, undefined, tx);
    cell.set(value);
    tx.writeOrThrow(
      cfcLabelsAddress({
        space,
        id: cell.getAsNormalizedFullLink().id,
        type: "application/json",
      }),
      labels,
    );
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();
    return cell;
  }

  async function readPersistedLabels(id: `${string}:${string}`) {
    const tx = runtime.edit();
    const raw = tx.readOrThrow(cfcLabelsAddress({
      space,
      id,
      type: "application/json",
    }));
    await tx.abort();
    return normalizePersistedLabels(raw);
  }

  it("rejects exact-copy writes of device-locked data on a different device", async () => {
    const source = await seedSource(
      "runtime:device-source",
      "09:00-10:00",
      {
        "/": {
          classification: [[userAliceAtom], [alicePhoneDeviceAtom]],
        },
      },
    );

    executionIntegrity = [tabletDeviceAtom];

    const tx = runtime.edit();
    const target = runtime.getCell<string>(
      space,
      "runtime:device-target",
      undefined,
      tx,
    );
    target.withTx(tx).asSchema(
      exactCopySchema([[userAliceAtom], [alicePhoneDeviceAtom]]),
    ).set(source.withTx(tx).get() ?? "");

    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: space }),
    ).rejects.toMatchObject({
      name: "CfcOutputTransitionViolationError",
      requirement: "runtimeConfinement",
    });
    await tx.abort();
  });

  it("allows exact-copy writes of device-locked data on the enrolled device", async () => {
    const source = await seedSource(
      "runtime:device-source-pass",
      "09:00-10:00",
      {
        "/": {
          classification: [[userAliceAtom], [alicePhoneDeviceAtom]],
        },
      },
    );

    executionIntegrity = [alicePhoneDeviceAtom];

    const tx = runtime.edit();
    const target = runtime.getCell<string>(
      space,
      "runtime:device-target-pass",
      undefined,
      tx,
    );
    target.withTx(tx).asSchema(
      exactCopySchema([[userAliceAtom], [alicePhoneDeviceAtom]]),
    ).set(source.withTx(tx).get() ?? "");

    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: space }),
    ).resolves.toBeUndefined();
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const labels = await readPersistedLabels(target.getAsNormalizedFullLink().id);
    expect(labels["/"]?.classification).toEqual([
      [userAliceAtom],
      [alicePhoneDeviceAtom],
    ]);
  });

  it("rejects exact-copy writes of shared-CC-locked data outside the approved runtime", async () => {
    const source = await seedSource(
      "runtime:cc-source",
      "calendar-secret",
      {
        "/": {
          classification: [
            [userAliceAtom],
            [runtimeProfileAtom],
            [runtimeTeeAtom],
            [runtimeProviderAtom],
            [runtimeImageAtom],
          ],
        },
      },
    );

    executionIntegrity = [
      runtimeProfileAtom,
      runtimeTeeAtom,
      runtimeProviderAtom,
    ];

    const tx = runtime.edit();
    const target = runtime.getCell<string>(
      space,
      "runtime:cc-target",
      undefined,
      tx,
    );
    target.withTx(tx).asSchema(
      exactCopySchema([
        [userAliceAtom],
        [runtimeProfileAtom],
        [runtimeTeeAtom],
        [runtimeProviderAtom],
        [runtimeImageAtom],
      ]),
    ).set(source.withTx(tx).get() ?? "");

    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: space }),
    ).rejects.toMatchObject({
      name: "CfcOutputTransitionViolationError",
      requirement: "runtimeConfinement",
    });
    await tx.abort();
  });

  it("does not treat ordinary caveat clauses as runtime confinement", async () => {
    const source = await seedSource(
      "runtime:caveat-source",
      "report draft",
      {
        "/": {
          classification: [[userAliceAtom], [promptInfluenceCaveatAtom]],
        },
      },
    );

    const tx = runtime.edit();
    const target = runtime.getCell<string>(
      space,
      "runtime:caveat-target",
      undefined,
      tx,
    );
    target.withTx(tx).asSchema(
      exactCopySchema([[userAliceAtom], [promptInfluenceCaveatAtom]]),
    ).set(source.withTx(tx).get() ?? "");

    await expect(
      prepareBoundaryCommit(tx, { actingPrincipal: space }),
    ).resolves.toBeUndefined();
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();
  });
});
