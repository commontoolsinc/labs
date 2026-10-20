import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import type { Server } from "@commonfabric/memory/v2/server";
import { ServingPortBridge } from "../../src/executor/serving-port-bridge.ts";
import { ServingWorker } from "../../src/executor/serving-worker-host.ts";

const identity = await Identity.fromPassphrase("serving-worker-recovery");

describe("serving-worker-recovery", () => {
  for (const source of ["init", "error"] as const) {
    for (const closing of [false, true]) {
      it(`${closing ? "suppresses replacement after close" : "waits for lease release before replacement"} when ${source} fails`, async () => {
        const workers: FakeWorker[] = [];
        const spawned = Promise.withResolvers<void>();
        class FakeWorker extends EventTarget {
          onerror: ((event: ErrorEvent) => void) | null = null;
          terminated = false;
          constructor() {
            super();
            workers.push(this);
            if (workers.length === 2) spawned.resolve();
          }
          postMessage() {}
          terminate() {
            this.terminated = true;
          }
        }
        const original = globalThis.Worker;
        globalThis.Worker = FakeWorker as unknown as typeof Worker;
        const init = Promise.withResolvers<{ lifetimeLock: undefined }>();
        const release = Promise.withResolvers<void>();
        const releasing = Promise.withResolvers<void>();
        let restart: (() => void) | undefined;
        using _timer = stub(
          globalThis,
          "setTimeout",
          ((callback: () => void) => {
            restart = callback;
            return 1;
          }) as typeof setTimeout,
        );
        using _init = stub(
          ServingPortBridge.prototype,
          "init",
          () =>
            workers.length === 1
              ? init.promise
              : Promise.resolve({ lifetimeLock: undefined }),
        );
        using _release = stub(
          ServingPortBridge.prototype,
          "releaseLeasesOf",
          () => {
            releasing.resolve();
            return release.promise;
          },
        );
        using _close = stub(
          ServingPortBridge.prototype,
          "closeHost",
          () => Promise.resolve(),
        );
        const host = new ServingWorker({
          server: { setServerExecutionObserver() {} } as unknown as Server,
          identity,
          apiUrl: new URL(import.meta.url),
        });
        try {
          const ready = host.ready;
          if (source === "init") {
            init.reject(new Error("init failed"));
            await expect(ready).rejects.toThrow("init failed");
          } else {
            init.resolve({ lifetimeLock: undefined });
            await ready;
            workers[0].onerror!(
              new ErrorEvent("error", {
                message: "worker failed",
                cancelable: true,
              }),
            );
          }
          await releasing.promise;
          expect(workers[0].terminated).toBe(true);
          expect(restart).toBeDefined();
          restart!();
          await Promise.resolve();
          expect(workers).toHaveLength(1);
          const closed = closing ? host.close() : undefined;
          release.resolve();
          if (closing) {
            await closed;
            expect(workers).toHaveLength(1);
          } else {
            await spawned.promise;
            await host.ready;
            expect(workers).toHaveLength(2);
          }
        } finally {
          release.resolve();
          await host.close();
          globalThis.Worker = original;
        }
      });
    }
  }
});
