import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

// Resume owned-cell pre-sync for a pattern with a static nested sub-pattern node.
//
// On a cold resume, the runner walks the pattern tree and pre-syncs each
// sub-pattern's owned (derived internal) cells before instantiation, so the
// resume instantiation commit reads confirmed-loaded state and stays
// read-mostly. The walk derives each child node's result cell from its output
// redirect, resolved the same way the minting path resolves it.
//
// This is a coverage-and-smoke test: it drives the owned-cell walk and its
// redirect resolution and asserts the nested value survives a cold reload. It
// does not by itself distinguish resolving the redirect to its end from taking
// the unresolved head, because this single-hop binding makes those the same
// cell — the multi-hop case where they differ is exercised by the home
// rehydration churn integration test (nested profile patterns), which would
// regress to commit churn if the walk pre-synced the wrong subtree.

const signer = await Identity.fromPassphrase("resume owned cells");
const space = signer.did();

function plainLoopback(
  server: MemoryV2Server.Server,
): MemoryV2Client.Transport {
  return MemoryV2Client.loopback(server);
}

class LoopbackSessionFactory implements SessionFactory {
  constructor(private readonly getServer: () => MemoryV2Server.Server) {}
  async create(spaceId: string, sgnr?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: plainLoopback(this.getServer()),
    });
    const session = await client.mount(spaceId, {}, () => ({
      invocation: {},
      authorization: { principal: sgnr?.did() },
    }));
    return { client, session };
  }
}

class LoopbackStorageManager extends StorageManager {
  static make(
    as: Identity,
    server: MemoryV2Server.Server,
  ): LoopbackStorageManager {
    return new LoopbackStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      server,
    );
  }
  private constructor(options: Options, server: MemoryV2Server.Server) {
    super(options, new LoopbackSessionFactory(() => server));
  }
  override registerSpaceHost(): boolean {
    return false;
  }
}

// An outer pattern that statically composes an inner sub-pattern; the inner
// pattern keeps a derived internal cell (the lifted scaled value), so the resume
// walk has an owned cell to pre-sync for the nested node.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { lift, pattern } from 'commonfabric';",
      "const scale = lift((n: number) => n * 10);",
      "const inner = pattern<{ n: number }>(({ n }) => {",
      "  return { scaled: scale(n) };",
      "});",
      "export default pattern<{ seed: number }>(({ seed }) => {",
      "  const child = inner({ n: seed });",
      "  return { value: child.scaled };",
      "});",
    ].join("\n"),
  }],
};

describe("resume owned-cell pre-sync", () => {
  let server: MemoryV2Server.Server;
  let sm1: LoopbackStorageManager;
  let sm2: LoopbackStorageManager;

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
    });
    sm1 = LoopbackStorageManager.make(signer, server);
    sm2 = LoopbackStorageManager.make(signer, server);
  });
  afterEach(async () => {
    await sm1?.close();
    await sm2?.close();
    await server?.close();
  });

  it("resumes a nested sub-pattern's value from durable state", async () => {
    // CREATE (runtime A): run the composed pattern and persist its value.
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm1,
    });
    const compiled1 = await rt1.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx0 = rt1.edit();
    const rc1 = rt1.getCell<{ value: number }>(
      space,
      "owned-result",
      compiled1.resultSchema,
      tx0,
    );
    const h1 = rt1.run(tx0, compiled1, { seed: 7 }, rc1);
    await tx0.commit();
    for (let k = 0; k < 10; k++) {
      await h1.pull();
      await rt1.idle();
    }
    await rt1.patternManager.flushCompileCacheWrites();
    await sm1.synced();
    expect(rc1.key("value").get()).toBe(70);
    rt1.scheduler.dispose();

    // RESUME (runtime B): cold cache. start() walks the pattern tree and
    // pre-syncs the nested node's owned cells before instantiating.
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm2,
    });
    try {
      await rt2.patternManager.compilePattern(PROGRAM, { space });
      const tx = rt2.edit();
      const rc2 = rt2.getCell<{ value: number }>(
        space,
        "owned-result",
        compiled1.resultSchema,
        tx,
      );
      await tx.commit();

      const started = await rt2.start(rc2);
      expect(started).toBe(true);

      for (let k = 0; k < 10; k++) {
        await rc2.pull();
        await rt2.idle();
      }
      expect(rc2.key("value").get()).toBe(70);
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
