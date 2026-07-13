import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { Options } from "../src/storage/v2.ts";
import { Runtime } from "../src/runtime.ts";
import { resolveCellPath } from "../src/piece-helpers.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

// Fresh-replica read asymmetry: writes from one replica commit durably, but a
// second (fresh) replica's reads of the same data used to come back masked —
// `undefined` / "property not found" — whenever the read path carried no
// schema. A schema-less sync normalizes to the rejecting selector and
// delivers only the root doc; link targets the selector never walked read as
// `unclaimed` (silently undefined). The fix kicks a background pull for
// same-space link targets the local replica has never seen (see the hop loop
// in link-resolution.ts and IStorageManager.shouldPullDoc), which
// `Cell.pull()`'s convergence loop awaits — so schema-less pulls now resolve
// to the true value. This suite mirrors the CLI `piece get` read path
// (schema-less cell -> pull() -> resolveCellPath).
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

const signer = await Identity.fromPassphrase("fresh-replica-read-asymmetry");
const space = signer.did();

const entrySchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
  },
} as const satisfies JSONSchema;

const containerSchema = {
  type: "object",
  properties: {
    boardTitle: { type: "string" },
    myName: { type: "string" },
    topics: { type: "array", items: entrySchema },
  },
} as const satisfies JSONSchema;

const CONTAINER_CAUSE = "asymmetry-container";

describe("fresh-replica read asymmetry", () => {
  let server: MemoryV2Server.Server;
  let writerStorage: SharedServerStorageManager;
  let writerRt: Runtime;

  beforeEach(async () => {
    server = newSharedServer();
    writerStorage = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    writerRt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });

    // Writer replica: container whose `topics` entries are LINKS to separate
    // entry cells (the shape addTopic-style handlers produce).
    const tx = writerRt.edit();
    const entry0 = writerRt.getCell(space, "entry-0", entrySchema, tx);
    entry0.set({ title: "T0", body: "B0" });
    const entry1 = writerRt.getCell(space, "entry-1", entrySchema, tx);
    entry1.set({ title: "T1", body: "B1" });
    const entry2 = writerRt.getCell(space, "entry-2", entrySchema, tx);
    entry2.set({ title: "T2", body: "B2" });
    const container = writerRt.getCell(
      space,
      CONTAINER_CAUSE,
      containerSchema,
      tx,
    );
    container.set({
      boardTitle: "the board",
      myName: "gideon-c",
      topics: [entry0, entry1, entry2],
    });
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
    await writerStorage.synced();
  });

  afterEach(async () => {
    await writerRt?.dispose();
    await writerStorage?.close();
    await server?.close();
  });

  function freshReader(): { rt: Runtime; close: () => Promise<void> } {
    const storage = SharedServerStorageManager.connectTo(server, {
      as: signer,
    });
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    return {
      rt,
      close: async () => {
        await rt.dispose();
        await storage.close();
      },
    };
  }

  it("writer's own replica reads everything (control)", async () => {
    const container = writerRt.getCell(space, CONTAINER_CAUSE, containerSchema);
    const value = await container.pull();
    expect(value?.boardTitle).toBe("the board");
    expect(value?.topics?.length).toBe(3);
    expect(value?.topics?.[1]?.title).toBe("T1");
  });

  it("fresh replica, schema'd sync + get resolves linked entries", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(space, CONTAINER_CAUSE, containerSchema);
      await container.sync();
      const value = container.get();
      expect(value?.boardTitle).toBe("the board");
      expect(value?.topics?.length).toBe(3);
      expect(value?.topics?.[0]?.title).toBe("T0");
      expect(value?.topics?.[1]?.title).toBe("T1");
      expect(value?.topics?.[2]?.body).toBe("B2");
    } finally {
      await close();
    }
  });

  it("fresh replica, SCHEMA-LESS pull resolves linked entries", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell<Record<string, unknown>>(
        space,
        CONTAINER_CAUSE,
        undefined,
      );
      const value = (await container.pull()) as {
        boardTitle?: string;
        topics?: { title?: string; body?: string }[];
      };
      expect(value?.boardTitle).toBe("the board");
      // Before the shouldPullDoc kick, these read [null, null, null]: the
      // schema-less sync's rejecting selector delivered only the container
      // root, and the never-pulled entry docs masked as null.
      expect(value?.topics?.length).toBe(3);
      expect(value?.topics?.[0]?.title).toBe("T0");
      expect(value?.topics?.[1]?.title).toBe("T1");
      expect(value?.topics?.[2]?.body).toBe("B2");
    } finally {
      await close();
    }
  });

  it("fresh replica, SCHEMA-LESS pull + per-index path reads (CLI piece get shape)", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell<Record<string, unknown>>(
        space,
        CONTAINER_CAUSE,
        undefined,
      );
      await container.pull();
      // Before the fix each of these threw `Cannot access path ... -
      // property "title" not found` — the CLI's manufactured-data-loss
      // signature (indistinguishable from past-array-end errors).
      expect(resolveCellPath(container, ["boardTitle"])).toBe("the board");
      expect(resolveCellPath(container, ["topics", 0, "title"])).toBe("T0");
      expect(resolveCellPath(container, ["topics", 1, "title"])).toBe("T1");
      expect(resolveCellPath(container, ["topics", 2, "title"])).toBe("T2");
    } finally {
      await close();
    }
  });

  it("fresh replica, schema-less pull converges across a two-hop link chain", async () => {
    // container.topics[N] -> entry doc -> entry.detail -> detail doc: each
    // hop is a doc the rejecting selector never delivered, so convergence
    // needs one kick round per depth level.
    const chainSchema = {
      type: "object",
      properties: {
        detail: {
          type: "object",
          properties: { note: { type: "string" } },
        },
      },
    } as const satisfies JSONSchema;

    const tx = writerRt.edit();
    const detail = writerRt.getCell(
      space,
      "chain-detail",
      { type: "object", properties: { note: { type: "string" } } } as const,
      tx,
    );
    detail.set({ note: "deep note" });
    const chainEntry = writerRt.getCell(space, "chain-entry", chainSchema, tx);
    chainEntry.set({ detail });
    const chainContainer = writerRt.getCell(
      space,
      "chain-container",
      {
        type: "object",
        properties: { entry: chainSchema },
      } as const,
      tx,
    );
    chainContainer.set({ entry: chainEntry });
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const container = rt.getCell<Record<string, unknown>>(
        space,
        "chain-container",
        undefined,
      );
      const value = (await container.pull()) as {
        entry?: { detail?: { note?: string } };
      };
      expect(value?.entry?.detail?.note).toBe("deep note");
    } finally {
      await close();
    }
  });

  it("fresh replica, dangling link reads as absent without stalling pull", async () => {
    // A link to a cell that was never written: the kick pulls, the server
    // reports nothing, and the read settles as undefined/null — one kick
    // only (the shouldPullDoc set), so pull's convergence loop terminates.
    const tx = writerRt.edit();
    const ghost = writerRt.getCell(space, "ghost-entry", entrySchema, tx);
    const holder = writerRt.getCell(
      space,
      "dangling-holder",
      {
        type: "object",
        properties: { present: { type: "string" }, ghost: entrySchema },
      } as const,
      tx,
    );
    holder.set({ present: "here", ghost });
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    const { rt, close } = freshReader();
    try {
      const cell = rt.getCell<Record<string, unknown>>(
        space,
        "dangling-holder",
        undefined,
      );
      const value = (await cell.pull()) as {
        present?: string;
        ghost?: unknown;
      };
      expect(value?.present).toBe("here");
      expect(value?.ghost ?? null).toBeNull();
    } finally {
      await close();
    }
  });

  it("fresh replica, whole-array read under a strict required items schema converges", async () => {
    // Models the topics board: items schema with `required` (strict, not
    // nullable), entries as links. One absent element used to void the WHOLE
    // array (traverseArrayWithSchema's every -> undefined), so a fresh
    // replica read the board's topics as []/undefined while every per-index
    // leaf read worked. The pull must converge to the full array.
    const strictContainerSchema = {
      type: "object",
      properties: {
        topics: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string" },
            },
            required: ["title", "body"],
          },
          default: [],
        },
      },
    } as const satisfies JSONSchema;

    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(
        space,
        CONTAINER_CAUSE,
        strictContainerSchema,
      );
      const value = await container.pull();
      expect(value?.topics?.length).toBe(3);
      expect(value?.topics?.[0]?.title).toBe("T0");
      expect(value?.topics?.[1]?.title).toBe("T1");
      expect(value?.topics?.[2]?.body).toBe("B2");
    } finally {
      await close();
    }
  });

  it("characterization: schema-less sync + one-shot get still shows root only", async () => {
    // get() is synchronous: the hop kick is async, so the FIRST get() after a
    // bare schema-less sync() still masks linked entries. pull() (above) is
    // the converging read; this test documents the remaining get()-vs-pull()
    // semantic so a future change that heals or breaks it is visible.
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell<Record<string, unknown>>(
        space,
        CONTAINER_CAUSE,
        undefined,
      );
      await container.sync();
      const value = container.get() as {
        boardTitle?: string;
        topics?: unknown[];
      };
      expect(value?.boardTitle).toBe("the board");
      expect(value?.topics?.length).toBe(3);
      expect(value?.topics?.every((entry) => entry == null)).toBe(true);
    } finally {
      await close();
    }
  });
});
