import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { wishStateSchemaForResult } from "../src/builtins/wish-schema.ts";
import { Runtime } from "../src/runtime.ts";
import { validateAndTransformResult } from "../src/schema.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isInternalVerifierRead } from "../src/storage/reactivity-log.ts";
import { InvalidDataURIError } from "../src/storage/transaction/attestation.ts";
import {
  assertValidUnavailableInputPolicy,
} from "../src/unavailable-input-policy.ts";

const signer = await Identity.fromPassphrase(
  "availability schema support coverage",
);
const space = signer.did();

describe("availability schema support coverage", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  });

  it("rejects availability policy entries with missing or extra keys", () => {
    for (
      const policy of [
        [{ path: [] }],
        [{ path: [], reasons: ["pending"], extra: true }],
      ]
    ) {
      expect(() => assertValidUnavailableInputPolicy(policy)).toThrow(
        /must contain only path and reasons/,
      );
    }
  });

  it("wraps boolean wish result schemas as cells", () => {
    expect(wishStateSchemaForResult(true)).toMatchObject({
      properties: {
        result: {
          anyOf: [
            { type: "undefined" },
            { asCell: ["cell"] },
          ],
        },
        candidates: {
          items: { asCell: ["cell"] },
        },
      },
    });
  });

  it("uses a fallback error when linked synchronization has no detail", () => {
    const source = runtime.getCell(space, "missing-link-source", undefined, tx);
    const target = runtime.getCell<number>(
      space,
      "missing-link-target",
      { type: "number" },
      tx,
    );
    source.setRaw(target.getAsLink());

    runtime.ensureLinkedDocLoaded = (_link) => "error";
    runtime.linkedDocLoadError = (_link) => undefined;

    const result = validateAndTransformResult(runtime, tx, {
      ...source.getAsNormalizedFullLink(),
      schema: { type: "number" },
    });

    expect(result).toMatchObject({
      unavailableReason: "error",
      unavailableError: new Error("Linked document synchronization failed"),
    });
  });

  it("throws unexpected storage errors from the verifier read", () => {
    const source = runtime.getCell<number>(
      space,
      "unexpected-read-error",
      { type: "number" },
      tx,
    );
    source.set(42);

    const originalRead = tx.read.bind(tx);
    tx.read = ((address, options) => {
      if (isInternalVerifierRead(options?.meta)) {
        return { error: InvalidDataURIError("unexpected verifier failure") };
      }
      return originalRead(address, options);
    }) as IExtendedStorageTransaction["read"];

    expect(() =>
      validateAndTransformResult(
        runtime,
        tx,
        source.getAsNormalizedFullLink(),
      )
    ).toThrow(/unexpected verifier failure/);
  });
});
