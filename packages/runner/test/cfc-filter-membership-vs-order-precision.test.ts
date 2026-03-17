import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  deriveImplementationIdentity,
  encodeImplementationIdentity,
} from "../src/cfc/implementation-identity.ts";
import type { CfcTrustContext } from "../src/cfc/integrity-trust.ts";
import { recordFlowPrecisionOutputSource } from "../src/cfc/flow-precision.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import { recordCfcWriteSchemaContext } from "../src/cfc/schema-context.ts";
import { FLOW_TAINT_PRECISION_CONCEPT } from "../src/cfc/trust-lattice.ts";
import { Runtime } from "../src/runtime.ts";
import type { Labels, URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc filter membership vs order precision test",
);
const space = signer.did();

const filterItemSchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    flowPrecisionClaim: {
      concept: FLOW_TAINT_PRECISION_CONCEPT,
      sourceCollection: "/",
      claims: [
        { type: "ElementLocalExpansion" },
        { type: "StableRelativeOrder" },
      ],
    },
  },
} as const satisfies JSONSchema;

const filterResultSchema = {
  type: "array",
  items: filterItemSchema,
  ifc: {
    collection: {
      filteredFrom: "/",
    },
  },
} as const satisfies JSONSchema;

function createFlowPrecisionTrustContext(
  delegator: string,
  concrete: string,
): CfcTrustContext {
  return {
    delegations: [{
      delegator,
      verifier: "did:key:cfc-filter-flow-precision-verifier",
      scope: {
        concepts: [FLOW_TAINT_PRECISION_CONCEPT],
      },
    }],
    statements: [{
      verifier: "did:key:cfc-filter-flow-precision-verifier",
      concrete,
      concept: FLOW_TAINT_PRECISION_CONCEPT,
    }],
  };
}

describe("CFC filter membership vs order precision", () => {
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

  async function seedDocument(
    id: URI,
    value: unknown,
    labelsByPath?: Record<string, Labels>,
  ): Promise<void> {
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["value"],
    }, value as never);
    if (labelsByPath) {
      tx.writeOrThrow({
        space,
        id,
        type: "application/json",
        path: ["cfc", "labels"],
      }, labelsByPath);
    }
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  async function runPrepare(
    trusted: boolean,
  ): Promise<{ error: unknown; labels?: unknown }> {
    const sourceId = "cfc-filter-membership-source" as URI;
    const targetId = "cfc-filter-membership-target" as URI;
    await seedDocument(sourceId, [11, 22], {
      "/0": { classification: ["secret"] },
      "/1": { classification: ["confidential"] },
    });
    await seedDocument(targetId, []);

    const filterIdentity = deriveImplementationIdentity(
      runtime.moduleRegistry.getModule("filter"),
    );
    const tx = runtime.edit();
    tx.readValueOrThrow({
      space,
      id: sourceId,
      type: "application/json",
      path: ["0"],
    });
    const kept = tx.readValueOrThrow({
      space,
      id: sourceId,
      type: "application/json",
      path: ["1"],
    });
    tx.writeOrThrow({
      space,
      id: targetId,
      type: "application/json",
      path: ["value", "0"],
    }, kept);
    recordFlowPrecisionOutputSource(tx, {
      space,
      id: targetId,
      type: "application/json",
      path: ["value", "0"],
    }, {
      space,
      id: sourceId,
      type: "application/json",
      path: ["1"],
    });
    recordCfcWriteSchemaContext(tx, {
      space,
      id: targetId,
      type: "application/json",
      path: [],
    }, filterResultSchema);
    tx.markCfcRelevant("ifc-write-schema");

    let error: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx, {
        implementationIdentity: filterIdentity,
        actingPrincipal: trusted ? signer.did() : undefined,
        trustContext: trusted
          ? createFlowPrecisionTrustContext(
            signer.did(),
            encodeImplementationIdentity(filterIdentity),
          )
          : undefined,
      });
      const committed = await tx.commit();
      error = committed.error;
    } catch (thrown) {
      error = thrown;
      tx.abort(thrown);
    }

    if (error) {
      return { error };
    }

    const readTx = runtime.edit();
    const labels = readTx.readOrThrow({
      space,
      id: targetId,
      type: "application/json",
      path: ["cfc", "labels"],
    });
    readTx.abort();
    return { error: undefined, labels };
  }

  it("lets trusted Builtin(filter) keep item content local while container keeps structural taint", async () => {
    const result = await runPrepare(true);

    expect(result.error).toBeUndefined();
    expect(result.labels).toEqual({
      "/": { classification: [["secret"]] },
      "/*": { classification: [["confidential"]] },
    });
  });

  it("falls back conservative for untrusted Builtin(filter) claims", async () => {
    const result = await runPrepare(false);

    expect((result.error as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
  });
});
