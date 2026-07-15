import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { combineSchema } from "../src/traverse.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";
import type { Cell } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Regression coverage for CT-1880.
//
// A scoped cell's `.of()` initial is a schema-level default: the value is
// merged into the cell's own schema (`schemaWithDefaultAndScope`) by the
// pattern body, which re-runs in EVERY viewing runtime — so the default is
// locally available in every session. But a lift reads the cell through its
// transformer-lowered input schema, which carries `asCell`/`scope` and no
// `default`. When the reading session's scope partition is unwritten (every
// session except the one that instantiated the piece), the read must fall
// back to the default carried by the cell's own schema on the link — today it
// yields `undefined` instead, because `combineSchema`'s scalar branch drops
// everything but `asCell` from the link schema.

Deno.test("combineSchema preserves a scalar link-schema default the governing schema lacks", () => {
  // The lunch-poll shape: governing (lift input property) schema has no
  // default; the link carries the `.of()` cell's schema, which does.
  const combined = combineSchema(
    { type: "number", asCell: [{ kind: "cell", scope: "session" }] },
    { type: "number", scope: "session", default: 42 },
  );
  expect((combined as { default?: unknown }).default).toEqual(42);

  // Precedence: a governing-schema default wins over the link's.
  const governingWins = combineSchema(
    { type: "number", default: 7 },
    { type: "number", default: 42 },
  );
  expect((governingWins as { default?: unknown }).default).toEqual(7);
});

// Two storage managers sharing ONE in-memory server but with SEPARATE client
// caches and separate memory sessions — the second runtime models a different
// viewer (distinct `session:<did>:<sessionId>` scope partition) loading the
// same piece cold. Mirrors rehydrate-internal-default.test.ts.
class SharedServerStorageManager extends EmulatedStorageManager {
  constructor(as: Identity, server: MemoryV2Server.Server) {
    super({ as, memoryHost: new URL("memory://") }, () => server);
  }
  // The shared server is owned by the test; close only this manager's client.
  override close(): Promise<void> {
    const baseClose = Object.getPrototypeOf(EmulatedStorageManager.prototype)
      .close as (this: EmulatedStorageManager) => Promise<void>;
    return baseClose.call(this);
  }
}

describe("scoped cell default across sessions (CT-1880)", () => {
  let server: MemoryV2Server.Server;
  let sm1: SharedServerStorageManager;
  let sm2: SharedServerStorageManager;

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    });
    sm1 = new SharedServerStorageManager(signer, server);
    sm2 = new SharedServerStorageManager(signer, server);
  });
  afterEach(async () => {
    await sm1?.close();
    await sm2?.close();
    await server?.close();
  });

  it("a session that did not instantiate the piece observes the declared default through a lift", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      // Build the same pattern in both runtimes. This mirrors reality:
      // pattern bodies re-run in every viewing runtime, so the `.of()`
      // default is embedded in each session's local cell schema — the wire
      // carries only the manifest link.
      const makeRoot = (runtime: Runtime) => {
        const { lift, pattern, Writable } =
          createTrustedBuilder(runtime).commonfabric;

        // The transformer-lowered read: input schema carries asCell + scope
        // but NO default, exactly like a lowered `computed(() => today.get())`.
        const readToday = lift(
          ({ today }: { today: Cell<number> }) => today.get(),
          {
            type: "object",
            properties: {
              today: {
                type: "number",
                asCell: [{ kind: "cell", scope: "session" }],
              },
            },
            required: ["today"],
          },
          { type: "number" },
        );

        return pattern<Record<string, never>>(() => {
          // Transformed shape of `Writable.perSession.of<number>(42)`.
          const today = Writable.perSession.of<number>(42, {
            type: "number",
            scope: "session",
          }).for("today", true);
          return { view: readToday({ today }), today };
        }, { type: "object", properties: {} });
      };

      // Session 1 instantiates the piece. Its own partition is seeded, so it
      // observes the initial directly.
      const rc1 = rt1.getCell<{ view: number }>(
        space,
        "scoped-default-cross-session",
      );
      await rt1.runSynced(rc1, makeRoot(rt1), {});
      await rt1.idle();
      await sm1.synced();
      await rc1.pull();
      // The creating session's lift read is ALSO schema-governed: the seed
      // write is skipped when the schema carries a default (getRawUntyped
      // observes the default as an existing value), so this assertion pins
      // the same read-path behavior as session 2, not the seed.
      expect(rc1.key("view").get()).toEqual(42);

      // Session 2 loads the SAME piece cold under a different memory session.
      // Its scope partition for `today` is unwritten; the declared initial
      // must still be observed — this is the CT-1880 regression (currently
      // reads `undefined`).
      const rc2 = rt2.getCell<{ view: number }>(
        space,
        "scoped-default-cross-session",
      );
      await rt2.runSynced(rc2, makeRoot(rt2), {});
      await rt2.idle();
      await sm2.synced();
      await rc2.pull();
      expect(rc2.key("view").get()).toEqual(42);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
