import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { NodePlan } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("node plan");
const space = signer.did();

// One node of each kind a pattern graph holds: a lift (a JavaScript action),
// a handler (a JavaScript handler), a `map` (a raw builtin reached through a
// ref), and a nested pattern.
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { handler, lift, pattern, type Writable } from 'commonfabric';",
      "const scale = lift((n: number) => n * 10);",
      "const inner = pattern<{ n: number }>(({ n }) => {",
      "  return { scaled: scale(n) };",
      "});",
      "const bump = handler<unknown, { count: Writable<number> }>(",
      "  (_event, { count }) => { count.set(count.get() + 1); },",
      ");",
      "export default pattern<{",
      "  seed: number; items: { n: number }[]; count: number;",
      "}>(({ seed, items, count }) => {",
      "  const child = inner({ n: seed });",
      "  return {",
      "    tenfold: scale(seed),",
      "    value: child.scaled,",
      "    doubled: items.map((item) => ({ value: item.n * 2 })),",
      "    bump: bump({ count }),",
      "  };",
      "});",
    ].join("\n"),
  }],
};

describe("Runner node plans", () => {
  let storageManager: StorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("derives every node kind, and the child a pattern node instantiated", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const resultCell = runtime.getCell(space, "node plan instance");
    const running = await runtime.runSynced(resultCell, compiled, {
      seed: 1,
      items: [{ n: 1 }, { n: 2 }],
      count: 0,
    });
    await running.pull();
    await runtime.idle();
    expect(running.key("tenfold").get()).toBe(10);
    expect(running.key("value").get()).toBe(10);

    const tx = runtime.edit();
    const plans: NodePlan[] = [];
    try {
      for (const node of compiled.nodes) {
        const plan = runtime.runner.accessForTestingOnly.nodePlan(
          tx,
          node,
          resultCell as Cell<any>,
          compiled,
        );
        if (plan !== undefined) plans.push(plan);
      }
    } finally {
      tx.abort("node plans: read-only");
    }

    const byKind = (kind: NodePlan["kind"]) =>
      plans.filter((plan) => plan.kind === kind);
    // The lift and the handler.
    expect(byKind("javascript").length).toBe(2);
    expect(byKind("raw").length).toBe(1);
    expect(byKind("pattern").length).toBe(1);

    // A JavaScript node reads through links into the argument document, and
    // each such link carries the schema its binding declared. The lift
    // writes its derived cell; the handler writes nothing statically.
    const [lift, bump] = byKind("javascript").sort((a, b) =>
      b.writes.length - a.writes.length
    );
    expect(lift.reads.map((link) => link.path)).toEqual([["seed"]]);
    expect(lift.writes.length).toBe(1);
    expect(bump.reads.map((link) => link.path)).toEqual([["count"], []]);
    expect(bump.writes).toEqual([]);
    for (const link of [...lift.reads, ...bump.reads]) {
      if (link.path.length > 0) expect(link.schema).toBeDefined();
    }

    // The raw node is the list coordinator, with the immutable inputs
    // document the builtin reads from and the output spot it is keyed on.
    const [raw] = byKind("raw");
    if (raw.kind !== "raw") throw new Error("unreachable");
    expect(raw.moduleRefName).toBe("map");
    expect(raw.inputsCell).toBeDefined();
    expect(raw.resolvedOutputSpot).toBeDefined();
    expect(raw.writes.length).toBeGreaterThan(0);

    // The pattern node's plan derives the result cell its instantiation
    // minted: the child is registered as a running piece under that id.
    const [nested] = byKind("pattern");
    if (nested.kind !== "pattern") throw new Error("unreachable");
    expect(nested.sendToBindings).toBe(true);
    const childId = nested.childResultCell?.getAsNormalizedFullLink().id;
    expect(childId).toBeDefined();
    const runningIds = [...runtime.runner.cancels.keys()];
    expect(runningIds.some((key) => key.endsWith(`/${childId}`))).toBe(true);
    expect(nested.child.nodes.length).toBe(1);
  });
});
