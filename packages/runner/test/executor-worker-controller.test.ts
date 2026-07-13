import { assert, assertEquals } from "@std/assert";
import type { BranchName } from "@commonfabric/memory/v2";
import type {
  ExecutionLeaseHandle,
  Server,
} from "@commonfabric/memory/v2/server";
import {
  DenoSpaceExecutorFactory,
  type ExecutorWorkerLike,
} from "../src/executor/deno-space-executor.ts";

const SPACE = "did:key:z6Mk-executor-controller";
const BRANCH = "feature" as BranchName;
const LEASE = {
  version: 1,
  space: SPACE,
  branch: BRANCH,
  leaseGeneration: 7,
  hostId: "host:controller-test",
  onBehalfOf: "did:key:z6Mk-controller-sponsor",
  state: "active",
  expiresAt: Date.now() + 60_000,
} as ExecutionLeaseHandle;

class FakeWorker extends EventTarget implements ExecutorWorkerLike {
  readonly messages: unknown[] = [];
  terminated = false;

  boot(): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "booted" },
      }),
    );
  }

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    this.messages.push(message);
    const request = message as { type?: string; requestId?: number };
    if (request.type === "initialize") {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "ready", requestId: request.requestId },
        }),
      );
    } else {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "complete", requestId: request.requestId },
        }),
      );
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

Deno.test("Deno executor controller transfers only an opaque provider and sponsor DID", async () => {
  const worker = new FakeWorker();
  const channel = new MessageChannel();
  let disposed = 0;
  const factory = new DenoSpaceExecutorFactory({
    server: {} as Server,
    apiUrl: new URL("https://toolshed.example/"),
    protocolFlags: {},
    createWorker: () => {
      queueMicrotask(() => worker.boot());
      return worker;
    },
    createProvider: (options) => {
      assertEquals(options.executionLease, LEASE);
      return {
        port: channel.port1,
        dispose: () => {
          disposed++;
          channel.port2.close();
          return Promise.resolve();
        },
      };
    },
  });

  const executor = await factory.start({
    space: SPACE,
    branch: BRANCH,
    lease: LEASE,
    pieces: ["fid1:piece-a"],
    onCrash: () => {
      throw new Error("unexpected crash");
    },
  });

  const initialization = worker.messages[0] as Record<string, unknown>;
  assertEquals(initialization.type, "initialize");
  assertEquals(initialization.space, SPACE);
  assertEquals(initialization.branch, BRANCH);
  assertEquals(initialization.principal, LEASE.onBehalfOf);
  assertEquals(initialization.leaseGeneration, 7);
  assertEquals(initialization.pieces, ["fid1:piece-a"]);
  assert(initialization.port instanceof MessagePort);
  assertEquals("rawIdentity" in initialization, false);
  assertEquals("lease" in initialization, false);

  await executor.setDemand(["fid1:piece-a", "fid1:piece-b"]);
  await executor.wake();
  await executor.stop();

  assertEquals(
    worker.messages.map((message) => (message as { type?: string }).type),
    ["initialize", "set-demand", "wake", "stop"],
  );
  assertEquals(worker.terminated, true);
  assertEquals(disposed, 1);
});
