import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  builtinImplementationIdentity,
  deriveImplementationIdentity,
  encodeAnnotatedImplementationIdentity,
} from "../src/cfc/implementation-identity.ts";
import type { CfcTrustContext } from "../src/cfc/integrity-trust.ts";
import { recordCfcWriteSchemaContext } from "../src/cfc/schema-context.ts";
import { computeCfcSchemaHash } from "../src/cfc/schema-hash.ts";
import { FLOW_TAINT_PRECISION_CONCEPT } from "../src/cfc/trust-lattice.ts";

const signer = await Identity.fromPassphrase("cfc scheduler prepare shim test");
const space = signer.did();

const exactCopyIfc = {
  exactCopyOf: "/",
} as const;

const maxConfidentialityIfc = {
  maxConfidentiality: ["confidential"],
} as const;

const ifcNumberSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const ifcStringSchema = {
  type: "string",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const ifcConfidentialNumberSchema = {
  type: "number",
  ifc: { classification: ["confidential"] },
} as const satisfies JSONSchema;

const ifcExactCopyNumberSchema = {
  type: "number",
  ifc: {
    classification: ["secret"],
    ...exactCopyIfc,
  },
} as const satisfies JSONSchema;

const maxConfidentialInputSchema = {
  type: "number",
  ifc: {
    classification: ["secret"],
    ...maxConfidentialityIfc,
  },
} as const satisfies JSONSchema;

const flowPrecisionNumberSchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    flowPrecisionClaim: {
      concept: FLOW_TAINT_PRECISION_CONCEPT,
      sourceCollection: "/",
      claims: [
        { type: "PointwisePresencePreserved" },
        { type: "PointwiseWriteDependency" },
      ],
    },
  },
} as const satisfies JSONSchema;

function createFlowPrecisionTrustContext(delegator: string): CfcTrustContext {
  const annotatedMapAction = {
    cfcImplementationIdentity: builtinImplementationIdentity("map"),
  };
  return {
    delegations: [{
      delegator,
      verifier: "did:key:cfc-scheduler-flow-precision-verifier",
      scope: {
        concepts: [FLOW_TAINT_PRECISION_CONCEPT],
      },
    }],
    statements: [{
      verifier: "did:key:cfc-scheduler-flow-precision-verifier",
      concrete: encodeAnnotatedImplementationIdentity(annotatedMapAction),
      concept: FLOW_TAINT_PRECISION_CONCEPT,
    }],
  };
}

describe("CFC scheduler prepare shim", () => {
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

  it("commits reactive action with IFC-relevant read/write via prepare shim", async () => {
    const tx = runtime.edit();
    const input = runtime.getCell<number>(
      space,
      "cfc-prepare-input",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "cfc-prepare-output",
      undefined,
      tx,
    );
    input.set(1);
    output.set(0);
    await tx.commit();

    const action = (actionTx: IExtendedStorageTransaction) => {
      const value = Number(
        input.withTx(actionTx).asSchema(ifcNumberSchema).get() ?? 0,
      );
      output.withTx(actionTx).set(value + 1);
    };

    await runtime.scheduler.run(action);
    for (let attempt = 0; attempt < 20; attempt++) {
      await output.pull();
      if (output.get() === 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(output.get()).toBe(2);
  });

  it("passes builtin identity through scheduler prepare for trusted flow precision claims", async () => {
    await runtime.dispose();
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
      cfcTrustContext: createFlowPrecisionTrustContext(signer.did()),
    });
    runtime.scheduler.disablePullMode();

    let tx = runtime.edit();
    let sourceCell = runtime.getCell<number[]>(
      space,
      "cfc-prepare-flow-source",
      undefined,
      tx,
    );
    const targetCell = runtime.getCell<number[]>(
      space,
      "cfc-prepare-flow-target",
      undefined,
      tx,
    );
    sourceCell.set([11, 22]);
    targetCell.set([0, 0]);
    await tx.commit();

    tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id: sourceCell.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/0": { classification: ["secret"] },
      "/1": { classification: ["confidential"] },
    });
    await tx.commit();
    sourceCell = runtime.getCell<number[]>(
      space,
      "cfc-prepare-flow-source",
      undefined,
    );
    await sourceCell.pull();

    const mapIdentity = deriveImplementationIdentity(
      runtime.moduleRegistry.getModule("map"),
    );
    const action = Object.assign((actionTx: IExtendedStorageTransaction) => {
      actionTx.readValueOrThrow({
        space,
        id: sourceCell.getAsNormalizedFullLink().id,
        type: "application/json",
        path: ["0"],
      });
      const value = actionTx.readValueOrThrow({
        space,
        id: sourceCell.getAsNormalizedFullLink().id,
        type: "application/json",
        path: ["1"],
      });
      actionTx.writeOrThrow({
        space,
        id: targetCell.getAsNormalizedFullLink().id,
        type: "application/json",
        path: ["value", "1"],
      }, value);
      recordCfcWriteSchemaContext(actionTx, {
        space,
        id: targetCell.getAsNormalizedFullLink().id,
        type: "application/json",
        path: ["1"],
      }, flowPrecisionNumberSchema);
      actionTx.markCfcRelevant("ifc-write-schema");
    }, {
      cfcImplementationIdentity: mapIdentity,
    });

    await runtime.scheduler.run(action);
    for (let attempt = 0; attempt < 20; attempt++) {
      await targetCell.pull();
      if (targetCell.get()?.[1] === 22) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(targetCell.get()).toEqual([0, 22]);
  });

  it("commits event handler path with IFC-relevant read/write via prepare shim", async () => {
    const tx = runtime.edit();
    const eventCell = runtime.getCell<number>(
      space,
      "cfc-prepare-event",
      undefined,
      tx,
    );
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-prepare-source",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell<number>(
      space,
      "cfc-prepare-result",
      undefined,
      tx,
    );
    eventCell.set(0);
    sourceCell.set(5);
    resultCell.set(0);
    await tx.commit();

    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        const source = Number(
          sourceCell.withTx(handlerTx).asSchema(ifcNumberSchema).get() ?? 0,
        );
        resultCell.withTx(handlerTx).set(source + 10);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve, reject) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        undefined,
        (commitTx) => {
          const status = commitTx.status().status;
          if (status === "error") {
            reject(new Error("event handler commit failed"));
            return;
          }
          resolve();
        },
      );
    });
    await resultCell.pull();

    expect(resultCell.get()).toBe(15);
  });

  it("retries event handler attempts and still commits through prepare shim", async () => {
    const tx = runtime.edit();
    const eventCell = runtime.getCell<number>(
      space,
      "cfc-prepare-retry-event",
      undefined,
      tx,
    );
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-prepare-retry-source",
      undefined,
      tx,
    );
    const resultCell = runtime.getCell<number>(
      space,
      "cfc-prepare-retry-result",
      undefined,
      tx,
    );
    eventCell.set(0);
    sourceCell.set(7);
    resultCell.set(0);
    await tx.commit();

    let attempts = 0;
    let callbackStatus: string | undefined;

    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        attempts++;
        const source = Number(
          sourceCell.withTx(handlerTx).asSchema(ifcNumberSchema).get() ?? 0,
        );
        if (attempts === 1) {
          resultCell.withTx(handlerTx).set(source + 1);
          handlerTx.abort("intentional-first-attempt-failure");
          return;
        }
        resultCell.withTx(handlerTx).set(source + 20);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        1,
        (commitTx) => {
          callbackStatus = commitTx.status().status;
          resolve();
        },
      );
    });
    await resultCell.pull();

    expect(attempts).toBe(2);
    expect(callbackStatus).toBe("done");
    expect(resultCell.get()).toBe(27);
  });

  it("does not retry terminal CFC prepare errors", async () => {
    let tx = runtime.edit();
    const eventCell = runtime.getCell<number>(
      space,
      "cfc-prepare-terminal-event",
      undefined,
      tx,
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-prepare-terminal-target",
      undefined,
      tx,
    );
    eventCell.set(0);
    targetCell.set(1);
    await tx.commit();

    const mismatchedSchemaHash = await computeCfcSchemaHash(ifcStringSchema);
    tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id: targetCell.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "schemaHash"],
    }, mismatchedSchemaHash);
    await tx.commit();

    let attempts = 0;
    let callbackStatus: string | undefined;
    let callbackErrorName: string | undefined;
    let callbackErrorReasonName: string | undefined;

    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        attempts++;
        targetCell.withTx(handlerTx).asSchema(ifcNumberSchema).set(42);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        2,
        (commitTx) => {
          const status = commitTx.status();
          callbackStatus = status.status;
          if (status.status === "error") {
            callbackErrorName = status.error.name;
            callbackErrorReasonName =
              (status.error as { reason?: { name?: string } })
                .reason?.name;
          }
          resolve();
        },
      );
    });
    await runtime.scheduler.idle();
    await runtime.scheduler.idle();

    expect(attempts).toBe(1);
    expect(callbackStatus).toBe("error");
    expect(callbackErrorName).toBe("StorageTransactionAborted");
    expect(callbackErrorReasonName).toBe("CfcSchemaHashMismatchError");
  });

  it("does not retry reactive actions on terminal CFC prepare errors", async () => {
    let tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-prepare-terminal-reactive-source",
      undefined,
      tx,
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-prepare-terminal-reactive-target",
      undefined,
      tx,
    );
    sourceCell.set(10);
    targetCell.set(0);
    await tx.commit();

    const mismatchedSchemaHash = await computeCfcSchemaHash(ifcStringSchema);
    tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id: targetCell.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "schemaHash"],
    }, mismatchedSchemaHash);
    await tx.commit();

    let attempts = 0;
    const action = (actionTx: IExtendedStorageTransaction) => {
      attempts++;
      const source = Number(
        sourceCell.withTx(actionTx).asSchema(ifcNumberSchema).get() ?? 0,
      );
      targetCell.withTx(actionTx).asSchema(ifcNumberSchema).set(source + 1);
    };

    await runtime.scheduler.run(action);
    await runtime.scheduler.idle();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runtime.scheduler.idle();
    await targetCell.pull();

    expect(attempts).toBe(1);
    expect(targetCell.get()).toBe(0);
  });

  it("does not retry reactive actions on maxConfidentiality input failures", async () => {
    let tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-prepare-maxconf-reactive-source",
      undefined,
      tx,
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-prepare-maxconf-reactive-target",
      undefined,
      tx,
    );
    sourceCell.set(10);
    targetCell.set(0);
    await tx.commit();

    tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id: sourceCell.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: ["secret"],
      },
    });
    await tx.commit();

    let attempts = 0;
    const action = (actionTx: IExtendedStorageTransaction) => {
      attempts++;
      const source = Number(
        sourceCell.withTx(actionTx).asSchema(maxConfidentialInputSchema)
          .get() ?? 0,
      );
      targetCell.withTx(actionTx).set(source + 1);
    };

    await runtime.scheduler.run(action);
    await runtime.scheduler.idle();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runtime.scheduler.idle();
    await targetCell.pull();

    expect(attempts).toBe(1);
    expect(targetCell.get()).toBe(0);
  });

  it("does not retry reactive actions on output confidentiality monotonicity failures", async () => {
    let tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-prepare-monotonic-reactive-source",
      undefined,
      tx,
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-prepare-monotonic-reactive-target",
      undefined,
      tx,
    );
    sourceCell.set(10);
    targetCell.set(0);
    await tx.commit();

    tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id: sourceCell.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: ["secret"],
      },
    });
    await tx.commit();

    let attempts = 0;
    const action = (actionTx: IExtendedStorageTransaction) => {
      attempts++;
      const source = Number(
        sourceCell.withTx(actionTx).asSchema(ifcNumberSchema).get() ?? 0,
      );
      targetCell.withTx(actionTx).asSchema(ifcConfidentialNumberSchema).set(
        source + 1,
      );
    };

    await runtime.scheduler.run(action);
    await runtime.scheduler.idle();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runtime.scheduler.idle();
    await targetCell.pull();

    expect(attempts).toBe(1);
    expect(targetCell.get()).toBe(0);
  });

  it("skips CFC boundary prepare enforcement when feature flag is disabled", async () => {
    const disabledStorageManager = StorageManager.emulate({ as: signer });
    const disabledRuntime = new Runtime({
      storageManager: disabledStorageManager,
      apiUrl: new URL(import.meta.url),
      experimental: {
        cfcBoundaryEnforcement: false,
      },
    });
    disabledRuntime.scheduler.disablePullMode();

    try {
      let tx = disabledRuntime.edit();
      const sourceCell = disabledRuntime.getCell<number>(
        space,
        "cfc-prepare-disabled-source",
        undefined,
        tx,
      );
      const targetCell = disabledRuntime.getCell<number>(
        space,
        "cfc-prepare-disabled-target",
        undefined,
        tx,
      );
      sourceCell.set(10);
      targetCell.set(0);
      await tx.commit();

      tx = disabledRuntime.edit();
      tx.writeOrThrow({
        space,
        id: sourceCell.getAsNormalizedFullLink().id,
        type: "application/json",
        path: ["cfc", "labels"],
      }, {
        "/": {
          classification: ["secret"],
        },
      });
      await tx.commit();

      let attempts = 0;
      const action = (actionTx: IExtendedStorageTransaction) => {
        attempts++;
        const source = Number(
          sourceCell.withTx(actionTx).asSchema(ifcNumberSchema).get() ?? 0,
        );
        targetCell.withTx(actionTx).asSchema(ifcConfidentialNumberSchema).set(
          source + 1,
        );
      };

      await disabledRuntime.scheduler.run(action);
      await disabledRuntime.scheduler.idle();
      await targetCell.pull();

      expect(attempts).toBeGreaterThanOrEqual(1);
      expect(targetCell.get()).toBe(11);
    } finally {
      await disabledRuntime.dispose();
      await disabledStorageManager.close();
    }
  });

  it("does not retry event handlers on exactCopyOf output transition failures", async () => {
    let tx = runtime.edit();
    const eventCell = runtime.getCell<number>(
      space,
      "cfc-prepare-terminal-exactcopy-event",
      undefined,
      tx,
    );
    let sourceCell = runtime.getCell<number>(
      space,
      "cfc-prepare-terminal-exactcopy-source",
      undefined,
      tx,
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-prepare-terminal-exactcopy-target",
      undefined,
      tx,
    );
    eventCell.set(0);
    sourceCell.set(5);
    targetCell.set(0);
    await tx.commit();

    tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id: sourceCell.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: ["secret"],
      },
    });
    await tx.commit();
    sourceCell = runtime.getCell<number>(
      space,
      "cfc-prepare-terminal-exactcopy-source",
      undefined,
    );
    await sourceCell.pull();

    let attempts = 0;
    let callbackStatus: string | undefined;
    let callbackErrorName: string | undefined;
    let callbackErrorReasonName: string | undefined;

    runtime.scheduler.addEventHandler(
      (handlerTx, _event) => {
        attempts++;
        const source = Number(
          handlerTx.readValueOrThrow({
            space,
            id: sourceCell.getAsNormalizedFullLink().id,
            type: "application/json",
            path: [],
          }) ?? 0,
        );
        handlerTx.writeOrThrow({
          space,
          id: targetCell.getAsNormalizedFullLink().id,
          type: "application/json",
          path: [],
        }, source + 1);
        recordCfcWriteSchemaContext(handlerTx, {
          space,
          id: targetCell.getAsNormalizedFullLink().id,
          type: "application/json",
          path: [],
        }, ifcExactCopyNumberSchema);
        handlerTx.markCfcRelevant("ifc-write-schema");
      },
      eventCell.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        2,
        (commitTx) => {
          const status = commitTx.status();
          callbackStatus = status.status;
          if (status.status === "error") {
            callbackErrorName = status.error.name;
            callbackErrorReasonName =
              (status.error as { reason?: { name?: string } }).reason?.name;
          }
          resolve();
        },
      );
    });
    await runtime.scheduler.idle();
    await runtime.scheduler.idle();

    expect(attempts).toBe(1);
    expect(callbackStatus).toBe("error");
    expect(callbackErrorName).toBe("StorageTransactionAborted");
    expect(callbackErrorReasonName).toBe("CfcOutputTransitionViolationError");
  });
});
