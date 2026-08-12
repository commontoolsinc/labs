import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { listPieceCallables } from "../lib/piece.ts";

/**
 * One pattern with one verb and three data fields of different shapes — a
 * scalar with a default, a computed number, and an array.
 *
 * The listing's classification is exercised against CELLS THE RUNTIME BUILT,
 * because the defect this pins cannot be reproduced against a double: the
 * forced-stream cast asked a cell "are you a stream?" after casting it to one,
 * and a hand-written double answers from whatever the test decided instead of
 * from the cast. Every data field below was reported as a callable handler,
 * with the field's own schema offered as its input schema.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, cell, computed, pattern, Stream } from "commonfabric";',
      "",
      "interface AddEvent { title: string; }",
      "",
      "interface Out {",
      "  label: string;",
      "  count: number;",
      "  items: string[];",
      "  add: Stream<AddEvent>;",
      "}",
      "",
      "export default pattern<Record<string, never>, Out>(() => {",
      "  const items = cell<string[]>([]);",
      "  const label = cell('untitled');",
      "  const add = action((event: AddEvent) => { items.push(event.title); });",
      "  return {",
      "    label,",
      "    count: computed(() => items.get().length),",
      "    items,",
      "    add,",
      "  };",
      "});",
    ].join("\n"),
  }],
};

describe("listPieceCallables against a live piece", () => {
  it("lists the verb and none of the data fields", async () => {
    const signer = await Identity.fromPassphrase("piece-verbs-live");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    const space = signer.did();

    try {
      const compiled = await runtime.patternManager.compilePattern(
        PROGRAM as never,
        { space },
      );
      const tx = runtime.edit();
      const rootCell = runtime.getCell(space, "listing-live", undefined, tx);
      const root = runtime.run(tx, compiled, {}, rootCell);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await root.pull();

      // The piece surface `listPieceCallables` walks: a result cell, an empty
      // input cell, and the piece root it sweeps for names the walk rejected.
      const emptyInput = runtime.getCell(space, "listing-live-input");
      const piece = {
        result: { getCell: () => Promise.resolve(root) },
        input: { getCell: () => Promise.resolve(emptyInput) },
        getCell: () => root,
      };

      const listing = await listPieceCallables(
        {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:live",
          space,
        },
        {
          loadPieces: () => Promise.resolve({ getSpace: () => space } as never),
          loadPiece: () => Promise.resolve(piece as never),
        },
      );

      // The pattern declares exactly one verb. Every other name is data, and
      // data is not callable — calling one is accepted and then dropped by the
      // scheduler, which the caller never sees.
      expect(listing.verbs.map((verb) => verb.name)).toEqual(["add"]);
      expect(listing.verbs[0].kind).toBe("handler");
      // The verb's input schema is the event's, not the property's own.
      expect(listing.verbs[0].inputSchema).toMatchObject({
        properties: { title: { type: "string" } },
      });
    } finally {
      await runtime.dispose?.();
      await storageManager.close?.();
    }
  });
});
