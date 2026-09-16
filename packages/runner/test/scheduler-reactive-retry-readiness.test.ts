import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { Action } from "../src/scheduler/types.ts";
import type { CommitError } from "../src/storage/interface.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  space,
} from "./scheduler-test-utils.ts";

describe("scheduler-reactive-retry-readiness", () => {
  for (const invocation of ["subscribe", "run", "run-after-removal"] as const) {
    for (
      const finish of [
        "retry",
        "remove",
        "replace",
        "dispose",
        "remove-before-verdict",
      ] as const
    ) {
      it(`keeps ${invocation} conflict repair on the commit barrier through ${finish}`, async () => {
        const fixture = createSchedulerTestRuntime(import.meta.url);
        const { runtime, storageManager } = fixture;
        const verdict = Promise.withResolvers<void>();
        const refusalReady = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        const awaited = Promise.withResolvers<void>();
        const repair = Promise.withResolvers<void>();
        const repairing = Promise.withResolvers<void>();
        const provider = storageManager.open(space);
        const output = runtime.getCell(
          space,
          "retry-output",
          undefined,
          undefined,
          "user",
        );
        const id = output.getAsNormalizedFullLink().id;
        const events: string[] = [];
        const sync = provider.sync.bind(provider);
        using _heldSync = stub(
          provider,
          "sync",
          async (uri, selector, scope, instance) => {
            if (uri === id && scope === "user") {
              events.push("pull");
              repairing.resolve();
              await repair.promise;
            }
            return await sync(uri, selector, scope, instance);
          },
        );
        const edit = runtime.edit.bind(runtime);
        let refused = false;
        using _edits = stub(runtime, "edit", (options) => {
          const tx = edit(options);
          const commit = tx.commit.bind(tx);
          tx.commit = (commitOptions) => {
            if (refused) return commit(commitOptions);
            refused = true;
            tx.abort("injected stale basis");
            const error: CommitError = {
              name: "ConflictError",
              message: "injected stale basis",
              transaction: {
                localSeq: 1,
                operations: [],
                reads: { confirmed: [], pending: [] },
              },
              conflict: {
                space,
                the: "application/json",
                of: id,
                scope: "user",
              },
              readyToRetry: () => {
                events.push("catch-up");
                awaited.resolve();
                return gate.promise;
              },
            };
            refusalReady.resolve();
            return verdict.promise.then(() => ({ error }));
          };
          return tx;
        });
        const action: Action = () => {
          events.push("run");
        };
        try {
          if (invocation !== "run") {
            runtime.scheduler.subscribe(action, {
              reads: [],
              shallowReads: [],
              writes: [],
            }, { isEffect: true });
            if (invocation === "run-after-removal") {
              runtime.scheduler.unsubscribe(action);
            }
          }
          if (invocation !== "subscribe") await runtime.scheduler.run(action);
          await refusalReady.promise;
          await runtime.idle();
          if (finish === "remove-before-verdict") {
            runtime.scheduler.unsubscribe(action);
            verdict.resolve();
            await runtime.scheduler.idleWithPendingCommits();
            expect(events).toEqual(["run"]);
            return;
          }
          verdict.resolve();
          await awaited.promise;
          await runtime.idle();
          expect(events).toEqual(["run", "catch-up"]);
          const barrier = runtime.scheduler.idleWithPendingCommits().then(() =>
            "released"
          );
          expect(await Promise.race([barrier, Promise.resolve("held")])).toBe(
            "held",
          );
          gate.resolve();
          await repairing.promise;
          await runtime.idle();
          expect(events).toEqual(["run", "catch-up", "pull"]);
          expect(await Promise.race([barrier, Promise.resolve("held")])).toBe(
            "held",
          );
          if (finish === "dispose") {
            await runtime.dispose();
            expect(await barrier).toBe("released");
            expect(events).toEqual(["run", "catch-up", "pull"]);
            repair.resolve();
          } else {
            if (finish !== "retry") runtime.scheduler.unsubscribe(action);
            if (finish === "replace") {
              runtime.scheduler.subscribe(action, {
                reads: [],
                shallowReads: [],
                writes: [],
              }, { isEffect: true });
              await runtime.idle();
            }
            repair.resolve();
            await barrier;
            expect(events).toEqual(
              finish === "remove"
                ? ["run", "catch-up", "pull"]
                : ["run", "catch-up", "pull", "run"],
            );
          }
        } finally {
          verdict.resolve();
          gate.resolve();
          repair.resolve();
          runtime.scheduler.unsubscribe(action);
          await disposeSchedulerTestRuntime(fixture);
        }
      });
    }
  }
});
