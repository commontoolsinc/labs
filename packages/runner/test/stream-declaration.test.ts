import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { type Cell, isStream } from "../src/cell.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getDerivedInternalCell, getMetaLink } from "../src/link-utils.ts";
import { readResultSchemaMeta } from "../src/result-schema-meta.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("stream-declaration");
const space = signer.did();

// The result type names `count` alone, so the result schema says nothing
// about `bump`: a reader reaching it has only the stored links to go on.
const COUNTER = [
  "import { Writable, handler, pattern } from 'commonfabric';",
  "const bump = handler<void, { count: Writable<number> }>((_, { count }) => {",
  "  count.set((count.get() ?? 0) + 1);",
  "});",
  "export default pattern<Record<string, never>, { count: Writable<number> }>(",
  "  () => {",
  "    const count = new Writable<number>(0).for('count');",
  "    return { count, bump: bump({ count }) };",
  "  },",
  ");",
  "",
].join("\n");

// `onPick` is forwarded into a sub-pattern through `.map`, which hands the
// sub-pattern's result back the same stream under another name.
const PICKER = [
  "import { Stream, Writable, handler, pattern } from 'commonfabric';",
  "interface Row { id: string }",
  "const Item = pattern<{ row: Row; onPick: Stream<{ id: string }> }>(",
  "  ({ row, onPick }) => ({ row, pick: onPick }),",
  ");",
  "const pick = handler<{ id: string }, { picked: Writable<string[]> }>(",
  "  ({ id }, { picked }) => {",
  "    picked.set([...(picked.get() ?? []), id]);",
  "  },",
  ");",
  "export default pattern<Record<string, never>>(() => {",
  "  const picked = new Writable<string[]>([]).for('picked');",
  "  const rows = new Writable<Row[]>([{ id: 'a' }, { id: 'b' }]).for('rows');",
  "  const onPick = pick({ picked });",
  "  return { picked, items: rows.map((row) => Item({ row, onPick })) };",
  "});",
  "",
].join("\n");

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

const asCellKindOf = (schema: JSONSchema | undefined) =>
  ContextualFlowControl.getAsCellKind(
    ContextualFlowControl.getAsCellValues(schema).at(0),
  );

describe("stream declaration", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });
  afterEach(async () => {
    await rt.dispose();
    await storageManager?.close();
  });

  const runProgram = async (source: string, cause: string) => {
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(programOf(source), {
      space,
      tx,
    });
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      cause,
      undefined,
      tx,
    );
    const running = rt.run(tx, pattern, {}, cell);
    await tx.commit();
    await running.pull();
    return { pattern, cell };
  };

  const countOf = (cell: Cell<Record<string, unknown>>) =>
    (cell.getAsQueryResult() as { count: number }).count;

  it("declares a handler's stream in its links and metadata, with no stored value", async () => {
    const { pattern, cell } = await runProgram(COUNTER, "counter");
    const descriptor = (pattern.derivedInternalCells ?? []).find((candidate) =>
      asCellKindOf(candidate.schema) === "stream"
    );
    expect(descriptor).toBeDefined();
    const stream = getDerivedInternalCell(cell, descriptor!);
    expect(stream.getRaw()).toBeUndefined();
    expect(getMetaLink(stream, "result")).toBeDefined();
    expect(asCellKindOf(readResultSchemaMeta(stream))).toBe("stream");
  });

  it("resolves a result field to a stream through its stored link alone", async () => {
    const { cell } = await runProgram(COUNTER, "counter-links");
    const bump = cell.key("bump");
    expect(isStream(bump)).toBe(true);
    const view = cell.getAsQueryResult() as {
      bump: { send: (event: unknown) => void };
    };
    expect(typeof view.bump.send).toBe("function");
    const before = countOf(cell);
    view.bump.send({});
    await cell.pull();
    expect(countOf(cell)).toBe(before + 1);
  });

  it("keeps a stream forwarded into a mapped sub-pattern dispatchable", async () => {
    const { cell } = await runProgram(PICKER, "picker");
    await rt.idle();
    const pick = cell.key("items").key(0).key("pick");
    expect(isStream(pick)).toBe(true);
    (pick as unknown as { send: (event: unknown) => void }).send({ id: "a" });
    await cell.pull();
    expect(cell.key("picked").get()).toEqual(["a"]);
  });
});
