import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import { readConfirmed } from "../src/confirmed-read.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { SessionSync } from "@commonfabric/memory/v2";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("confirmed read");
const space = signer.did();

const noteSchema = {
  type: "object",
  properties: { n: { type: "number" } },
} as const satisfies JSONSchema;
type Note = { n?: number };

const parentSchema = {
  type: "object",
  properties: {
    n: { type: "number" },
    child: { ...noteSchema, asCell: ["cell"] },
  },
} as const satisfies JSONSchema;
type Parent = { n?: number; child?: Cell<Note> };

describe("confirmed-read", () => {
  let server: MemoryV2Server.Server;
  let writerManager: EmulatedStorageManager;
  let readerManager: EmulatedStorageManager;
  let writer: Runtime;
  let reader: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    writerManager = EmulatedStorageManager.connectTo(server, { as: signer });
    readerManager = EmulatedStorageManager.connectTo(server, { as: signer });
    writer = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerManager,
    });
    reader = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: readerManager,
    });
  });

  afterEach(async () => {
    await reader.dispose();
    await writer.dispose();
    await readerManager.close();
    await writerManager.close();
    await server.close();
  });

  /** Writes `n` to the note named `cause` from the writer, and returns the
   * sequence the commit landed at. */
  async function write(cause: string, n: number): Promise<number> {
    const tx = writer.edit();
    writer.getCell<Note>(space, cause, noteSchema, tx).set({ n });
    expect((await tx.commit().settled).error).toBeUndefined();
    return tx.committedSeq!(space)!;
  }

  /** The reader's note named `cause`, loaded. */
  async function loaded(cause: string): Promise<Cell<Note>> {
    const note = reader.getCell<Note>(space, cause, noteSchema);
    await note.sync();
    return note;
  }

  /** Resolves once the reader's `note` holds `n`. */
  function arrival(note: Cell<Note>, n: number): Promise<void> {
    const arrived = Promise.withResolvers<void>();
    const cancel = note.sink((value) => {
      if (value?.n === n) arrived.resolve();
    });
    return arrived.promise.finally(cancel);
  }

  it("returns the read as confirmed and complete through a commit a push delivered", async () => {
    await write("first", 1);
    await write("second", 1);
    const first = await loaded("first");
    const second = await loaded("second");

    const delivered = arrival(first, 2);
    const seq = await write("first", 2);
    await delivered;

    const read = readConfirmed(reader, space, (tx) => ({
      first: first.withTx(tx).get()?.n,
      second: second.withTx(tx).get()?.n,
    }));
    expect(read.value).toEqual({ first: 2, second: 1 });
    expect(read.confirmed).toBe(true);
    expect(read.seq).toBeGreaterThanOrEqual(seq);
  });

  it("reads a document and the document it links to as one confirmed read", async () => {
    await write("child", 1);
    const created = writer.edit();
    writer.getCell<Parent>(space, "parent", parentSchema, created).set({
      n: 1,
      child: writer.getCell<Note>(space, "child", noteSchema, created),
    });
    expect((await created.commit().settled).error).toBeUndefined();
    const parent = reader.getCell<Parent>(space, "parent", parentSchema);
    await parent.sync();
    const child = await loaded("child");

    const delivered = arrival(child, 2);
    const seq = await write("child", 2);
    await delivered;

    const read = readConfirmed(reader, space, (tx) => {
      const value = parent.withTx(tx).get();
      return { n: value?.n, child: value?.child?.withTx(tx).get()?.n };
    });
    expect(read.value).toEqual({ n: 1, child: 2 });
    expect(read.confirmed).toBe(true);
    expect(read.seq).toBeGreaterThanOrEqual(seq);
  });

  it("returns no sequence once a frame failed to apply", async () => {
    await write("broken", 1);
    const broken = await loaded("broken");
    const delivered = arrival(broken, 2);
    await write("broken", 2);
    await delivered;
    expect(readConfirmed(reader, space, () => undefined).seq).toBeDefined();

    // A frame without the upserts every frame carries fails to apply.
    const malformed = {
      type: "sync",
      fromSeq: 0,
      toSeq: 0,
      removes: [],
    } as unknown as SessionSync;
    const replica = readerManager.open(space).replica as SpaceReplica;
    expect(() =>
      replica.accessForTestingOnly.applySessionSync(malformed, "integrate")
    ).toThrow();

    const read = readConfirmed(
      reader,
      space,
      (tx) => broken.withTx(tx).get()?.n,
    );
    expect(read).toEqual({ value: 2, confirmed: true });
  });

  it("returns a confirmed read with no sequence before any push has applied", async () => {
    await write("only", 1);
    const only = await loaded("only");

    const read = readConfirmed(reader, space, (tx) => only.withTx(tx).get()?.n);
    expect(read).toEqual({ value: 1, confirmed: true });
  });

  it("returns an unconfirmed read of a document with a pending local write", async () => {
    await write("pending", 1);
    const pending = await loaded("pending");

    const tx = reader.edit();
    pending.withTx(tx).set({ n: 2 });
    const committed = tx.commit();
    const read = readConfirmed(
      reader,
      space,
      (readTx) => pending.withTx(readTx).get()?.n,
    );
    expect((await committed.settled).error).toBeUndefined();

    expect(read).toEqual({ value: 2, confirmed: false });
  });

  it("returns the reader's own write as confirmed once a push covers its commit", async () => {
    await write("own", 1);
    const own = await loaded("own");

    const tx = reader.edit();
    own.withTx(tx).set({ n: 2 });
    expect((await tx.commit().settled).error).toBeUndefined();
    const seq = tx.committedSeq!(space)!;

    const read = readConfirmed(
      reader,
      space,
      (readTx) => own.withTx(readTx).get()?.n,
    );
    expect(read.value).toBe(2);
    expect(read.confirmed).toBe(true);
    expect(read.seq).toBeGreaterThanOrEqual(seq);
  });

  it("returns the reader's own deletion as confirmed once a push covers its commit", async () => {
    // The server does not echo a writer's own `delete` back to it, so only
    // the push that covers the commit makes the replica's deletion confirmed.

    await write("deleted", 1);
    const deleted = await loaded("deleted");

    const tx = reader.edit();
    tx.writeValueOrThrow(deleted.getAsNormalizedFullLink(), undefined);
    expect((await tx.commit().settled).error).toBeUndefined();
    const seq = tx.committedSeq!(space)!;

    const read = readConfirmed(
      reader,
      space,
      (readTx) => deleted.withTx(readTx).get(),
    );
    expect(read.value).toBeUndefined();
    expect(read.confirmed).toBe(true);
    expect(read.seq).toBeGreaterThanOrEqual(seq);
  });

  it("returns an unconfirmed read of a document it sampled without loading", async () => {
    await write("anchor", 1);
    const anchor = await loaded("anchor");
    const delivered = arrival(anchor, 2);
    await write("anchor", 2);
    await delivered;
    const unloaded = reader.getCell<Note>(space, "sampled", noteSchema);

    const read = readConfirmed(
      reader,
      space,
      (tx) => unloaded.withTx(tx).sample()?.n,
    );
    expect(read).toEqual({ value: undefined, confirmed: false });
  });

  it("throws for a write inside the read", async () => {
    await write("written", 1);
    const written = await loaded("written");

    expect(() =>
      readConfirmed(reader, space, (tx) => {
        written.withTx(tx).set({ n: 999 });
        return written.withTx(tx).get()?.n;
      })
    ).toThrow();
    expect(
      readConfirmed(reader, space, (tx) => written.withTx(tx).get()?.n).value,
    )
      .toBe(1);
  });

  it("returns no sequence while its server runs server execution", async () => {
    // Set before either session opens, so the server's hello says so.
    server.setServerExecutionObserver({});
    await write("served", 1);
    const served = await loaded("served");
    const delivered = arrival(served, 2);
    await write("served", 2);
    await delivered;

    const read = readConfirmed(
      reader,
      space,
      (tx) => served.withTx(tx).get()?.n,
    );
    expect(read).toEqual({ value: 2, confirmed: true });
  });

  it("returns an unconfirmed read of a document it has not loaded", () => {
    const unloaded = reader.getCell<Note>(space, "unloaded", noteSchema);

    const read = readConfirmed(
      reader,
      space,
      (tx) => unloaded.withTx(tx).get()?.n,
    );
    expect(read).toEqual({ value: undefined, confirmed: false });
  });
});
