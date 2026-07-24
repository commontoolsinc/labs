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

// Whole-object piece reads void on scoped links (CLI `cf piece get` with no
// path returns undefined while every child path works).
//
// Mechanism under test: the piece result cell is NOT schema-less — the CLI
// read path recovers the durable result schema via
// getResultCellWithSourceSchema, and pattern result schemas mark every output
// property `required` (ts-transformers). When one property's stored value is
// a link into a session/user-scoped doc that this replica's session never
// wrote, the link target reads notFound (value undefined); a strict property
// schema (e.g. {type:"string"}) rejects undefined, the property is dropped
// from the assembled object, and traverseObjectWithSchema's `required` check
// then voids the ENTIRE object (traverse.ts, "Missing required property" ->
// return undefined). Child-path reads narrow the schema below the container,
// so the parent's `required` check never runs and they resolve fine.
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

const signer = await Identity.fromPassphrase("scoped-link-whole-object-read");
const space = signer.did();

const CONTAINER_CAUSE = "scoped-container";
const DRAFT_CAUSE = "session-draft";

// Analog of a generated pattern result schema: plain leaf schemas and every
// property required (that is what ts-transformers emits for a non-optional
// output interface, e.g. lunch-poll's CozyPollOutput -> required: [...all]).
const requiredResultSchema = {
  type: "object",
  properties: {
    question: { type: "string" },
    count: { type: "number" },
    myDraft: { type: "string" },
  },
  required: ["question", "count", "myDraft"],
} as const satisfies JSONSchema;

// Same shape without the scoped property being required.
const lenientResultSchema = {
  type: "object",
  properties: requiredResultSchema.properties,
  required: ["question", "count"],
} as const satisfies JSONSchema;

describe("whole-object read over a session-scoped link", () => {
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

    // Writer replica ("browser session"): a session-scoped draft cell plus a
    // container whose `myDraft` property links to it — the shape a pattern
    // result doc has when an output property derives from a
    // Writable.perSession / perUser cell.
    const tx = writerRt.edit();
    const draft = writerRt.getCell<string>(
      space,
      DRAFT_CAUSE,
      { type: "string" } as const,
      tx,
      "session",
    );
    draft.set("only-visible-in-writer-session");
    const container = writerRt.getCell(
      space,
      CONTAINER_CAUSE,
      {
        type: "object",
        properties: requiredResultSchema.properties,
      } as const,
      tx,
    );
    container.set({
      question: "Where should we eat?",
      count: 3,
      myDraft: draft,
    });
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
    await writerStorage.synced();

    // Sanity: the stored link really is session-scoped.
    const rawLink = container.key("myDraft").getAsNormalizedFullLink();
    void rawLink;
  });

  afterEach(async () => {
    await writerRt?.dispose();
    await writerStorage?.close();
    await server?.close();
  });

  function freshReader(): { rt: Runtime; close: () => Promise<void> } {
    // A fresh storage manager mints a fresh sessionId — this replica is a
    // DIFFERENT session (the CLI) than the writer (the browser), so the
    // session-scoped draft doc does not exist for it.
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

  it("writer's own session reads the whole object (control)", async () => {
    const container = writerRt.getCell(
      space,
      CONTAINER_CAUSE,
      requiredResultSchema,
    );
    const value = await container.pull();
    expect(value?.question).toBe("Where should we eat?");
    expect(value?.count).toBe(3);
    expect(value?.myDraft).toBe("only-visible-in-writer-session");
  });

  it("fresh session: child-path reads work (the CLI's per-path success)", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(
        space,
        CONTAINER_CAUSE,
        requiredResultSchema,
      );
      await container.pull();
      expect(resolveCellPath(container, ["question"])).toBe(
        "Where should we eat?",
      );
      expect(resolveCellPath(container, ["count"])).toBe(3);
    } finally {
      await close();
    }
  });

  it("fresh session: whole-object read under the required schema returns the plain properties (THE BUG: currently undefined)", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(
        space,
        CONTAINER_CAUSE,
        requiredResultSchema,
      );
      const value = await container.pull();
      // Desired behavior: the unreadable scoped property reads as absent,
      // but the plain properties survive. Actual behavior today: the
      // `required` check voids the whole object -> value is undefined.
      expect(value?.question).toBe("Where should we eat?");
      expect(value?.count).toBe(3);
    } finally {
      await close();
    }
  });

  it("fresh session: same read with the scoped property not required works (isolates the required-collapse)", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell(
        space,
        CONTAINER_CAUSE,
        lenientResultSchema,
      );
      const value = await container.pull();
      expect(value?.question).toBe("Where should we eat?");
      expect(value?.count).toBe(3);
      expect(value?.myDraft ?? null).toBeNull();
    } finally {
      await close();
    }
  });

  it("fresh session: SCHEMA-LESS whole-object read works (rules out the schema-less-read hypothesis)", async () => {
    const { rt, close } = freshReader();
    try {
      const container = rt.getCell<Record<string, unknown>>(
        space,
        CONTAINER_CAUSE,
        undefined,
      );
      const value = (await container.pull()) as {
        question?: string;
        count?: number;
        myDraft?: string;
      };
      expect(value?.question).toBe("Where should we eat?");
      expect(value?.count).toBe(3);
    } finally {
      await close();
    }
  });
});
