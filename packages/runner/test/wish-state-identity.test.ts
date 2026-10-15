/**
 * Two sessions, each running a piece from its own compilation of the piece's
 * pattern, over one shared space. The two compilations declare the wish's
 * result under schemas that differ, as a program compiled before a deploy and
 * one compiled after it do, so the serialized inputs of the wish node differ
 * while its output slot is the same. Both name one wish state, each reads its
 * own user's result through it, and once both have settled nothing writes
 * again. The remote-echo breaker runs over it as it runs everywhere: with one
 * state behind the shared slot there is no loop for it to see.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { parseLink } from "../src/link-utils.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const alice = await Identity.fromPassphrase("wish state identity alice");
const bob = await Identity.fromPassphrase("wish state identity bob");
const space = (await Identity.fromPassphrase("wish state identity space"))
  .did();

const CAUSE = "wish state identity piece";
const TAG = "wish_state_identity_profile";

type Result = { name: string | undefined; found: unknown };

/**
 * A piece whose `name` is the viewer's own favorite tagged `TAG`, found through
 * the viewer's Home, with the wish's result declared as `resultType`.
 */
const program = (resultType: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { pattern, wish } from "commonfabric";',
      "",
      "export default pattern<{}, { name: string | undefined; found: unknown }>(",
      "  () => {",
      `    const found = wish<${resultType}>({ query: "#${TAG}", scope: ["~"] });`,
      "    return { name: found.result?.name, found };",
      "  },",
      ");",
    ].join("\n"),
  }],
});

describe("wish-state-identity", () => {
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let a: Runtime;
  let b: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storageA = EmulatedStorageManager.connectTo(server, { as: alice });
    storageB = EmulatedStorageManager.connectTo(server, { as: bob });
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

  /** Gives `user`'s Home one favorite tagged `TAG`, named after the user. */
  async function seedHome(runtime: Runtime, user: Identity): Promise<void> {
    const home = user.did() as MemorySpace;
    const tx = runtime.edit();
    const favorite = runtime.getCell(home, "favorite", undefined, tx);
    favorite.set({ name: `favorite of ${user.did()}` });
    const homeCell = runtime.getCell(home, home, undefined, tx);
    homeCell.set({
      defaultPattern: { favorites: [{ cell: favorite, tags: [TAG] }] },
    });
    expect((await tx.commit().settled).error).toBeUndefined();
  }

  /** Syncs `runtime` with the server and refreshes `result` from it. */
  async function settle(
    runtime: Runtime,
    storage: EmulatedStorageManager,
    result: { pull(): Promise<unknown> },
  ): Promise<void> {
    await runtime.idle();
    await storage.synced();
    await result.pull();
  }

  /**
   * The wish state `result`'s `found` slot links to: the slot is the wish
   * node's output document, and what it holds is the link the wish wrote.
   */
  async function wishStateLink(
    runtime: Runtime,
    result: Cell<Result>,
  ): Promise<NormalizedFullLink> {
    const slot = runtime.getCellFromLink(
      parseLink(result.key("found").getRaw(), result)!,
    );
    await slot.pull();
    return parseLink(slot.getRaw(), slot)!;
  }

  it("names one state for two compilations whose wish inputs differ", async () => {
    await seedHome(a, alice);
    await seedHome(b, bob);

    // Alice's session creates the piece from a program declaring the wish's
    // result as `{ name: string }`.
    const txA = a.edit();
    const compiledA = await a.patternManager.compilePattern(
      program("{ name: string }"),
      { space, tx: txA },
    );
    const resultA = a.getCell<Result>(space, CAUSE, undefined, txA);
    a.run(txA, compiledA, {}, resultA);
    a.prepareTxForCommit(txA);
    expect((await txA.commit().settled).error).toBeUndefined();
    // Each session watches its result, as a session rendering the piece does.
    const cancelA = resultA.key("name").sink(() => {});
    await settle(a, storageA, resultA);
    expect(resultA.key("name").get()).toBe(`favorite of ${alice.did()}`);
    const stateA = await wishStateLink(a, resultA);
    expect(stateA.scope).toBe("user");

    // Bob's session runs the same piece from a program declaring the result
    // with one more member, so its wish node serializes different inputs to
    // the same output slot.
    const compiledB = await b.patternManager.compilePattern(
      program("{ name: string; avatar?: string }"),
      { space },
    );
    const resultB = b.getCell<Result>(space, CAUSE, compiledB.resultSchema);
    await b.runner.runSynced(resultB, compiledB, {});
    const cancelB = resultB.key("name").sink(() => {});
    try {
      await b.settled();
      await settle(b, storageB, resultB);
      await settle(a, storageA, resultA);
      expect(resultB.key("name").get()).toBe(`favorite of ${bob.did()}`);
      expect(resultA.key("name").get()).toBe(`favorite of ${alice.did()}`);

      // One state document behind the shared slot, from both sides.
      const stateB = await wishStateLink(b, resultB);
      expect(stateB).toMatchObject({ id: stateA.id, scope: "user" });
      expect(await wishStateLink(a, resultA)).toMatchObject({
        id: stateA.id,
        scope: "user",
      });

      // Settled recomputation on both sides writes nothing further.
      const engine = await server.engineForSpace(space);
      const seq = Engine.serverSeq(engine);
      for (let round = 0; round < 2; round++) {
        await settle(a, storageA, resultA);
        await settle(b, storageB, resultB);
      }
      expect(Engine.serverSeq(engine)).toBe(seq);
      expect(resultA.key("name").get()).toBe(`favorite of ${alice.did()}`);
      expect(resultB.key("name").get()).toBe(`favorite of ${bob.did()}`);
      const nothing = { active: 0, trips: 0, cyclesObserved: 0 };
      expect(a.scheduler.getEchoBreakerStats()).toEqual(nothing);
      expect(b.scheduler.getEchoBreakerStats()).toEqual(nothing);
    } finally {
      cancelB();
      cancelA();
    }
  });
});
