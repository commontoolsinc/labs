import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "v2-transaction integer-like keys",
);
const space = signer.did();

/** A storage session against the shared server, and the runtime over it. */
type Session = { storage: EmulatedStorageManager; runtime: Runtime };

describe("v2-transaction", () => {
  let server: MemoryV2Server.Server;
  const sessions: Session[] = [];

  beforeEach(() => {
    server = newSharedServer();
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      await session.runtime.dispose();
      await session.storage.close();
    }
    await server.close();
  });

  /** Opens a session against the shared server. */
  const connect = (): Session => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    const session = { storage, runtime };
    sessions.push(session);
    return session;
  };

  /**
   * Commits what `write` does to the cell of the document `doc`. Throws where
   * the commit is refused.
   */
  const commit = async (
    session: Session,
    doc: string,
    write: (cell: Cell<FabricValue>) => void,
  ): Promise<void> => {
    const tx = session.runtime.edit();
    write(session.runtime.getCell<FabricValue>(space, doc, undefined, tx));
    const result = await tx.commit().settled;
    if (result.error) throw result.error;
  };

  /**
   * Returns the value of the document `doc` as a session that connects now
   * loads it, which is the value the server made of the ops it was sent.
   */
  const storedValue = async (doc: string): Promise<FabricValue | undefined> => {
    const cell = connect().runtime.getCell<FabricValue>(space, doc);
    await cell.sync();
    return cell.getRaw();
  };

  describe("a record keyed by integer-like strings", () => {
    // A key of a plain object written as a non-negative integer is a key of
    // that object, inside the range of array indices and past it. Each case
    // reads the document back through a second session, so what it asserts is
    // the value the server made of the ops it was sent, and `toStrictEqual()`
    // tells a record from the array an index would address.

    const farPast = "1791869505000000000";
    const keys = [
      { key: "123", where: "inside the array index range" },
      { key: "4294967295", where: "one past the array index range" },
      { key: farPast, where: "far past the array index range" },
    ];

    for (const { key, where } of keys) {
      it(`commits a key ${where} added to an empty record`, async () => {
        const writer = connect();
        await commit(writer, "added", (cell) => cell.set({}));

        await commit(writer, "added", (cell) => cell.set({ [key]: 1 }));

        expect(await storedValue("added")).toStrictEqual({ [key]: 1 });
      });

      it(`commits the removal of a key ${where} from a record`, async () => {
        const writer = connect();
        await commit(
          writer,
          "removed",
          (cell) => cell.set({ [key]: 1, kept: 2 }),
        );

        await commit(writer, "removed", (cell) => cell.set({ kept: 2 }));

        expect(await storedValue("removed")).toStrictEqual({ kept: 2 });
      });
    }

    it("commits a key far past the array index range written beneath a key the record lacks", async () => {
      const writer = connect();
      await commit(writer, "created", (cell) => cell.set({}));

      await commit(
        writer,
        "created",
        (cell) => cell.key("byTime").key(farPast).set(1),
      );

      expect(await storedValue("created")).toStrictEqual({
        byTime: { [farPast]: 1 },
      });
    });

    it("commits a value written beneath a key far past the array index range, itself beneath a key the record lacks", async () => {
      const writer = connect();
      await commit(writer, "nested", (cell) => cell.set({}));

      await commit(
        writer,
        "nested",
        (cell) => cell.key("byTime").key(farPast).key("text").set("hi"),
      );

      expect(await storedValue("nested")).toStrictEqual({
        byTime: { [farPast]: { text: "hi" } },
      });
    });
  });
});
