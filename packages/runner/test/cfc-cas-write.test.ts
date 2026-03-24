import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareBoundaryCommit } from "../src/cfc/prepare-engine.ts";
import {
  cfcLabelsAddress,
  normalizePersistedLabels,
  resolveObservationLabel,
} from "../src/cfc/shared.ts";
import {
  cfcCasLabelBindingsAddress,
  readCfcCasBlob,
  writeCfcCasBlob,
  writeCfcCasBlobFromPreparedPath,
  writeCfcCasBlobWithBoundary,
} from "../src/cfc/cas-storage.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("cfc cas write test");
const space = signer.did();

const aliceLabel = {
  classification: [[{
    type: "https://commonfabric.org/cfc/atom/User",
    subject: space,
  }]],
} as const;

const attestedLabel = {
  classification: [[{
    type: "https://commonfabric.org/cfc/atom/User",
    subject: space,
  }]],
  integrity: [{
    type: "https://commonfabric.org/cfc/atom/RuntimeProfile",
    profile: "approved-profile",
  }],
} as const;

const attestedLabelReordered = {
  integrity: [{
    profile: "approved-profile",
    type: "https://commonfabric.org/cfc/atom/RuntimeProfile",
  }],
  classification: [[{
    subject: space,
    type: "https://commonfabric.org/cfc/atom/User",
  }]],
} as const;

const preparedSourceSchema = {
  type: "object",
  properties: {
    secret: {
      type: "string",
      ifc: {
        classification: [[{
          type: "https://commonfabric.org/cfc/atom/User",
          subject: space,
        }]],
      },
    },
  },
} as const satisfies JSONSchema;

describe("CFC direct CAS write substrate", () => {
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

  it("stores immutable bytes by blob hash and records the first binding", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);

    const tx = runtime.edit();
    const { blobHash } = writeCfcCasBlob(tx, space, payload, aliceLabel);
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const verifyTx = runtime.edit();
    const storedPayload = readCfcCasBlob(verifyTx, space, blobHash);
    const storedBindings = verifyTx.readOrThrow(
      cfcCasLabelBindingsAddress(space, blobHash),
    );
    await verifyTx.abort();

    expect(Array.from(storedPayload as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(storedBindings).toEqual({
      blobHash,
      bindings: [{ label: aliceLabel }],
    });
  });

  it("appends a second binding for the same bytes without changing the payload", async () => {
    const payload = new Uint8Array([9, 8, 7, 6]);

    let tx = runtime.edit();
    const first = writeCfcCasBlob(tx, space, payload, aliceLabel);
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    const second = writeCfcCasBlob(tx, space, payload, attestedLabel);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();
    expect(second.blobHash).toBe(first.blobHash);

    const verifyTx = runtime.edit();
    const storedPayload = readCfcCasBlob(verifyTx, space, first.blobHash);
    const storedBindings = verifyTx.readOrThrow(
      cfcCasLabelBindingsAddress(space, first.blobHash),
    ) as {
      blobHash: string;
      bindings: Array<{ label: unknown }>;
    };
    await verifyTx.abort();

    expect(Array.from(storedPayload as Uint8Array)).toEqual([9, 8, 7, 6]);
    expect(storedBindings.blobHash).toBe(first.blobHash);
    expect(storedBindings.bindings).toEqual([
      { label: aliceLabel },
      { label: attestedLabel },
    ]);
  });

  it("does not append duplicate bindings for the same bytes and label", async () => {
    const payload = new Uint8Array([5, 5, 5, 5]);

    let tx = runtime.edit();
    const { blobHash } = writeCfcCasBlob(tx, space, payload, attestedLabel);
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    writeCfcCasBlob(tx, space, payload, attestedLabel);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const verifyTx = runtime.edit();
    const storedBindings = verifyTx.readOrThrow(
      cfcCasLabelBindingsAddress(space, blobHash),
    ) as {
      blobHash: string;
      bindings: Array<{ label: unknown }>;
    };
    await verifyTx.abort();

    expect(storedBindings.bindings).toEqual([{ label: attestedLabel }]);
  });

  it("does not append duplicate bindings when the same label arrives with reordered atom keys", async () => {
    const payload = new Uint8Array([6, 6, 6, 6]);

    let tx = runtime.edit();
    const { blobHash } = writeCfcCasBlob(tx, space, payload, attestedLabel);
    let committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    tx = runtime.edit();
    writeCfcCasBlob(tx, space, payload, attestedLabelReordered);
    committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const verifyTx = runtime.edit();
    const storedBindings = verifyTx.readOrThrow(
      cfcCasLabelBindingsAddress(space, blobHash),
    ) as {
      blobHash: string;
      bindings: Array<{ label: unknown }>;
    };
    await verifyTx.abort();

    expect(storedBindings.bindings).toEqual([{ label: attestedLabel }]);
  });

  it("appends the trusted boundary's effective label rather than the caller proposal", async () => {
    const payload = new Uint8Array([2, 4, 6, 8]);
    const elevatedLabel = {
      classification: [[{
        type: "https://commonfabric.org/cfc/atom/User",
        subject: "did:example:reviewer",
      }]],
      integrity: [{
        type: "https://commonfabric.org/cfc/atom/RuntimeProfile",
        profile: "boundary-approved",
      }],
    } as const;

    const tx = runtime.edit();
    const { blobHash } = await writeCfcCasBlobWithBoundary(tx, {
      space,
      payload,
      proposedLabel: aliceLabel,
      evaluateEffectiveLabel: () => Promise.resolve(elevatedLabel),
    });
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const verifyTx = runtime.edit();
    const storedBindings = verifyTx.readOrThrow(
      cfcCasLabelBindingsAddress(space, blobHash),
    ) as {
      blobHash: string;
      bindings: Array<{ label: unknown }>;
    };
    await verifyTx.abort();

    expect(storedBindings.bindings).toEqual([{ label: elevatedLabel }]);
  });

  it("does not write blob or label bindings when trusted boundary evaluation rejects", async () => {
    const payload = new Uint8Array([3, 1, 4, 1]);
    const boundaryError = new Error("cfc policy rejected");

    const tx = runtime.edit();
    await expect(
      writeCfcCasBlobWithBoundary(tx, {
        space,
        payload,
        proposedLabel: aliceLabel,
        evaluateEffectiveLabel: () => {
          throw boundaryError;
        },
      }),
    ).rejects.toBe(boundaryError);
    await tx.abort();

    const verifyTx = runtime.edit();
    const { blobHash: computedBlobHash } = writeCfcCasBlob(
      verifyTx,
      space,
      payload,
      aliceLabel,
    );
    await verifyTx.abort();

    const readTx = runtime.edit();
    const storedPayload = readCfcCasBlob(readTx, space, computedBlobHash);
    const storedBindings = readTx.readOrThrow(
      cfcCasLabelBindingsAddress(space, computedBlobHash),
    );
    await readTx.abort();

    expect(storedPayload).toBeUndefined();
    expect(storedBindings).toBeUndefined();
  });

  it("can source the CAS binding label from prepared cfc.labels metadata", async () => {
    const tx = runtime.edit();
    const cell = runtime.getCell<{ secret: string }>(
      space,
      "cfc-cas-from-prepared-labels",
      preparedSourceSchema,
      tx,
    );
    const link = cell.getAsNormalizedFullLink();
    cell.set({ secret: "top secret" });

    await prepareBoundaryCommit(tx);

    const preparedLabels = normalizePersistedLabels(
      tx.readOrThrow(cfcLabelsAddress(link)),
    );
    expect(
      resolveObservationLabel(preparedLabels, "/secret", "value"),
    ).toEqual(aliceLabel);

    const { blobHash } = writeCfcCasBlobFromPreparedPath(tx, {
      space,
      payload: new TextEncoder().encode("top secret"),
      source: link,
      sourcePath: "/secret",
    });
    const committed = await tx.commit();
    expect(committed.error).toBeUndefined();

    const verifyTx = runtime.edit();
    const storedBindings = verifyTx.readOrThrow(
      cfcCasLabelBindingsAddress(space, blobHash),
    ) as {
      blobHash: string;
      bindings: Array<{ label: unknown }>;
    };
    await verifyTx.abort();

    expect(storedBindings.bindings).toEqual([{ label: aliceLabel }]);
  });
});
