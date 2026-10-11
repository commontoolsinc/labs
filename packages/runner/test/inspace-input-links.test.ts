import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { Cell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

/** Where the child a handler creates is placed. */
type Placement = { target: MemorySpace } | "parent's space";

/** Which cell of the parent the handler hands to the child. */
type Handed = "input" | "derived";

/**
 * Runs, in `home`, a parent whose argument holds `topic`, and sends its
 * handler an event. The handler creates a child, placed by `placement`, and
 * hands it the cell `handed` names: the parent's own input, or a cell the
 * parent derives from it. Returns the child.
 */
async function createChild(
  runtime: Runtime,
  home: MemorySpace,
  placement: Placement,
  handed: Handed,
): Promise<Cell<{ topic: string }>> {
  const { handler, lift, pattern } = createTrustedBuilder(runtime)
    .commonfabric;
  const Child = pattern<{ topic: string }>(({ topic }) => ({ topic }));
  const create = handler<
    Record<string, never>,
    { topic: Cell<string>; room: Cell<unknown> }
  >(
    { type: "object" },
    {
      type: "object",
      properties: {
        topic: { type: "string", asCell: ["cell"] },
        room: { asCell: ["cell"] },
      },
      required: ["topic", "room"],
    },
    (_event, { topic, room }) => {
      const factory = placement === "parent's space"
        ? Child
        : Child.inSpace(placement.target);
      room.set(factory({ topic }));
    },
  );
  const shout = lift((topic: string) => `${topic}!`);
  const Parent = pattern<{ topic: string; room: Cell<unknown> }>(
    ({ topic, room }) => ({
      create: create({
        topic: handed === "input" ? topic : shout(topic),
        room,
      }),
    }),
    {
      type: "object",
      properties: {
        topic: { type: "string" },
        room: { asCell: ["cell"] },
      },
      required: ["topic", "room"],
    },
  );
  const tx = runtime.edit();
  const room = runtime.getCell(home, "room-reference", undefined, tx);
  const root = runtime.getCell(home, "parent", undefined, tx);
  const result = runtime.run(
    tx,
    Parent,
    { topic: "lunch", room },
    root,
  );
  runtime.prepareTxForCommit(tx);
  expect((await tx.commit().settled).error).toBeUndefined();
  await runtime.idle();
  await result.pull();
  result.key("create").send({});
  await runtime.idle();
  await runtime.storageManager.synced();
  await room.pull();
  return room.resolveAsCell() as Cell<{ topic: string }>;
}

/**
 * Runs `body` against a runtime acting for a principal whose home space is
 * the first argument it gets, beside a second space the principal may write.
 */
async function withRuntime(
  body: (
    runtime: Runtime,
    home: MemorySpace,
    other: MemorySpace,
  ) => Promise<void>,
): Promise<void> {
  const creator = await Identity.fromPassphrase("inspace-input-links-home");
  const other = (await Identity.fromPassphrase("inspace-input-links-room"))
    .did();
  const storage = EmulatedStorageManager.emulate({ as: creator });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
  });
  try {
    await body(runtime, creator.did(), other);
  } finally {
    await runtime.dispose();
    await storage.close();
  }
}

describe("inspace-input-links", () => {
  // A handler running in one space creates a child with `inSpace()` in
  // another, and hands it a cell of the handler's own space as an argument.
  // The stored link is what the assertions on it read: `parseLink()` fills a
  // link's missing space from the document holding it, so a link that names
  // no space reads as one into the child's space.

  describe("a child in another space", () => {
    it("stores, in its argument, a link into the space of the parent's input", async () => {
      await withRuntime(async (runtime, home, other) => {
        const child = await createChild(
          runtime,
          home,
          { target: other },
          "input",
        );
        expect(child.space).toBe(other);
        const argument = child.getArgumentCell<{ topic: string }>()!;
        const link = parseLink(argument.key("topic").getRaw(), argument);
        expect(link?.space).toBe(home);
      });
    });

    it("reads the parent's input", async () => {
      await withRuntime(async (runtime, home, other) => {
        const child = await createChild(
          runtime,
          home,
          { target: other },
          "input",
        );
        expect(await child.key("topic").pull()).toBe("lunch");
      });
    });

    it("reads a cell the parent derives", async () => {
      await withRuntime(async (runtime, home, other) => {
        const child = await createChild(
          runtime,
          home,
          { target: other },
          "derived",
        );
        expect(await child.key("topic").pull()).toBe("lunch!");
      });
    });
  });

  describe("a child in the parent's space", () => {
    it("reads the parent's input", async () => {
      await withRuntime(async (runtime, home) => {
        const child = await createChild(
          runtime,
          home,
          "parent's space",
          "input",
        );
        expect(child.space).toBe(home);
        expect(await child.key("topic").pull()).toBe("lunch");
      });
    });
  });
});
