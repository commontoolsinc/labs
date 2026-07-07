/**
 * A directly-invoked sub-pattern node used to bind through
 * `unwrapOneLevelAndBindtoDoc`'s `convert`, which STRUCTURALLY COPIED the
 * embedded sub-pattern graph (`Object.fromEntries` + `noteDerivedCopy`). That
 * copy is a fresh object, so the reactive interpreter's STRICT `getBuiltRog`
 * WeakMap lookup missed it and fell to the derived-copy path
 * (`getBuiltRogResolved` + `validatePositionalCorrespondence`), counted by
 * `census.interpretedViaResolved`.
 *
 * `convert` now represents a content-addressed pattern value as a
 * `{ $patternRef }` sentinel and `instantiatePatternNode` resolves it back to
 * the LIVE canonical — the exact object the ROG was keyed on. These tests pin
 * that (a) the sub-pattern instantiates as a STRICT hit (no
 * `interpretedViaResolved`), and (b) a scoped sub-pattern still lands its child
 * result cell + redirect at the right scope through the sentinel round-trip.
 */
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  getDispatchCensus,
  resetDispatchCensus,
} from "../src/reactive-interpreter/dispatch.ts";

const signer = await Identity.fromPassphrase("pattern-node-patternref");
const space = signer.did();

// A parent pattern that directly invokes a sub-pattern with two chained lifts
// (≥2 collapsible node-ops, so the sub-pattern actually INTERPRETS rather than
// falling out on the cost gate — which is what makes `interpretedViaResolved`
// observable when the sub-pattern is a copy).
const NESTED_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern, lift } from 'commonfabric';",
        "const inc = lift(({ x }: { x: number }) => x + 1);",
        "const dbl = lift(({ x }: { x: number }) => x * 2);",
        "const Inner = pattern<{ n: number }>(({ n }) => {",
        "  const a = inc({ x: n });",
        "  const b = dbl({ x: a });",
        "  return { out: b };",
        "});",
        "export default pattern<{ v: number }>(({ v }) => {",
        "  const inner = Inner({ n: v });",
        "  return { result: inner.out };",
        "});",
      ].join("\n"),
    },
  ],
};

describe("pattern node $patternRef instantiation", () => {
  it("resolves a content-addressed sub-pattern to a STRICT interpreter hit", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { experimentalInterpreter: true },
    });
    try {
      const parent = await runtime.patternManager.compilePattern(
        NESTED_PROGRAM,
      );

      const resultCell = runtime.getCell(
        space,
        "patternref-strict-hit",
      );

      resetDispatchCensus();
      const result = runtime.run(
        undefined,
        parent as never,
        { v: 5 } as never,
        resultCell as never,
      );
      await runtime.idle();
      const value = JSON.parse(JSON.stringify(await result.pull()));

      // Correctness: Inner computes (5 + 1) * 2 = 12.
      assertEquals(value, { result: 12 });

      const census = getDispatchCensus();
      // Both the parent and the directly-invoked sub-pattern reach dispatch
      // (`attempted === 2`) — the sub-pattern got there by resolving its
      // `$patternRef` back to the LIVE canonical. The sub-pattern (two
      // collapsible lifts) interprets; instantiating the live canonical rather
      // than a copy makes it a STRICT `getBuiltRog` hit, so NOTHING routes
      // through the derived-copy resolved path. (The parent, a single
      // pattern-node, benignly hits the `nothing_to_collapse` cost gate.)
      assert(
        census.attempted >= 2,
        `expected parent + sub-pattern to both dispatch, census=${
          JSON.stringify(census)
        }`,
      );
      assert(
        census.interpreted >= 1,
        `expected the sub-pattern to interpret, census=${
          JSON.stringify(census)
        }`,
      );
      assertEquals(
        census.interpretedViaResolved,
        0,
        `no dispatch should fall to the derived-copy resolved path; census=${
          JSON.stringify(census)
        }`,
      );
      // A surviving structural copy would leave a trace: either a
      // `interpretedViaResolved` hit (checked above) or a `derived_*` cost
      // fallback. Neither may appear.
      const derivedFallback = Object.keys(census.fallbackByReason).find((r) =>
        r.startsWith("derived")
      );
      assertEquals(
        derivedFallback,
        undefined,
        `no derived-copy fallback expected; census=${JSON.stringify(census)}`,
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  // A `.asScope(...)` sub-pattern node carries its declared scope on
  // `module.defaultScope`, which `instantiatePatternNode` reads off the
  // RESOLVED `patternImpl` (`patternDefaultScope`). Resolving the `$patternRef`
  // to the live canonical must preserve that so the child result cell + its
  // redirect still land at the declared scope. Verified for PerUser and
  // PerSession, under both flag states — the scope path is runner-level and must
  // not depend on the interpreter.
  for (const scope of ["user", "session"] as const) {
    for (const interpreter of [false, true]) {
      it(`preserves a ${scope}-scoped sub-pattern's child result scope (interpreter=${interpreter})`, async () => {
        const storageManager = StorageManager.emulate({ as: signer });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager,
          experimental: { experimentalInterpreter: interpreter },
        });
        const tx = runtime.edit();
        try {
          const parent = await runtime.patternManager.compilePattern(
            scopedProgram(scope),
          );

          const resultCell = runtime.getCell(
            space,
            `patternref-scoped-child-${scope}-${interpreter}`,
            undefined,
            tx,
          );
          const result = runtime.run(
            tx,
            parent as never,
            { v: 5 } as never,
            resultCell as never,
          );
          await tx.commit();
          await runtime.idle();
          await runtime.storageManager.synced();
          const value = JSON.parse(JSON.stringify(await result.pull()));
          assertEquals(value, { child: { out: 6 } });

          // The child result cell (and thus the redirect the parent stores to
          // it) is scoped to the declared scope, not the base `space` scope.
          const childLink = (result as never as {
            key: (k: string) => {
              resolveAsCell: () => {
                getAsNormalizedFullLink: () => { scope: string };
              };
            };
          })
            .key("child")
            .resolveAsCell()
            .getAsNormalizedFullLink();
          assertEquals(childLink.scope, scope);
        } finally {
          await runtime.dispose();
          await storageManager.close();
        }
      });
    }
  }
});

// A parent that invokes a `.asScope(<scope>)` sub-pattern node.
const scopedProgram = (scope: "user" | "session"): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern, lift } from 'commonfabric';",
        "const inc = lift(({ x }: { x: number }) => x + 1);",
        "const Inner = pattern<{ n: number }>(({ n }) => {",
        "  return { out: inc({ x: n }) };",
        "});",
        "export default pattern<{ v: number }>(({ v }) => {",
        `  return { child: Inner.asScope('${scope}')({ n: v }) };`,
        "});",
      ].join("\n"),
    },
  ],
});
