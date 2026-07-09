import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import type {
  IExtendedStorageTransaction,
  IReadActivity,
} from "../src/storage/interface.ts";
import {
  CFC_PREFIX_PROVENANCE_MAX_WRITES,
  type CfcPrefixProvenanceSummary,
  prepareBoundaryCommit,
} from "../src/cfc/mod.ts";

const signer = await Identity.fromPassphrase("runner-cfc-prefix-provenance");

// Stage 0 of the value-level-provenance design
// (docs/specs/cfc-value-level-provenance.md §6, SC-24): per-prepare precision
// counters measuring how much the shipped D4 write prefix
// (docs/specs/cfc-write-prefix-provenance.md) narrows the gated-read set
// versus the pre-D4 transaction-global gate. Measurement only — every
// scenario here pairs its counter assertions with the UNCHANGED enforcement
// outcome, and the hook-absent default is pinned byte-identical (all-zero
// stats, same decision).

const FLOOR_ATOM = "prefix-endorsed";
const OTHER_ATOM = "prefix-unrelated";

const SINK_SCHEMA = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { requiredIntegrity: [FLOOR_ATOM] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const makeRuntime = (options: {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  cfcPrefixProvenanceStats?: boolean;
}): Runtime =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: options.storageManager,
    cfcEnforcementMode: "enforce-explicit",
    ...(options.cfcPrefixProvenanceStats !== undefined
      ? { cfcPrefixProvenanceStats: options.cfcPrefixProvenanceStats }
      : {}),
  });

// Seed a doc's stored CFC metadata directly via an ungated path-[]
// full-document write (how the runtime persists it), so a later read picks
// up the given label.
const seedLabeledDoc = async (
  runtime: Runtime,
  id: string,
  value: unknown,
  label: { integrity?: unknown[]; confidentiality?: unknown[] },
): Promise<void> => {
  const seed = runtime.edit();
  const cell = runtime.getCell(signer.did(), id, undefined, seed);
  const docId = cell.getAsNormalizedFullLink().id as URI;
  seed.writeOrThrow({
    space: signer.did(),
    id: docId,
    type: "application/json",
    path: [],
  }, {
    value,
    cfc: {
      version: 1,
      schemaHash: `seed-${id}`,
      labelMap: { version: 1, entries: [{ path: [], label }] },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

const seedPlainDoc = async (
  runtime: Runtime,
  id: string,
  value: unknown,
): Promise<void> => {
  const seed = runtime.edit();
  const cell = runtime.getCell(signer.did(), id, undefined, seed);
  const docId = cell.getAsNormalizedFullLink().id as URI;
  seed.writeOrThrow({
    space: signer.did(),
    id: docId,
    type: "application/json",
    path: [],
  }, { value });
  expect((await seed.commit()).ok).toBeDefined();
};

describe("CFC prefix-provenance precision counters (Stage 0, doc §6)", () => {
  it("a labeled read past the last overlapping write reports prefix-gated < transaction-global", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      cfcPrefixProvenanceStats: true,
    });
    try {
      await seedLabeledDoc(runtime, "d4-stats-endorsed", "endorsed", {
        integrity: [FLOOR_ATOM],
      });
      await seedLabeledDoc(runtime, "d4-stats-low", "tainted", {
        integrity: [OTHER_ATOM],
      });
      await seedPlainDoc(runtime, "d4-stats-sink", { out: "seed" });

      const tx = runtime.edit();
      // journal: read E (endorsed) | write out = "a" | read R (low). R sits
      // past the last write overlapping /out, so the D4 prefix excludes it —
      // the transaction-global gate would have counted it. The commit
      // outcome is the shipped one (accepted); the counters just measure
      // the narrowing.
      runtime.getCell(signer.did(), "d4-stats-endorsed", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "d4-stats-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "a" });
      runtime.getCell(signer.did(), "d4-stats-low", undefined, tx).get();

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();

      const stats = runtime.getCfcStats();
      expect(stats.prefixProvenanceSummaries).toBe(1);
      expect(stats.prefixProtectedWrites).toBe(1);
      // Counts are per gate-visible read ACTIVITY (a doc .get() can record
      // several), so pin the relation, not traverse's read granularity: the
      // prefix kept the endorsed doc's reads and dropped the low doc's.
      expect(stats.prefixGatedReads).toBeGreaterThan(0);
      expect(stats.prefixGatedReads).toBeLessThan(
        stats.prefixTxGlobalGatedReads,
      );
      expect(stats.prefixBoundReal).toBe(1);
      expect(stats.prefixBoundInfinityFallback).toBe(0);
      expect(stats.prefixBoundClockLess).toBe(0);
      expect(stats.prefixS7ExemptionFires).toBe(0);
      expect(stats.prefixClockLessReads).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a protected path with no logged overlapping attempt reports the +Infinity fallback", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      cfcPrefixProvenanceStats: true,
    });
    try {
      await seedLabeledDoc(runtime, "d4-inf-endorsed", "endorsed", {
        integrity: [FLOOR_ATOM],
      });
      await seedPlainDoc(runtime, "d4-inf-sink", { out: "same" });
      await seedPlainDoc(runtime, "d4-inf-other", { n: 0 });

      const tx = runtime.edit();
      runtime.getCell(signer.did(), "d4-inf-endorsed", undefined, tx).get();
      // Value-equal write: the diff applies nothing, so no write attempt is
      // logged for the sink — but the attempted-write-marked read makes the
      // protected entry applicable (the doc §1 "attempted-but-unapplied"
      // shape). boundFor degrades to +Infinity for /out while the log stays
      // non-empty (the other doc's applied write), so the bound source is
      // the +Infinity fallback, not clock-less.
      const sink = runtime.getCell(
        signer.did(),
        "d4-inf-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "same" });
      runtime.getCell(signer.did(), "d4-inf-other", undefined, tx).set({
        n: 1,
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();

      const stats = runtime.getCfcStats();
      expect(stats.prefixProvenanceSummaries).toBe(1);
      expect(stats.prefixProtectedWrites).toBe(1);
      expect(stats.prefixBoundReal).toBe(0);
      expect(stats.prefixBoundInfinityFallback).toBe(1);
      expect(stats.prefixBoundClockLess).toBe(0);
      // +Infinity means transaction-global for this write: no narrowing.
      expect(stats.prefixGatedReads).toBe(stats.prefixTxGlobalGatedReads);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("a provenance-only read within the prefix increments the S7 exemption counter", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      cfcPrefixProvenanceStats: true,
    });
    try {
      // The ported group-chat shape: a structural provenance lookup (link
      // reference + current-principal claim) in the protected write's
      // prefix. Only the S7 exemption keeps it out of the gate — exactly
      // the event the counter measures.
      await seedLabeledDoc(runtime, "d4-s7-lookup", "lookup", {
        integrity: [
          { kind: "represents-principal", subject: signer.did() },
          { type: "https://commonfabric.org/cfc/atom/LinkReference" },
        ],
      });

      const tx = runtime.edit();
      runtime.getCell(signer.did(), "d4-s7-lookup", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "d4-s7-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "granted" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();

      const stats = runtime.getCfcStats();
      expect(stats.prefixProvenanceSummaries).toBe(1);
      expect(stats.prefixProtectedWrites).toBe(1);
      // At least one per gate-visible read activity of the lookup (a .get()
      // can record several — the exact count is traverse granularity).
      expect(stats.prefixS7ExemptionFires).toBeGreaterThanOrEqual(1);
      // The provenance-only reads are exempt on BOTH sides of the comparison
      // (the pre-D4 gate filtered them transaction-globally) — exact zeros,
      // independent of read granularity.
      expect(stats.prefixGatedReads).toBe(0);
      expect(stats.prefixTxGlobalGatedReads).toBe(0);
      expect(stats.prefixBoundReal).toBe(1);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("hook absent: no summary, and the enforcement outcome is identical to hook present", async () => {
    // The §3 re-attempt rejection from the D4 suite, run twice: counters off
    // (the default) and on. Same reason either way — measurement must be
    // byte-identical on decisions — and the disabled run reports no summary.
    const runScenario = async (
      cfcPrefixProvenanceStats: boolean,
    ): Promise<
      { message: string; stats: ReturnType<Runtime["getCfcStats"]> }
    > => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({
        storageManager,
        ...(cfcPrefixProvenanceStats ? { cfcPrefixProvenanceStats: true } : {}),
      });
      try {
        await seedLabeledDoc(runtime, "d4-pair-endorsed", "endorsed", {
          integrity: [FLOOR_ATOM],
        });
        await seedLabeledDoc(runtime, "d4-pair-low", "tainted", {
          integrity: [OTHER_ATOM],
        });
        await seedPlainDoc(runtime, "d4-pair-sink", { out: "seed" });

        const tx = runtime.edit();
        runtime.getCell(signer.did(), "d4-pair-endorsed", undefined, tx)
          .get();
        const sink = runtime.getCell(
          signer.did(),
          "d4-pair-sink",
          SINK_SCHEMA,
          tx,
        );
        sink.set({ out: "a" });
        runtime.getCell(signer.did(), "d4-pair-low", undefined, tx).get();
        sink.set({ out: "b" });

        tx.prepareCfc();
        const result = await tx.commit();
        return {
          message: String((result.error as Error | undefined)?.message),
          stats: runtime.getCfcStats(),
        };
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    const off = await runScenario(false);
    const on = await runScenario(true);

    expect(off.message).toContain("requiredIntegrity failed");
    expect(on.message).toBe(off.message);

    // Hook absent: nothing collected, nothing emitted.
    expect(off.stats.prefixProvenanceSummaries).toBe(0);
    expect(off.stats.prefixProtectedWrites).toBe(0);
    expect(off.stats.prefixGatedReads).toBe(0);
    expect(off.stats.prefixTxGlobalGatedReads).toBe(0);
    expect(off.stats.prefixBoundReal).toBe(0);
    expect(off.stats.prefixS7ExemptionFires).toBe(0);

    // Hook present: the rejecting write was still measured (both labeled
    // docs' reads precede the re-attempt, so the prefix equals
    // transaction-global here).
    expect(on.stats.prefixProvenanceSummaries).toBe(1);
    expect(on.stats.prefixProtectedWrites).toBe(1);
    expect(on.stats.prefixGatedReads).toBeGreaterThan(0);
    expect(on.stats.prefixGatedReads).toBe(on.stats.prefixTxGlobalGatedReads);
    expect(on.stats.prefixBoundReal).toBe(1);
  });

  it("hook present but no protected writes: no summary is emitted", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({
      storageManager,
      cfcPrefixProvenanceStats: true,
    });
    try {
      await seedLabeledDoc(runtime, "d4-none-labeled", "data", {
        integrity: [OTHER_ATOM],
      });

      const tx = runtime.edit();
      // A labeled read plus an UNPROTECTED write: the gate walks no entry
      // with requiredIntegrity/maxConfidentiality, so nothing is measured
      // and the per-prepare summary must not fire.
      runtime.getCell(signer.did(), "d4-none-labeled", undefined, tx).get();
      runtime.getCell(signer.did(), "d4-none-sink", undefined, tx).set({
        out: "plain",
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();

      const stats = runtime.getCfcStats();
      expect(stats.prefixProvenanceSummaries).toBe(0);
      expect(stats.prefixProtectedWrites).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

describe("CFC prefix-provenance summary (direct gate probes)", () => {
  // Delegating view that erases every order source the D4 bound consumes:
  // read activities lose their activity-clock stamp (they degrade to
  // -Infinity, joining every prefix) and the ordered write-attempt log is
  // empty. This is the clock-less backend of WritePrefixBounds.boundFor's
  // doc comment, which the V2 harness cannot otherwise produce.
  const clockLessView = (
    tx: IExtendedStorageTransaction,
  ): IExtendedStorageTransaction =>
    new Proxy(tx, {
      get(target, prop) {
        if (prop === "getReadActivities") {
          return (): IReadActivity[] =>
            [...target.getReadActivities?.() ?? []].map((activity) => {
              const { journalIndex: _journalIndex, ...rest } = activity;
              return rest as IReadActivity;
            });
        }
        if (prop === "getWriteAttemptLog") {
          return () => [];
        }
        const member = Reflect.get(target, prop, target);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });

  it("clock-less order sources classify as clockLess and count the -Infinity reads", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager });
    try {
      await seedLabeledDoc(runtime, "d4-clockless-endorsed", "endorsed", {
        integrity: [FLOOR_ATOM],
      });

      const tx = runtime.edit();
      runtime.getCell(signer.did(), "d4-clockless-endorsed", undefined, tx)
        .get();
      const sink = runtime.getCell(
        signer.did(),
        "d4-clockless-sink",
        SINK_SCHEMA,
        tx,
      );
      sink.set({ out: "a" });

      const summaries: CfcPrefixProvenanceSummary[] = [];
      const reasons = prepareBoundaryCommit(clockLessView(tx), {
        onPrefixProvenance: (summary) => summaries.push(summary),
      });
      expect(reasons).toEqual([]);
      expect(summaries.length).toBe(1);
      const summary = summaries[0];
      expect(summary.protectedWrites).toBe(1);
      expect(summary.boundSources).toEqual({
        real: 0,
        infinityFallback: 0,
        clockLess: 1,
      });
      // Every gate-visible read activity lost its clock position, so the
      // clock-less count covers at least the gated (labeled) ones.
      expect(summary.clockLessReads).toBeGreaterThanOrEqual(
        summary.prefixGatedReads,
      );
      expect(summary.clockLessReads).toBeGreaterThanOrEqual(1);
      // Order unknown = transaction-global gating: no narrowing to report.
      expect(summary.prefixGatedReads).toBeGreaterThan(0);
      expect(summary.prefixGatedReads).toBe(summary.txGlobalGatedReads);
      expect(summary.writes.length).toBe(1);
      expect(summary.writes[0].path).toBe("/out");
      expect(summary.writes[0].boundSource).toBe("clockLess");

      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("the per-write list is capped while the totals keep counting", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = makeRuntime({ storageManager });
    try {
      await seedLabeledDoc(runtime, "d4-cap-endorsed", "endorsed", {
        integrity: [FLOOR_ATOM],
      });
      const width = CFC_PREFIX_PROVENANCE_MAX_WRITES + 1;
      const wideSchema = {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: width }, (_, i) => [
            `f${i}`,
            { type: "string", ifc: { requiredIntegrity: [FLOOR_ATOM] } },
          ]),
        ),
      } as JSONSchema;

      const tx = runtime.edit();
      runtime.getCell(signer.did(), "d4-cap-endorsed", undefined, tx).get();
      const sink = runtime.getCell(
        signer.did(),
        "d4-cap-sink",
        wideSchema,
        tx,
      );
      sink.set(Object.fromEntries(
        Array.from({ length: width }, (_, i) => [`f${i}`, `v${i}`]),
      ));

      const summaries: CfcPrefixProvenanceSummary[] = [];
      const reasons = prepareBoundaryCommit(tx, {
        onPrefixProvenance: (summary) => summaries.push(summary),
      });
      expect(reasons).toEqual([]);
      expect(summaries.length).toBe(1);
      const summary = summaries[0];
      expect(summary.protectedWrites).toBe(width);
      expect(summary.writes.length).toBe(CFC_PREFIX_PROVENANCE_MAX_WRITES);
      expect(summary.boundSources.real).toBe(width);
      // Totals aggregate past the cap: every protected write gates the same
      // endorsed read activities, so the total is width times the per-write
      // count (whatever traverse's read granularity makes that).
      expect(summary.writes[0].prefixGatedReads).toBeGreaterThan(0);
      expect(summary.prefixGatedReads).toBe(
        width * summary.writes[0].prefixGatedReads,
      );

      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
