import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
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
  ) => Promise<boolean | undefined>;
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
});
