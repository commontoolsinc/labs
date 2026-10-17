import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { type Cell, hostValueOf } from "../src/cell.ts";
import { isSigilLink } from "../src/link-types.ts";
import { KeepAsCell, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-host-value-of");
const space = signer.did();

/** What the room document every case shares holds. */
const ROOM = { title: "Lunch", messages: ["noon?", "noon."] };

describe("hostValueOf()", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Writes each of `docs` as given, raw, and returns their cells by id. */
  const write = async (
    docs: Record<string, (cells: Record<string, Cell<unknown>>) => unknown>,
  ): Promise<Record<string, Cell<unknown>>> => {
    const cells = Object.fromEntries(
      Object.keys(docs).map((id) => [id, runtime.getCell(space, id)]),
    );
    const tx = runtime.edit();
    for (const [id, valueOf] of Object.entries(docs)) {
      cells[id].withTx(tx).setRawUntyped(valueOf(cells) as never);
    }
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    return cells;
  };

  /** The link a stored document holds to `cell`. */
  const linkTo = (cell: Cell<unknown>) =>
    cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });

  /** The address a link in a converted value names. */
  const addressOf = (link: unknown) => {
    expect(isSigilLink(link)).toBe(true);
    const { id, space, path } = parseLink(link as never)!;
    return { id, space, path };
  };

  /**
   * A manager listing the room once and naming it in two notices: three
   * paths to one document.
   */
  const manager = () =>
    write({
      room: () => ROOM,
      manager: ({ room }) => ({
        rooms: [{ room: linkTo(room) }],
        notices: [{ room: linkTo(room) }, { room: linkTo(room) }],
      }),
    });

  it("returns a document reached by several paths in full at the first, and a link to it at the rest", async () => {
    const { room, manager: managed } = await manager();
    const value = hostValueOf(managed.get()) as {
      rooms: { room: unknown }[];
      notices: { room: unknown }[];
    };

    expect(value.rooms[0].room).toEqual(ROOM);
    const roomAddress = {
      id: room.getAsNormalizedFullLink().id,
      space,
      path: [],
    };
    expect(addressOf(value.notices[0].room)).toEqual(roomAddress);
    expect(addressOf(value.notices[1].room)).toEqual(roomAddress);
  });

  it("returns the copy at the position a depth-first walk in each container's order visits first", async () => {
    // The same documents, with the notices written ahead of the list. The
    // first position is a property of the value's own order, so it moves with
    // the order and nothing else.

    const { room } = await manager();
    const reordered = (await write({
      reordered: () => ({
        notices: [{ room: linkTo(room) }],
        rooms: [{ room: linkTo(room) }],
      }),
    })).reordered;
    const value = hostValueOf(reordered.get()) as {
      rooms: { room: unknown }[];
      notices: { room: unknown }[];
    };

    expect(value.notices[0].room).toEqual(ROOM);
    expect(isSigilLink(value.rooms[0].room)).toBe(true);
  });

  it("returns a copy at every path where the read carries a schema", async () => {
    // A schema saying to read the room inline is the reader's own statement
    // of the shape it takes, so each position keeps the copy it asked for.

    const { manager: managed } = await manager();
    const roomSchema = {
      type: "object",
      properties: {
        title: { type: "string" },
        messages: { type: "array", items: { type: "string" } },
      },
    } as const;
    const entries = {
      type: "array",
      items: { type: "object", properties: { room: roomSchema } },
    } as const;
    const value = hostValueOf(
      managed.asSchema({
        type: "object",
        properties: { rooms: entries, notices: entries },
      }).get(),
    ) as { rooms: { room: unknown }[]; notices: { room: unknown }[] };

    expect(value.rooms[0].room).toEqual(ROOM);
    expect(value.notices[0].room).toEqual(ROOM);
    expect(value.notices[1].room).toEqual(ROOM);
  });

  it("returns a back-link to the root where two documents link to each other", async () => {
    // The walk is inside the first document when the second leads back to
    // it, so that position is a cycle and takes the back-link a cycle takes,
    // naming the path it was reached from.

    const { first } = await write({
      first: ({ second }) => ({ name: "first", next: linkTo(second) }),
      second: ({ first }) => ({ name: "second", next: linkTo(first) }),
    });
    const value = hostValueOf(first.get()) as {
      name: string;
      next: { name: string; next: unknown };
    };

    expect(value.name).toBe("first");
    expect(value.next.name).toBe("second");
    expect(value.next.next).toEqual({ "/": { "link@1": { path: [] } } });
  });
});
