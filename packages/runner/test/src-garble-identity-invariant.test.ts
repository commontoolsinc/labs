import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Module } from "../src/builder/types.ts";
import type { HarnessedFunction } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  __setSrcAnnotationTransformForTest,
  setEagerSourceAnnotation,
} from "../src/builder/module.ts";
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
// THE BOUNDARY (second test): CFC verified-implementation identity
// (resolveProvenanceImplementationIdentity, which feeds `writeAuthorizedBy`) is
// now ALSO `.src`-independent — re-rooted off `.src` onto the WeakMap provenance
// (the anti-spoof proof) so lazy/debug-only `.src` (skipped at boot) cannot deny
// authorized writes. Garbling OR removing `.src` must keep identity `verified`
// with the same moduleIdentity. This test characterizes that boundary so a future
// change that re-introduces a `.src` dependency in CFC identity trips a loud,
// self-documenting failure here.
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
    // This harness exercises the annotation path — enable the (default-off)
    // eager source-location resolution so `.src` is actually written + garbled.
    setEagerSourceAnnotation(true);
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
      setEagerSourceAnnotation(false);
    }

    // The whole point: identity did not move.
    expect(garbled).toEqual(baseline);
    // And the garble introduced no collisions of its own.
    expect(new Set(garbled.map((g) => g.actionId)).size).toBe(garbled.length);
  },
);

Deno.test(
  "BOUNDARY: CFC verified-implementation identity is .src-independent",
  () => {
    // Part B (workstream C prerequisite) re-rooted CFC verified-source identity
    // OFF `.src`: the WeakMap provenance lookup IS the anti-spoof proof, and every
    // policy-facing identity field is provenance-derived. `writeAuthorizedBy`
    // verifies moduleIdentity + bindingPath; sourceFile is diagnostic there. So
    // garbling or REMOVING `.src` must NOT
    // change the resolved identity — that is exactly what makes lazy/debug-only
    // `.src` (skipped at boot) safe for authorized writes. If a future change
    // re-introduces a `.src` dependency in CFC identity, this test trips.
    const impl = (() => {}) as unknown as HarnessedFunction;
    recordVerifiedProvenance(impl, { identity: "HASH", symbol: "__cfLift_1" });

    const resolve = () =>
      resolvePolicyFacingImplementationIdentity({} as Module, {
        implementation: impl,
      });

    // Canonical `.src` pointing into the provenance module => verified.
    (impl as { src?: string }).src = "cf:module/HASH/main.tsx:3:20";
    const canonical = resolve();
    expect(canonical?.kind).toBe("verified");
    expect((canonical as { moduleIdentity?: string }).moduleIdentity).toBe(
      "HASH",
    );

    // Garbled `.src` => STILL verified, same identity (`.src` is identity-inert).
    (impl as { src?: string }).src = "GARBLED-SRC";
    const garbled = resolve();
    expect(garbled?.kind).toBe("verified");
    expect((garbled as { moduleIdentity?: string }).moduleIdentity).toBe(
      "HASH",
    );

    // Absent `.src` (the lazy/debug-only boot state) => STILL verified.
    delete (impl as { src?: string }).src;
    const absent = resolve();
    expect(absent?.kind).toBe("verified");
    expect((absent as { moduleIdentity?: string }).moduleIdentity).toBe("HASH");
  },
);

// Two calls to ONE hoisted lift -> two action INSTANCES of the same symbol. The
// content address (`cf:module/<hash>:<symbol>`) is per-symbol, so the action id
// appends a source-independent per-instance key (a hash of reads/writes) to keep
// instances distinct. This guards that fix: with a per-symbol-only id the two
// collided onto one durable observation (one silently overwrote the other).
const MULTI_INSTANCE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern, lift } from 'commonfabric';",
      "const dbl = lift((n: number) => n * 2);",
      "export default pattern<{ a: number; b: number }>(({ a, b }) => {",
      "  const da = dbl(a);",
      "  const db = dbl(b);",
      "  return { da, db };",
      "});",
    ].join("\n"),
  }],
};

async function runMultiAndCollect(
  storageManager: ReturnType<typeof StorageManager.emulate>,
): Promise<{ actionId: string; fingerprint: string }[]> {
  const runtime = newRuntime(storageManager);
  try {
    const compiled = await runtime.patternManager.compilePattern(
      MULTI_INSTANCE_PROGRAM,
    );
    const tx = runtime.edit();
    const resultCell = runtime.getCell<any>(space, "mi-result", undefined, tx);
    const handle = runtime.run(tx, compiled, { a: 5, b: 9 }, resultCell);
    await tx.commit();
    for (let k = 0; k < 8; k++) {
      await handle.pull();
      await runtime.idle();
    }
    await runtime.storageManager.synced();
    expect(resultCell.getAsQueryResult()).toEqual({ da: 10, db: 18 });
    return await collectIdentities(runtime);
  } finally {
    runtime.scheduler.dispose();
    await runtime.dispose();
  }
}

Deno.test(
  "two instances of one lift get DISTINCT per-instance ids (no collision), .src-independent",
  async () => {
    setEagerSourceAnnotation(true);
    const baseline = await runMultiAndCollect(
      StorageManager.emulate({ as: signer }),
    );

    // Two distinct action instances => two distinct durable observations (the
    // pre-fix per-symbol id collapsed these to one).
    expect(baseline.length).toBe(2);
    expect(new Set(baseline.map((b) => b.actionId)).size).toBe(2);
    // Same symbol (`:dbl`), distinct per-instance suffix; never a `:line:col`.
    for (const { actionId } of baseline) {
      expect(actionId).toMatch(/^cf:module\/[^:]+:dbl:[^:]+$/);
      expect(actionId).not.toMatch(/:\d+:\d+$/);
    }

    // The per-instance key hashes reads/writes, not `.src`, so garbling `.src`
    // leaves the ids byte-identical.
    let counter = 0;
    __setSrcAnnotationTransformForTest((loc) =>
      `GARBLED-SRC-${counter++}-len${loc.length}`
    );
    let garbled: { actionId: string; fingerprint: string }[];
    try {
      garbled = await runMultiAndCollect(
        StorageManager.emulate({ as: signer }),
      );
    } finally {
      __setSrcAnnotationTransformForTest(undefined);
      setEagerSourceAnnotation(false);
    }
    expect(garbled).toEqual(baseline);
  },
);

Deno.test(
  "multi-instance ids stay per-instance with the eager annotation OFF (production default)",
  async () => {
    // THE REGRESSION THIS PINS: with eager annotation off, anonymous arrow
    // implementations have an empty fn.name, and identity stamping was once
    // gated behind the name — the stamps were skipped and identity fell to a
    // per-symbol re-derivation with NO instance key, silently collapsing two
    // instances of one lift onto one durable observation (and one actionStats
    // entry, mis-tuning auto-debounce for maps/repeated ops). Stamping is now
    // unconditional and the fallback derivation is deleted, so the DEFAULT
    // (annotation-off) state must produce the same per-instance shape the
    // eager-on test above pins.
    const observations = await runMultiAndCollect(
      StorageManager.emulate({ as: signer }),
    );

    expect(observations.length).toBe(2);
    expect(new Set(observations.map((o) => o.actionId)).size).toBe(2);
    for (const { actionId, fingerprint } of observations) {
      // Per-instance id: content address + `:dbl` symbol + instance suffix.
      expect(actionId).toMatch(/^cf:module\/[^:]+:dbl:[^:]+$/);
      // Per-symbol fingerprint: NO instance suffix, shared by both instances.
      expect(fingerprint).toMatch(/^impl:cf:module\/[^:]+:dbl$/);
    }
    expect(new Set(observations.map((o) => o.fingerprint)).size).toBe(1);
  },
);
