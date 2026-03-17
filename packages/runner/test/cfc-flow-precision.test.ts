import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { lift } from "../src/builder/module.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  deriveImplementationIdentity,
  encodeImplementationIdentity,
} from "../src/cfc/implementation-identity.ts";
import type { CfcImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import type { CfcTrustContext } from "../src/cfc/integrity-trust.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import { recordCfcWriteSchemaContext } from "../src/cfc/schema-context.ts";
import {
  FLOW_TAINT_PRECISION_CONCEPT,
  isImplementationTrustedForConcept,
} from "../src/cfc/trust-lattice.ts";
import { Runtime } from "../src/runtime.ts";
import type { Labels, URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("cfc flow precision test");
const space = signer.did();

const flowPrecisionIfc = {
  flowPrecisionClaim: {
    concept: FLOW_TAINT_PRECISION_CONCEPT,
    sourceCollection: "/",
    claims: [
      { type: "KeyLocalShapePreserved" },
      { type: "KeyLocalWriteDependency" },
    ],
  },
} as const;

const malformedFlowPrecisionIfc = {
  flowPrecisionClaim: {
    concept: FLOW_TAINT_PRECISION_CONCEPT,
    sourceCollection: "/",
    claims: [{ type: "KeyLocalShapePreserved" }],
  },
} as const;

const pointwiseFlowPrecisionIfc = {
  flowPrecisionClaim: {
    concept: FLOW_TAINT_PRECISION_CONCEPT,
    sourceCollection: "/",
    claims: [
      { type: "PointwisePresencePreserved" },
      { type: "PointwiseWriteDependency" },
    ],
  },
} as const;

const confidentialFlowPrecisionItemSchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    ...flowPrecisionIfc,
  },
} as const satisfies JSONSchema;

const malformedFlowPrecisionItemSchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    ...malformedFlowPrecisionIfc,
  },
} as const satisfies JSONSchema;

const pointwiseFlowPrecisionItemSchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    ...pointwiseFlowPrecisionIfc,
  },
} as const satisfies JSONSchema;

function createFlowPrecisionTrustContext(
  delegator: string,
  concrete: string,
): CfcTrustContext {
  return {
    delegations: [{
      delegator,
      verifier: "did:key:cfc-flow-precision-verifier",
      scope: {
        concepts: [FLOW_TAINT_PRECISION_CONCEPT],
      },
    }],
    statements: [{
      verifier: "did:key:cfc-flow-precision-verifier",
      concrete,
      concept: FLOW_TAINT_PRECISION_CONCEPT,
    }],
  };
}

describe("CFC flow precision", () => {
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

  async function runFlowPrecisionPrepare(
    options: {
      readonly sourceId: URI;
      readonly targetId: URI;
      readonly itemSchema: JSONSchema;
      readonly implementationIdentity?: CfcImplementationIdentity;
      readonly actingPrincipal?: string;
      readonly trustContext?: CfcTrustContext;
    },
  ): Promise<unknown> {
    const tx = runtime.edit();
    tx.readValueOrThrow({
      space,
      id: options.sourceId,
      type: "application/json",
      path: ["0"],
    });
    const sourceValue = tx.readValueOrThrow({
      space,
      id: options.sourceId,
      type: "application/json",
      path: ["1"],
    });
    tx.writeOrThrow({
      space,
      id: options.targetId,
      type: "application/json",
      path: ["value", "1"],
    }, sourceValue);
    recordCfcWriteSchemaContext(tx, {
      space,
      id: options.targetId,
      type: "application/json",
      path: ["1"],
    }, options.itemSchema);
    tx.markCfcRelevant("ifc-write-schema");

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx, {
        implementationIdentity: options.implementationIdentity,
        actingPrincipal: options.actingPrincipal,
        trustContext: options.trustContext,
      });
      const { error } = await tx.commit();
      thrown = error;
    } catch (error) {
      thrown = error;
      tx.abort(error);
    }

    return thrown;
  }

  it("falls back to conservative flow when less-restrictive claim is untrusted", async () => {
    const sourceId = "cfc-flow-precision-untrusted-source" as URI;
    const targetId = "cfc-flow-precision-untrusted-target" as URI;
    await seedDocument(sourceId, [11, 22], {
      "/0": { classification: ["secret"] },
      "/1": { classification: ["confidential"] },
    });
    await seedDocument(targetId, [0, 0]);

    const thrown = await runFlowPrecisionPrepare({
      sourceId,
      targetId,
      itemSchema: confidentialFlowPrecisionItemSchema,
    });

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("confidentialityMonotonicity");
  });

  it("uses trusted Builtin(map) flow precision when claim is less restrictive", async () => {
    const sourceId = "cfc-flow-precision-trusted-source" as URI;
    const targetId = "cfc-flow-precision-trusted-target" as URI;
    const implementationIdentity = deriveImplementationIdentity(
      runtime.moduleRegistry.getModule("map"),
    );
    await seedDocument(sourceId, [11, 22], {
      "/0": { classification: ["secret"] },
      "/1": { classification: ["confidential"] },
    });
    await seedDocument(targetId, [0, 0]);

    const thrown = await runFlowPrecisionPrepare({
      sourceId,
      targetId,
      itemSchema: confidentialFlowPrecisionItemSchema,
      implementationIdentity,
      actingPrincipal: signer.did(),
      trustContext: createFlowPrecisionTrustContext(
        signer.did(),
        encodeImplementationIdentity(implementationIdentity),
      ),
    });

    expect(thrown).toBeUndefined();
  });

  it("falls back to conservative flow when Builtin(map) has no trusted statement", async () => {
    const sourceId = "cfc-flow-precision-builtin-untrusted-source" as URI;
    const targetId = "cfc-flow-precision-builtin-untrusted-target" as URI;
    await seedDocument(sourceId, [11, 22], {
      "/0": { classification: ["secret"] },
      "/1": { classification: ["confidential"] },
    });
    await seedDocument(targetId, [0, 0]);

    const thrown = await runFlowPrecisionPrepare({
      sourceId,
      targetId,
      itemSchema: confidentialFlowPrecisionItemSchema,
      implementationIdentity: deriveImplementationIdentity(
        runtime.moduleRegistry.getModule("map"),
      ),
    });

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("confidentialityMonotonicity");
  });

  it("uses trusted Builtin(map) flow precision with Pointwise claims", async () => {
    const sourceId = "cfc-flow-precision-pointwise-source" as URI;
    const targetId = "cfc-flow-precision-pointwise-target" as URI;
    const implementationIdentity = deriveImplementationIdentity(
      runtime.moduleRegistry.getModule("map"),
    );
    await seedDocument(sourceId, [11, 22], {
      "/0": { classification: ["secret"] },
      "/1": { classification: ["confidential"] },
    });
    await seedDocument(targetId, [0, 0]);

    const thrown = await runFlowPrecisionPrepare({
      sourceId,
      targetId,
      itemSchema: pointwiseFlowPrecisionItemSchema,
      implementationIdentity,
      actingPrincipal: signer.did(),
      trustContext: createFlowPrecisionTrustContext(
        signer.did(),
        encodeImplementationIdentity(implementationIdentity),
      ),
    });

    expect(thrown).toBeUndefined();
  });

  it("keeps same-restrictiveness claims without trust", async () => {
    const sourceId = "cfc-flow-precision-same-source" as URI;
    const targetId = "cfc-flow-precision-same-target" as URI;
    await seedDocument(sourceId, [11, 22], {
      "/0": { classification: ["confidential"] },
      "/1": { classification: ["confidential"] },
    });
    await seedDocument(targetId, [0, 0]);

    const thrown = await runFlowPrecisionPrepare({
      sourceId,
      targetId,
      itemSchema: confidentialFlowPrecisionItemSchema,
    });

    expect(thrown).toBeUndefined();
  });

  it("falls back to conservative flow when the claim is malformed", async () => {
    const sourceId = "cfc-flow-precision-malformed-source" as URI;
    const targetId = "cfc-flow-precision-malformed-target" as URI;
    await seedDocument(sourceId, [11, 22], {
      "/0": { classification: ["secret"] },
      "/1": { classification: ["confidential"] },
    });
    await seedDocument(targetId, [0, 0]);

    const thrown = await runFlowPrecisionPrepare({
      sourceId,
      targetId,
      itemSchema: malformedFlowPrecisionItemSchema,
      implementationIdentity: deriveImplementationIdentity(
        runtime.moduleRegistry.getModule("map"),
      ),
    });

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
  });

  it("resolves builtin trust from the acting principal's trust context", () => {
    const identity = deriveImplementationIdentity(
      runtime.moduleRegistry.getModule("map"),
    );
    const trustContext = createFlowPrecisionTrustContext(
      signer.did(),
      encodeImplementationIdentity(identity),
    );

    expect(
      isImplementationTrustedForConcept(
        identity,
        FLOW_TAINT_PRECISION_CONCEPT,
      ),
    ).toBe(false);
    expect(
      isImplementationTrustedForConcept(
        identity,
        FLOW_TAINT_PRECISION_CONCEPT,
        { actingPrincipal: signer.did(), trustContext },
      ),
    ).toBe(true);
  });

  it("does not trust custom map overrides without the builtin marker", () => {
    runtime.moduleRegistry.addModuleByRef(
      "map",
      lift((value: number) => value),
    );

    const identity = deriveImplementationIdentity(
      runtime.moduleRegistry.getModule("map"),
    );

    expect(encodeImplementationIdentity(identity)).toContain("CodeHash(");
    expect(
      isImplementationTrustedForConcept(
        identity,
        FLOW_TAINT_PRECISION_CONCEPT,
      ),
    ).toBe(false);
  });
});
