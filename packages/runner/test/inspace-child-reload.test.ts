import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("inspace-child-reload");
const spaceA = signer.did();
const spaceB = (await Identity.fromPassphrase("inspace child target B")).did();
const spaceC = (await Identity.fromPassphrase("inspace child target C")).did();

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

type ChildOutput = {
  label: string;
};

type ParentOutput = {
  items?: ChildOutput[];
  create?: { label?: string };
};

type StaticParentOutput = {
  kid?: ChildOutput;
};

type ChildOutputCell = Cell<ChildOutput>;

const childLinkSchema: JSONSchema = {
  type: "unknown",
  asCell: ["cell"],
};

const childLinkListSchema: JSONSchema = {
  type: "array",
  items: childLinkSchema,
};

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
      const resultCell1 = rt1.getCell<ParentOutput>(
        spaceA,
        RESULT_CAUSE,
        undefined,
        tx1,
      );
      const r1 = rt1.run(tx1, parent, {}, resultCell1);
      await tx1.commit();
      await r1.pull();

      r1.key("create").send({ label: "hi" });
      await r1.pull();
      await rt1.idle();

      // The child materialized in space B (link identity, no deep resolve).
      const links = r1.key("items").asSchema(childLinkListSchema)
        .get() as ChildOutputCell[];
      expect(links.length).toBe(1);
      const childLink = links[0].getAsNormalizedFullLink();
      expect(childLink.space).toBe(spaceB);

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // Session 2: a fresh runtime loads the child piece from ITS OWN space —
      // the shell's navigate-to-piece path. Before the fix this rejects with
      // "Pattern <id> has no stored source".
      const childCell = rt2.getCellFromLink<ChildOutput>(childLink);
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

  // The build-time variant: the child node sits in the PARENT's graph (not a
  // handler frame), so the cross-space transition is visible to
  // `instantiatePatternNode` (resultCell.space !== resultCellLink.space) —
  // the other replication hook.
  it("a fresh runtime can start a build-time inSpace child", async () => {
    const STATIC_PROGRAM: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import { pattern } from 'commonfabric';",
            "",
            "export const child = pattern<{ label: string }>(({ label }) => ({",
            "  label,",
            "}));",
            "",
            "export default pattern(() => ({",
            `  kid: child.inSpace("${spaceC}")({ label: 'static-hi' }),`,
            "}));",
          ].join("\n"),
        },
      ],
    };

    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      const tx1 = rt1.edit();
      const parent = await rt1.patternManager.compilePattern(STATIC_PROGRAM, {
        space: spaceA,
        tx: tx1,
      });
      const resultCell1 = rt1.getCell<StaticParentOutput>(
        spaceA,
        "inspace static child parent",
        undefined,
        tx1,
      );
      const r1 = rt1.run(tx1, parent, {}, resultCell1);
      await tx1.commit();
      await r1.pull();
      await rt1.idle();

      const kidCell = r1.key("kid").asSchema(childLinkSchema)
        .get() as ChildOutputCell;
      const kidLink = kidCell.getAsNormalizedFullLink();
      expect(kidLink.space).toBe(spaceC);

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      const childCell = rt2.getCellFromLink<ChildOutput>(kidLink);
      await childCell.sync();
      const started = await rt2.start(childCell);
      expect(started).toBe(true);

      await childCell.pull();
      const value = childCell.getAsQueryResult() as { label: string };
      expect(value.label).toBe("static-hi");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
