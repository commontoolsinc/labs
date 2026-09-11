/**
 * Drives the serving loop end to end under `SpaceServerPolicy.storeReadThrough`
 * — a real memory server, its engine, a client runtime committing over the
 * loopback wire, and the SpaceServer's serving runtime — and checks that the
 * serving runtime reads its home space from the engine: it registers no
 * session watch, it derives from documents it read on first access, and an
 * authored commit landing after its reads reaches it through the feed's
 * refresh rather than through a frame. The piece is instantiated by a
 * separate, short-lived runtime before the host exists, so the serving
 * structure comes up through the demand loader after activation, and every
 * read reaches the engine through the read-through the SpaceServer itself
 * installed from the policy. The posture off is the control.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import type { FabricValue } from "@commonfabric/api";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { type Options, SpaceReplica } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import { engineReadThrough } from "../src/executor/engine-read-through.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import {
  type RuntimeFactoryContext,
  type SpaceServerPolicy,
  STORE_REFRESH_ATTEMPTS,
} from "../src/executor/space-server.ts";
import { readWatermarkSeq, waitForSettled } from "../src/executor/watermark.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";
import { waitUntil } from "./support/wait-until.ts";

class SharedServerStorageManager extends EmulatedStorageManager {
  /**
   * Delegates to the base `connectTo()`: `new this` gives back this subclass,
   * and the base clears server ownership so closing this manager never closes
   * the shared server.
   */
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    return super.connectTo(server, options) as SharedServerStorageManager;
  }
}

const spaceSigner = await Identity.fromPassphrase("read-through space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("read-through service");
const aliceSigner = await Identity.fromPassphrase("read-through alice");
/** The instantiating runtime's identity: not the service's, so that the
 * session it leaves behind in the registry (a closed connection's sessions
 * linger for the resume window) never counts among the serving runtime's
 * sessions when the test inspects their watches. */
const creatorSigner = await Identity.fromPassphrase("read-through creator");

/**
 * The `{ total }` result schema of the pattern served below. The client
 * reads the result under it, so its watch crosses from `total` to the
 * computed document behind it: that crossing is the demand the serving loop
 * loads the piece for and runs the derivation under.
 */
const TOTAL_RESULT_SCHEMA = {
  type: "object",
  properties: { total: { type: "number" } },
  required: ["total"],
} as const satisfies JSONSchema;

describe("engine-read-through", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let clientManager: SharedServerStorageManager;
  let clientRuntime: Runtime;

  /** How the serving manager's feed refresh is made to fail, when it is:
   * `once` throws on the first refresh and delegates from then on,
   * `always` throws on every refresh. */
  let failRefreshes: "once" | "always" | undefined;
  let refreshCalls = 0;

  /** The context the SpaceServer handed the runtime factory at the last
   * activation. The factory does not install what it carries — it reads
   * nothing before returning — so the SpaceServer's own install is what
   * the tests exercise. */
  let factoryContext: RuntimeFactoryContext | undefined;

  /** The serving manager the factory built at the last activation. */
  let factoryManager: SharedServerStorageManager | undefined;

  const newHost = (policy: SpaceServerPolicy): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: (_space, context) => {
        factoryContext = context;
        const manager = SharedServerStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        factoryManager = manager;
        const integrate = manager.integrateStoreWrites.bind(manager);
        manager.integrateStoreWrites = (writeSpace, writes) => {
          refreshCalls += 1;
          if (
            failRefreshes === "always" ||
            (failRefreshes === "once" && refreshCalls === 1)
          ) {
            throw new Error("induced store refresh failure");
          }
          return integrate(writeSpace, writes);
        };
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy,
    });

  /**
   * Instantiates the piece — a pattern deriving `total = n + 1` — through a
   * short-lived runtime that leaves before the host exists. Nothing else
   * writes the space while it runs, so its commit lands first time, and its
   * local run dies with it: from then on only a server-started piece derives
   * anything.
   */
  const instantiatePiece = async (): Promise<void> => {
    const manager = SharedServerStorageManager.connectTo(server, {
      as: creatorSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    try {
      const compiled = await runtime.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { computed, pattern } from 'commonfabric';",
            "export default pattern<{ n: number }, { total: number }>(",
            "  ({ n }) => ({ total: computed(() => n + 1) }),",
            ");",
          ].join("\n"),
        }],
      }, { space });
      const argument = runtime.getCell<{ n: number }>(
        space,
        "read-through-arg",
        undefined,
      );
      const result = runtime.getCell<{ total: number }>(
        space,
        "read-through-result",
        compiled.resultSchema,
      );
      await argument.sync();
      await result.sync();
      const tx = runtime.edit();
      runtime.run(tx, compiled, argument, result);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
    } finally {
      await runtime.dispose();
      await manager.close();
    }
  };

  /** The service principal's live sessions on the space. */
  const serviceSessions = () =>
    server.accessForTestingOnly.sessionsForSpace(space).filter((session) =>
      session.principal === serviceSigner.did()
    );

  /**
   * Opens the client's demand on the result document under its schema,
   * which activates the space and has the serving loop load the piece, and
   * waits for the SpaceServer to be serving. Returns the client's result and
   * argument cells.
   */
  const demandFromClient = async (): Promise<{
    clientResult: Cell<{ total: number }>;
    clientArg: Cell<{ n: number }>;
  }> => {
    const clientResult = clientRuntime.getCell<{ total: number }>(
      space,
      "read-through-result",
      TOTAL_RESULT_SCHEMA,
    );
    await clientResult.sync();
    await waitUntil(
      () => host?.spaceServer(space)?.active === true,
      "the SpaceServer to activate on the client's session",
    );
    const clientArg = clientRuntime.getCell<{ n: number }>(
      space,
      "read-through-arg",
      undefined,
    );
    await clientArg.sync();
    return { clientResult, clientArg };
  };

  /** Commits `n` from the client and waits for the serving loop's derived
   * `total` to reach the client's subscription. */
  const deriveFromClient = async (
    clientArg: Cell<{ n: number }>,
    clientResult: Cell<{ total: number }>,
    n: number,
  ): Promise<void> => {
    const engine = await server.engineForSpace(space);
    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n });
    expect((await tx.commit()).error).toBeUndefined();
    const authoredSeq = Engine.serverSeq(engine);
    await waitUntil(
      () => readWatermarkSeq(engine) >= authoredSeq,
      "watermark to reach the authored commit",
    );
    const settled = await waitForSettled(clientRuntime, space, authoredSeq, {
      timeoutMs: 10_000,
    });
    expect(settled).toBeGreaterThanOrEqual(authoredSeq);
    await waitUntil(
      () => clientResult.key("total").get() === n + 1,
      `client to observe the derived value ${n + 1}`,
    );
  };

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    });
    failRefreshes = undefined;
    refreshCalls = 0;
    factoryContext = undefined;
    clientManager = SharedServerStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    clientRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: clientManager,
    });
  });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    await clientRuntime.dispose();
    await clientManager.close();
    await server.close();
  });

  it("derives from engine reads with no session watch, and refreshes a held document from the feed when a later authored commit writes it", async () => {
    await instantiatePiece();
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    });
    const { clientResult, clientArg } = await demandFromClient();
    // The SpaceServer offers the factory the tenure's read-through, so a
    // factory that reads before returning can install it ahead of that.
    expect(factoryContext?.storeReadThrough).toBeDefined();

    await deriveFromClient(clientArg, clientResult, 41);
    // A serving runtime under the posture may open no session at all —
    // nothing it did here needed one: reads came from the engine and the
    // wave committed through the engine sink — and any it does open
    // carries no watch.
    for (const session of serviceSessions()) {
      expect(session.watches).toEqual([]);
    }
    const readsAfterFirst = host.stats().storeReads;
    expect(readsAfterFirst).toBeGreaterThan(0);
    // A refresh touches only what the replica holds: nothing to list, or
    // an instance it never read, refreshes nothing and reads nothing.
    expect(factoryManager!.integrateStoreWrites(space, [])).toBe(0);
    expect(
      factoryManager!.integrateStoreWrites(space, [
        { id: "of:never-read", scopeKey: "space" },
      ]),
    ).toBe(0);
    expect(host.stats().storeReads).toBe(readsAfterFirst);

    // The second write lands after the serving runtime read the argument
    // document; with no watch on it, only the feed refresh can move it.
    await deriveFromClient(clientArg, clientResult, 100);
    expect(host.stats().storeRefreshes).toBeGreaterThan(0);
    expect(host.stats().storeReads).toBeGreaterThan(readsAfterFirst);
    for (const session of serviceSessions()) {
      expect(session.watches).toEqual([]);
    }
  });

  it("registers session watches and performs no engine reads with the posture off", async () => {
    await instantiatePiece();
    host = newHost({ flushDeadlineMs: 5_000, idleParkMs: 600_000 });
    const { clientResult, clientArg } = await demandFromClient();
    expect(factoryContext?.storeReadThrough).toBeUndefined();

    await deriveFromClient(clientArg, clientResult, 41);
    expect(serviceSessions().some((session) => session.watches.length > 0))
      .toBe(true);
    expect(host.stats().storeReads).toBe(0);
    expect(host.stats().storeRefreshes).toBe(0);
  });

  it("holds a feed record whose refresh failed for the next cycle, and derives from it once the retry succeeds, in the same tenure", async () => {
    failRefreshes = "once";
    await instantiatePiece();
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    });
    const { clientResult, clientArg } = await demandFromClient();
    const tenure = host.spaceServer(space);

    await deriveFromClient(clientArg, clientResult, 41);
    expect(refreshCalls).toBeGreaterThanOrEqual(2);
    expect(host.spaceServer(space)).toBe(tenure);
    expect(tenure?.active).toBe(true);
  });

  it("parks the space after a feed record's refresh has failed on consecutive cycles up to the bound", async () => {
    failRefreshes = "always";
    await instantiatePiece();
    host = newHost({
      flushDeadlineMs: 5_000,
      idleParkMs: 600_000,
      storeReadThrough: true,
    });
    const { clientArg } = await demandFromClient();
    const tenure = host.spaceServer(space)!;

    const tx = clientRuntime.edit();
    clientArg.withTx(tx).set({ n: 41 });
    expect((await tx.commit()).error).toBeUndefined();
    await tenure.whenParked;
    expect(tenure.active).toBe(false);
    expect(refreshCalls).toBe(STORE_REFRESH_ATTEMPTS);
  });

  it("returns nothing for every address once the engine's database is closed", async () => {
    // A separate server, so closing its engine here leaves the suite's own
    // teardown nothing to close twice.
    const closing = new MemoryV2Server.Server({
      subscriptionRefreshDelayMs: 0,
      authorizeSessionOpen: () => aliceSigner.did(),
      sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
    });
    const engine = await closing.engineForSpace(space);
    let reads = 0;
    const read = engineReadThrough(engine, {
      onRead: () => {
        reads += 1;
      },
    });
    const absent = read({ id: "of:never-written" as never, scopeKey: "space" });
    expect(absent).toEqual({
      branch: "",
      id: "of:never-written",
      scope: "space",
      scopeKey: "space",
      seq: 0,
      deleted: true,
    });
    expect(reads).toBe(1);
    // A replica served by it reads the same way: before the close a miss
    // is served, after it a miss stays a miss and a sync resolves with
    // nothing.
    const manager = SharedServerStorageManager.connectTo(closing, {
      as: serviceSigner,
    });
    try {
      manager.installStoreReadThrough(space, read);
      const provider = manager.open(space);
      expect(provider.replica.getDocument("of:never-written" as URI))
        .toBeUndefined();
      expect(reads).toBe(2);
      await closing.close();
      expect(provider.replica.getDocument("of:closed-late" as URI))
        .toBeUndefined();
      expect((await provider.sync("of:closed-late" as URI)).ok).toBeDefined();
      expect(reads).toBe(2);
    } finally {
      await manager.close();
    }
    expect(read({ id: "of:never-written" as never, scopeKey: "space" }))
      .toBeUndefined();
    expect(reads).toBe(2);
  });

  it("reads the schema documents a document's link positions name, and the documents those name in turn, along with it", async () => {
    // The chase the frame validator's delivery guarantee needs, over a
    // store of three documents: a carrier whose link carries a schema
    // reference, the schema document that reference names, and the
    // schema document THAT one's own refs name. One read of the carrier
    // integrates all three.
    const decomposed = decomposeSchema({
      type: "object",
      properties: { leaf: { $ref: "#/$defs/Leaf" } },
      $defs: {
        Leaf: { type: "object", properties: { text: { type: "string" } } },
      },
    });
    const store = new Map<string, FabricValue>(
      [...decomposed.documents].map((
        [hash, document],
      ) => [`cid:${hash}`, document as FabricValue]),
    );
    const carried = {
      "/": {
        "link@1": {
          id: "of:chase-target",
          path: [],
          schema: { $ref: decomposed.rootRef },
        },
      },
    };
    store.set("of:chase-carrier", { carried });
    const reads: string[] = [];
    const manager = SharedServerStorageManager.connectTo(server, {
      as: serviceSigner,
    });
    try {
      manager.installStoreReadThrough(space, ({ id, scopeKey }) => {
        reads.push(id);
        const value = store.get(id);
        return {
          branch: "",
          id,
          scope: "space",
          scopeKey,
          ...(value === undefined
            ? { seq: 0, deleted: true as const }
            : { seq: 1, doc: { value } }),
        };
      });
      // The class, for the persisted-content probe the interface does
      // not carry.
      const replica = manager.open(space).replica as SpaceReplica;
      expect(replica.getDocument("of:chase-carrier" as URI)).toEqual({
        value: { carried },
      });
      // Dependency-first in the decomposition, so the chase — which reads
      // the referrer before what it references — runs it in reverse.
      expect(reads).toEqual([
        "of:chase-carrier",
        ...[...decomposed.documents.keys()].reverse().map((hash) =>
          `cid:${hash}`
        ),
      ]);
      for (const hash of decomposed.documents.keys()) {
        expect(replica.isContentAddressedDocPersisted(hash)).toBe(true);
      }
    } finally {
      await manager.close();
    }
  });
});
