import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-runtime-stats");
const space = signer.did();

describe("CFC runtime stats", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("tracks relevant, prepared, reject, invalidation, outbox, and sink dedupe counters", async () => {
    storageManager = StorageManager.emulate({
      as: signer,
    });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });

    expect(runtime.getCfcStats()).toEqual({
      cfcRelevantTx: 0,
      cfcPreparedTx: 0,
      cfcPrepareRejects: 0,
      cfcDigestInvalidations: 0,
      cfcOutboxFlushes: 0,
      sinkDedupHits: 0,
      sinkReleaseRejects: 0,
      prefixProvenanceSummaries: 0,
      prefixProtectedWrites: 0,
      prefixGatedReads: 0,
      prefixTxGlobalGatedReads: 0,
      prefixBoundReal: 0,
      prefixBoundInfinityFallback: 0,
      prefixBoundClockLess: 0,
      prefixS7ExemptionFires: 0,
      prefixClockLessReads: 0,
    });

    const preparedTx = runtime.edit();
    preparedTx.setCfcEnforcementMode("enforce-explicit");
    preparedTx.markCfcRelevant("stats-prepared");
    const preparedCell = runtime.getCell(
      space,
      "cfc-runtime-stats-prepared",
      {
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
        required: ["secret"],
      },
      preparedTx,
    );
    preparedCell.set({ secret: "value" });
    let preparedFlushCount = 0;
    enqueueSinkRequestPostCommitEffect(
      preparedTx,
      "fetchJson",
      "fetchJson:cfc-runtime-stats-prepared",
      createFrozenRequestSnapshot({
        url: "https://example.com/cfc-runtime-stats-prepared",
      }),
      "fetchJson-start",
      () => {
        preparedFlushCount++;
      },
    );
    preparedTx.prepareCfc();
    expect((await preparedTx.commit()).ok).toBeDefined();
    expect(preparedFlushCount).toBe(1);

    const rejectTx = runtime.edit();
    rejectTx.setCfcEnforcementMode("enforce-explicit");
    rejectTx.markCfcRelevant("stats-reject");
    const rejectSchema = {
      type: "object",
      properties: {
        value: {
          type: "string",
          ifc: { collection: ["unsupported"] },
        },
      },
      required: ["value"],
    } as unknown as JSONSchema;
    const rejectCell = runtime.getCell(
      space,
      "cfc-runtime-stats-reject",
      rejectSchema,
      rejectTx,
    );
    rejectCell.set({ value: "blocked" });
    expect(rejectTx.prepareCfc()).toBe("");
    expect((await rejectTx.commit()).error?.message).toContain(
      "unsupported trust-sensitive claim collection",
    );

    const invalidationTx = runtime.edit();
    invalidationTx.setCfcEnforcementMode("enforce-explicit");
    invalidationTx.markCfcRelevant("stats-invalidation");
    const invalidationCell = runtime.getCell(
      space,
      "cfc-runtime-stats-invalidation",
      {
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
        required: ["secret"],
      },
      invalidationTx,
    );
    invalidationCell.set({ secret: "initial" });
    invalidationTx.prepareCfc();
    invalidationCell.set({ secret: "mutated" });
    expect((await invalidationTx.commit()).error?.message).toContain(
      "read-after-prepare",
    );

    const sinkTx = runtime.edit();
    sinkTx.markCfcRelevant("stats-sink");
    const request = createFrozenRequestSnapshot({
      url: "https://example.com/cfc-runtime-stats",
    });
    let flushCount = 0;
    enqueueSinkRequestPostCommitEffect(
      sinkTx,
      "fetchJson",
      "fetchJson:cfc-runtime-stats",
      request,
      "fetchJson-start",
      () => {
        flushCount++;
      },
    );
    enqueueSinkRequestPostCommitEffect(
      sinkTx,
      "fetchJson",
      "fetchJson:cfc-runtime-stats",
      request,
      "fetchJson-start",
      () => {
        flushCount++;
      },
    );
    sinkTx.prepareCfc();
    expect((await sinkTx.commit()).ok).toBeDefined();
    expect(flushCount).toBe(1);

    expect(runtime.getCfcStats()).toEqual({
      cfcRelevantTx: 4,
      cfcPreparedTx: 3,
      cfcPrepareRejects: 1,
      cfcDigestInvalidations: 1,
      cfcOutboxFlushes: 2,
      sinkDedupHits: 1,
      sinkReleaseRejects: 0,
      // Stage-0 prefix-provenance counters stay untouched without the
      // cfcPrefixProvenanceStats opt-in — the hook-absent default collects
      // nothing even across relevant, rejected, and invalidated prepares.
      prefixProvenanceSummaries: 0,
      prefixProtectedWrites: 0,
      prefixGatedReads: 0,
      prefixTxGlobalGatedReads: 0,
      prefixBoundReal: 0,
      prefixBoundInfinityFallback: 0,
      prefixBoundClockLess: 0,
      prefixS7ExemptionFires: 0,
      prefixClockLessReads: 0,
    });
  });
});
