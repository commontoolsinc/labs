import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { CfcTrustContext } from "../src/cfc/integrity-trust.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc trust-context retry snapshot test",
);
const space = signer.did() as MemorySpace;

const conceptRequiredIntegrity =
  "https://commonfabric.org/cfc/concepts/verified-input";

const conceptRequiredIntegritySchema = {
  type: "number",
  ifc: {
    requiredIntegrity: [conceptRequiredIntegrity],
  },
} as const satisfies JSONSchema;

function createTrustContext(delegator: string): CfcTrustContext {
  return {
    delegations: [{
      delegator,
      verifier: "did:key:cfc-retry-snapshot-verifier",
      scope: {
        concepts: [conceptRequiredIntegrity],
      },
    }],
    statements: [{
      verifier: "did:key:cfc-retry-snapshot-verifier",
      concrete: "runtime-attested-source",
      concept: conceptRequiredIntegrity,
    }],
  };
}

describe("CFC trust-context retry snapshots", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let trustContext: CfcTrustContext | undefined;

  beforeEach(() => {
    trustContext = createTrustContext(signer.did());
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
      cfcTrustContext: () => trustContext,
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  async function seedRuntime(
    sourceName: string,
    targetName: string,
  ): Promise<{ source: Cell<number>; target: Cell<number> }> {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(space, sourceName, undefined, tx);
    const target = runtime.getCell<number>(space, targetName, undefined, tx);
    source.set(1);
    target.set(0);
    let result = await tx.commit();
    expect(result.error).toBeUndefined();

    tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id: source.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        integrity: ["runtime-attested-source"],
      },
    });
    result = await tx.commit();
    expect(result.error).toBeUndefined();

    const refreshedSource = runtime.getCell<number>(space, sourceName);
    const refreshedTarget = runtime.getCell<number>(space, targetName);
    await refreshedSource.pull();
    await refreshedTarget.pull();
    return { source: refreshedSource, target: refreshedTarget };
  }

  it("uses a fresh trust-context snapshot on reactive retry attempts", async () => {
    const { source, target } = await seedRuntime(
      "cfc-retry-snapshot-reactive-source",
      "cfc-retry-snapshot-reactive-target",
    );

    let attempts = 0;
    const action = (actionTx: IExtendedStorageTransaction) => {
      attempts++;
      const value = Number(
        source.withTx(actionTx).asSchema(conceptRequiredIntegritySchema)
          .get() ??
          0,
      );
      target.withTx(actionTx).set(value + 1);
      if (attempts === 1) {
        trustContext = undefined;
        actionTx.abort("force-reactive-retry");
      }
    };

    try {
      await runtime.scheduler.run(action);
      await runtime.scheduler.idle();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await runtime.scheduler.idle();
      await target.pull();

      expect(attempts).toBe(2);
      expect(target.get()).toBe(0);
    } finally {
      runtime.scheduler.unsubscribe(action);
    }
  });

  it("re-evaluates concept guards with a fresh trust-context snapshot on requeued events", async () => {
    const { source, target } = await seedRuntime(
      "cfc-retry-snapshot-event-source",
      "cfc-retry-snapshot-event-target",
    );
    const tx = runtime.edit();
    const eventCell = runtime.getCell<number>(
      space,
      "cfc-retry-snapshot-event",
      undefined,
      tx,
    );
    eventCell.set(0);
    const result = await tx.commit();
    expect(result.error).toBeUndefined();

    let attempts = 0;
    let callbackStatus: string | undefined;
    let callbackErrorReasonName: string | undefined;

    runtime.scheduler.addEventHandler(
      (handlerTx) => {
        attempts++;
        const value = Number(
          source.withTx(handlerTx).asSchema(conceptRequiredIntegritySchema)
            .get() ?? 0,
        );
        target.withTx(handlerTx).set(value + 1);
        if (attempts === 1) {
          trustContext = undefined;
          handlerTx.abort("force-event-retry");
        }
      },
      eventCell.getAsNormalizedFullLink(),
    );

    await new Promise<void>((resolve) => {
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
        1,
        (commitTx) => {
          const status = commitTx.status();
          callbackStatus = status.status;
          if (status.status === "error") {
            callbackErrorReasonName =
              (status.error as { reason?: { name?: string } }).reason?.name;
          }
          resolve();
        },
      );
    });
    await runtime.scheduler.idle();
    await target.pull();

    expect(attempts).toBe(2);
    expect(callbackStatus).toBe("error");
    expect(callbackErrorReasonName).toBe("CfcInputRequirementViolationError");
    expect(target.get()).toBe(0);
  });
});
