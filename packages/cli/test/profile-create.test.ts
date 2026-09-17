/**
 * Drives `createProfile()` against a runtime with no renderer, hosting the
 * real `profile-create.tsx` behind a stubbed connection, so that what is
 * checked is the whole of what the command does once connected: the event it
 * builds reaches the create handler, the profile is born in a space of its
 * own, and the address returned names it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  createdByThisCall,
  createProfile,
  type ProfileCreateConfig,
} from "../lib/profile.ts";

const sysDir = fromFileUrl(
  new URL("../../patterns/system/", import.meta.url),
);
const read = (name: string) => Deno.readTextFileSync(sysDir + name);

// A host owning a `profiles` list, embedding the real create pattern and
// exposing its stream under the name the home pattern exposes its own.
const WRAPPER_SRC = [
  "import ProfileCreate from './profile-create.tsx';",
  "import { pattern, Writable } from 'commonfabric';",
  "import type { ProfileHomeOutput } from './profile-home.tsx';",
  "",
  "export default pattern(() => {",
  "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
  "  const created = ProfileCreate({ profiles });",
  "  return { profiles, createProfile: created.createProfile };",
  "});",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: WRAPPER_SRC },
    { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
};

const signer = await Identity.fromPassphrase("cf-profile-create");
const space = signer.did();

const CONFIG: ProfileCreateConfig = {
  apiUrl: "http://127.0.0.1:8000",
  identity: "/unread.key",
  space,
  name: "Ada Lovelace",
};

describe("createProfile()", () => {
  let manager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  // deno-lint-ignore no-explicit-any
  let host: any;
  // deno-lint-ignore no-explicit-any
  let loadPieces: any;

  beforeEach(async () => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    const tx = runtime.edit();
    const parent = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      "cf profile create host",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    host = runtime.run(tx, parent as any, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    const setup = await tx.commit();
    expect(setup.error).toBeUndefined();
    await host.pull();
    // The connection the command would open, answering with this host as
    // the home root.
    loadPieces = () =>
      Promise.resolve({
        runtime,
        synced: () => Promise.resolve(),
        ensureDefaultPattern: () => Promise.resolve({ getCell: () => host }),
      });
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await manager.close();
  });

  it("creates the profile in a space of its own and returns its address", async () => {
    const created = await createProfile(CONFIG, { loadPieces });
    expect(created.name).toBe("Ada Lovelace");
    expect(created.space).not.toBe(space);
    expect(created.address).toContain(created.space);
    expect(created.address).toContain(created.id);
  });

  it("returns the profile the call made, not one already there", async () => {
    const first = await createProfile(CONFIG, { loadPieces });
    const second = await createProfile(
      { ...CONFIG, name: "Alan Turing" },
      { loadPieces },
    );
    expect(second.name).toBe("Alan Turing");
    expect(second.space).not.toBe(first.space);
  });

  it("refuses a name carrying a control character", async () => {
    await expect(createProfile({ ...CONFIG, name: "Ada\u001bLovelace" }, {
      loadPieces,
    })).rejects.toThrow(/control characters/);
  });

  it("picks the profile carrying this call's name when two appeared at once, and refuses a tie", async () => {
    // Two profiles land between one call's first read and its second, as
    // two processes creating at once make happen.
    const ada = await createProfile(CONFIG, { loadPieces });
    const alan = await createProfile({ ...CONFIG, name: "Alan Turing" }, {
      loadPieces,
    });
    const links = host.key("profiles").asSchema({
      type: "array",
      items: { type: "unknown", asCell: ["cell"] },
      // deno-lint-ignore no-explicit-any
    } as any).get() as Cell<unknown>[];
    const candidates: [string, Cell<unknown>][] = links.map((link) => [
      link.getAsNormalizedFullLink().space,
      link,
    ]);
    expect(candidates.map(([space]) => space).sort())
      .toEqual([ada.space, alan.space].sort());
    const picked = await createdByThisCall(candidates, "Alan Turing");
    expect(picked?.[0]).toBe(alan.space);
    const twoAdas = await createProfile(CONFIG, { loadPieces });
    const tie = candidates.filter(([space]) => space !== alan.space).concat([[
      twoAdas.space,
      links.length === 3 ? links[2] : candidates[0][1],
    ]]);
    await expect(createdByThisCall(tie, "Ada Lovelace")).rejects.toThrow(
      /more than one carries that name/,
    );
    expect(await createdByThisCall([], "Ada Lovelace")).toBeUndefined();
  });

  it("trims the name and refuses a blank one before connecting", async () => {
    let connected = 0;
    const counting = () => {
      connected++;
      return loadPieces();
    };
    await expect(createProfile({ ...CONFIG, name: "  " }, {
      loadPieces: counting,
    })).rejects.toThrow(/needs a name/);
    expect(connected).toBe(0);
    const created = await createProfile({ ...CONFIG, name: "  Ada  " }, {
      loadPieces: counting,
    });
    expect(created.name).toBe("Ada");
  });
});
