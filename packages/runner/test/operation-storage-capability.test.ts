import { Identity } from "@commonfabric/identity";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
} from "@commonfabric/memory/v2/operation-codec";
import { toValuePath } from "@commonfabric/memory/v2";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { hasOperationStorageCapability } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("operation storage capability");

describe("operation storage capability", () => {
  it("exposes codec-neutral collaboration through a space replica", async () => {
    const storage = EmulatedStorageManager.emulate({ as: signer });
    const space = signer.did();

    try {
      const seed = storage.edit();
      expect(
        seed.write({
          space,
          id: "of:operation-storage",
          type: "application/json",
          path: [],
        }, { value: { body: "ac" } }).error,
      ).toBeUndefined();
      expect((await seed.commit()).error).toBeUndefined();

      const replica = storage.open(space).replica;
      expect(hasOperationStorageCapability(replica)).toBe(true);
      if (!hasOperationStorageCapability(replica)) return;

      expect(await replica.operationCodecs()).toContain(
        CODEMIRROR_CHANGESET_CODEC,
      );
      const initial = await replica.queryOperationField({
        id: "of:operation-storage",
        path: toValuePath(["body"]),
      });
      expect(initial).toMatchObject({ active: false, materialized: "ac" });

      const resolution = await replica.applyOperation({
        op: "apply-op",
        id: "of:operation-storage",
        path: toValuePath(["body"]),
        codec: CODEMIRROR_CHANGESET_CODEC,
        submissionId: "runner:1",
        base: null,
        baselineHash: operationBaselineHash("ac"),
        payload: {
          updates: [{
            clientId: "runner",
            changes: [1, [0, "b"], 1],
          }],
        },
      });

      expect(resolution).toMatchObject({
        from: { epoch: 1, version: 0 },
        to: { epoch: 1, version: 1 },
      });
      expect(
        await replica.queryOperationField({
          id: "of:operation-storage",
          path: toValuePath(["body"]),
          after: { epoch: 1, version: 0 },
        }),
      ).toMatchObject({
        active: true,
        cursor: { epoch: 1, version: 1 },
        materialized: "abc",
        operations: [{ opId: expect.stringMatching(/^op:/) }],
      });
    } finally {
      await storage.close();
    }
  });
});
