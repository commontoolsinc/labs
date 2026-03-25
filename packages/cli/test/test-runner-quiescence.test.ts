import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commontools/identity";
import { type Cell, Engine, type Pattern, Runtime } from "@commontools/runner";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { experimentalOptionsFromEnv } from "../lib/utils.ts";

const NOTEBOOK_TEST_PATH = join(
  import.meta.dirname!,
  "..",
  "..",
  "patterns",
  "notes",
  "notebook.test.tsx",
);

const PATTERNS_ROOT = join(
  import.meta.dirname!,
  "..",
  "..",
  "patterns",
);

const settle = async (
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
): Promise<void> => {
  await runtime.idle();
  await storageManager.synced();
  await runtime.idle();
};

const runNotebookCreateNameSequence = async (): Promise<boolean> => {
  const identity = await Identity.fromPassphrase(
    `test-runner-quiescence-${crypto.randomUUID()}`,
  );
  const space = identity.did();
  const storageManager = StorageManager.emulate({
    as: identity,
    memoryVersion: "v2",
  });
  const runtime = new Runtime({
    storageManager,
    memoryVersion: "v2",
    experimental: experimentalOptionsFromEnv(),
    apiUrl: new URL(import.meta.url),
  });
  const engine = new Engine(runtime);
  let sinkCancel: (() => void) | undefined;

  try {
    const program = await engine.resolve(
      new FileSystemProgramResolver(NOTEBOOK_TEST_PATH, PATTERNS_ROOT),
    );
    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);
    if (!main?.default) {
      throw new Error("Notebook test pattern did not export a default pattern");
    }
    const testPatternFactory = main.default as Pattern;

    {
      const setupTx = runtime.edit();
      const spaceCell = runtime.getCell(space, space, undefined, setupTx);
      const defaultPatternCell = runtime.getCell(
        space,
        "default-pattern",
        undefined,
        setupTx,
      );
      (defaultPatternCell as any).key("allPieces").set([]);
      (defaultPatternCell as any).key("recentPieces").set([]);
      (defaultPatternCell as any).key("backlinksIndex").set({
        mentionable: [],
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);
      await setupTx.commit();
      await runtime.idle();
    }

    const tx = runtime.edit();
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      `test-pattern-result-${Date.now()}`,
      undefined,
      tx,
    );
    const patternResult = runtime.run(tx, testPatternFactory, {}, resultCell);
    await tx.commit();
    await settle(runtime, storageManager);

    sinkCancel = patternResult.sink(() => {});

    const testsCell = patternResult.key("tests") as Cell<unknown>;

    const createNoteAction = testsCell.key(11).key("action") as unknown as {
      send(value: undefined): void;
    };
    const nameAssertion = testsCell.key(15).key("assertion") as Cell<boolean>;

    createNoteAction.send(undefined);
    await settle(runtime, storageManager);

    return nameAssertion.get() === true;
  } finally {
    sinkCancel?.();
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("test runner quiescence", () => {
  it("keeps notebook createNote->NAME visible without an extra timer turn under concurrent v2 load", async () => {
    const rounds = 3;
    const concurrency = 4;

    for (let round = 0; round < rounds; round++) {
      const results = await Promise.all(
        Array.from(
          { length: concurrency },
          () => runNotebookCreateNameSequence(),
        ),
      );
      expect(results.every(Boolean)).toBe(true);
    }
  });
});
