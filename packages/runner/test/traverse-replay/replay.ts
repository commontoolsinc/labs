/**
 * Replay driver for traverse fixtures (see src/traverse-recorder.ts for the
 * fixture format and capture instructions).
 *
 * Replays the recorded `SchemaObjectTraverser.traverse()` invocations against
 * a corpus-backed read-only transaction and extracts:
 *
 * - an **oracle**: per-invocation result hashes, the set of reads issued
 *   (address + read-option flags), and the schema-tracker contents per
 *   shared context. Behavior-preserving optimizations must keep the oracle
 *   byte-identical; deliberate semantic changes regenerate the goldens.
 * - **metrics**: aggregated traverser counters. These are *not* asserted —
 *   they exist so benchmarks can attribute wins (e.g. anyOfBranches -80%).
 */
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import type { JSONObject } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import type { SchemaPathSelector } from "../../src/storage/interface.ts";
import {
  type BaseMemoryAddress,
  CompoundCycleTracker,
  createSchemaMemo,
  createTraversalContext,
  type IAttestation,
  type IMemorySpaceValueAttestation,
  ManagedStorageTransaction,
  MapSetStringToPathSelectors,
  type ObjectStorageManager,
  SchemaObjectTraverser,
  type TraversalContext,
} from "../../src/traverse.ts";
import { ContextualFlowControl } from "../../src/cfc.ts";
import { ExtendedStorageTransaction } from "../../src/storage/extended-storage-transaction.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadOptions,
} from "../../src/storage/interface.ts";
import {
  fixtureDocKey,
  type TraverseFixture,
} from "../../src/traverse-recorder.ts";
import type { Immutable } from "../../../utils/src/types.ts";

export type ReplayInvocationOracle = {
  ok: boolean;
  /** TraverseFailure code when ok is false. */
  code?: string;
  /** Structural hash of the returned value ("undefined" sentinel if so). */
  hash: string;
};

export type ReplayOracle = {
  invocations: ReplayInvocationOracle[];
  /** Sorted unique read descriptors: `space|scope|id|<json path>|flags`. */
  readSet: string[];
  /** Per shared-context id: sorted `trackerKey::selectorHash` entries. */
  schemaTrackers: Record<string, string[]>;
};

export type ReplayMetrics = {
  invocations: number;
  docs: number;
  traverseWithSchemaCalls: number;
  traversePointerCalls: number;
  traverseArrayCalls: number;
  traverseObjectCalls: number;
  traverseDAGCalls: number;
  anyOfBranches: number;
  anyOfFastRejects: number;
  anyOfPropertyMerges: number;
  getDocAtPathCalls: number;
  schemaMemoHits: number;
  reads: number;
};

export type ReplayResult = {
  oracle: ReplayOracle | undefined;
  metrics: ReplayMetrics;
};

/**
 * ObjectStorageManager over a fixture's doc corpus. Space/scope-aware
 * (ManagedStorageTransaction passes the full space address through), and
 * decodes `data:application/json` ids inline, mirroring how captured server
 * datasets carry undecoded data links.
 */
export class FixtureObjectManager implements ObjectStorageManager {
  private attestations = new Map<string, IAttestation>();

  constructor(private docs: Record<string, FabricValue>) {}

  load(address: BaseMemoryAddress): IAttestation | null {
    if (address.id.startsWith("data:application/json")) {
      const [_prefix, encoded] = address.id.split(",", 2);
      const value = JSON.parse(decodeURIComponent(encoded));
      return {
        address: { ...address, path: ["value"] },
        value: value as JSONObject | undefined,
      };
    }
    const key = fixtureDocKey(
      address as BaseMemoryAddress & { space: string },
    );
    const cached = this.attestations.get(key);
    if (cached !== undefined) return cached;
    const value = this.docs[key];
    if (value === undefined) return null;
    const attestation: IAttestation = {
      address: { ...address, path: [] },
      value: value as Immutable<FabricValue>,
    };
    this.attestations.set(key, attestation);
    return attestation;
  }
}

/** Wrap a tx so each read/readOrThrow appends a descriptor to `log`. */
function wrapTxWithReadLog(
  tx: IExtendedStorageTransaction,
  log: Set<string>,
): IExtendedStorageTransaction {
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === "read" || prop === "readOrThrow") {
        return (address: IMemorySpaceAddress, options?: IReadOptions) => {
          const flags = `${options?.nonRecursive ? "n" : ""}${
            options?.trackReadWithoutLoad ? "t" : ""
          }${options?.meta !== undefined ? "m" : ""}`;
          log.add(
            `${address.space}|${address.scope ?? "space"}|${address.id}|${
              JSON.stringify(address.path)
            }|${flags}`,
          );
          // deno-lint-ignore no-explicit-any
          return (target as any)[prop](address, options);
        };
      }
      // deno-lint-ignore no-explicit-any
      const value = (target as any)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function makeContext(includeMeta: boolean): TraversalContext {
  return createTraversalContext(
    new CompoundCycleTracker(),
    new ContextualFlowControl(),
    new MapSetStringToPathSelectors(true),
    includeMeta,
  );
}

export function replayFixture(
  fixture: TraverseFixture,
  options: { collectOracle?: boolean } = {},
): ReplayResult {
  const collectOracle = options.collectOracle ?? false;

  const manager = new FixtureObjectManager(fixture.docs);
  const managedTx = new ManagedStorageTransaction(manager);
  const rawTx = new ExtendedStorageTransaction(managedTx);
  const readLog = new Set<string>();
  const tx = collectOracle ? wrapTxWithReadLog(rawTx, readLog) : rawTx;

  const contexts = new Map<number, TraversalContext>();
  const memos = new Map<number, ReturnType<typeof createSchemaMemo>>();

  const invocationOracles: ReplayInvocationOracle[] = [];
  const metrics: ReplayMetrics = {
    invocations: fixture.invocations.length,
    docs: Object.keys(fixture.docs).length,
    traverseWithSchemaCalls: 0,
    traversePointerCalls: 0,
    traverseArrayCalls: 0,
    traverseObjectCalls: 0,
    traverseDAGCalls: 0,
    anyOfBranches: 0,
    anyOfFastRejects: 0,
    anyOfPropertyMerges: 0,
    getDocAtPathCalls: 0,
    schemaMemoHits: 0,
    reads: 0,
  };

  for (const invocation of fixture.invocations) {
    let context = contexts.get(invocation.context);
    if (context === undefined) {
      context = makeContext(invocation.includeMeta);
      contexts.set(invocation.context, context);
    }
    let memo = undefined;
    if (invocation.memo !== undefined) {
      memo = memos.get(invocation.memo);
      if (memo === undefined) {
        memo = createSchemaMemo();
        memos.set(invocation.memo, memo);
      }
    }
    const selector = fixture.selectors[invocation.selector];
    const link = invocation.link !== undefined
      ? fixture.links[invocation.link]
      : undefined;
    const address: IMemorySpaceAddress = {
      space: invocation.address.space as IMemorySpaceAddress["space"],
      id: invocation.address.id as IMemorySpaceAddress["id"],
      type: invocation.address.type as IMemorySpaceAddress["type"],
      path: [...invocation.address.path],
      ...(invocation.address.scope !== undefined &&
        { scope: invocation.address.scope as IMemorySpaceAddress["scope"] }),
    };
    // Mirror validateAndTransform: materialize the root value outside the
    // read log (the live path reads it with ignoreReadForScheduling).
    const value = rawTx.readOrThrow(address);
    const doc: IMemorySpaceValueAttestation = {
      address: address as IMemorySpaceValueAttestation["address"],
      value,
    };
    const traverser = new SchemaObjectTraverser(
      tx,
      selector as SchemaPathSelector,
      context,
      undefined,
      memo,
    );
    const rv = traverser.traverse(doc, link);

    metrics.traverseWithSchemaCalls += traverser.traverseWithSchemaCalls;
    metrics.traversePointerCalls += traverser.traversePointerCalls;
    metrics.traverseArrayCalls += traverser.traverseArrayCalls;
    metrics.traverseObjectCalls += traverser.traverseObjectCalls;
    metrics.traverseDAGCalls += traverser.traverseDAGCalls;
    metrics.anyOfBranches += traverser.anyOfBranches;
    metrics.anyOfFastRejects += traverser.anyOfFastRejects;
    metrics.anyOfPropertyMerges += traverser.anyOfPropertyMerges;
    metrics.getDocAtPathCalls += traverser.getDocAtPathCalls;
    metrics.schemaMemoHits += traverser.schemaMemoHits;

    if (collectOracle) {
      invocationOracles.push({
        ok: rv.error === undefined,
        ...(rv.error !== undefined && { code: rv.error.code }),
        hash: rv.ok === undefined ? "undefined" : hashStringOf(rv.ok),
      });
    }
  }

  metrics.reads = readLog.size;

  let oracle: ReplayOracle | undefined;
  if (collectOracle) {
    const schemaTrackers: Record<string, string[]> = {};
    for (const [contextId, context] of contexts) {
      const entries: string[] = [];
      for (const [key, selectors] of context.schemaTracker) {
        for (const selector of selectors) {
          entries.push(`${key}::${hashStringOf(selector)}`);
        }
      }
      schemaTrackers[String(contextId)] = entries.sort();
    }
    oracle = {
      invocations: invocationOracles,
      readSet: [...readLog].sort(),
      schemaTrackers,
    };
  }

  return { oracle, metrics };
}

export function loadFixture(path: string): TraverseFixture {
  return JSON.parse(Deno.readTextFileSync(path)) as TraverseFixture;
}
