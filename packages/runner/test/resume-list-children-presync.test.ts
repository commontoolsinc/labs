import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("resume list children presync");
const space = signer.did();

// A map over a durable list: each element runs as a child piece of its own,
// resumed by the coordinator from inside its scheduler run.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "export default pattern<{ items: { n: number }[] }>(({ items }) => {",
      "  return { doubled: items.map((item) => ({ value: item.n * 2 })) };",
      "});",
    ].join("\n"),
  }],
};

describe("resume-list-children-presync", () => {
  // A coordinator's children arrive at a cold replica without their execution
  // families, and the coordinator instantiates them synchronously inside its
  // own run — so the resume pre-sync must name each child before the parent
  // instantiates. The spy records every cell sync a replica issues; the
  // assertions are on the children the pre-sync named, and on those being
  // exactly the children the coordinator itself minted.

  let server: ReturnType<typeof newSharedServer>;
  let managers: EmulatedStorageManager[];
  let runtimes: Runtime[];

  beforeEach(() => {
    server = newSharedServer();
    managers = [];
    runtimes = [];
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    for (const manager of managers) await manager.close();
    await server.close();
  });

  function replica(): { runtime: Runtime; syncedIds: string[] } {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    const syncedIds: string[] = [];
    const original = manager.syncCell.bind(manager);
    manager.syncCell = ((cell, options) => {
      syncedIds.push(cell.getAsNormalizedFullLink().id);
      return original(cell, options);
    }) as typeof manager.syncCell;
    managers.push(manager);
    runtimes.push(runtime);
    return { runtime, syncedIds };
  }

  it("names every list child before a cold resume instantiates the parent", async () => {
    const cellId = "resume-list-children-parent";

    // CREATE: build the durable list and its children on one replica.
    const author = replica();
    const compiled = await author.runtime.patternManager.compilePattern(
      PROGRAM,
      { space },
    );
    const tx = author.runtime.edit();
    const authored = author.runtime.getCell<{ doubled: { value: number }[] }>(
      space,
      cellId,
      compiled.resultSchema,
      tx,
    );
    author.runtime.run(tx, compiled, { items: [{ n: 1 }, { n: 2 }] }, authored);
    await tx.commit();
    await authored.pull();
    await author.runtime.settled();
    await author.runtime.patternManager.flushCompileCacheWrites();
    await author.runtime.storageManager.synced();
    expect(
      (authored.key("doubled").getAsQueryResult() as { value: number }[])
        .map((row) => row.value),
    ).toEqual([2, 4]);
    // The children the coordinator minted: the result container's slots
    // link each element's result document.
    const container = authored.key("doubled").resolveAsCell();
    const slots = container.getRaw() as unknown[];
    const childIds: string[] = slots.flatMap((slot) => {
      const id = parseLink(slot, container)?.id;
      return id === undefined ? [] : [id as string];
    });
    expect(childIds.length).toBe(2);
    await author.runtime.dispose({ closeStorage: false });
    runtimes.splice(runtimes.indexOf(author.runtime), 1);

    // RESUME: a cold replica starts the parent; the pre-sync names both
    // children, and does so before the coordinator has instantiated either.
    const resumer = replica();
    await resumer.runtime.patternManager.compilePattern(PROGRAM, { space });
    const resumed = resumer.runtime.getCell<{ doubled: { value: number }[] }>(
      space,
      cellId,
      compiled.resultSchema,
    );
    const registeredWhenNamed = new Map<string, boolean>();
    const original = resumer.runtime.storageManager.syncCell.bind(
      resumer.runtime.storageManager,
    );
    resumer.runtime.storageManager.syncCell = ((cell, options) => {
      const id = cell.getAsNormalizedFullLink().id;
      if (childIds.includes(id) && !registeredWhenNamed.has(id)) {
        registeredWhenNamed.set(
          id,
          [...resumer.runtime.runner.cancels.keys()].some((key) =>
            key.endsWith(`/${id}`)
          ),
        );
      }
      return original(cell, options);
    }) as typeof resumer.runtime.storageManager.syncCell;

    expect(await resumer.runtime.runner.start(resumed)).toBe(true);
    await resumer.runtime.settled();
    await resumer.runtime.storageManager.synced();

    // Both children were named (mutation: without the children wave the
    // coordinator's own run is the first thing to touch them)...
    for (const id of childIds) {
      expect(resumer.syncedIds).toContain(id);
    }
    // ...and each was named while it was not yet running — the pre-sync
    // ran ahead of the coordinator's instantiation.
    for (const id of childIds) {
      expect(registeredWhenNamed.get(id)).toBe(false);
    }
    expect(
      (resumed.key("doubled").getAsQueryResult() as { value: number }[])
        .map((row) => row.value),
    ).toEqual([2, 4]);
  });
});
