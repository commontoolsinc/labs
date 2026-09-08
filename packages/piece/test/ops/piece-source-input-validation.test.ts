/**
 * Source-update validation over linked and scoped inputs, including retained
 * profile handles whose producer enforces its own write policy.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import {
  getPieceSourceSnapshot,
  isLink,
  parseLinkOrThrow,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import {
  assertSuppliedLinkSchemasCompatible,
  type PieceController,
} from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("source input validation");

function program(version: string, avatarType = "string"): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `
import { Cell, Default, pattern, PerSpace, PerUser } from "commonfabric";
interface Profile { name: string; }
interface Row { profile: Cell<Profile>; count: number; note?: string; }
interface Input {
  viewer?: PerUser<{ name?: string } | Default<{}>>;
  rows?: PerSpace<Row[] | Default<[]>>;
  host?: { profile?: Cell<{ avatar?: ${avatarType} }> };
}
export default pattern<Input, { version: string; count: number }>(
  ({ rows }) => ({ version: ${JSON.stringify(version)}, count: rows.length }),
);
`,
    }],
  };
}

describe("piece-controller", () => {
  describe("source input validation", () => {
    let storage: EmulatedStorageManager;
    let server: ReturnType<typeof newLoopbackServer>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let spaceName: string;

    async function withFreshPiece(
      id: string,
      run: (piece: PieceController, replica: PiecesController) => Promise<void>,
    ): Promise<void> {
      await runtime.idle();
      await storage.synced();
      const freshStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const freshRuntime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: freshStorage,
      });
      try {
        const freshPieces = new PiecesController(
          await createSession({ identity: signer, spaceName }),
          freshRuntime,
        );
        await freshPieces.synced();
        await run(await freshPieces.get(id, false), freshPieces);
      } finally {
        await freshRuntime.dispose();
        await freshStorage.close();
      }
    }

    beforeEach(async () => {
      server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      storage = EmulatedStorageManager.connectTo(server, { as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: storage,
      });
      spaceName = `source-input-${crypto.randomUUID()}`;
      pieces = new PiecesController(
        await createSession({ identity: signer, spaceName }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime.dispose();
      await storage.close();
      await server.close();
    });

    it("returns a compatible verdict for an uninitialized user-scoped input", async () => {
      const piece = await pieces.create(program("v1"));
      const argument = pieces.getArgument(piece.getCell());
      const before = getPieceSourceSnapshot(piece.getCell());
      expect(isLink((argument.getRaw() as { viewer: unknown }).viewer)).toBe(
        true,
      );
      const scoped = runtime.getCellFromLink(parseLinkOrThrow(
        (argument.getRaw() as { viewer: unknown }).viewer,
        argument,
      ));
      const { error } = await runtime.editWithRetry((tx) => {
        scoped.withTx(tx).asSchema(undefined).set(undefined);
      });
      expect(error).toBeUndefined();

      const report = await piece.checkPattern(program("v2"));
      expect(report.issues).toEqual({});
      expect(report.compatible).toBe(true);
      expect(getPieceSourceSnapshot(piece.getCell())).toEqual(before);

      await piece.setPattern(program("v2"));
      expect(await piece.result.get()).toMatchObject({
        version: "v2",
        count: 0,
      });
    });

    it("returns a compatible verdict for an optional `undefined` field in a linked row", async () => {
      const piece = await pieces.create(program("v1"));
      const profile = runtime.getCell<{ name: string }>(
        pieces.getSpace(),
        "profile",
      );
      const argument = pieces.getArgument(piece.getCell());
      const { error } = await runtime.editWithRetry((tx) => {
        profile.withTx(tx).set({ name: "Baker" });
        argument.withTx(tx).asSchema<{ rows: unknown[] }>(undefined)
          .key("rows").push({ profile, count: 2, note: undefined });
      });
      expect(error).toBeUndefined();
      expect(isLink((argument.getRaw() as { rows: unknown[] }).rows[0])).toBe(
        true,
      );

      await withFreshPiece(piece.id, async (reloaded, replica) => {
        const report = await reloaded.checkPattern(program("v2"));
        expect(report.issues).toEqual({});
        expect(report.compatible).toBe(true);
        await reloaded.setPattern(program("v2"));
        expect(await reloaded.result.get()).toMatchObject({
          version: "v2",
          count: 1,
        });
        expect(
          await replica.getArgument(reloaded.getCell()).asSchema(undefined)
            .pull(),
        )
          .toMatchObject({ rows: [{ profile: { name: "Baker" }, count: 2 }] });
      });
    });

    it("defers an unreadable linked profile until its value arrives", async () => {
      const piece = await pieces.create(program("v1"));
      const profile = runtime.getCell<{ name: string }>(
        pieces.getSpace(),
        "profile",
      );
      const argument = pieces.getArgument(piece.getCell());
      const { error } = await runtime.editWithRetry((tx) => {
        argument.withTx(tx).asSchema<{ rows: unknown[] }>(undefined)
          .key("rows").push({ profile, count: 2, note: "linked" });
      });
      expect(error).toBeUndefined();
      expect(isLink((argument.getRaw() as { rows: unknown[] }).rows[0])).toBe(
        true,
      );

      await withFreshPiece(piece.id, async (reloaded, replica) => {
        const report = await reloaded.checkPattern(program("v2"));
        expect(report.issues).toEqual({});
        expect(report.compatible).toBe(true);
        await reloaded.setPattern(program("v2"));
        expect(await reloaded.result.get()).toMatchObject({
          version: "v2",
          count: 1,
        });
        const { error } = await replica.runtime.editWithRetry((tx) => {
          replica.runtime.getCellFromLink(profile.getAsNormalizedFullLink())
            .withTx(tx).set({ name: "Baker" });
        });
        expect(error).toBeUndefined();
        expect(
          await replica.getArgument(reloaded.getCell()).asSchema(undefined)
            .pull(),
        )
          .toMatchObject({
            rows: [{ profile: { name: "Baker" }, count: 2, note: "linked" }],
          });
      });
    });

    it("refuses a readable wrong-typed value inside a linked row", async () => {
      const piece = await pieces.create(program("v1"));
      const profile = runtime.getCell<{ name: string }>(
        pieces.getSpace(),
        "profile",
      );
      const argument = pieces.getArgument(piece.getCell());
      const { error } = await runtime.editWithRetry((tx) => {
        profile.withTx(tx).set({ name: "Baker" });
        argument.withTx(tx).asSchema<{ rows: unknown[] }>(undefined)
          .key("rows").push({ profile, count: "two" });
      });
      expect(error).toBeUndefined();
      await argument.asSchema(undefined).pull();
      const before = getPieceSourceSnapshot(piece.getCell());
      const report = await piece.checkPattern(program("v2"));
      expect(report.compatible).toBe(false);
      expect(report.issues.argument).toContain(
        "count: value does not match type number",
      );
      await expect(piece.setPattern(program("v2"))).rejects.toThrow("count");
      expect(getPieceSourceSnapshot(piece.getCell())).toEqual(before);
    });

    it("returns a compatible verdict for a retained owner-protected profile", async () => {
      const profile = await pieces.create({
        main: "/profile.tsx",
        files: [{
          name: "/profile.tsx",
          contents: `
import {
  Cfc, CurrentPrincipal, handler, pattern, RepresentsCurrentUser,
  Writable, WriteAuthorizedBy,
} from "commonfabric";
const setAvatar = handler<string, { avatar: Writable<string> }>(
  (value, { avatar }) => avatar.set(value),
);
type Owned = RepresentsCurrentUser<Cfc<
  WriteAuthorizedBy<string, typeof setAvatar>,
  { ownerPrincipal: CurrentPrincipal }
>>;
export default pattern<{ avatar: string }, { avatar: Owned }>(
  ({ avatar }) => ({ avatar }),
);
`,
        }],
      }, { input: { avatar: "donut" } });
      expect(await profile.result.get()).toMatchObject({ avatar: "donut" });
      const piece = await pieces.create(program("v1"));
      const argument = pieces.getArgument(piece.getCell());
      const candidate = await runtime.patternManager.compilePattern(
        program("v2"),
        {
          space: pieces.getSpace(),
        },
      );
      expect(() =>
        assertSuppliedLinkSchemasCompatible(
          [{ path: ["host", "profile"], value: profile.getCell() }],
          candidate.argumentSchema,
          argument,
          pieces,
          {
            priorArgumentSchema: candidate.argumentSchema,
            linksPreservedVerbatim: true,
          },
        )
      ).toThrow("ifc changed");
      const { error } = await runtime.editWithRetry((tx) => {
        argument.withTx(tx).asSchema<{ host: unknown }>(undefined).key("host")
          .set({ profile: profile.getCell() });
      });
      expect(error).toBeUndefined();
      const report = await piece.checkPattern(program("v2"));
      expect(report.issues).toEqual({});
      expect(report.compatible).toBe(true);
      const profileBefore = profile.getCell().getRaw();
      const profileSchemaBefore = profile.getCell().getMetaRaw("schema");
      expect(profileSchemaBefore).toBeDefined();
      await piece.setPattern(program("v2"));
      expect(await piece.result.get()).toMatchObject({ version: "v2" });
      expect(profile.getCell().getRaw()).toEqual(profileBefore);
      expect(profile.getCell().getMetaRaw("schema")).toEqual(
        profileSchemaBefore,
      );

      const changed = await piece.checkPattern(program("v3", "number"));
      expect(changed.compatible).toBe(false);
      expect(changed.issues.retainedLinks).toBeDefined();
      await expect(piece.setPattern(program("v3", "number"))).rejects.toThrow();
      expect(await piece.result.get()).toMatchObject({ version: "v2" });
    });
  });
});
