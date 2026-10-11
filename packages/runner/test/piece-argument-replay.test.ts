/**
 * Setting up a piece whose argument document already exists writes that whole
 * document, so what the write carries decides what survives. A caller names
 * some of the argument's slots and leaves the rest to the piece: a nested
 * piece is instantiated with the argument its parent's expression carries —
 * `Child({ supplied })` names one slot — and the piece's own durable state
 * lives in the slots that expression never mentions.
 *
 * These tests pin both routes a same-pattern setup takes over an existing
 * argument document: `Runner.#applySetupState`, which a piece reaches when it
 * holds no registration (the nested piece its parent restarts), and
 * `Runner.#maybeReuseRunningSetup`, which a registered piece reaches when it is
 * run again with an argument. They pin the route a changed pattern takes as
 * well, the restage in `Runner.#applySetupState`, which a nested piece reaches
 * when its code changed: the stored slots survive it, a slot holding nothing
 * takes its default, and a stored slot the new code's input type refuses stops
 * the setup rather than being replaced.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { STORED_ARGUMENT_SCHEMA_REFUSAL } from "../src/stored-argument-refusal.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("piece argument replay");
const space = signer.did();

// `kept` is the piece's own state: seeded from its schema default at the first
// setup and grown by `add` after that. `supplied` is what a caller passes in.
const CHILD_SOURCE = [
  "import { Default, handler, pattern, Stream, Writable } from 'commonfabric';",
  "",
  "export interface Arguments {",
  "  supplied?: string | Default<'seed'>;",
  "  kept?: string[] | Default<[]>;",
  "}",
  "",
  "export interface Surface {",
  "  add: Stream<{ text: string }>;",
  "  kept: readonly string[];",
  "}",
  "",
  "const add = handler<{ text: string }, { kept: Writable<string[]> }>(",
  "  ({ text }, { kept }) => {",
  "    kept.push(text);",
  "  },",
  ");",
  "",
  "export default pattern<Arguments, Surface>(({ kept }) => ({",
  "  add: add({ kept }),",
  "  kept,",
  "}));",
  "",
].join("\n");

// The parent's expression names `supplied` alone, so the nested piece's `kept`
// is state no caller passes down. Its `add` stream and `kept` reading are
// re-exported so a test drives and reads the nested piece through the root.
const PARENT_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "import Child, { type Arguments, type Surface } from './child.tsx';",
  "",
  "export default pattern<Arguments, Surface>(({ supplied }) => {",
  "  const child = Child({ supplied });",
  "  return { add: child.add, kept: child.kept };",
  "});",
  "",
].join("\n");

const files = [
  { name: "/child.tsx", contents: CHILD_SOURCE },
  { name: "/main.tsx", contents: PARENT_SOURCE },
];

const parentProgram: RuntimeProgram = { main: "/main.tsx", files };
const childProgram: RuntimeProgram = { main: "/child.tsx", files };

/** Run `probe` against a fresh runtime over an emulated store. */
const withRuntime = async (
  probe: (runtime: Runtime) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    await probe(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/**
 * Run `program` at `cause` with `supplied` alone, then grow the piece's `kept`
 * to `["one", "two"]` through its `add` stream.
 */
const startedPiece = async (
  runtime: Runtime,
  program: RuntimeProgram,
  cause: string,
) => {
  const tx = runtime.edit();
  const pattern = await runtime.patternManager.compilePattern(program, {
    space,
    tx,
  });
  const cell = runtime.getCell<Record<string, unknown>>(
    space,
    cause,
    undefined,
    tx,
  );
  const running = runtime.run(tx, pattern, { supplied: "first" }, cell);
  await tx.commit().settled;
  await running.pull();
  await runtime.idle();

  for (const text of ["one", "two"]) {
    (cell.key("add") as unknown as { send: (event: unknown) => void })
      .send({ text });
    await runtime.idle();
  }
  await cell.pull();
  expect(cell.key("kept").get()).toEqual(["one", "two"]);
  return { cell, pattern };
};

/**
 * The parent and child sources with `childSource` in place of the child's, and
 * `parentSource` in place of the parent's when it is given.
 */
const changedFiles = (childSource: string, parentSource = PARENT_SOURCE) => [
  { name: "/child.tsx", contents: childSource },
  { name: "/main.tsx", contents: parentSource },
];

/** Compile the program `files` makes, rooted at the parent. */
const compiledParent = (
  runtime: Runtime,
  files: { name: string; contents: string }[],
  tx: ReturnType<Runtime["edit"]>,
) =>
  runtime.patternManager.compilePattern({ main: "/main.tsx", files }, {
    space,
    tx,
  });

/**
 * Stop the piece in `cell` and run it again on the program `files` makes,
 * leaving its argument to what the piece has stored, as an update of its code
 * does.
 */
const runChanged = async (
  runtime: Runtime,
  cell: Awaited<ReturnType<typeof startedPiece>>["cell"],
  files: { name: string; contents: string }[],
) => {
  runtime.runner.stop(cell);
  const tx = runtime.edit();
  const pattern = await compiledParent(runtime, files, tx);
  const running = runtime.run(tx, pattern, undefined, cell);
  await tx.commit().settled;
  await running.pull();
  await runtime.idle();
  await cell.pull();
};

describe("piece argument replay", () => {
  it("keeps a nested piece's state when its parent is restarted", async () => {
    await withRuntime(async (runtime) => {
      const { cell } = await startedPiece(
        runtime,
        parentProgram,
        "parent-restart",
      );

      runtime.runner.stop(cell);
      expect(await runtime.start(cell)).toBe(true);
      await runtime.idle();
      await cell.pull();

      expect(
        cell.key("kept").get(),
        "the restart re-instantiated the nested piece with the argument its " +
          "parent's expression names, and dropped the slots that expression " +
          "leaves to the piece",
      ).toEqual(["one", "two"]);
    });
  });

  describe("when the nested piece's code changes", () => {
    // Each change gives the nested piece a new pattern identity, so its
    // parent sets it up again over its existing argument document with the
    // argument the parent's expression carries.

    it("keeps the nested piece's state across a change to a comment", async () => {
      await withRuntime(async (runtime) => {
        const { cell } = await startedPiece(
          runtime,
          parentProgram,
          "child-comment-change",
        );

        await runChanged(
          runtime,
          cell,
          changedFiles("// A comment and nothing else.\n" + CHILD_SOURCE),
        );

        expect(
          cell.key("kept").get(),
          "the nested piece was set up again with the argument its parent's " +
            "expression names, and `kept` was written over with its default",
        ).toEqual(["one", "two"]);
      });
    });

    it("fills an input the changed code adds with its default, and keeps the stored ones", async () => {
      await withRuntime(async (runtime) => {
        const { cell } = await startedPiece(
          runtime,
          parentProgram,
          "child-input-added",
        );

        const child = CHILD_SOURCE
          .replace(
            "  kept?: string[] | Default<[]>;\n",
            "  kept?: string[] | Default<[]>;\n" +
              "  note?: string | Default<'fresh'>;\n",
          )
          .replace(
            "  kept: readonly string[];\n",
            "  kept: readonly string[];\n  note: string;\n",
          )
          .replace(
            "(({ kept }) => ({",
            "(({ kept, note }) => ({\n  note,",
          );
        const parent = PARENT_SOURCE.replace(
          "{ add: child.add, kept: child.kept }",
          "{ add: child.add, kept: child.kept, note: child.note }",
        );
        expect(child).not.toBe(CHILD_SOURCE);
        expect(child).toContain("({\n  note,");
        expect(parent).not.toBe(PARENT_SOURCE);

        await runChanged(runtime, cell, changedFiles(child, parent));

        expect(cell.key("note").get()).toBe("fresh");
        expect(cell.key("kept").get()).toEqual(["one", "two"]);
      });
    });

    it("throws when the changed code's input type refuses a stored value, and leaves the value stored", async () => {
      await withRuntime(async (runtime) => {
        const { cell } = await startedPiece(
          runtime,
          parentProgram,
          "child-input-narrowed",
        );
        runtime.runner.stop(cell);

        // `kept` holds a list, and the changed code's input takes a number.
        const child = CHILD_SOURCE
          .replace(
            "kept?: string[] | Default<[]>;",
            "kept?: number | Default<0>;",
          )
          .replace("kept: readonly string[];", "kept: number;")
          .replace("kept: Writable<string[]>", "kept: Writable<number>")
          .replace("kept.push(text);", "kept.set(text.length);");
        expect(child).toContain("kept.set(text.length);");
        const tx = runtime.edit();
        const pattern = await compiledParent(runtime, changedFiles(child), tx);

        expect(() => runtime.run(tx, pattern, undefined, cell)).toThrow(
          STORED_ARGUMENT_SCHEMA_REFUSAL,
        );
        tx.abort();

        // The refused setup committed nothing, so the piece starts on its
        // stored pattern with its stored state.
        expect(await runtime.start(cell)).toBe(true);
        await runtime.idle();
        await cell.pull();
        expect(cell.key("kept").get()).toEqual(["one", "two"]);
      });
    });
  });

  it("keeps the slots an argument does not name when a running piece is run again", async () => {
    await withRuntime(async (runtime) => {
      const { cell, pattern } = await startedPiece(
        runtime,
        childProgram,
        "running-rerun",
      );

      const tx = runtime.edit();
      runtime.run(tx, pattern, { supplied: "second" }, cell);
      await tx.commit().settled;
      await runtime.idle();
      await cell.pull();

      expect(
        cell.key("kept").get(),
        "the re-run wrote the whole argument document from a value naming " +
          "`supplied` alone, so `kept` fell back to its schema default",
      ).toEqual(["one", "two"]);
    });
  });
});
