/**
 * What a host holds after reading, with no schema, a value whose parts share
 * a document: the worker's answer as `HostReadGate` builds it, hydrated as a
 * `CellHandle` hydrates every answer it is given.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { type Cell, KeepAsCell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { HostReadGate } from "@/backends/host-read-gate.ts";
import {
  $conn,
  CellHandle,
  type CellRef,
  isCellHandle,
  type RuntimeClient,
} from "@/mod.ts";

const signer = await Identity.fromPassphrase("host read shared documents");
const space = signer.did();

/** What the room document both paths reach holds. */
const ROOM = { title: "Lunch", messages: ["noon?", "noon."] };

/** A runtime holding a room, and a manager listing it and naming it again. */
async function shelf() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const room = runtime.getCell(space, "room");
  const manager = runtime.getCell(space, "manager");
  const linkTo = (cell: Cell<unknown>) =>
    cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });
  const tx = runtime.edit();
  room.withTx(tx).setRawUntyped(ROOM as never);
  manager.withTx(tx).setRawUntyped({
    rooms: [{ room: linkTo(room) }],
    notices: [{ room: linkTo(room) }],
  } as never);
  expect((await tx.commit().settled).error).toBeUndefined();
  await runtime.idle();
  return {
    room,
    manager,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

/** A handle on the manager whose runtime client answers nothing. */
function managerHandle(manager: Cell<unknown>): CellHandle<unknown> {
  const runtime = {
    [$conn]: () => ({
      request: () => Promise.resolve({}),
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
    }),
  } as unknown as RuntimeClient;
  const { id, space, path } = manager.getAsNormalizedFullLink();
  return new CellHandle(runtime, {
    id: id as CellRef["id"],
    space: space as CellRef["space"],
    scope: "space",
    path: path.map(String),
  });
}

describe("host-read-shared-documents", () => {
  it("hydrates the first path to a shared document as its data, and a later one as a handle on it", async () => {
    await using docs = await shelf();
    const answer = new HostReadGate(undefined, {}).read(docs.manager);
    if (!("value" in answer)) throw new Error("The read was refused.");
    const value = CellHandle.deserialize(
      managerHandle(docs.manager),
      answer.value,
    ) as {
      rooms: { room: unknown }[];
      notices: { room: unknown }[];
    };

    expect(value.rooms[0].room).toEqual(ROOM);
    const handle = value.notices[0].room;
    expect(isCellHandle(handle)).toBe(true);
    const { id, space: handleSpace, path } = (handle as CellHandle<unknown>)
      .ref();
    expect({ id, space: handleSpace, path }).toEqual({
      id: docs.room.getAsNormalizedFullLink().id,
      space,
      path: [],
    });
  });
});
