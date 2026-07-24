import type { ActionClaimKey } from "@commonfabric/memory/v2";
import { expect } from "@std/expect";
import {
  schedulerIdentityKeyForAction,
  schedulerIdentityKeyForStaleReader,
} from "../src/executor/scheduler-wake-identity.ts";

const claimKey: ActionClaimKey = {
  branch: "main",
  space: "did:key:space",
  contextKey: "space",
  pieceId: "piece",
  actionId: "action",
  actionKind: "computation",
  implementationFingerprint: "implementation",
  runtimeFingerprint: "runtime",
};

Deno.test(
  "claim identity resolves a stale reader when action owner space is absent",
  () => {
    const action = Object.assign(() => undefined, {
      schedulerObservationIdentity: {
        pieceId: claimKey.pieceId,
        processGeneration: 3,
      },
    });

    expect(schedulerIdentityKeyForAction(action, claimKey)).toBe(
      schedulerIdentityKeyForStaleReader({
        branch: claimKey.branch,
        ownerSpace: claimKey.space,
        pieceId: claimKey.pieceId,
        processGeneration: 3,
        actionId: claimKey.actionId,
        executionContextKey: claimKey.contextKey,
      }),
    );
  },
);

Deno.test("claim identity defaults an absent process generation to zero", () => {
  expect(schedulerIdentityKeyForAction(() => undefined, claimKey)).toBe(
    schedulerIdentityKeyForStaleReader({
      branch: claimKey.branch,
      ownerSpace: claimKey.space,
      pieceId: claimKey.pieceId,
      processGeneration: 0,
      actionId: claimKey.actionId,
      executionContextKey: claimKey.contextKey,
    }),
  );
});
