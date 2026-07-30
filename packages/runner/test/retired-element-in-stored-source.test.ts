import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

// A pattern's source is DURABLE. A piece keeps running the source it was stored
// with for as long as it lives, so the set of element names patterns may emit
// is not "whatever the palette defines today" — it is the union of every
// palette that has ever shipped. Deleting a component does not retire it; it
// removes the definition out from under source that still names it.
//
// Removing `cf-cell-context` (#5132) showed the cost. Stored home sections
// still emitted it, and with the component and its `jsx.d.ts` declaration both
// gone, that source no longer type-checks — and a `$cell` prop the compiler
// cannot see as a cell changes the schema derived around it. So a retired
// element keeps a declaration and an inert definition: authoring is warned
// (`@deprecated`), a run is warned once (see the ui package's
// retired-element test), and nothing breaks.
//
// These cases pin the half that only the compiler can answer: stored source
// naming a retired element still compiles, and the subtree under it survives.

const signer = await Identity.fromPassphrase("retired-element-stored-source");
const space = signer.did();

const programOf = (contents: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents }],
});

// The shape stored home sections carry: a retired wrapper taking a `$cell`,
// with the content that matters nested inside it.
const USES_RETIRED_ELEMENT = [
  "import { NAME, pattern, UI, Writable } from 'commonfabric';",
  "",
  "export default pattern<",
  "  Record<string, never>,",
  "  { marker: string }",
  ">(() => {",
  "  const target = new Writable<{ [NAME]?: string }>({}).for('target');",
  "  return {",
  "    [NAME]: 'Uses Retired Element',",
  "    [UI]: (",
  "      <cf-vstack>",
  "        <cf-cell-context $cell={target}>",
  "          <span id='nested-child'>kept</span>",
  "        </cf-cell-context>",
  "      </cf-vstack>",
  "    ),",
  "    marker: 'ok',",
  "  };",
  "});",
  "",
].join("\n");

describe("stored source naming a retired element", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let rt: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: {},
    });
  });
  afterEach(async () => {
    await rt?.dispose();
    await storageManager?.close();
  });

  it("still compiles, and keeps the subtree underneath it", async () => {
    const tx = rt.edit();
    // Compilation is the assertion for the declaration: with `cf-cell-context`
    // absent from `jsx.d.ts` this rejects the source outright, which is what
    // stranded stored home sections.
    const compiled = await rt.patternManager.compilePattern(
      programOf(USES_RETIRED_ELEMENT),
      { space, tx },
    );
    const cell = rt.getCell<Record<string, unknown>>(
      space,
      "retired-element-piece",
      undefined,
      tx,
    );
    const running = rt.run(tx, compiled, {}, cell);
    await tx.commit();
    await running.pull();
    await rt.idle();

    const result = cell.getAsQueryResult() as { marker?: string };
    expect(result.marker).toBe("ok");

    const rendered = JSON.stringify(cell.getAsQueryResult());
    // The element survives in the tree rather than being dropped...
    expect(rendered).toContain("cf-cell-context");
    // ...and, the part that actually matters, so does what it wraps. A wrapper
    // that swallowed its children would render an empty region instead of a
    // blank-looking one, which is the same bug wearing a different hat.
    expect(rendered).toContain("nested-child");
  });
});
