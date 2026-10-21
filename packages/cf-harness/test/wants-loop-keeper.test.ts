import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  archiveOnExitSignals,
  markerKeeper,
} from "../scripts/want-eval/wants-loop-keeper.ts";

/**
 * A keeper whose filing and archiving each wait on a promise the test
 * settles, recording every archive asked for.
 */
const keeperWithHeldCalls = () => {
  const filed = Promise.withResolvers<string>();
  const archive = Promise.withResolvers<void>();
  const archived: string[] = [];
  const keeper = markerKeeper(
    () => filed.promise,
    (id) => {
      archived.push(id);
      return archive.promise;
    },
  );
  return { keeper, filed, archive, archived };
};

/** Whether `promise` has settled once pending callbacks have run. */
const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false;
  promise.then(() => done = true, () => done = true);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await Promise.resolve();
  return done;
};

/** Runs the handler registered for `signal`, which must be there. */
const fire = (handlers: Map<Deno.Signal, () => void>, signal: Deno.Signal) => {
  const handler = handlers.get(signal);
  if (handler === undefined) throw new Error(`no handler for ${signal}`);
  handler();
};

describe("wants-loop-keeper", () => {
  describe("markerKeeper()", () => {
    it("returns a cleanup that, asked again during an archive, waits for that archive", async () => {
      const { keeper, filed, archive, archived } = keeperWithHeldCalls();
      filed.resolve("w1");
      await keeper.file();

      const first = keeper.cleanup();
      const interrupt = keeper.cleanup();

      expect(await settled(interrupt)).toBe(false);
      expect(keeper.kept()).toBe("w1");
      archive.resolve();
      await interrupt;
      await first;
      expect(archived).toEqual(["w1"]);
      expect(keeper.kept()).toBeUndefined();
    });

    it("archives the want a filing in flight at cleanup returns", async () => {
      const { keeper, filed, archive, archived } = keeperWithHeldCalls();
      const filing = keeper.file();

      const interrupt = keeper.cleanup();

      expect(archived).toEqual([]);
      filed.resolve("w1");
      await filing;
      archive.resolve();
      await interrupt;
      expect(archived).toEqual(["w1"]);
    });

    it("archives once however many times cleanup is asked", async () => {
      const { keeper, filed, archive, archived } = keeperWithHeldCalls();
      filed.resolve("w1");
      archive.resolve();
      await keeper.file();

      await keeper.cleanup();
      await keeper.cleanup();

      expect(archived).toEqual(["w1"]);
    });

    it("archives nothing when nothing was filed or the filing failed", async () => {
      const unfiled = keeperWithHeldCalls();
      await unfiled.keeper.cleanup();
      expect(unfiled.archived).toEqual([]);

      const failing = keeperWithHeldCalls();
      const filing = failing.keeper.file();
      failing.filed.reject(new Error("refused"));
      await expect(filing).rejects.toThrow("refused");
      await failing.keeper.cleanup();
      expect(failing.archived).toEqual([]);
    });

    it("keeps the want counted as kept when its archive fails", async () => {
      const { keeper, filed, archive } = keeperWithHeldCalls();
      filed.resolve("w1");
      await keeper.file();

      const cleanup = keeper.cleanup();
      archive.reject(new Error("conflict"));

      await expect(cleanup).rejects.toThrow("conflict");
      expect(keeper.kept()).toBe("w1");
    });

    it("throws when asked to file after its cleanup began", async () => {
      const { keeper } = keeperWithHeldCalls();
      await keeper.cleanup();

      expect(() => keeper.file()).toThrow("after its cleanup began");
    });
  });

  describe("archiveOnExitSignals()", () => {
    /** The handlers registered by signal, and the statuses exited with. */
    const registered = (cleanup: () => Promise<void>) => {
      const handlers = new Map<Deno.Signal, () => void>();
      const exits = Promise.withResolvers<number>();
      const reports: string[] = [];
      archiveOnExitSignals(
        cleanup,
        (signal, handler) => handlers.set(signal, handler),
        exits.resolve,
        (message) => reports.push(message),
      );
      return { handlers, exited: exits.promise, reports };
    };

    it("registers a handler for SIGTERM, SIGINT and SIGHUP", () => {
      const { handlers } = registered(() => Promise.resolve());

      expect([...handlers.keys()].sort()).toEqual([
        "SIGHUP",
        "SIGINT",
        "SIGTERM",
      ]);
    });

    it("exits 143 on SIGTERM only after the cleanup has finished", async () => {
      const archive = Promise.withResolvers<void>();
      let archived = false;
      const { handlers, exited } = registered(() =>
        archive.promise.then(() => {
          archived = true;
        })
      );

      fire(handlers, "SIGTERM");
      archive.resolve();

      expect(await exited).toBe(143);
      expect(archived).toBe(true);
    });

    it("exits 130 on SIGINT and 129 on SIGHUP", async () => {
      const interrupted = registered(() => Promise.resolve());
      fire(interrupted.handlers, "SIGINT");
      expect(await interrupted.exited).toBe(130);

      const hungUp = registered(() => Promise.resolve());
      fire(hungUp.handlers, "SIGHUP");
      expect(await hungUp.exited).toBe(129);
    });

    it("reports a failed cleanup and exits all the same", async () => {
      const { handlers, exited, reports } = registered(() =>
        Promise.reject(new Error("conflict"))
      );

      fire(handlers, "SIGTERM");

      expect(await exited).toBe(143);
      expect(reports).toEqual(["archiving the marker failed: conflict"]);
    });
  });
});
