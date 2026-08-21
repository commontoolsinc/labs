/**
 * The multi-user orchestrator's `{ label }` / `{ await }` handshake.
 *
 * A marker is a durable write in the shared space, so crossing one means the
 * announcing participant's earlier writes have reached this replica. That is
 * what lets an assertion be read once.
 *
 * What these tests hold in place is that contract as an author meets it: a
 * marker carries state across, a marker announced from a replica that predates
 * another participant's announcement still arrives, a wait outlives a change to
 * the announcer's document that is not the awaited marker, a false assertion is
 * reported for what it read rather than for running out of time, a marker
 * nobody announces is still a deadlock, and an explicit `{ settle: true }` step
 * settles a participant where the author asks for it and the run carries on. The
 * propagation gap itself is too small to observe in a fixture this size — the
 * barrier's discriminating coverage is the pattern-test corpus, where removing
 * it fails seven assertions across `topics`, `lobby`, and `cfc-group-chat-demo`.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { Identity, realmValueFromKeyPair } from "@commonfabric/identity";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { runTests } from "../lib/test-runner.ts";
import type {
  WorkerRequest,
  WorkerResponse,
} from "../lib/multi-user-test-worker.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/multi-user-markers");

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

/**
 * One participant worker, driven by hand over the same request/response
 * protocol the orchestrator uses.
 *
 * The orchestrator issues `awaitMarker` only for a marker it has already seen
 * announced, so through it a wait always begins on a marker the announcer has
 * committed and settled — which of the wait's two paths runs is then left to
 * how fast the announcement reaches the awaiting replica. This client leaves a
 * call in flight while it drives another worker, which is what lets a test
 * choose the order instead.
 */
class ParticipantWorkerClient {
  readonly name: string;
  #worker: Worker;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(name: string) {
    this.name = name;
    this.#worker = new Worker(
      new URL("../lib/multi-user-test-worker.ts", import.meta.url),
      { type: "module", name: `marker-wait:${name}` },
    );
    this.#worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      if ("error" in event.data) {
        pending.reject(new Error(`[${this.name}] ${event.data.error}`));
      } else {
        pending.resolve(event.data.ok);
      }
    };
    // Without this a worker-level failure would leave every call pending, and
    // a test that reports nothing is worse than one that reports the error.
    this.#worker.onerror = (event) => {
      const error = new Error(`[${this.name}] worker error: ${event.message}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
  }

  call(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId++;
    const request: WorkerRequest = { id, cmd, args };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage(request);
    });
  }

  async close(): Promise<void> {
    await this.call("dispose").catch(() => {});
    this.#worker.terminate();
  }
}

describe(
  "multi-user-test-runner",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("delivers what was written before the marker", async () => {
      const { passed, failed, results } = await runTests(
        fixture("marker-barrier.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(1);
      expect(results[0].results[0].name).toBe("bob/assertion_1");
    });

    it("runs an explicit settle step for a participant", async () => {
      // `verbose` exercises the per-step logging the orchestrator emits,
      // settle included, so those lines are covered rather than merely run.
      const { passed, failed, results } = await runTests(
        fixture("settle-step.test.tsx"),
        { root: FIXTURES, verbose: true },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(1);
      expect(results[0].results[0].name).toBe("bob/assertion_1");
    });

    it("carries markers announced crosswise", async () => {
      // Each participant announces before crossing the other's marker, from
      // a replica that predates the other's announcement. One marker document
      // per announcer keeps that order conflict-free.
      const { passed, failed } = await runTests(
        fixture("crosswise-markers.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(2);
    });

    it("reports a false assertion with the operands it read", async () => {
      const { passed, failed, results } = await runTests(
        fixture("false-assertion.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(0);
      expect(failed).toBe(1);
      // The assertion is answered from settled state, so the failure names
      // the value that was there rather than reporting elapsed time.
      expect(results[0].results[0].error).toContain(`"from alice"`);
    });

    it("holds a wait open across a change that is not the marker", async () => {
      // The wait re-reads on every change to the announcer's document, so the
      // marker it was given releases it and nothing else does.
      //
      // Driving the workers directly is what orders it that way. The
      // orchestrator announces a marker before it asks anyone to wait for it,
      // so through it the wait's first read decides the outcome. Here bob's
      // wait starts on a marker alice has not been asked for — that request
      // goes out a round trip later — and alice's other marker wakes the wait
      // onto a document that still lacks the one it wants.
      const server = StandaloneMemoryServer.start();
      const spaceName = crypto.randomUUID();
      const names = ["alice", "bob"];
      const workers = new Map<string, ParticipantWorkerClient>();
      try {
        for (const [index, name] of names.entries()) {
          const client = new ParticipantWorkerClient(name);
          workers.set(name, client);
          const identity = await Identity.fromPassphrase(
            `test-runner ${name}`,
            { implementation: "noble" },
          );
          await client.call("init", {
            identity: realmValueFromKeyPair(identity.keyPair),
            spaceName,
            apiUrl: server.url.href,
            // Any two-participant descriptor will do: the markers this test
            // announces and awaits are its own, not the fixture's steps.
            testPath: fixture("marker-barrier.test.tsx"),
            root: FIXTURES,
            participant: name,
            participants: names,
            seedDefaults: index === 0,
          });
        }
        const alice = workers.get("alice")!;
        const bob = workers.get("bob")!;

        // The outcome is an order rather than a moment: "not released yet" is
        // only worth asserting against something bob has demonstrably seen.
        const order: string[] = [];
        let failure: unknown;
        const waiting = bob.call("awaitMarker", {
          announcedBy: "alice",
          marker: "wanted",
        }).then(() => {
          order.push("released");
        }, (error: unknown) => {
          failure = error;
        });

        await alice.call("label", { marker: "unwanted" });
        // A second wait, for the marker alice did announce, returns once bob's
        // replica holds it — so the first wait has now seen the change that
        // must not release it.
        await bob.call("awaitMarker", {
          announcedBy: "alice",
          marker: "unwanted",
        });
        order.push("saw the other marker");
        expect(failure).toBeUndefined();

        await alice.call("label", { marker: "wanted" });
        await waiting;
        if (failure !== undefined) throw failure;
        expect(order).toEqual(["saw the other marker", "released"]);
      } finally {
        for (const client of workers.values()) await client.close();
        await server.close().catch(() => {});
      }
    });

    it("reports a marker nobody announces as a deadlock", async () => {
      const { failed, results } = await runTests(
        fixture("unannounced-marker.test.tsx"),
        { root: FIXTURES },
      );
      expect(failed).toBeGreaterThan(0);
      expect(results[0].error).toContain("Deadlock");
      expect(results[0].error).toContain(`bob awaits "never-announced"`);
    });
  },
);
