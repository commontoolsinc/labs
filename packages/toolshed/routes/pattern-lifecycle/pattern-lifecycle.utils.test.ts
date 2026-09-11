import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import {
  createAclServer,
  genesisAcl,
  LoopbackSessionFactory,
  TestStorageManager,
} from "@/lib/test-support/memory-acl.ts";
import {
  type LifecycleDeps,
  type LifecycleResult,
  processInstantiate,
  processSetSource,
  processUpload,
} from "./pattern-lifecycle.utils.ts";

const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ seed?: string }, { label: string }>(",
      "  ({ seed }) => ({ label: seed ?? 'unset' }),",
      ");",
      "",
    ].join("\n"),
  }],
};

const NUMERIC_SEED_PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ seed?: number }, { label: string }>(",
      "  ({ seed }) => ({ label: String(seed ?? 0) }),",
      ");",
      "",
    ].join("\n"),
  }],
};

/** Narrow a result to its success body, failing loudly otherwise. */
const ok = <T>(result: LifecycleResult<T>): T => {
  assert(
    result.status === 200,
    `expected 200, got ${result.status}: ${JSON.stringify(result.body)}`,
  );
  return result.body;
};

/** Narrow a result to its refusal, failing loudly otherwise. */
const refused = (result: LifecycleResult<unknown>) => {
  assert(result.status !== 200, "expected a refusal");
  return { status: result.status, ...result.body };
};

describe("pattern-lifecycle verbs (transport half)", () => {
  // Authorization against a real ACL document, and the verbs against a
  // real serving host. The memory server's own enforcement is off so the
  // serving side's loopback sessions need no grant; what is under test is
  // the writer check the route makes against the ACL, and the routing of a
  // verb into the host and of its outcome into a status.

  let server: MemoryV2Server.Server;
  let factory: LoopbackSessionFactory;
  let operator: Identity;
  let alice: Identity;
  let bob: Identity;
  let mallory: Identity;
  let spaceIdentity: Identity;
  let space: string;
  let storageManager: TestStorageManager;
  let runtime: Runtime;
  let host: ExecutorHost | undefined;
  let deps: LifecycleDeps;

  /** A serving host over the test server, holding leases as `serviceDid`. */
  const newHost = (serviceDid: string): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceDid,
      createRuntime: (servedSpace) => {
        const manager = LoopbackStorageManager.connect(server, {
          as: operator,
          servingHomeSpace: servedSpace,
        });
        const serving = new Runtime({
          apiUrl: new URL("https://pl-test.invalid"),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        return Promise.resolve({
          runtime: serving,
          dispose: async () => {
            await serving.dispose();
            await manager.close();
          },
        });
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      ensureSpaceRoots: false,
    });

  beforeEach(async () => {
    server = createAclServer(
      `pattern-lifecycle-${crypto.randomUUID()}`,
      "off",
    );
    factory = new LoopbackSessionFactory(server);
    operator = await Identity.fromPassphrase("pl-operator");
    alice = await Identity.fromPassphrase("pl-alice");
    bob = await Identity.fromPassphrase("pl-bob");
    mallory = await Identity.fromPassphrase("pl-mallory");
    spaceIdentity = await Identity.fromPassphrase("pl-space");
    space = spaceIdentity.did();
    storageManager = TestStorageManager.overServer({ as: operator }, factory);
    runtime = new Runtime({
      apiUrl: new URL("https://pl-test.invalid"),
      storageManager,
    });
    host = newHost(operator.did());
    deps = {
      authority: {
        runtime,
        operatorDid: operator.did(),
        serviceDids: [],
        hostsSpace: () => true,
        aclMode: "enforce",
      },
      host: () => host,
      serviceIdentity: operator,
    };
    await genesisAcl(factory, spaceIdentity, {
      [alice.did()]: "OWNER",
      [bob.did()]: "WRITE",
      [operator.did()]: "READ",
    });
  });

  afterEach(async () => {
    await host?.close();
    await runtime.dispose();
    await storageManager.close();
    await server.close();
  });

  it("refuses a caller the ACL names as a reader only, and one it does not name", async () => {
    const mallorySees = refused(
      await processInstantiate(deps, mallory.did(), {
        space,
        program: PROGRAM,
      }),
    );
    expect(mallorySees.status).toBe(403);
    expect(mallorySees.code).toBe("forbidden");
    const operatorSees = refused(
      await processInstantiate(deps, operator.did(), {
        space,
        program: PROGRAM,
      }),
    );
    expect(operatorSees.status).toBe(403);
    // Refused before the host saw anything.
    expect(host!.stats().lifecycleVerbs.runs).toBe(0);
  });

  it("answers 503 with its own code on a deployment without the serving loop", async () => {
    const seen = refused(
      await processInstantiate(
        { ...deps, host: () => undefined },
        alice.did(),
        { space, program: PROGRAM },
      ),
    );
    expect(seen.status).toBe(503);
    expect(seen.code).toBe("server-execution-off");
  });

  it("refuses a request naming both a program and a pattern, or neither", async () => {
    const both = refused(
      await processInstantiate(deps, alice.did(), {
        space,
        program: PROGRAM,
        pattern: { identity: "x", symbol: "default" },
      }),
    );
    expect(both.status).toBe(400);
    expect(both.code).toBe("invalid-source");
    const neither = refused(
      await processInstantiate(deps, alice.did(), { space }),
    );
    expect(neither.status).toBe(400);
  });

  it("instantiates for an owner and for a writer, and uploads the pattern they share", async () => {
    const created = ok(
      await processInstantiate(deps, alice.did(), {
        space,
        program: PROGRAM,
        argument: { seed: "one" },
      }),
    );
    expect(created.pieceId).toMatch(/\S/);
    expect(created.pattern.symbol).toBe("default");
    const byWriter = ok(
      await processInstantiate(deps, bob.did(), { space, program: PROGRAM }),
    );
    expect(byWriter.pattern).toEqual(created.pattern);

    const uploaded = ok(
      await processUpload(deps, alice.did(), { space, program: PROGRAM }),
    );
    expect(uploaded.pattern).toEqual(created.pattern);
  });

  it("replaces a piece's source for a writer, and maps its refusals to their statuses", async () => {
    const created = ok(
      await processInstantiate(deps, alice.did(), {
        space,
        program: PROGRAM,
      }),
    );
    const updated = ok(
      await processSetSource(deps, bob.did(), {
        space,
        piece: created.pieceId,
        program: NUMERIC_SEED_PROGRAM,
        dangerouslyAllowIncompatibleSchema: true,
      }),
    );
    expect(updated.pieceId).toBe(created.pieceId);
    expect(updated.pattern.identity).not.toBe(created.pattern.identity);
    expect(updated.revisionId).toMatch(/\S/);
    expect(updated.detachedOrigin).toBeNull();

    const incompatible = refused(
      await processSetSource(deps, alice.did(), {
        space,
        piece: created.pieceId,
        program: PROGRAM,
      }),
    );
    expect(incompatible.status).toBe(422);
    expect(incompatible.code).toBe("incompatible");

    const missing = refused(
      await processSetSource(deps, alice.did(), {
        space,
        piece: "no-such-piece",
        program: PROGRAM,
      }),
    );
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("piece-not-found");

    const moved = refused(
      await processSetSource(deps, alice.did(), {
        space,
        piece: created.pieceId,
        program: PROGRAM,
        expectedPattern: created.pattern,
      }),
    );
    expect(moved.status).toBe(409);
    expect(moved.code).toBe("source-moved");

    const reader = refused(
      await processSetSource(deps, mallory.did(), {
        space,
        piece: created.pieceId,
        program: PROGRAM,
      }),
    );
    expect(reader.status).toBe(403);
  });

  it("maps a compile failure to 422", async () => {
    const broken = refused(
      await processInstantiate(deps, alice.did(), {
        space,
        program: {
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: "export default nope;" }],
        },
      }),
    );
    expect(broken.status).toBe(422);
    expect(broken.code).toBe("compile-failed");
  });

  it("answers 500 with its own code when the verb fails for a reason it does not name", async () => {
    const failing = {
      runLifecycleVerb: () => Promise.reject(new Error("the loop fell over")),
    } as unknown as ExecutorHost;
    const seen = refused(
      await processUpload(
        { ...deps, host: () => failing },
        alice.did(),
        { space, program: PROGRAM },
      ),
    );
    expect(seen.status).toBe(500);
    expect(seen.code).toBe("internal");
    expect(seen.error).toContain("the loop fell over");
  });

  it("answers 503 when the space is served elsewhere", async () => {
    // Another holder's unexpired lease: this deployment's host cannot
    // acquire, so the verb cannot run here. The host built in beforeEach
    // activated the space when the genesis session opened, so it parks
    // first, a rival takes the lease, and a fresh host stands in for it.
    await host!.close();
    const rival = newHost((await Identity.fromPassphrase("pl-rival")).did());
    try {
      await rival.runLifecycleVerb(space as MemorySpace, {
        name: "hold",
        run: () => Promise.resolve(undefined),
      });
      host = newHost(operator.did());
      const seen = refused(
        await processInstantiate(deps, alice.did(), {
          space,
          program: PROGRAM,
        }),
      );
      expect(seen.status).toBe(503);
      expect(seen.code).toBe("space-not-served");
    } finally {
      await rival.close();
    }
  });
});
