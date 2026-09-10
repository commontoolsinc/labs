import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PieceController } from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece input scoped links");

/** The stored form of a per-user slot: a redirect into the user instance. */
const userRedirect = (path: string[]) => ({
  "/": { "link@1": { overwrite: "redirect", path, scope: "user" } },
});

const schema: JSONSchema = {
  type: "object",
  properties: {
    myName: { type: "string" },
    title: { type: "string" },
  },
  required: ["myName", "title"],
};

describe("piece-controller", () => {
  describe("input writes over stored links", () => {
    let storage: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let session: Awaited<ReturnType<typeof createSession>>;
    let pieces: PiecesController;

    beforeEach(async () => {
      storage = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://localhost:9999"),
        storageManager: storage,
      });
      session = await createSession({
        identity: signer,
        spaceName: crypto.randomUUID(),
      });
      pieces = new PiecesController(session, runtime);
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime.dispose();
      await storage.close();
    });

    /** Installs the schema fixture through the normal persistent-piece setup. */
    async function create(input: unknown): Promise<PieceController> {
      const pattern = runtime.unsafeTrustPattern({
        argumentSchema: schema,
        resultSchema: { type: "object", properties: {} },
        result: {},
        nodes: [],
      }, { reason: "stored link input fixture" });
      return new PieceController(
        pieces,
        await pieces.runPersistent(pattern, input, undefined, { start: true }),
      );
    }

    it("writes a sibling of a per-user slot this principal has not written", async () => {
      const piece = await create({
        myName: userRedirect(["myName"]),
        title: "before",
      });

      await piece.input.set("after", ["title"]);

      expect(await piece.input.get(["title"])).toBe("after");
    });

    it("writes the per-user slot itself through its redirect", async () => {
      const piece = await create({
        myName: userRedirect(["myName"]),
        title: "before",
      });

      await piece.input.set("me", ["myName"]);

      expect(await piece.input.get(["myName"])).toBe("me");
    });

    it("still refuses a sibling write when a linked slot holds a readable wrong-typed value", async () => {
      const tx = runtime.edit();
      const other = runtime.getCell(
        session.space,
        "wrong-typed-name",
        { type: "object", properties: { n: { type: "number" } } },
        tx,
      );
      other.set({ n: 42 });
      await tx.commit();
      const piece = await create({
        myName: other.key("n").getAsLink(),
        title: "before",
      });

      await expect(piece.input.set("after", ["title"])).rejects.toThrow(
        /myName: value does not match type string/,
      );
    });

    it("still refuses an explicit `undefined` written at a required slot", async () => {
      const piece = await create({
        myName: userRedirect(["myName"]),
        title: "before",
      });

      await expect(piece.input.set(undefined, ["title"])).rejects.toThrow(
        /title/,
      );
    });
  });
});
