import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { createSession, Identity } from "@commonfabric/identity";
import type { Cell } from "@commonfabric/runner";
import { Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "@commonfabric/piece/ops";

import { describePiece, listPieceCallables } from "../lib/piece.ts";

/**
 * A pattern whose result type reaches a collection: one verb, and a list whose
 * element type is a named interface. On a real piece that list is where the
 * documents are — a board's topics, a note's blocks — so the declared result
 * type is the widest read anything could take, and `Item` is what a watch
 * under that type would descend into.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, cell, pattern, Stream } from "commonfabric";',
      "",
      "interface AddEvent { title: string; }",
      "interface Item { title: string; body: string; }",
      "",
      "interface Out {",
      "  items: Item[];",
      "  add: Stream<AddEvent>;",
      "}",
      "",
      "export default pattern<Record<string, never>, Out>(() => {",
      "  const items = cell<Item[]>([]);",
      "  const add = action((event: AddEvent) => {",
      "    items.push({ title: event.title, body: 'body' });",
      "  });",
      "  return { items, add };",
      "});",
    ].join("\n"),
  }],
};

/** Whether `schema` is the pattern's declared result type — the read this file
 * exists to prove discovery never takes. Recognized by the element type only
 * the declared type names, so a bounded schema that happens to mention the
 * same property cannot pass for it. */
function isDeclaredResultType(schema: unknown): boolean {
  return JSON.stringify(schema ?? null).includes('"#/$defs/Item"');
}

/** The reader replica's loads, in the order it issued them: one entry per
 * document sync, carrying the schema the sync went out under. */
interface RecordedSync {
  id: string;
  schema: unknown;
}

/**
 * Run `read` against a piece the reader replica has never seen, and return
 * what it read alongside every sync it issued.
 *
 * Two replicas over one server, because the point is which documents travel: a
 * replica that wrote the piece already holds them, and a cold one asks for
 * exactly what it needs.
 */
async function readsOfColdDiscovery<T>(
  read: (
    pieces: PiecesController,
    pieceId: string,
    space: string,
  ) => Promise<T>,
): Promise<{ result: T; syncs: RecordedSync[] }> {
  // Every resource is registered for release the moment it exists, so a
  // failure while the next one is being built still closes what came before:
  // a loopback server or a runtime left open outlives the test that made it.
  const closers: (() => Promise<void>)[] = [];
  const release = async () => {
    for (const close of closers.reverse()) await close();
  };
  try {
    const signer = await Identity.fromPassphrase("cli piece discovery reads");
    const server = newLoopbackServer();
    closers.push(() => server.close());
    const spaceName = "discovery-reads-" + crypto.randomUUID();

    const writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    closers.push(() => writerStorage.close());
    const writerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: writerStorage,
    });
    closers.push(() => writerRuntime.dispose());
    const writerPieces = new PiecesController(
      await createSession({ identity: signer, spaceName }),
      writerRuntime,
    );

    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    closers.push(() => readerStorage.close());
    const readerRuntime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: readerStorage,
    });
    closers.push(() => readerRuntime.dispose());
    const readerPieces = new PiecesController(
      await createSession({ identity: signer, spaceName }),
      readerRuntime,
    );

    await writerPieces.synced();
    const space = writerPieces.getSpace();
    const compiled = await writerRuntime.patternManager.compilePattern(
      PROGRAM as never,
      { space },
    );
    const piece = await writerPieces.runPersistent(compiled, {}, undefined, {
      start: true,
    });
    await writerPieces.synced();

    await readerPieces.synced();
    const syncs: RecordedSync[] = [];
    const manager = readerRuntime.storageManager as unknown as {
      syncCell: (cell: unknown, options?: unknown) => Promise<unknown>;
    };
    const syncCell = manager.syncCell.bind(manager);
    manager.syncCell = (cell: unknown, options?: unknown) => {
      const link = (cell as Cell<unknown>).getAsNormalizedFullLink();
      syncs.push({ id: link.id, schema: link.schema });
      return syncCell(cell, options);
    };

    const result = await read(
      readerPieces,
      entityRefToString(piece.entityId),
      space,
    );
    return { result, syncs };
  } finally {
    await release();
  }
}

describe("piece discovery reads", () => {
  it("lists the verb without syncing under the declared result type", async () => {
    const { result, syncs } = await readsOfColdDiscovery((
      pieces,
      piece,
      space,
    ) =>
      listPieceCallables({
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece,
        space,
      }, { loadPieces: () => Promise.resolve(pieces as never) })
    );

    // The listing is the whole point of paying anything at all, so it is
    // asserted beside the reads: a discovery that syncs nothing and lists
    // nothing has not been made cheaper, it has been broken.
    expect(result.verbs.map((verb) => verb.name)).toEqual(["add"]);
    expect(result.verbs[0].kind).toBe("handler");
    // The event schema still rides the verb's own callable cell, which is what
    // `cf piece call add --help` renders its flags from. A root narrowed past
    // the declared type must not take this with it.
    expect(result.verbs[0].inputSchema).toMatchObject({
      properties: { title: { type: "string" } },
    });

    expect(syncs.filter((sync) => isDeclaredResultType(sync.schema)))
      .toEqual([]);
  });

  it("describes the piece without syncing under the declared result type", async () => {
    const { result, syncs } = await readsOfColdDiscovery((
      pieces,
      piece,
      space,
    ) =>
      describePiece({
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece,
        space,
      }, { loadPieces: () => Promise.resolve(pieces as never) })
    );

    // `describe`'s STATE section comes from the compiled pattern, not from a
    // projection of the piece, so narrowing the root costs it nothing.
    expect(result.verbs.map((verb) => verb.name)).toEqual(["add"]);
    expect(result.state?.map((field) => field.name)).toEqual(["items"]);

    expect(syncs.filter((sync) => isDeclaredResultType(sync.schema)))
      .toEqual([]);
  });
});
