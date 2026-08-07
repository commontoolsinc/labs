// The accepted-commit half of the CT-1950 callback split (the rejection
// half lives in commit-conflict-reconcile.test.ts): on accept, the verdict
// callback fires at the verdict, while the commit callback and the commit
// promise wait for marker coverage. The runtime talks to a real
// MemoryV2Server through the plain loopback transport (no flush-on-send
// nudge), so the coverage marker rides the server's timed fan-out — which
// a held-clock drain never fires — while the verdict arrives over the
// microtask loopback inside the drain.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("commit-callback-timing");
const space = signer.did();

class TimedFanOutStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): TimedFanOutStorageManager {
    const manager = new TimedFanOutStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }

  private sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }
}

describe("commit callback timing", () => {
  let server: MemoryV2Server.Server;
  let storageManager: TimedFanOutStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    });
    storageManager = TimedFanOutStorageManager.connectTo(server, {
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  it("fires the verdict callback at the accept verdict, the commit callback and promise at coverage", async () => {
    const cell = runtime.getCell<{ v: string }>(
      space,
      "accept-timing-doc",
      undefined,
    );
    {
      const tx = runtime.edit();
      cell.withTx(tx).set({ v: "v0" });
      runtime.prepareTxForCommit(tx);
      const res = await tx.commit({ resolveAt: "verdict" });
      expect(res.error, `seed: ${JSON.stringify(res.error)}`).toBeUndefined();
    }

    // A live watch makes accepts PARK: coverage now needs the marker.
    await cell.sync();
    await cell.pull();
    expect(cell.get()).toEqual({ v: "v0" });

    const tx = runtime.edit();
    cell.withTx(tx).set({ v: "v1" });
    runtime.prepareTxForCommit(tx);

    let verdictResult: { error?: unknown } | undefined;
    tx.addVerdictCallback((_tx, result) => {
      verdictResult = result;
    });
    let commitCallbackFired = false;
    tx.addCommitCallback(() => {
      commitCallbackFired = true;
    });
    let promiseSettled = false;
    const commitP = tx.commit().then((result) => {
      promiseSettled = true;
      return result;
    });

    // Held-clock fixpoint: the accept verdict has arrived (microtask
    // loopback), the coverage marker has not (timed fan-out).
    await clock.settle();
    expect(verdictResult, "verdict callback fired at the accept verdict")
      .toBeDefined();
    expect(verdictResult?.error, "verdict callback saw the accept")
      .toBeUndefined();
    expect(
      commitCallbackFired,
      "commit callback still waiting for coverage",
    ).toBe(false);
    expect(promiseSettled, "commit promise still waiting for coverage")
      .toBe(false);

    // Real time resumes: the marker arrives, the promise resolves, and the
    // commit callback fires with the same accepted result.
    const res = await commitP;
    expect(res.error, `commit: ${JSON.stringify(res.error)}`).toBeUndefined();
    expect(commitCallbackFired, "commit callback fired at coverage").toBe(true);
    expect(cell.get()).toEqual({ v: "v1" });
  });
});
