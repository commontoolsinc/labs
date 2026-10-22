/**
 * Drives `listProfiles()`, `renameProfile()`, `setProfilePicture()`,
 * `retireProfile()` and `restoreProfile()` against a runtime with no
 * renderer, running the real Home pattern behind a stubbed connection, so
 * that each command meets the write contracts Home's lists carry. The
 * profiles are made by `createProfile()`, as profile-create.test.ts drives it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { type Cell, type MemorySpace, Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "@commonfabric/piece/ops";

import type { loadPieces as loadPiecesOf, SpaceConfig } from "../lib/piece.ts";
import {
  createProfile,
  listProfiles,
  PROFILE_PICTURE_MAX_BYTES,
  renameProfile,
  restoreProfile,
  retireProfile,
  setProfilePicture,
} from "../lib/profile.ts";

const signer = await Identity.fromPassphrase("cf-profile-manage");
const stranger = await Identity.fromPassphrase("cf-profile-manage stranger");
const space = signer.did();

const CONFIG: SpaceConfig = {
  apiUrl: "http://127.0.0.1:8000",
  identity: "/unread.key",
  space,
};

describe("profile management", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  let host: Cell<Record<string, unknown>>;
  let loadPieces: typeof loadPiecesOf;
  // Who a connection to a profile's own space acts as.
  let profileSigner: Identity;

  beforeEach(async () => {
    profileSigner = signer;
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: new URL("../../patterns/system/home.tsx", import.meta.url)
          .pathname,
        root: new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""),
      },
    );
    const tx = runtime.edit();
    const home = await runtime.patternManager.compilePattern(program, {
      space,
      tx,
    });
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "cf profile manage home",
      undefined,
      tx,
    );
    host = runtime.run(tx, home, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await host.pull();
    // The home connection answers with this host as the home root, and is
    // the test's to close; any other space gets a runtime of its own over
    // the same server, as a second connection from one process is.
    loadPieces = (config: SpaceConfig) => {
      if (config.space === space) {
        // The part of a connection the commands use on the home space.
        return Promise.resolve({
          runtime,
          synced: () => Promise.resolve(),
          dispose: () => Promise.resolve(),
          getDefaultPattern: () => Promise.resolve(host),
          ensureDefaultPattern: () => Promise.resolve({ getCell: () => host }),
        } as unknown as PiecesController);
      }
      const storage = EmulatedStorageManager.connectTo(server, {
        as: profileSigner,
      });
      const profileRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      const pieces = new PiecesController(
        { as: profileSigner, space: config.space as MemorySpace },
        profileRuntime,
        { deferSpaceCellSync: true },
      );
      pieces.dispose = async () => {
        await profileRuntime.dispose({ closeStorage: false });
        await storage.close();
      };
      return Promise.resolve(pieces);
    };
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await manager.close();
    await server.close();
  });

  /** The names of the listed profiles, in the order they are listed. */
  async function listedNames(): Promise<string[]> {
    return (await listProfiles(CONFIG, { loadPieces })).map((each) =>
      each.name
    );
  }

  describe("listProfiles()", () => {
    it("returns no profiles for a person who has none", async () => {
      expect(await listProfiles(CONFIG, { loadPieces })).toEqual([]);
    });

    it("returns each profile's name, space and address, the first marked current", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      const alan = await createProfile({ ...CONFIG, name: "Alan" }, {
        loadPieces,
      });

      const listed = await listProfiles(CONFIG, { loadPieces });

      expect(listed.map((each) => [each.name, each.space, each.address]))
        .toEqual([
          ["Ada", ada.space, ada.address],
          ["Alan", alan.space, alan.address],
        ]);
      expect(listed.map((each) => each.current)).toEqual([true, false]);
      expect(listed.map((each) => each.picture)).toEqual([
        undefined,
        undefined,
      ]);
    });

    it("throws, naming the space, when a profile after the current one cannot be read", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });
      const alan = await createProfile({ ...CONFIG, name: "Alan" }, {
        loadPieces,
      });
      const sync = manager.syncCell.bind(manager);
      using _refused = stub(
        manager,
        "syncCell",
        (cell, options) =>
          cell.space === alan.space
            ? Promise.reject(new Error("access refused"))
            : sync(cell, options),
      );

      await expect(listProfiles(CONFIG, { loadPieces })).rejects.toThrow(
        `Cannot read the profile in ${alan.space}.`,
      );
    });
  });

  describe("retireProfile()", () => {
    it("leaves the retired profile out of the list, and the rest in it", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      await createProfile({ ...CONFIG, name: "Alan" }, { loadPieces });

      await retireProfile({ ...CONFIG, profileSpace: ada.space }, {
        loadPieces,
      });

      expect(await listedNames()).toEqual(["Alan"]);
      expect((await listProfiles(CONFIG, { loadPieces }))[0].current).toBe(
        true,
      );
    });

    it("refuses a space no listed profile lives in", async () => {
      await createProfile({ ...CONFIG, name: "Ada" }, { loadPieces });

      await expect(
        retireProfile({ ...CONFIG, profileSpace: space }, { loadPieces }),
      ).rejects.toThrow(/No profile/);
      expect(await listedNames()).toEqual(["Ada"]);
    });

    it("refuses a profile that is retired already", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      await retireProfile({ ...CONFIG, profileSpace: ada.space }, {
        loadPieces,
      });

      await expect(
        retireProfile({ ...CONFIG, profileSpace: ada.space }, { loadPieces }),
      ).rejects.toThrow(/is retired/);
    });
  });

  describe("restoreProfile()", () => {
    it("lists the restored profile again", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      await createProfile({ ...CONFIG, name: "Alan" }, { loadPieces });
      await retireProfile({ ...CONFIG, profileSpace: ada.space }, {
        loadPieces,
      });

      await restoreProfile({ ...CONFIG, profileSpace: ada.space }, {
        loadPieces,
      });

      expect(await listedNames()).toEqual(["Ada", "Alan"]);
    });

    it("refuses a profile that is not retired", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      await expect(
        restoreProfile({ ...CONFIG, profileSpace: ada.space }, { loadPieces }),
      ).rejects.toThrow(/is not retired/);
      expect(await listedNames()).toEqual(["Ada"]);
    });
  });

  describe("renameProfile()", () => {
    it("stores the new name, which the list reads back", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      await renameProfile(
        { ...CONFIG, profileSpace: ada.space, name: "  Countess  " },
        { loadPieces },
      );

      expect(await listedNames()).toEqual(["Countess"]);
    });

    it("refuses a blank name and leaves the stored one", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      await expect(
        renameProfile({ ...CONFIG, profileSpace: ada.space, name: " " }, {
          loadPieces,
        }),
      ).rejects.toThrow(/needs a name/);
      expect(await listedNames()).toEqual(["Ada"]);
    });

    it("throws, leaving the stored name, when the profile refuses the rename", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      profileSigner = stranger;

      await expect(
        renameProfile({ ...CONFIG, profileSpace: ada.space, name: "Count" }, {
          loadPieces,
        }),
      ).rejects.toThrow(/^Renaming profile /);
      profileSigner = signer;
      expect(await listedNames()).toEqual(["Ada"]);
    });

    it("refuses a retired profile", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      await retireProfile({ ...CONFIG, profileSpace: ada.space }, {
        loadPieces,
      });

      await expect(
        renameProfile({ ...CONFIG, profileSpace: ada.space, name: "Count" }, {
          loadPieces,
        }),
      ).rejects.toThrow(/is retired/);
    });
  });

  describe("setProfilePicture()", () => {
    // A PNG's signature and header chunk start, which is what the picture is
    // checked by; the profile stores the bytes as they are.
    const picture = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
      0,
      0,
      13,
    ]);

    /** Gives `profile` the legacy avatar text `avatar`, through `setAvatar`. */
    async function setLegacyAvatar(
      profile: { space: string; id: string },
      avatar: string,
    ): Promise<void> {
      const pieces = await loadPieces({ ...CONFIG, space: profile.space });
      try {
        const piece = await pieces.getPieceCell(profile.id, true);
        const tx = pieces.runtime.edit();
        piece.withTx(tx).asSchema(undefined).key("setAvatar").send({ avatar });
        expect((await tx.commit().settled).error).toBeUndefined();
        await pieces.runtime.idle();
        await pieces.synced();
        await pieces.stopPiece(piece);
      } finally {
        await pieces.dispose();
      }
    }

    it("removes the legacy avatar text too with `clear`, since it shows where there is no picture", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      await setLegacyAvatar(ada, "data:image/png;base64,iVBORw0KGgo=");
      const [before] = await listProfiles(CONFIG, { loadPieces });
      expect(before.avatar).not.toBe("");
      expect(before.avatarByOwner).toBe(true);

      await setProfilePicture(
        { ...CONFIG, profileSpace: ada.space, clear: true },
        { loadPieces },
      );
      const [listed] = await listProfiles(CONFIG, { loadPieces });
      expect(listed.avatar).toBe("");
      expect(listed.avatarByOwner).toBe(false);
      expect(listed.picture).toBeUndefined();
    });

    it("refuses a picture over `PROFILE_PICTURE_MAX_BYTES`, and stores nothing", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      const large = new Uint8Array(PROFILE_PICTURE_MAX_BYTES + 1);
      large.set(picture);

      await expect(
        setProfilePicture(
          { ...CONFIG, profileSpace: ada.space, bytes: large },
          { loadPieces },
        ),
      ).rejects.toThrow(/at most 262144 bytes/);
      expect((await listProfiles(CONFIG, { loadPieces }))[0].picture)
        .toBeUndefined();
    });

    it("stores the picture's bytes, which the list reads back, and removes them with `clear`", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      await setProfilePicture(
        { ...CONFIG, profileSpace: ada.space, bytes: picture },
        { loadPieces },
      );
      const [set] = await listProfiles(CONFIG, { loadPieces });
      expect(set.picture).toEqual(picture);
      expect(set.pictureByOwner).toBe(true);

      await setProfilePicture(
        { ...CONFIG, profileSpace: ada.space, clear: true },
        { loadPieces },
      );
      expect((await listProfiles(CONFIG, { loadPieces }))[0].picture)
        .toBeUndefined();
    });

    it("reports a picture another principal set as not the owner's", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      // The profile's space lets anyone write, and the picture's writer
      // labels the value with whoever wrote it.
      profileSigner = stranger;
      await setProfilePicture(
        { ...CONFIG, profileSpace: ada.space, bytes: picture },
        { loadPieces },
      );
      profileSigner = signer;

      const [listed] = await listProfiles(CONFIG, { loadPieces });
      expect(listed.picture).toEqual(picture);
      expect(listed.pictureByOwner).toBe(false);

      await setProfilePicture(
        { ...CONFIG, profileSpace: ada.space, bytes: picture },
        { loadPieces },
      );
      expect((await listProfiles(CONFIG, { loadPieces }))[0].pictureByOwner)
        .toBe(true);
    });

    it("reports a picture stored without a label as not attested to its owner", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });
      // A picture as a writer that brings no policy stores it: bytes, and no
      // label.
      const profile = runtime.getCellFromEntityId<{ picture?: unknown }>(
        ada.space as MemorySpace,
        ada.id,
      );
      await profile.sync();
      const tx = runtime.edit();
      tx.writeValueOrThrow(
        profile.key("picture").resolveAsCell().getAsNormalizedFullLink(),
        new FabricBytes(picture),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();

      const [listed] = await listProfiles(CONFIG, { loadPieces });
      expect(listed.picture).toEqual(picture);
      expect(listed.pictureByOwner).toBe(false);
    });

    it("refuses bytes that are not a raster image, and leaves the picture", async () => {
      const ada = await createProfile({ ...CONFIG, name: "Ada" }, {
        loadPieces,
      });

      await expect(
        setProfilePicture(
          {
            ...CONFIG,
            profileSpace: ada.space,
            bytes: new TextEncoder().encode("<svg/>"),
          },
          { loadPieces },
        ),
      ).rejects.toThrow(/PNG, JPEG/);
      expect((await listProfiles(CONFIG, { loadPieces }))[0].picture)
        .toBeUndefined();
    });
  });
});
