// The (2-D) serve-time closure kick of the ruled 3b close
// (verification-coverage.md OW45, RULING 2026-08-28): the sidecar pattern
// cache is process-global while a serving runtime serves MANY spaces, and
// its compile persists a closure only into the FIRST demanding space — so
// every later space is served a pattern whose closure was never persisted
// THERE, and a cross-space child replication out of such a space finds its
// origin dry (the lunch host-join park's supplier hole, one channel of
// it). The kick: serving a cached sidecar pattern for a space other than
// the one it compiled into fires the same fire-and-forget
// replicate-into-the-demanding-space the content-cache hit fires, so the
// space's closure supplier is REGISTERED at page-serve time — before any
// create-profile click can issue the child replication, whose
// strictly-older-ticket await then covers the race by registration
// instead of healing after the fact.
//
// This file pins the cache-level mechanism (`ensureClosureReplicated` and
// the fetch-side kick for chained demanders) against real storage: the
// demanding space ends up holding a loadable closure, exactly once per
// (cache epoch, space). The wish launch arms wire the same call under
// `runtime.servingPosture` (see wish.ts); the serving-stack end-to-end
// coverage is the lunch surface itself (the arc's campaign + direct-CI
// probe).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
} from "../src/compilation-cache/cell-cache.ts";
import {
  getPatternEnvironment,
  setPatternEnvironment,
} from "../src/builder/env.ts";
import { createSidecarPatternCache } from "../src/builtins/wish.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("sidecar closure kick test");
const spaceA = signer.did() as MemorySpace; // the first demander: compile target
const spaceB = (await Identity.fromPassphrase(
  "sidecar closure kick second space",
)).did() as MemorySpace; // a later cached-serve demander
const spaceC = (await Identity.fromPassphrase(
  "sidecar closure kick chained space",
)).did() as MemorySpace; // a demander chained through fetch()

const KICK_PATTERN_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern(() => ({ label: 'kick pin' }));",
].join("\n");

describe("sidecar cache serve-time closure kick", () => {
  let server: MemoryV2Server.Server;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let originalFetch: typeof globalThis.fetch;
  let originalEnvironment: ReturnType<typeof getPatternEnvironment>;

  beforeEach(async () => {
    server = newSharedServer();
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    originalFetch = globalThis.fetch;
    originalEnvironment = getPatternEnvironment();
    // A unique pattern-environment origin keys this test's entries in the
    // module-global URL-keyed caches; the stub serves the pin's pattern.
    setPatternEnvironment({
      apiUrl: new URL("https://sidecar-closure-kick.test/"),
    });
    globalThis.fetch = ((input: Request | URL | string) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("closure-kick-pin.tsx")) {
        return Promise.resolve(
          new Response(KICK_PATTERN_SOURCE, { status: 200 }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as typeof fetch;
    // World-writable genesis for the kick targets: the write-backs into
    // them are ordinary client-shaped commits by `signer`.
    for (const space of [spaceB, spaceC]) {
      Engine.applyCommit(await server.engineForSpace(space), {
        sessionId: "test-genesis-session",
        space,
        principal: space,
        commit: {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { "did:key:alice": "OWNER", "*": "WRITE" } },
          }],
        },
      });
    }
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    setPatternEnvironment(originalEnvironment);
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  /** The closure identities readable for `entry` in `space` on a fresh
   * transaction (the replication's own read shape). */
  const readableClosure = async (
    rt: Runtime,
    space: MemorySpace,
    entryIdentity: string,
  ): Promise<{ source: string[]; compiled: string[] }> => {
    const runtimeVersion = await getCompileCacheRuntimeVersion();
    const readTx = rt.edit();
    try {
      const source = await loadVerifiedSourceClosure(
        rt,
        space,
        entryIdentity,
        readTx,
      );
      const compiled = runtimeVersion === undefined
        ? new Map<string, unknown>()
        : await loadCompiledClosure(
          rt,
          space,
          entryIdentity,
          { runtimeVersion },
          readTx,
        );
      return {
        source: [...(source?.keys() ?? [])],
        compiled: [...compiled.keys()],
      };
    } finally {
      readTx.abort?.("closure kick pin read");
    }
  };

  it(
    "a cached sidecar pattern served for a SECOND space replicates its " +
      "closure there — once per space, never for the compile space, " +
      "never without a demanding space",
    async () => {
      const cache = createSidecarPatternCache({
        name: "closure-kick-pin.tsx",
        compileInUserSpace: true,
      });
      // First demander: the fetch compiles into A (the closure persists
      // THERE and only there — the process-global cache's whole hazard).
      const pattern = await cache.fetch(runtime, undefined, spaceA);
      expect(pattern).toBeDefined();
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();
      const entry = runtime.patternManager.getArtifactEntryRef(pattern!);
      if (entry === undefined) throw new Error("no entry ref for the pattern");

      // Count the kicks through the manager's replication entry point.
      const pm = runtime.patternManager as unknown as {
        replicatePatternToSpace?: (...args: unknown[]) => void;
      };
      const real = runtime.patternManager.replicatePatternToSpace.bind(
        runtime.patternManager,
      );
      let replications = 0;
      pm.replicatePatternToSpace = (...args: unknown[]) => {
        replications++;
        (real as (...a: unknown[]) => void)(...args);
      };
      try {
        // The cached-serve arm for a LATER space: kick fires exactly once.
        cache.ensureClosureReplicated(runtime, spaceB);
        expect(replications).toBe(1);
        // Dedupe: a repeat serve for the same space is free.
        cache.ensureClosureReplicated(runtime, spaceB);
        expect(replications).toBe(1);
        // The compile space needs no kick (its closure is already there).
        cache.ensureClosureReplicated(runtime, spaceA);
        expect(replications).toBe(1);
        // No demanding space (a client-side serve) — no kick.
        cache.ensureClosureReplicated(runtime, undefined);
        expect(replications).toBe(1);
      } finally {
        delete pm.replicatePatternToSpace;
      }
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      // THE PIN: the second space holds the closure — its supplier ran at
      // serve time, so a later child replication out of B has a wet
      // origin (and, mid-flight, a REGISTERED one the ticket await sees).
      const target = await readableClosure(runtime, spaceB, entry.identity);
      expect(target.source).toContain(entry.identity);
      const rt2 = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { serverExecution: true },
      });
      try {
        const loaded = await rt2.patternManager.loadPatternByIdentity(
          entry.identity,
          entry.symbol,
          spaceB,
        );
        expect(loaded).toBeDefined();
      } finally {
        await rt2.dispose();
      }
    },
  );

  it(
    "a demander CHAINED through fetch() for a space the fetch did not " +
      "compile into gets its kick from the fetch itself (the launch arms " +
      "pass the demanding space; the memoized fetch would otherwise drop " +
      "it on the floor)",
    async () => {
      const cache = createSidecarPatternCache({
        name: "closure-kick-pin.tsx",
        compileInUserSpace: true,
      });
      // The fetch that compiles (into A).
      const pattern = await cache.fetch(runtime, undefined, spaceA);
      expect(pattern).toBeDefined();
      // A later demander for space C goes through the SAME fetch() —
      // memoized — and its space must not be dropped: the fetch-side
      // kick replicates the closure into C.
      const chained = await cache.fetch(runtime, undefined, spaceC);
      expect(chained).toBe(pattern);
      await runtime.patternManager.flushCompileCacheWrites();
      // The chained kick fires from a continuation on the fetch promise;
      // a second flush observes the replication it registered.
      await runtime.patternManager.flushCompileCacheWrites();
      await storageManager.synced();

      const entry = runtime.patternManager.getArtifactEntryRef(pattern!);
      if (entry === undefined) throw new Error("no entry ref for the pattern");
      const target = await readableClosure(runtime, spaceC, entry.identity);
      expect(target.source).toContain(entry.identity);
    },
  );
});
