import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("cross-space-value-read");
const spaceH = signer.did(); // "home" — holds the link
const spaceP = (await Identity.fromPassphrase("cross-space target P")).did();

// A storage manager with its OWN per-space client replicas, loopback-connected
// to a SHARED in-process memory server. This is what a real browser/CLI
// session looks like: data written by another session only reaches this one
// through an explicit per-space server query/subscription. The plain
// `StorageManager.emulate` masks CT-1667 in the common test shape because a
// shared manager means shared replicas — reads find data the reader never
// fetched.
class SharedServerStorageManager extends EmulatedStorageManager {
  static connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.sharedServer = server;
    return manager;
  }

  private sharedServer!: MemoryV2Server.Server;

  // The server is SHARED between managers and closed once by the test's
  // afterEach — serve it without ever initializing the base class's private
  // `#server`, whose `close()` would otherwise close the shared server once
  // per manager.
  protected override server(): MemoryV2Server.Server {
    return this.sharedServer;
  }
}

const newSharedServer = () =>
  new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });

// CT-1667: a value READ through a cross-space link never materializes the
// target's fields in a session that didn't create them. The home Profile tab
// binds `cf-profile-badge` (minimal `{name, avatar}` schema) and `cf-render`
// to a profile living in its own space; both show blanks because the
// profile-space docs behind the link are never fetched — derived cell handles
// inherit `synced` from their parent even across the space boundary (where
// the parent's per-space server query cannot have covered them), and the
// schema traversal returns notFound for the absent docs without triggering a
// fetch. Only explicit per-path `.pull()`s on fresh cells (the wish.ts
// workaround) materialize them.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { handler, pattern, Writable } from 'commonfabric';",
        "",
        "export const child = pattern<{ name: string }>(({ name }) => ({",
        "  name,",
        "  greeting: 'hello',",
        "}));",
        "",
        "type ChildOutput = { name: string; greeting: string };",
        "",
        "const create = handler<",
        "  { name?: string },",
        "  { items: Writable<ChildOutput[]> }",
        ">((event, { items }) => {",
        `  items.push(child.inSpace("${spaceP}")({`,
        "    name: event.name ?? 'Ada',",
        "  }) as ChildOutput);",
        "});",
        "",
        "export default pattern(() => {",
        "  const items = new Writable<ChildOutput[]>([]).for('items');",
        "  return { items, create: create({ items }) };",
        "});",
      ].join("\n"),
    },
  ],
};

const RESULT_CAUSE = "cross-space value read parent";

const linkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

// The badge-style minimal read schema on the child.
const nameSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    greeting: { type: "string" },
  },
  // deno-lint-ignore no-explicit-any
} as any;

describe("cross-space value reads (CT-1667)", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: SharedServerStorageManager;
  let readerStorage: SharedServerStorageManager;

  beforeEach(() => {
    server = newSharedServer();
    writerStorage = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    readerStorage = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
  });
  afterEach(async () => {
    await writerStorage?.close();
    await readerStorage?.close();
    await server?.close();
  });

  // Session 1 (writer): create the parent in H and the child in P, fully
  // synced to the server. Returns the H-space parent result link.
  async function createPieces(rt1: Runtime) {
    const tx1 = rt1.edit();
    const parent = await rt1.patternManager.compilePattern(PROGRAM, {
      space: spaceH,
      tx: tx1,
    });
    const resultCell1 = rt1.getCell<Record<string, unknown>>(
      spaceH,
      RESULT_CAUSE,
      undefined,
      tx1,
    );
    // deno-lint-ignore no-explicit-any
    const r1 = rt1.run(tx1, parent as any, {}, resultCell1);
    await tx1.commit();
    await r1.pull();
    r1.key("create").send({ name: "Ada" });
    await r1.pull();
    await rt1.idle();
    // Sanity: the child materialized in P and reads fine in the creating
    // runtime (everything is in its own replicas).
    // deno-lint-ignore no-explicit-any
    const links = r1.key("items").asSchema(linkListSchema).get() as any[];
    expect(links.length).toBe(1);
    expect(links[0].getAsNormalizedFullLink().space).toBe(spaceP);
    await rt1.patternManager.flushCompileCacheWrites();
    await rt1.storageManager.synced();
    return r1.getAsNormalizedFullLink();
  }

  it("pull() + get() through the link materializes the child's fields", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      const parentLink = await createPieces(rt1);

      // Reader session: home-space context. Read the child's field THROUGH
      // the cross-space link, the way a generic consumer (cf-render, a
      // computed) would — no per-path workaround pulls.
      const parentCell = rt2.getCellFromLink(parentLink);
      await parentCell.sync();

      const childField = parentCell.key("items").key(0).key("name");
      // pull() itself must converge — no storageManager.synced() assist (the
      // convergence loop awaits the kicked cross-space loads).
      const pulled = await childField.pull();
      expect(pulled).toBe("Ada");
      expect(childField.get()).toBe("Ada");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  // This is THE regression guard: red without the fix (the deep value read
  // goes through traverse's followPointer, which had no fetch trigger at
  // all). The key-path-pull and sink steps above/below converge through
  // link-resolution's pre-existing cross-space kick under loopback timing —
  // they pin the contract but already passed on main in this harness.
  it("a whole-value pull() of the linking parent materializes the child", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      const parentLink = await createPieces(rt1);

      const parentCell = rt2.getCellFromLink(parentLink);
      await parentCell.sync();
      // Pull the parent's whole items value (deep) — the cross-space child is
      // part of it. This is the "naive resolve" shape from the issue.
      const itemsCell = parentCell.key("items");
      await itemsCell.pull();
      // deno-lint-ignore no-explicit-any
      const items = itemsCell.get() as any[];
      expect(Array.isArray(items)).toBe(true);
      expect(items.length).toBe(1);
      expect(items[0]?.name).toBe("Ada");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });

  it("sink() with a minimal schema on the child link fires with the value", async () => {
    const rt1 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    const rt2 = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerStorage,
    });
    try {
      const parentLink = await createPieces(rt1);

      const parentCell = rt2.getCellFromLink(parentLink);
      await parentCell.sync();
      // Resolve the child link to a cell (what cf-profile-badge does with
      // $profile) and subscribe with a minimal schema. NOTE: derived from the
      // parent's read — the handle inherits the parent's synced state.
      // deno-lint-ignore no-explicit-any
      const links = parentCell.key("items").asSchema(linkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(links.length).toBe(1);
      const childCell = links[0].asSchema(nameSchema);

      // deno-lint-ignore no-explicit-any
      const seen: any[] = [];
      const cancel = childCell.sink((value: unknown) => {
        seen.push(value);
      });
      await rt2.idle();
      await rt2.storageManager.synced();
      await rt2.idle();
      cancel();
      const last = seen.at(-1);
      expect(last?.name).toBe("Ada");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
