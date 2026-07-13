/**
 * Scope differentials for the reactive interpreter (task: scope
 * flow-tracking). The oracle is the SCOPE STRUCTURE legacy writes — not
 * just the values: a computed derived from scoped data writes its value to
 * a SCOPED instance of its internal cell and a REDIRECT link at the space
 * instance (pattern-binding.ts sendValueToBinding narrowestReadScope
 * routing; see test/pattern-scope.test.ts "broad computed output links to
 * narrower scoped result" for the legacy-only oracle).
 *
 * The discriminating case is PER-OP precision: legacy runs one action per
 * node, so a sibling computed that never reads scoped data keeps a SPACE
 * output — a segment threading one ambient tx-wide scope would over-narrow
 * it. flag-on must equal flag-off on the full {value, internal scope,
 * redirect scope} triple for EVERY output, and must actually interpret
 * (never green-via-fallback).
 */
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { type Cell, createCell } from "../../src/cell.ts";
import { parseLink } from "../../src/link-utils.ts";
import {
  getDispatchCensus,
  resetDispatchCensus,
} from "../../src/reactive-interpreter/dispatch.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("ri2 scope differential");
const space = signer.did();

/** The observable scope shape of one result field: the value, the scope of
 * the link the result holds, and — when the internal doc holds a redirect —
 * the scope that redirect points at ("space" = no redirect, plain value). */
interface ScopeShape {
  value: unknown;
  resultLinkScope: string;
  redirectScope: string;
}

function scopeShapeOf(
  runtime: Runtime,
  // deno-lint-ignore no-explicit-any
  result: Cell<any>,
  key: string,
): ScopeShape {
  const raw = result.key(key).getRaw();
  const link = parseLink(raw, result);
  if (!link) {
    return {
      value: result.key(key).get(),
      resultLinkScope: "inline",
      redirectScope: "inline",
    };
  }
  const internalCell = runtime.getCellFromLink(link);
  const innerRaw = internalCell.getRaw();
  const innerLink = parseLink(innerRaw, internalCell);
  return {
    value: result.key(key).get(),
    resultLinkScope: link.scope ?? "space",
    redirectScope: innerLink?.scope ?? "space",
  };
}

interface ScopedOutcome {
  fromSecret: ScopeShape;
  fromOpen: ScopeShape;
}

/** Run the two-sibling pattern with a user-scoped `secret` input and a
 * plain `open` input, one flag state per call. */
async function runSiblings(interpreter: boolean): Promise<ScopedOutcome> {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { experimentalInterpreter: interpreter },
  });
  const tx = runtime.edit();
  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const baseSecret = runtime.getCell<number>(
      space,
      `ri2-scope-secret-${interpreter}`,
      undefined,
      tx,
    );
    const secret = createCell(
      runtime,
      { ...baseSecret.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    secret.set(41);

    const Root = pattern<{ secret: number; open: number }>(
      ({ secret, open }) => ({
        fromSecret: lift(
          (x: number) => x + 1,
          { type: "number" },
          { type: "number" },
        )(secret),
        fromOpen: lift(
          (x: number) => x * 2,
          { type: "number" },
          { type: "number" },
        )(open),
      }),
    );

    const resultCell = runtime.getCell(
      space,
      `ri2-scope-result-${interpreter}`,
      undefined,
      tx,
    );
    const result = runtime.run(tx, Root, { secret, open: 10 }, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    return {
      fromSecret: scopeShapeOf(runtime, result, "fromSecret"),
      fromOpen: scopeShapeOf(runtime, result, "fromOpen"),
    };
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

describe("interpreter scope differentials", () => {
  it("per-op precision: scoped sibling narrows, plain sibling stays space", async () => {
    const legacy = await runSiblings(false);
    resetDispatchCensus();
    const interpreted = await runSiblings(true);
    const census = getDispatchCensus();

    // Pin the legacy shape first (the oracle, not mutual equality alone):
    // the scoped-input computed redirects to a user-scoped instance; the
    // plain computed keeps a space-scoped plain value.
    assertEquals(legacy.fromSecret.value, 42);
    assertEquals(legacy.fromSecret.redirectScope, "user");
    assertEquals(legacy.fromOpen.value, 20);
    assertEquals(legacy.fromOpen.redirectScope, "space");

    // flag-on must MATCH the full scope structure per output.
    assertEquals(interpreted, legacy);

    // And it must have actually interpreted.
    assert(
      census.interpreted >= 1,
      `expected interpreted>=1, census=${JSON.stringify(census)}`,
    );
  });

  // FINDING (pinned): legacy's SIMPLE javascript write path (plain-value
  // lift results) takes scope ONLY from the narrowest READ scope —
  // `.asScope`/schema scope fold in on the frame-result and raw-builtin
  // paths only (both preserved-boundary territory under the interpreter).
  // So a plain-value `.asScope("user")` lift does NOT narrow in legacy,
  // and flag-on must match that — while still INTERPRETING (the old
  // pattern-wide scope_narrowing gate refused this pattern outright).
  it("static defaultScope (.asScope) on a plain-value lift: no narrowing, still interprets", async () => {
    const run = async (interpreter: boolean): Promise<ScopeShape> => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        experimental: { experimentalInterpreter: interpreter },
      });
      const tx = runtime.edit();
      try {
        const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
        const scopedDouble = lift(
          (x: number) => x * 2,
          { type: "number" },
          { type: "number" },
          // deno-lint-ignore no-explicit-any
        ) as any;
        const Root = pattern<{ n: number }>(({ n }) => {
          const doubled = scopedDouble.asScope("user")(n);
          // Second collapsible op so the segment clears the cost gate
          // (>=2 collapsed node ops) — the subject is the .asScope lift.
          const shifted = lift(
            (x: number) => x + 1,
            { type: "number" },
            { type: "number" },
          )(doubled);
          return { doubled, shifted };
        });
        const resultCell = runtime.getCell(
          space,
          `ri2-scope-static-${interpreter}`,
          undefined,
          tx,
        );
        const result = runtime.run(tx, Root, { n: 21 }, resultCell);
        await tx.commit();
        await runtime.idle();
        await runtime.storageManager.synced();
        await result.pull();
        return scopeShapeOf(runtime, result, "doubled");
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    const legacy = await run(false);
    resetDispatchCensus();
    const interpreted = await run(true);
    const census = getDispatchCensus();

    assertEquals(legacy.value, 42);
    assertEquals(legacy.redirectScope, "space");
    assertEquals(interpreted, legacy);
    assert(
      census.interpreted >= 1,
      `expected interpreted>=1 (static scope markers must not fall back), ` +
        `census=${JSON.stringify(census)}`,
    );
  });
});
