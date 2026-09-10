/** Verifies served effect requests distinguish the selected scope instance. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";

import { fetchText } from "../../src/builtins/fetch.ts";
import { stampWaveRunContext } from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const service = await Identity.fromPassphrase("builtin-instance-service");
const alice = await Identity.fromPassphrase("builtin-instance-alice");
const bob = await Identity.fromPassphrase("builtin-instance-bob");
const space = service.did();
const aliceOne = { principal: alice.did(), sessionId: "alice-one" };
const aliceTwo = { principal: alice.did(), sessionId: "alice-two" };
const bobOne = { principal: bob.did(), sessionId: "bob-one" };

describe("fetch-served-instances", () => {
  let manager: EmulatedStorageManager;
  let server: ReturnType<typeof newSharedServer>;
  let runtime: Runtime;
  const transactions: IExtendedStorageTransaction[] = [];

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const engine = await server.engineForSpace(space);
    const lease = new ExecutionLeaseCycle({
      engine,
      space,
      holder: executionLeaseHolder(service.did()),
    });
    expect(lease.acquire()).toBe(true);
    manager = EmulatedStorageManager.connectTo(server, { as: service });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    for (const tx of transactions.splice(0)) tx.abort();
    await manager.synced();
    await runtime.dispose();
    await manager.close();
    await server.close();
  });

  /** Stages two requests without allowing network work or the first transaction to settle. */
  function staged(
    scope: "space" | "user" | "session",
    identities: ScopeKeyIdentity[],
    sharedClosure = false,
  ) {
    const input = runtime.getCellFromLink<{ url?: string }>({
      ...runtime.getCell(space, "instance-input").getAsNormalizedFullLink(),
      scope,
    });
    const parent = runtime.getCell(space, "instance-parent");
    const construct = () =>
      fetchText(input, () => {}, () => {}, [parent], parent, runtime);
    const shared = sharedClosure ? construct() : undefined;
    return identities.map((identity) => {
      const tx = runtime.edit();
      transactions.push(tx);
      stampWaveRunContext(tx, {
        kind: "derivation",
        actionId: "instance-investigation",
        scopeKeyIdentity: identity,
        attributionFromScope: true,
      });
      input.withTx(tx).set({ url: "https://example.test/scoped" });
      (shared ?? construct())(tx);
      return tx.getCfcState().outbox.map((effect) => effect.idempotencyKey);
    });
  }

  it(`fetchText retains one user's deterministic request identity`, () => {
    const keys = staged("user", [aliceOne, aliceOne]);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toEqual(keys[0]);
  });

  it(`fetchText shares one user's key across sessions`, () => {
    const keys = staged("user", [aliceOne, aliceTwo]);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toEqual(keys[0]);
  });

  it(`fetchText shares a space-scoped key across users`, () => {
    const keys = staged("space", [aliceOne, bobOne]);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toEqual(keys[0]);
  });

  it(`fetchText separates two user instances`, () => {
    const keys = staged("user", [aliceOne, bobOne]);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toHaveLength(1);
    expect(keys[1][0]).not.toBe(keys[0][0]);
  });

  it(`fetchText separates two session instances`, () => {
    const keys = staged("session", [aliceOne, aliceTwo]);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toHaveLength(1);
    expect(keys[1][0]).not.toBe(keys[0][0]);
  });

  it(`fetchText stages both users on one builtin closure`, () => {
    const keys = staged("user", [aliceOne, bobOne], true);
    expect(keys[0]).toHaveLength(1);
    expect(keys[1]).toHaveLength(1);
  });
});
