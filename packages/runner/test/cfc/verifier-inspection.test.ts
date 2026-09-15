import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../../src/builder/types.ts";
import { prepareBoundaryCommit } from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc-verifier-inspection");
const secret = "verifier-inspection-secret";
const intermediateSchema = {
  type: "object",
  ifc: { confidentiality: [secret] },
  properties: { value: { type: "string" } },
  required: ["value"],
} as const satisfies JSONSchema;
const closedSinkSchema = {
  type: "object",
  ifc: { maxConfidentiality: [] },
  properties: { value: { type: "string" } },
  required: ["value"],
} as const satisfies JSONSchema;

/** Exposes a backend with neither native nor journal write inspection. */
const withoutWriteInspection = (
  tx: IExtendedStorageTransaction,
): IExtendedStorageTransaction => {
  const raw = new Proxy(tx.tx, {
    get(target, property) {
      if (property === "getWriteAttemptLog") return undefined;
      if (property === "journal") {
        return {
          activity: () => {
            throw new Error("write inspection unavailable");
          },
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return new Proxy(tx, {
    get(target, property) {
      if (property === "tx") return raw;
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
};

describe("prepareBoundaryCommit()", () => {
  it("clears metadata reuse when write inspection is unavailable", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    try {
      const tx = runtime.edit();
      const intermediate = runtime.getCell(
        signer.did(),
        "inspection-a-intermediate",
        intermediateSchema,
        tx,
      );
      intermediate.set({ value: "derived" });
      runtime.getCell(
        signer.did(),
        "inspection-b-sink",
        closedSinkSchema,
        tx,
      ).set(intermediate);

      try {
        // .set() records the value and schema; target A's preparation persists
        // the confidential envelope. Target B must then re-read that envelope
        // instead of reusing the absent metadata cached while checking A.
        expect(tx.readOrThrow({
          ...intermediate.getAsNormalizedFullLink(),
          path: ["cfc"],
        })).toBeUndefined();
        const reasons = prepareBoundaryCommit(withoutWriteInspection(tx));
        expect(reasons.some((reason) => reason.includes("maxConfidentiality")))
          .toBe(true);
      } finally {
        tx.abort();
      }
    } finally {
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });
});
