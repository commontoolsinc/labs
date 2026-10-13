/**
 * Replays the real Home before its shared-space interface, then updates it in
 * place through PiecesController. Only Home's entry source differs between
 * the two programs; both compile the production manager and its dependencies.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import {
  FabricDurationNsec,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  getPatternIdentityRef,
  Runtime,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const owner = await Identity.fromPassphrase("Home interface state retention");

describe("Home interface upgrade", () => {
  it("preserves manager requests, direct counterparts and queued notices across the Home code change", async () => {
    const server = newLoopbackServer();
    const storage = EmulatedStorageManager.connectTo(server, { as: owner });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const controller = new PiecesController(
      createSession({ identity: owner, spaceDid: owner.did() }),
      runtime,
    );
    try {
      const candidate = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        {
          main: fromFileUrl(new URL("../system/home.tsx", import.meta.url)),
          root: fromFileUrl(new URL("..", import.meta.url)),
        },
      );
      const previous = structuredClone(candidate);
      const entry = previous.files.find((file) => file.name === previous.main);
      expect(entry).toBeDefined();
      // Snapshot of Home at 676e4cae1b, before the interface change. Retaining
      // its entry path keeps every production dependency's identity intact.
      entry!.contents = await Deno.readTextFile(
        new URL(
          "./fixtures/home-interface-upgrade/home-before.tsx.txt",
          import.meta.url,
        ),
      );
      const compiled = await runtime.patternManager.compilePattern(previous, {
        space: owner.did(),
      });
      const tx = runtime.edit();
      const home = runtime.run(
        tx,
        compiled,
        {},
        runtime.getCell(owner.did(), "upgrade Home", undefined, tx),
      );
      runtime.getSpaceCell(owner.did(), undefined, tx).key("defaultPattern")
        .set(home);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      await home.pull();

      const social = await runtime.createSpace({});
      const roomTx = runtime.edit();
      const room = runtime.getCell(social, "direct room", undefined, roomTx);
      // The seed fits the manager's schema, so a candidate that changes the
      // manager is judged on retention rather than refused at swap setup.
      const policy = runtime.getCell(social, "room policy", undefined, roomTx);
      policy.set({
        ownersMayObliterate: false,
        keepsHistory: true,
        deletionIsObliteration: false,
        proposedTimeMaxAgeNsec: new FabricDurationNsec(1000n),
        proposedTimeMaxLeadNsec: new FabricDurationNsec(1000n),
        recentActivityWindowNsec: new FabricDurationNsec(1000n),
        maxWindowCount: 10,
        maxOpenWindows: 2,
      });
      room.set({ about: { kind: "direct", policy }, participants: [] });
      runtime.prepareTxForCommit(roomTx);
      expect((await roomTx.commit().settled).error).toBeUndefined();
      const seedTx = runtime.edit();
      const counterpart =
        (await Identity.fromPassphrase("retained direct counterpart")).did();
      const direct = {
        [counterpart]: {
          room,
          kind: "direct",
          counterpart,
          since: new FabricEpochNsec(1000n),
        },
      };
      const requests = {
        refused: {
          status: "refused",
          reason: "Two profiles share an inbox.",
          code: "shared-inbox",
        },
      };
      const notices = [{ id: "queued notice", room, recipient: counterpart }];
      const manager = home.key("chatManager");
      // `requests` is a direct argument binding, while the public notice list
      // is a computed copy. Seed the manager's actual notice argument.
      const requestStorage = manager.key("requests").resolveAsCell();
      const managerArgument = runtime.getCellFromLink({
        ...requestStorage.getAsNormalizedFullLink(),
        path: [],
      });
      expect(
        manager.key("direct").resolveAsCell().equalLinks(
          managerArgument.key("direct"),
        ),
      ).toBe(true);
      manager.withTx(seedTx).key("requests").set(requests);
      manager.withTx(seedTx).key("direct").set(direct);
      managerArgument.withTx(seedTx).key("outgoingNotices").set(notices);
      runtime.prepareTxForCommit(seedTx);
      expect((await seedTx.commit().settled).error).toBeUndefined();
      await runtime.idle();
      await home.pull();
      const fields = ["requests", "direct", "outgoingNotices"] as const;
      const storedFields = async (reader: Runtime, root: Cell<unknown>) =>
        await Promise.all(fields.map(async (field) => {
          const requests = root.key("chatManager").key("requests")
            .resolveAsCell();
          const argument = reader.getCellFromLink({
            ...requests.getAsNormalizedFullLink(),
            path: [],
          });
          const stored = argument.key(field).resolveAsCell();
          await stored.sync();
          const { space, id, path } = stored.getAsNormalizedFullLink();
          return { address: { space, id, path }, value: stored.getRaw() };
        }));
      // Raw stored snapshots retain complete data and serialized room links;
      // a projected query result can lazily change as the source rolls.
      const before = await storedFields(runtime, home);
      expect(before[0].value).toMatchObject(requests);
      expect(before[1].value).toHaveProperty(counterpart);
      expect(before[2].value).toHaveLength(1);
      expect(await manager.key("outgoingNotices").pull()).toHaveLength(1);
      const identity = getPatternIdentityRef(home)?.identity;
      const rootLink = home.getAsNormalizedFullLink();
      const piece = await controller.get(rootLink.id);
      await piece.setPattern(candidate);
      await runtime.idle();
      const rolled = (await controller.getDefaultPattern(false))!;
      await rolled.pull();
      expect(rolled.equalLinks(home)).toBe(true);
      expect(getPatternIdentityRef(rolled)?.identity).not.toBe(identity);
      expect(await rolled.key("sharedSpaces").key("view").key("status").pull())
        .toBe("ready");
      const after = await storedFields(runtime, rolled);
      expect(after).toEqual(before);
      const links = await rolled.key("chatManager").key("direct").key(
        counterpart,
      ).key("room").asSchema<Cell<unknown>>({ asCell: ["cell"] }).pull();
      expect(links?.equalLinks(room)).toBe(true);
      await runtime.idle();
      await storage.synced();
      const peerStorage = EmulatedStorageManager.connectTo(server, {
        as: owner,
      });
      const peer = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: peerStorage,
      });
      try {
        const reopened = await peer.getCellFromLink(rootLink).sync();
        expect(await peer.start(reopened)).toBe(true);
        await peer.idle();
        await reopened.pull();
        expect(await storedFields(peer, reopened)).toEqual(before);
      } finally {
        await peer.dispose();
        await peerStorage.close();
      }
    } finally {
      await controller.dispose();
      await runtime.dispose();
      await storage.close();
      await server.close();
    }
  });
});
