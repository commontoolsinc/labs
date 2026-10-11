/**
 * The profile embed shows each viewer their own profile, and a host mounts it
 * in a space other viewers reach. Its edit-mode toggle, and the drafts beside
 * it, must therefore be each session's own: `isEditing`, computed from the
 * toggle, is placed behind one shared redirect that names a per-session
 * instance, as `profile-home.tsx`'s edit toggle is. The drafts beside it are
 * not exported, so this covers the toggle.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("profile embed session state");
const space = signer.did();
const CAUSE = "profile embed session state piece";

const sysDir = fromFileUrl(new URL("../../patterns/system/", import.meta.url));
const read = (name: string) => Deno.readTextFileSync(sysDir + name);

const PROGRAM: RuntimeProgram = {
  main: "/profile-embed.tsx",
  files: [
    { name: "/profile-embed.tsx", contents: read("profile-embed.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
};

describe("profile-embed session state", () => {
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let a: Runtime;
  let b: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = EmulatedStorageManager.connectTo(server, { as: signer });
    a = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    b = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
  });

  afterEach(async () => {
    await a?.dispose();
    await b?.dispose();
    await storageA?.close();
    await storageB?.close();
    await server?.close();
  });

  it("places isEditing in a per-session instance both sessions follow", async () => {
    const txA = a.edit();
    const compiledA = await a.patternManager.compilePattern(PROGRAM, {
      space,
      tx: txA,
    });
    const resultA = a.getCell<{ isEditing: boolean }>(
      space,
      CAUSE,
      undefined,
      txA,
    );
    a.run(txA, compiledA, {}, resultA);
    a.prepareTxForCommit(txA);
    await txA.commit().settled;
    await a.idle();
    await storageA.synced();
    await resultA.pull();

    const compiledB = await b.patternManager.compilePattern(PROGRAM, { space });
    const txB = b.edit();
    const resultB = b.getCell<{ isEditing: boolean }>(
      space,
      CAUSE,
      compiledB.resultSchema,
      txB,
    );
    await txB.commit().settled;
    await b.start(resultB);
    const cancel = resultB.key("isEditing").sink(() => {});
    try {
      await b.settled();
      await b.idle();
      await storageB.synced();
      await resultB.pull();

      const internalA = parseLink(resultA.key("isEditing").getRaw(), resultA)!;
      const internalB = parseLink(resultB.key("isEditing").getRaw(), resultB)!;
      expect(internalB).toMatchObject({ id: internalA.id, scope: "space" });
      const cellA = a.getCellFromLink(internalA);
      const cellB = b.getCellFromLink(internalB);
      await cellA.pull();
      await cellB.pull();
      expect(parseLink(cellA.getRaw(), cellA)).toMatchObject({
        scope: "session",
      });
      expect(parseLink(cellB.getRaw(), cellB)).toMatchObject({
        scope: "session",
      });
    } finally {
      cancel();
    }
  });
});
