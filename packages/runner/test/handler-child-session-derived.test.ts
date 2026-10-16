/**
 * A piece whose body nests a pattern with a value derived from a per-session
 * input computes that value for a session that did not create the piece once
 * that session starts it, as a display that opens it does.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("handler child session derived");
const space = signer.did();

const program = (main: "Board" | "Panel"): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
      import { computed, Default, handler, pattern, PerSession, Writable } from "commonfabric";

      interface InnerInput {
        words: string[];
        showAnswers?: PerSession<Writable<boolean | Default<false>>>;
      }
      const Inner = pattern<InnerInput, { cells: string[]; listed: string[] }>(
        ({ words, showAnswers }) => {
          const listed = computed(() => [...words].sort());
          const cells = computed(() =>
            words.map((w) => showAnswers.get() ? w.toUpperCase() : w)
          );
          return { cells, listed };
        },
      );

      const Panel = pattern<{ words: string[] }, { inner: { cells: string[]; listed: string[] } }>(
        ({ words }) => ({ inner: Inner({ words }) }),
      );

      const add = handler<unknown, { panels: Writable<unknown[]> }>(
        (_, { panels }) => { panels.push(Panel({ words: ["b", "a"] })); },
      );

      const Board = pattern<{ panels: Writable<unknown[] | Default<[]>> }>(
        ({ panels }) => ({ panels, add: add({ panels }) }),
      );

      export default ${main};
    `,
  }],
});

const CAUSE = "handler child session derived piece";

type PanelResult = { inner: { cells: string[]; listed: string[] } };

/** Reads a nested result value the way a renderer follows its links. */
async function read(piece: Cell<PanelResult>, key: "cells" | "listed") {
  const inner = piece.key("inner").resolveAsCell();
  await inner.sync();
  const value = inner.key(key).resolveAsCell();
  return await value.pull();
}

describe("handler-child-session-derived", () => {
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let a: Runtime | undefined;
  let b: Runtime | undefined;

  beforeEach(() => {
    server = newSharedServer();
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = EmulatedStorageManager.connectTo(server, { as: signer });
  });

  afterEach(async () => {
    await a?.dispose();
    await b?.dispose();
    await storageA?.close();
    await storageB?.close();
    await server?.close();
  });

  /**
   * Session A runs `main` and finds the panel piece (the Board's handler makes
   * it); A then goes away. Session B starts that piece and reads its values.
   */
  async function viewInSecondSession(main: "Board" | "Panel", start = true) {
    const source = program(main);
    a = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    const txA = a.edit();
    const compiled = await a.patternManager.compilePattern(source, {
      space,
      tx: txA,
    });
    const resultA = a.getCell<Record<string, unknown>>(
      space,
      CAUSE,
      undefined,
      txA,
    );
    a.run(txA, compiled, main === "Board" ? {} : { words: ["b", "a"] }, resultA);
    a.prepareTxForCommit(txA);
    await txA.commit().settled;
    await a.idle();
    if (main === "Board") {
      resultA.key("add").send({});
      await a.idle();
    }
    await storageA.synced();
    const panelA = (main === "Board"
      ? resultA.key("panels").key(0).resolveAsCell()
      : resultA) as Cell<PanelResult>;
    // The creating session computes both values.
    expect(await read(panelA, "listed")).toEqual(["a", "b"]);
    expect(await read(panelA, "cells")).toEqual(["b", "a"]);
    const panelLink = panelA.getAsNormalizedFullLink();
    await a.dispose();
    a = undefined;

    b = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
    await b.patternManager.compilePattern(source, { space });
    const panel = b.getCellFromLink<PanelResult>(panelLink);
    await panel.sync();
    if (start) await b.start(panel);
    const cancel = panel.sink(() => {});
    try {
      await b.settled();
      await b.idle();
      await storageB.synced();
      return {
        listed: await read(panel, "listed"),
        cells: await read(panel, "cells"),
      };
    } finally {
      cancel();
    }
  }

  it("computes it for a piece the session starts by itself", async () => {
    expect(await viewInSecondSession("Panel"))
      .toEqual({ listed: ["a", "b"], cells: ["b", "a"] });
  });

  it("computes it for a piece a handler made", async () => {
    expect(await viewInSecondSession("Board"))
      .toEqual({ listed: ["a", "b"], cells: ["b", "a"] });
  });

  it("leaves it to the creating session's instance for a session that only reads", async () => {
    // Without a start, the space-scoped value the creator stored shows, and
    // the per-session one is the creator's alone: this session has none.
    expect(await viewInSecondSession("Board", false))
      .toEqual({ listed: ["a", "b"], cells: undefined });
  });
});
