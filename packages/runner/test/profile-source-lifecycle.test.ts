import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";

import {
  type Cell,
  getPatternIdentityRef,
  getPatternSource,
  getPieceSourceRevisions,
  resolveEntryIdentity,
  Runtime,
  type RuntimeFetch,
  type RuntimeProgram,
  systemPatternSource,
} from "../src/index.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const origin = systemPatternSource("system/profile-home.tsx");
const program: RuntimeProgram = {
  main: "/api/patterns/system/profile-create.tsx",
  files: ["profile-create.tsx", "profile-home.tsx"].map((name) => ({
    name: `/api/patterns/system/${name}`,
    contents: Deno.readTextFileSync(
      new URL(`../../patterns/system/${name}`, import.meta.url),
    ),
  })),
};

describe("profile-source-lifecycle", () => {
  it("preserves a legacy saved name when its source is updated", async () => {
    const signer = await Identity.fromPassphrase("legacy profile source");
    const manager = EmulatedStorageManager.emulate({ as: signer });
    const current = program.files[1];
    // Reproduce the legacy layout: the argument carries an initial name and
    // the mutable name is an internal cell initialized from that argument.
    const legacySource = current.contents.replace(
      `    const name = new Writable<
      OwnerProtectedProfileWrite<string, typeof setName>
    >("").for("name");`,
      `    const initialProfileName = trimInitialName(initialName);
    const name = new Writable<
      OwnerProtectedProfileWrite<string, typeof setName>
    >(initialProfileName).for("name");`,
    );
    expect(legacySource).not.toBe(current.contents);
    const currentIdentity = await resolveEntryIdentity(
      current.name,
      () => Promise.resolve(current.contents),
    );
    let servedSource = legacySource;
    let servedIdentity = await resolveEntryIdentity(
      current.name,
      () => Promise.resolve(legacySource),
    );
    const runtime = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: manager,
      fetch: (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname !== current.name) {
          return Promise.resolve(new Response("not found", { status: 404 }));
        }
        return Promise.resolve(
          new Response(
            url.searchParams.has("identity") ? servedIdentity : servedSource,
          ),
        );
      },
    });
    try {
      const tx = runtime.edit();
      const legacy = await runtime.patternManager.compilePattern({
        main: current.name,
        files: [{ ...current, contents: legacySource }],
      }, { space: signer.did(), tx });
      const profile = runtime.getCell(signer.did(), "legacy-profile");
      runtime.runner.run(tx, legacy, { initialName: "Ada" }, profile, {
        sourceOrigin: origin,
      });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await profile.pull();
      const edit = runtime.edit();
      profile.withTx(edit).key("setName").send({ name: "Saved name" });
      runtime.prepareTxForCommit(edit);
      expect((await edit.commit()).error).toBeUndefined();
      await profile.pull();
      const name = profile.key("name").asSchema<string>({ type: "string" });
      await name.pull();
      expect(name.get()).toBe("Saved name");
      const before = getPatternIdentityRef(profile);
      servedSource = current.contents;
      servedIdentity = currentIdentity;

      expect(await runtime.sourceReconciler.reconcile(profile)).toBe(
        "updated",
      );
      await runtime.runner.idlePointerMaintenance();
      await name.pull();
      expect(name.get()).toBe("Saved name");
      expect(getPatternIdentityRef(profile)?.identity).not.toBe(
        before?.identity,
      );
      expect(getPatternIdentityRef(profile)?.identity).toBe(currentIdentity);
      expect(getPieceSourceRevisions(profile).map((entry) => entry.operation))
        .toEqual(["create", "origin-update"]);

      const rename = runtime.edit();
      profile.withTx(rename).key("setName").send({ name: "Updated name" });
      runtime.prepareTxForCommit(rename);
      expect((await rename.commit()).error).toBeUndefined();
      await runtime.idle();
      await name.pull();
      expect(name.get()).toBe("Updated name");
    } finally {
      await runtime.patternManager.flushCompileCacheWrites();
      await runtime.dispose();
      await manager.close();
    }
  });

  it("retains the shipped profile's source and creation origin in a fresh runtime", async () => {
    const signer = await Identity.fromPassphrase("profile source lifecycle");
    const server = newSharedServer();
    const firstManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const secondManager = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const homePath = "/api/patterns/system/profile-home.tsx";
    let homeSource =
      program.files.find((file) => file.name === homePath)!.contents;
    let homeIdentity = await resolveEntryIdentity(
      homePath,
      () => Promise.resolve(homeSource),
    );
    const fetch: RuntimeFetch = (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const contents = url.pathname === homePath
        ? homeSource
        : program.files.find((file) => file.name === url.pathname)?.contents;
      return Promise.resolve(
        contents === undefined
          ? new Response("not found", { status: 404 })
          : new Response(
            url.searchParams.has("identity") ? homeIdentity : contents,
          ),
      );
    };
    const first = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: firstManager,
      fetch,
    });
    const second = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: secondManager,
      fetch,
    });
    // Creation must retain source even when the background cache copy cannot
    // supply any documents. A fresh runtime can compile the retained source.
    const replication = stub(first.patternManager, "replicatePatternToSpace");
    try {
      const tx = first.edit();
      const creator = await first.patternManager.compilePattern(program, {
        space: signer.did(),
        tx,
      });
      const profiles = first.getCell<unknown[]>(
        signer.did(),
        "profiles",
        undefined,
        tx,
      );
      profiles.set([]);
      const result = first.getCell(signer.did(), "creator", undefined, tx);
      first.runner.run(tx, creator, { profiles }, result);
      first.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await result.withTx().pull();

      const eventTx = first.edit();
      result.withTx(eventTx).key("createProfile").send({ name: "Ada" });
      first.prepareTxForCommit(eventTx);
      expect((await eventTx.commit()).error).toBeUndefined();
      await result.withTx().pull();
      await first.idle();
      const list = profiles.withTx().asSchema<Cell<unknown>[]>({
        type: "array",
        items: { type: "unknown", asCell: ["cell"] },
      });
      await list.pull();
      const created = list.get();
      expect(created).toHaveLength(1);
      const link = created[0].getAsNormalizedFullLink();
      expect(link.space).not.toBe(signer.did());

      const profile = second.getCellFromLink(link);
      await profile.sync();
      expect(getPatternSource(profile)).toBe(origin);
      expect(
        getPieceSourceRevisions(profile).map((revision) => ({
          origin: revision.origin,
          operation: revision.operation,
          pattern: revision.pattern,
        })),
      ).toEqual([{
        origin,
        operation: "create",
        pattern: getPatternIdentityRef(profile),
      }]);
      const ref = getPatternIdentityRef(profile)!;
      expect(
        await second.patternManager.getPatternSourceProgramByIdentity(
          ref.identity,
          profile.space,
        ),
      ).toBeDefined();
      expect(await second.start(profile)).toBe(true);
      await profile.pull();
      const name = profile.key("name").asSchema<string>({ type: "string" });
      await name.pull();
      expect(name.get()).toBe("Ada");

      const rejectUntrustedNameWrite = async () => {
        await name.pull();
        const previousName = name.get();
        const tx = second.edit();
        tx.setCfcImplementationIdentity({
          kind: "builtin",
          builtinId: "untrusted-profile-writer",
        });
        name.withTx(tx).set("Untrusted rename");
        second.prepareTxForCommit(tx);
        expect((await tx.commit()).error?.message).toContain(
          "writeAuthorizedBy",
        );
        await name.pull();
        expect(name.get()).toBe(previousName);
      };
      await rejectUntrustedNameWrite();

      const send = async (stream: string, event: Record<string, string>) => {
        const tx = second.edit();
        profile.withTx(tx).key(stream).send(event);
        second.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        await profile.pull();
        await second.idle();
        await profile.pull();
      };
      await send("setName", { name: "Ada Lovelace" });
      await name.pull();
      expect(name.get()).toBe("Ada Lovelace");
      await send("addElement", { title: "Before update" });
      const inbox = { space: signer.did(), host: "https://inbox.test" };
      await send("setInbox", inbox);

      homeSource = homeSource.replace(
        "<cf-heading level={2}>Profile</cf-heading>",
        "<cf-heading level={2}>Updated profile</cf-heading>",
      );
      homeIdentity = await resolveEntryIdentity(
        homePath,
        () => Promise.resolve(homeSource),
      );
      expect(homeIdentity).not.toBe(ref.identity);
      expect(await second.sourceReconciler.reconcile(profile)).toBe("updated");
      await second.idle();
      await second.runner.idlePointerMaintenance();
      await profile.pull();
      expect(getPatternIdentityRef(profile)?.identity).toBe(homeIdentity);
      expect(getPatternSource(profile)).toBe(origin);
      expect(getPieceSourceRevisions(profile).map((entry) => entry.operation))
        .toEqual(["create", "origin-update"]);
      await name.pull();
      expect(name.get()).toBe("Ada Lovelace");
      const storedInbox = profile.key("inbox").asSchema<typeof inbox>({
        type: "object",
        properties: { space: { type: "string" }, host: { type: "string" } },
        required: ["space", "host"],
      });
      await storedInbox.pull();
      expect(storedInbox.get()).toEqual(inbox);

      await send("setName", { name: "Countess Lovelace" });
      await send("addElement", { title: "After update" });
      const updatedInbox = { ...inbox, host: "https://updated-inbox.test" };
      await send("setInbox", updatedInbox);
      await storedInbox.pull();
      expect(storedInbox.get()).toEqual(updatedInbox);
      await name.pull();
      expect(name.get()).toBe("Countess Lovelace");
      await rejectUntrustedNameWrite();
      const elements = profile.key("elements").asSchema<{ title: string }[]>({
        type: "array",
        items: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      });
      await elements.pull();
      expect(elements.get().map((element) => element.title))
        .toEqual(["Before update", "After update"]);
    } finally {
      replication.restore();
      await first.patternManager.flushCompileCacheWrites();
      await second.patternManager.flushCompileCacheWrites();
      await second.dispose();
      await first.dispose();
      await secondManager.close();
      await firstManager.close();
      await server.close();
    }
  });
});
