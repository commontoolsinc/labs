import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("inspace-child-reload");
const spaceA = signer.did();
const spaceB = (await Identity.fromPassphrase("inspace child target B")).did();

// CT-1687: a handler that materializes a child piece in ANOTHER space via
// `Child.inSpace(...)({...})` (the multi-profile flow: profile-create.tsx pushes
// `ProfileHome.inSpace(name)({initialName})` onto the home `profiles` list) must
// leave the child independently loadable FROM ITS OWN SPACE. A fresh runtime
// navigating to the child piece (the shell's piece view) loads pattern artifacts
// from `resultCell.space` — the child space — where, before the fix, neither the
// pattern meta (program) nor the content-addressed source/compiled closures were
// ever persisted: `savePattern` deduped on patternId alone and the sub-pattern
// object carries no program, and the compile-cache write-back only targets the
// space the parent bundle compiled into. Symptom: "Pattern <id> has no stored
// source" → "Failed to load piece"; profiles uneditable.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { handler, pattern, Writable } from 'commonfabric';",
        "",
        "export const child = pattern<{ label: string }>(({ label }) => ({",
        "  label,",
        "}));",
        "",
        "type ChildOutput = { label: string };",
        "",
        "const create = handler<",
        "  { label?: string },",
        "  { items: Writable<ChildOutput[]> }",
        ">((event, { items }) => {",
        `  items.push(child.inSpace("${spaceB}")({`,
        "    label: event.label ?? 'hi',",
        "  }) as ChildOutput);",
        "});",
        "",
        "export default pattern(() => {",
        "  const items = new Writable<ChildOutput[]>([]).for('items');",
        "  return { items, create: create({ items }) };",
        "});",
      ].join("\n"),
    },
  ],
};

const RESULT_CAUSE = "inspace child reload parent";

const childLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

describe("inSpace child piece reload from its own space (CT-1687)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  it("a fresh runtime can start the child from space B", async () => {
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      // Session 1: run the parent in space A, create the child in space B via
      // the handler (the profile-create flow).
      const tx1 = rt1.edit();
      const parent = await rt1.patternManager.compilePattern(PROGRAM, {
        space: spaceA,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        spaceA,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, parent as any, {}, resultCell1);
      await tx1.commit();
      await r1.pull();

      r1.key("create").send({ label: "hi" });
      await r1.pull();
      await rt1.idle();

      // The child materialized in space B (link identity, no deep resolve).
      const links = r1.key("items").asSchema(childLinkListSchema)
        // deno-lint-ignore no-explicit-any
        .get() as any[];
      expect(links.length).toBe(1);
      const childLink = links[0].getAsNormalizedFullLink();
      expect(childLink.space).toBe(spaceB);

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // Session 2: a fresh runtime loads the child piece from ITS OWN space —
      // the shell's navigate-to-piece path. Before the fix this rejects with
      // "Pattern <id> has no stored source".
      const childCell = rt2.getCellFromLink(childLink);
      await childCell.sync();
      const started = await rt2.start(childCell);
      expect(started).toBe(true);

      await childCell.pull();
      const value = childCell.getAsQueryResult() as { label: string };
      expect(value.label).toBe("hi");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
