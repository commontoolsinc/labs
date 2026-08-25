import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { PieceController } from "../../src/ops/piece-controller.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece controller edit");

/** A counter document; `n` is what the overlapping edits contend for. */
function counterProgram(): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ n?: number }>(({ n }) => ({",
        "  [NAME]: 'Counter',",
        "  n,",
        "}));",
        "",
      ].join("\n"),
    }],
  };
}

describe("piece-controller", () => {
  describe("edit()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;
    let piece: PieceController;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceName: `controller-edit-${crypto.randomUUID()}`,
        }),
        runtime,
      );
      await pieces.synced();
      piece = await pieces.create(counterProgram(), { input: { n: 0 } });
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    async function readN(): Promise<unknown> {
      const cell = await piece.input.getCell();
      await cell.pull();
      return (cell.getRaw({ lastNode: "value" }) as { n?: unknown }).n;
    }

    it("computes each overlapping edit from the then-current document", async () => {
      // Overlapping edits on one replica serialize rather than conflict
      // (an immediate transaction holds the local order), so the retry
      // path stays with editWithRetry's own contract for replica-behind
      // conflicts; what this proves is the property repair rests on —
      // every produce call answers for the document its commit sees, so
      // neither of two contending updates is lost.
      let runs = 0;
      const bump = () =>
        piece.input.edit((stored) => {
          runs += 1;
          const doc = stored as { n?: number };
          return { value: { n: (doc.n ?? 0) + 1 } };
        });
      await Promise.all([bump(), bump()]);
      expect(await readN()).toBe(2);
      expect(runs).toBe(2);
    });

    it("returns wrote: false and writes nothing for a no-write answer", async () => {
      const result = await piece.input.edit(() => undefined);
      expect(result).toEqual({ wrote: false });
      expect(await readN()).toBe(0);
    });

    it("hands produce the stored value and writes its answer", async () => {
      let seen: unknown;
      const result = await piece.input.edit((stored) => {
        seen = (stored as { n?: unknown }).n;
        return { value: { n: 7 } };
      });
      expect(result).toEqual({ wrote: true });
      expect(seen).toBe(0);
      expect(await readN()).toBe(7);
    });
  });
});
