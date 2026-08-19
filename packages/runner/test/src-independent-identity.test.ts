import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Module } from "../src/builder/types.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";
import type {
  HarnessedFunction,
  RuntimeProgram,
} from "../src/harness/types.ts";
import { recordVerifiedProvenance } from "../src/harness/verified-provenance.ts";
import { Runtime } from "../src/runtime.ts";

// `.src`-independent identity harness (workstream B — content-addressed action
// identity).
//
// THE INVARIANT: scheduler action identity — the persisted action id AND the
// durable implementation fingerprint — is derived from the content-addressed
// `{ identity, symbol }` provenance (module hash + hoisted `__cfReg`/export
// symbol), NOT from `fn.src`. `.src` is a debug field served from a separate
// map that nothing on the identity path reads
// (`harness/authored-debug-source.ts`), so a wrong or missing `.src` cannot
// move an id.
//
// THE BOUNDARY (second test): CFC verified-implementation identity
// (resolveProvenanceImplementationIdentity, which feeds `writeAuthorizedBy`) is
// ALSO `.src`-independent — rooted in the WeakMap provenance (the anti-spoof
// proof), so a debug `.src` that is garbled, absent, or attacker-supplied
// cannot deny or grant an authorized write. This test characterizes that
// boundary so a future change that re-introduces a `.src` dependency in CFC
// identity trips a loud, self-documenting failure here. Its sibling is attack 6
// in content-addressed-identity-adversarial.test.ts, which forges `.src` on a
// function it controls and shows the forgery inert.
//
// See docs/specs/content-addressed-action-identity.md and
// packages/patterns/lunch-poll/perf-seed/B-IDENTITY-REROOT-HANDOFF.md.

const signer = await Identity.fromPassphrase("src-independent identity invariant");
const space = signer.did();

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

Deno.test(
  "BOUNDARY: CFC verified-implementation identity is .src-independent",
  () => {
    // CFC verified-source identity is rooted in the WeakMap provenance: the
    // lookup IS the anti-spoof proof, and every policy-facing identity field is
    // provenance-derived. `writeAuthorizedBy` verifies moduleIdentity +
    // bindingPath; sourceFile is diagnostic there. So garbling or REMOVING
    // `.src` must NOT change the resolved identity — that is what makes a
    // debug-only `.src`, absent whenever a load carries no source, safe for
    // authorized writes. If a future change re-introduces a `.src` dependency
    // in CFC identity, this test trips.
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
    await runtime.dispose();
  }
}

Deno.test(
  "multi-instance ids stay per-instance for an anonymous implementation",
  async () => {
    // THE REGRESSION THIS PINS: identity stamping was once gated behind
    // `fn.name`, which an anonymous arrow implementation leaves empty — the
    // stamps were skipped and identity fell to a per-symbol re-derivation with
    // NO instance key, silently collapsing two instances of one lift onto one
    // durable observation (and one actionStats entry, mis-tuning auto-debounce
    // for maps/repeated ops). Stamping is unconditional and the fallback
    // derivation is gone.
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
