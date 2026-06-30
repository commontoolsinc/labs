import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Module } from "../src/builder/types.ts";
import type { HarnessedFunction } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { __setSrcAnnotationTransformForTest } from "../src/builder/module.ts";
import { recordVerifiedProvenance } from "../src/harness/verified-provenance.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";

// `.src`-garbled identity invariant harness (workstream B — content-addressed
// action identity).
//
// THE INVARIANT: scheduler action identity — the persisted action id AND the
// durable implementation fingerprint — is derived from the content-addressed
// `{ identity, symbol }` provenance (module hash + hoisted `__cfReg`/export
// symbol), NOT from `fn.src`. So running a pattern with `.src` deliberately
// garbled must yield a BYTE-IDENTICAL set of action ids and fingerprints.
//
// Why this harness exists: the first cut of B re-rooted only the *consumers* of
// identity and looked green, while `implementationHash` was still secretly
// `.src`-derived (applyImplementationHash -> implementationHashForSource(.src)).
// A consumer-only unit test could not catch that, because the leak was upstream
// at id *creation*. This harness garbles `.src` at its single write site
// (annotateFunctionDebugMetadata, via __setSrcAnnotationTransformForTest) so the
// garble is in effect during module eval + action creation — any `.src` -> id
// path *anywhere* in the pipeline makes the two runs diverge loudly.
//
// THE BOUNDARY (second test): B re-rooted the SCHEDULER action layer only. CFC
// verified-implementation identity (resolveProvenanceImplementationIdentity,
// which feeds `writeAuthorizedBy`) STILL consults `.src` as a fail-closed
// consistency check, so garbling `.src` flips it `verified` -> `unsupported`.
// That is the remaining `.src` dependency the red-team pass must bless and that
// the lazy/debug-only `.src` follow-up (workstream C) must re-root before `.src`
// can be deferred. This test characterizes that boundary so a future "make
// `.src` lazy" change trips a loud, self-documenting failure here.
//
// See docs/specs/content-addressed-action-identity.md and
// packages/patterns/lunch-poll/perf-seed/B-IDENTITY-REROOT-HANDOFF.md.

const signer = await Identity.fromPassphrase("src-garble identity invariant");
const space = signer.did();

// A pattern with several distinct reactive primitives (two lifts + three
// computeds) — five distinct hoisted symbols under one module identity, so the
// captured identity set exercises both the module hash AND the per-symbol
// discriminator (and "no collision among distinct symbols").
const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, computed, lift } from 'commonfabric';",
      "const dbl = lift((n: number) => n * 2);",
      "const inc = lift((n: number) => n + 1);",
      "export default pattern<{ value: number }>(({ value }) => {",
      "  const doubled = dbl(value);",
      "  const incremented = inc(value);",
      "  const plusOne = computed(() => (doubled as any) + 1);",
      "  const sum = computed(() => (doubled as any) + (incremented as any));",
      "  const label = computed(",
      "    () => 'v=' + (plusOne as any) + ':' + (sum as any),",
      "  );",
      "  return { doubled, incremented, plusOne, sum, label };",
      "});",
    ].join("\n"),
  }],
};

function newRuntime(sm: ReturnType<typeof StorageManager.emulate>) {
  return new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: sm,
    experimental: { persistentSchedulerState: true },
  });
}

/** The durable identity of every persisted scheduler action for this pattern. */
async function collectIdentities(
  runtime: Runtime,
): Promise<{ actionId: string; fingerprint: string }[]> {
  const provider = runtime.storageManager.open(space) as {
    listSchedulerActionSnapshots?: (
      q: Record<string, unknown>,
    ) => Promise<{
      snapshots: {
        observation: { actionId?: string; implementationFingerprint?: string };
      }[];
    }>;
  };
  const res = await provider.listSchedulerActionSnapshots!({
    ownerSpace: space,
    limit: 1000,
  });
  return res.snapshots
    .filter((s) => (s.observation.actionId ?? "").startsWith("cf:module/"))
    .map((s) => ({
      actionId: s.observation.actionId!,
      fingerprint: s.observation.implementationFingerprint ?? "",
    }))
    .sort((a, b) => a.actionId.localeCompare(b.actionId));
}

/** Run PROGRAM to a settled, persisted state and return its identity set. */
async function runAndCollect(
  storageManager: ReturnType<typeof StorageManager.emulate>,
): Promise<{ actionId: string; fingerprint: string }[]> {
  const runtime = newRuntime(storageManager);
  try {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const tx = runtime.edit();
    const resultCell = runtime.getCell<any>(space, "result", undefined, tx);
    const handle = runtime.run(tx, compiled, { value: 5 }, resultCell);
    await tx.commit();
    for (let k = 0; k < 8; k++) {
      await handle.pull();
      await runtime.idle();
    }
    await runtime.storageManager.synced();
    // Sanity: the pattern actually computed (so an empty id set can't masquerade
    // as "identical").
    expect(resultCell.getAsQueryResult()).toEqual({
      doubled: 10,
      incremented: 6,
      plusOne: 11,
      sum: 16,
      label: "v=11:16",
    });
    return await collectIdentities(runtime);
  } finally {
    runtime.scheduler.dispose();
    await runtime.dispose();
  }
}

Deno.test(
  "scheduler action ids + fingerprints are byte-identical with .src garbled",
  async () => {
    // Baseline: real `.src`.
    const baseline = await runAndCollect(
      StorageManager.emulate({ as: signer }),
    );

    expect(baseline.length).toBeGreaterThan(0);
    for (const { actionId, fingerprint } of baseline) {
      // Content-addressed `cf:module/<hash>:<symbol>` — NOT a `:line:col`
      // (`.src`-derived) id. A regression to source-location ids ends in
      // `:<line>:<col>`.
      expect(actionId).toMatch(/^cf:module\//);
      expect(actionId).not.toMatch(/:\d+:\d+$/);
      expect(fingerprint).toMatch(/^impl:cf:module\//);
      expect(fingerprint).not.toMatch(/:\d+:\d+$/);
    }
    // No two distinct primitives collide on an id under real `.src`.
    expect(new Set(baseline.map((b) => b.actionId)).size).toBe(baseline.length);

    // Garbled run: replace the annotated location with a distinct, NON-canonical
    // garbage string per primitive (distinct => maximally stresses any `.src`
    // keying; non-canonical => keeps the recordModuleProvenance `.src` guard a
    // no-op, exactly the real "source maps broke" failure mode).
    let counter = 0;
    __setSrcAnnotationTransformForTest((loc) =>
      `GARBLED-SRC-${counter++}-len${loc.length}`
    );
    let garbled: { actionId: string; fingerprint: string }[];
    try {
      garbled = await runAndCollect(StorageManager.emulate({ as: signer }));
    } finally {
      __setSrcAnnotationTransformForTest(undefined);
    }

    // The whole point: identity did not move.
    expect(garbled).toEqual(baseline);
    // And the garble introduced no collisions of its own.
    expect(new Set(garbled.map((g) => g.actionId)).size).toBe(garbled.length);
  },
);

Deno.test(
  "BOUNDARY: CFC verified-implementation identity still fail-closes on .src",
  () => {
    // This documents the remaining `.src` dependency B did NOT remove: CFC
    // verified-source identity (the `writeAuthorizedBy` arm) reads `.src` as a
    // fail-closed consistency check. It is NOT part of the scheduler-identity
    // invariant above — and it is the gate workstream C (lazy `.src`) must
    // re-root first. If a future change makes `.src` lazy without re-rooting
    // this check, this test trips.
    const impl = (() => {}) as unknown as HarnessedFunction;
    recordVerifiedProvenance(impl, { identity: "HASH", symbol: "__cfLift_1" });

    // Canonical `.src` pointing into the provenance module => verified.
    (impl as { src?: string }).src = "cf:module/HASH/main.tsx:3:20";
    const verified = resolvePolicyFacingImplementationIdentity(
      {} as Module,
      { implementation: impl },
    );
    expect(verified?.kind).toBe("verified");
    expect((verified as { moduleIdentity?: string }).moduleIdentity).toBe(
      "HASH",
    );

    // Garbled `.src` => CFC fails closed (NOT byte-identical, by design).
    (impl as { src?: string }).src = "GARBLED-SRC";
    const garbled = resolvePolicyFacingImplementationIdentity(
      {} as Module,
      { implementation: impl },
    );
    expect(garbled?.kind).toBe("unsupported");
  },
);
