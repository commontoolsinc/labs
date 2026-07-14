import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getTimingStatsBreakdown } from "@commonfabric/utils/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import type { IStorageProviderWithReplica } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase(
  "execution demand export test operator",
);
const space = signer.did();

type TestStorageManager = ReturnType<typeof StorageManager.emulate>;

type DemandProvider = IStorageProviderWithReplica & {
  setExecutionDemand?: (
    branch: string,
    pieces: readonly string[],
  ) => Promise<boolean>;
};

type DemandCall = {
  branch: string;
  pieces: string[];
};

const runtimes = new Set<Runtime>();

function createRuntime(
  serverPrimaryExecution: boolean,
): { runtime: Runtime; storageManager: TestStorageManager } {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { serverPrimaryExecution },
  });
  runtimes.add(runtime);
  return { runtime, storageManager };
}

function recordDemand(
  storageManager: TestStorageManager,
  supported = true,
): DemandCall[] {
  const calls: DemandCall[] = [];
  const provider = storageManager.open(space) as DemandProvider;
  provider.setExecutionDemand = (branch, pieces) => {
    calls.push({ branch, pieces: [...pieces] });
    return Promise.resolve(supported);
  };
  return calls;
}

async function setupPiece(
  runtime: Runtime,
  cause: string,
): Promise<Cell<{ ready: boolean }>> {
  const { pattern } = createTrustedBuilder(runtime).commonfabric;
  const piecePattern = pattern(() => ({ ready: true }));
  const result = runtime.getCell<{ ready: boolean }>(space, cause);
  await runtime.setup(undefined, piecePattern, {}, result);
  return result;
}

afterEach(async () => {
  await Promise.all([...runtimes].map((runtime) => runtime.dispose()));
  runtimes.clear();
});

describe("runner execution demand export", () => {
  it("publishes the exact resolved piece root when a piece starts", async () => {
    const { runtime, storageManager } = createRuntime(true);
    const calls = recordDemand(storageManager);
    const piece = await setupPiece(runtime, "execution-demand-root");
    const rootId = piece.getAsNormalizedFullLink().id;

    expect(await runtime.start(piece.key("ready"))).toBe(true);
    expect(calls).toEqual([{ branch: "", pieces: [rootId] }]);
  });

  it("publishes the deduplicated live-root union and removes roots precisely", async () => {
    const { runtime, storageManager } = createRuntime(true);
    const calls = recordDemand(storageManager);
    const first = await setupPiece(runtime, "execution-demand-first");
    const second = await setupPiece(runtime, "execution-demand-second");
    const firstId = first.getAsNormalizedFullLink().id;
    const secondId = second.getAsNormalizedFullLink().id;

    expect(await runtime.start(first)).toBe(true);
    expect(await runtime.start(first.key("ready"))).toBe(true);
    expect(await runtime.start(second)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ branch: "", pieces: [firstId] });
    expect(calls[1].branch).toBe("");
    expect(new Set(calls[1].pieces).size).toBe(2);
    expect([...calls[1].pieces].sort()).toEqual([firstId, secondId].sort());

    runtime.runner.stop(first);
    expect(calls.at(-1)).toEqual({ branch: "", pieces: [secondId] });

    runtime.runner.stop(second);
    expect(calls.at(-1)).toEqual({ branch: "", pieces: [] });
  });

  it("keeps normal execution when the rollout flag is off", async () => {
    const { runtime, storageManager } = createRuntime(false);
    const calls = recordDemand(storageManager);
    const piece = await setupPiece(runtime, "execution-demand-flag-off");

    expect(await runtime.start(piece)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("fails open when the provider reports the protocol unsupported", async () => {
    const { runtime, storageManager } = createRuntime(true);
    const calls = recordDemand(storageManager, false);
    const piece = await setupPiece(runtime, "execution-demand-unsupported");
    const rootId = piece.getAsNormalizedFullLink().id;

    expect(await runtime.start(piece)).toBe(true);
    expect(calls).toEqual([{ branch: "", pieces: [rootId] }]);
  });

  it("measures the active demand round trip that start awaits", async () => {
    const { runtime, storageManager } = createRuntime(true);
    const provider = storageManager.open(space) as DemandProvider;
    const called = Promise.withResolvers<void>();
    const response = Promise.withResolvers<boolean>();
    provider.setExecutionDemand = (_branch, pieces) => {
      if (pieces.length === 0) return Promise.resolve(true);
      called.resolve();
      return response.promise;
    };
    const piece = await setupPiece(runtime, "execution-demand-active-timing");
    const before = getTimingStatsBreakdown()["execution.demand"]?.[
      "publish-active"
    ]?.count ?? 0;

    let settled = false;
    const started = runtime.start(piece).finally(() => {
      settled = true;
    });
    await called.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(
      getTimingStatsBreakdown()["execution.demand"]?.["publish-active"]
        ?.count ?? 0,
    ).toBe(before);

    response.resolve(true);
    expect(await started).toBe(true);
    expect(
      getTimingStatsBreakdown()["execution.demand"]?.["publish-active"]
        ?.count ?? 0,
    ).toBe(before + 1);
  });

  it("does not originate demand through an executor provider that omits it", async () => {
    const { runtime, storageManager } = createRuntime(true);
    const provider = storageManager.open(space) as DemandProvider;
    // Executor HostReplicaSession deliberately omits this client-only method.
    // Mask the ordinary provider seam to that exact capability shape without
    // constructing a second runtime realm in this focused lifecycle test.
    Object.defineProperty(provider, "setExecutionDemand", {
      configurable: true,
      value: undefined,
    });
    const piece = await setupPiece(runtime, "execution-demand-executor-host");

    expect(provider.setExecutionDemand).toBeUndefined();
    expect(await runtime.start(piece)).toBe(true);
  });

  it("waits for the final empty demand snapshot before disposing storage", async () => {
    const { runtime, storageManager } = createRuntime(true);
    const provider = storageManager.open(space) as DemandProvider;
    const originalClose = storageManager.close.bind(storageManager);
    let storageCloseStarted = false;
    storageManager.close = async () => {
      storageCloseStarted = true;
      await originalClose();
    };
    let releaseFinalDemand!: () => void;
    const finalDemandSettled = new Promise<void>((resolve) => {
      releaseFinalDemand = resolve;
    });
    provider.setExecutionDemand = (_branch, pieces) =>
      pieces.length === 0
        ? finalDemandSettled.then(() => true)
        : Promise.resolve(true);
    const piece = await setupPiece(runtime, "execution-demand-dispose");
    expect(await runtime.start(piece)).toBe(true);
    await runtime.scheduler.idle();
    const emptyTimingBefore = getTimingStatsBreakdown()["execution.demand"]?.[
      "publish-empty"
    ]?.count ?? 0;

    let disposed = false;
    const disposal = runtime.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(disposed).toBe(false);
    expect(storageCloseStarted).toBe(false);
    releaseFinalDemand();
    await disposal;
    expect(disposed).toBe(true);
    expect(
      getTimingStatsBreakdown()["execution.demand"]?.["publish-empty"]
        ?.count ?? 0,
    ).toBe(emptyTimingBefore + 1);
  });
});
