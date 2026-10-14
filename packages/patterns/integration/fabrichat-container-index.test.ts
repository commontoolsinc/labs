/**
 * A manager discovers declared container chats through real space roots and
 * keeps each conversation's membership separate from its container's.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime, sendEvent } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("fabrichat container index");
const home = signer.did();

/** A listed conversation, read as a link and its opaque revision. */
interface Entry {
  /** The resolved conversation. */
  room: Cell<unknown>;

  /** The membership revision clients return when forgetting it. */
  revision: string;
}

const entriesSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      room: { type: "object", asCell: ["cell"] },
      revision: { type: "string" },
    },
  },
} as const;

describe("fabrichat-container-index", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer();
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.idle();
    await storage.synced();
    await runtime.dispose();
    await storage.close();
    await server.close();
  });

  it("discovers a declared chat added later, forgets only that conversation, and restores it with a fresh revision", async () => {
    const social = await runtime.createSpace({ spaceKind: "photo-album" });
    let tx = runtime.edit();
    const container = runtime.getCell<Record<string, unknown>>(
      social,
      "container",
      undefined,
      tx,
    );
    container.set({});
    runtime.getSpaceCell(social, undefined, tx).key("defaultPattern").set(
      container,
    );
    const room = runtime.getCell(
      social,
      "declared conversation",
      undefined,
      tx,
    );
    room.set({ about: { kind: "group", title: "Photos" } });
    const other = runtime.getCell(social, "other conversation", undefined, tx);
    other.set({ about: { kind: "group", title: "Other" } });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    const catalog = runtime.getCell(home, "catalog", undefined, tx);
    catalog.set({
      entries: {
        [social]: {
          space: social,
          host: "http://localhost:8000",
          kind: "photo-album",
          state: "saved",
          revision: "1:initial",
          since: 123,
        },
      },
      offers: {},
    });
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(new URL("../fabrichat/manager.tsx", import.meta.url)),
        root: fromFileUrl(new URL("..", import.meta.url)),
      },
    );
    const pattern = await runtime.patternManager.compilePattern({
      ...program,
      mainExport: "FabriChatManagerCore",
    }, { space: home, tx });
    const manager = runtime.run(
      tx,
      pattern,
      { sharedSpaceCatalog: catalog },
      runtime.getCell(home, "manager", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    const entries = manager.key("rooms").asSchema<Entry[]>(entriesSchema);
    expect(entries.get()).toEqual([]);

    const declareTx = runtime.edit();
    container.withTx(declareTx).key("chatRoom").set(room);
    expect((await declareTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].room.equals(room)).toBe(true);
    const discoveredRevision = entries.get()[0].revision;
    sendEvent(manager.key("forget"), {
      room,
      revision: discoveredRevision,
      requestId: "forget",
    });
    await runtime.idle();
    await manager.pull();
    expect(manager.key("requests").key("forget").key("status").get()).toBe(
      "done",
    );
    expect(entries.get()).toEqual([]);
    expect(catalog.key("entries").key(social).key("state").get()).toBe("saved");

    const reopenedStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const reopenedRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: reopenedStorage,
    });
    try {
      const reopened = reopenedRuntime.getCell(home, "manager");
      await reopenedRuntime.start(reopened);
      await reopened.pull();
      expect(reopened.key("rooms").asSchema<Entry[]>(entriesSchema).get())
        .toEqual([]);
      expect(reopened.key("roomMembership").key(0).key("state").get()).toBe(
        "archived",
      );
    } finally {
      await reopenedRuntime.idle();
      await reopenedRuntime.dispose();
      await reopenedStorage.close();
    }

    sendEvent(manager.key("accept"), {
      room,
      container,
      keepArchived: true,
      requestId: "offered",
    });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toEqual([]);
    sendEvent(manager.key("joinRoom"), { room, container, requestId: "join" });
    await runtime.idle();
    await manager.pull();
    expect(manager.key("requests").key("join").key("status").get()).toBe(
      "done",
    );
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].revision).not.toBe(discoveredRevision);
    sendEvent(manager.key("forget"), {
      room,
      revision: discoveredRevision,
      requestId: "stale",
    });
    await runtime.idle();
    await manager.pull();
    expect(manager.key("requests").key("stale").key("status").get()).toBe(
      "refused",
    );
    expect(entries.get()).toHaveLength(1);

    sendEvent(manager.key("joinRoom"), {
      room: other,
      container,
      requestId: "wrong",
    });
    await runtime.idle();
    await manager.pull();
    expect(manager.key("requests").key("wrong").key("status").get()).toBe(
      "refused",
    );
    expect(entries.get()).toHaveLength(1);
    const replaceTx = runtime.edit();
    container.withTx(replaceTx).key("chatRoom").set(other);
    expect((await replaceTx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(2);
    expect(entries.get().some((entry) => entry.room.equals(other))).toBe(true);
    expect(catalog.key("entries").get()).toEqual({
      [social]: {
        space: social,
        host: "http://localhost:8000",
        kind: "photo-album",
        state: "saved",
        revision: "1:initial",
        since: 123,
      },
    });
  });
  it("lists a room once through standalone and container entries and keeps forgetting it independent of its container", async () => {
    const standalone = await runtime.createSpace({
      spaceKind: "fabrichat-room",
    });
    const social = await runtime.createSpace({});
    let tx = runtime.edit();
    const room = runtime.getCell(
      standalone,
      "root conversation",
      undefined,
      tx,
    );
    room.set({
      about: { kind: "group", title: "Shared", record: { kind: "group" } },
    });
    runtime.getSpaceCell(standalone, undefined, tx).key("defaultPattern").set(
      room,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    const container = runtime.getCell(social, "container", undefined, tx);
    container.set({ chatRoom: room });
    runtime.getSpaceCell(social, undefined, tx).key("defaultPattern").set(
      container,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    const catalog = runtime.getCell(home, "catalog", undefined, tx);
    const stored = {
      entries: {
        [social]: {
          space: social,
          host: "http://localhost:8000",
          kind: "social",
          state: "saved",
          revision: "1:initial",
        },
        [standalone]: {
          space: standalone,
          host: "http://localhost:8000",
          kind: "fabrichat-room",
          state: "saved",
          revision: "1:initial",
        },
      },
      offers: {},
    };
    catalog.set(stored);
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(new URL("../fabrichat/manager.tsx", import.meta.url)),
        root: fromFileUrl(new URL("..", import.meta.url)),
      },
    );
    const pattern = await runtime.patternManager.compilePattern({
      ...program,
      mainExport: "FabriChatManagerCore",
    }, { space: home, tx });
    const manager = runtime.run(
      tx,
      pattern,
      { sharedSpaceCatalog: catalog },
      runtime.getCell(home, "manager", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await manager.pull();
    const entries = manager.key("rooms").asSchema<Entry[]>(entriesSchema);
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].room.equals(room)).toBe(true);
    sendEvent(manager.key("forget"), {
      room,
      revision: entries.get()[0].revision,
      requestId: "forget-root",
    });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toEqual([]);
    expect(catalog.key("entries").key(social).key("state").get()).toBe("saved");
    sendEvent(manager.key("joinRoom"), {
      room,
      container,
      requestId: "join-container",
    });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    const revision = entries.get()[0].revision;
    sendEvent(manager.key("forget"), { room, revision, requestId: "forget" });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toEqual([]);
    expect(catalog.key("entries").key(social).get()).toEqual(
      stored.entries[social],
    );
    expect(catalog.key("entries").key(standalone).key("state").get()).toBe(
      "archived",
    );
    sendEvent(manager.key("joinRoom"), { room, requestId: "join-root" });
    await runtime.idle();
    await manager.pull();
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].room.equals(room)).toBe(true);
    expect(entries.get()[0].revision).not.toBe(revision);
  });

  it("joins an unsaved container's real room when its viewer sends a message", async () => {
    const social = await runtime.createSpace({});
    let tx = runtime.edit();
    const profile = runtime.getCell(social, "profile", {
      type: "object",
      properties: { name: { type: "string" } },
      ifc: { addIntegrity: ["fabrichat-test-profile"] },
    }, tx);
    profile.set({ name: "Sender" });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(new URL("../fabrichat/manager.tsx", import.meta.url)),
        root: fromFileUrl(new URL("..", import.meta.url)),
      },
    );
    const managerPattern = await runtime.patternManager.compilePattern({
      ...program,
      mainExport: "FabriChatManagerCore",
    }, { space: home, tx });
    const manager = runtime.run(
      tx,
      managerPattern,
      { myProfile: profile },
      runtime.getCell(home, "manager", undefined, tx),
    );
    const homeRoot = runtime.getCell(home, "home", undefined, tx);
    homeRoot.set({
      profiles: [profile],
      defaultProfile: profile,
      chatManager: manager,
    });
    runtime.getSpaceCell(home, undefined, tx).key("defaultPattern").set(
      homeRoot,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await manager.pull();
    tx = runtime.edit();
    const roomProgram = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: fromFileUrl(new URL("../fabrichat/room.tsx", import.meta.url)),
        root: fromFileUrl(new URL("..", import.meta.url)),
      },
    );
    const roomPattern = await runtime.patternManager.compilePattern(
      roomProgram,
      { space: social, tx },
    );
    const room = runtime.run(
      tx,
      roomPattern,
      {},
      runtime.getCell(social, "room", undefined, tx),
    );
    const container = runtime.getCell(social, "container", undefined, tx);
    container.set({ chatRoom: room });
    runtime.getSpaceCell(social, undefined, tx).key("defaultPattern").set(
      container,
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await room.pull();
    expect(room.key("canSend").get()).toBe(true);
    const entries = manager.key("rooms").asSchema<Entry[]>(entriesSchema);
    expect(entries.get()).toEqual([]);
    const click = {
      type: "click",
      requestId: "placed-message",
      target: { value: "Our shared photos" },
      provenance: reviewedActionProvenance("dom", {
        surface: "ChatSendSurface",
        action: "ChatSend",
      }),
    };
    markRendererTrustedEvent(click);
    tx = runtime.edit();
    room.withTx(tx).key("sendMessage").send(click);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await room.pull();
    await manager.pull();
    expect(room.key("messages").key("count").get()).toBe(1);
    expect(entries.get()).toHaveLength(1);
    expect(entries.get()[0].room.equals(room)).toBe(true);
    expect(manager.key("sharedSpaceCatalog").get()).toEqual({
      entries: {},
      offers: {},
    });
  });
});
