import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type ClientCommit } from "@commonfabric/memory/v2";
import {
  buildSchedulerActionObservation,
  isSchedulerActionObservation,
  type SchedulerActionObservation,
} from "../src/scheduler/persistent-observation.ts";
import { serverBuiltinMaterializerScopeSummary } from "../src/scheduler/run.ts";
import {
  classifyStaticActionServability,
  dynamicActionTransactionUnservableReason,
} from "../src/scheduler/servability.ts";
import {
  createExecutorActionTransactionRouter,
  type ExecutorCandidateDiagnostic,
} from "../src/executor/action-transaction-router.ts";
import {
  builtinImplementationHash,
  isServerMaterializerBuiltinId,
  SERVER_MATERIALIZER_BUILTIN_IDS,
  type ServerBuiltinMaterializerDescriptor,
} from "../src/builtins/server-execution.ts";
import type { Action } from "../src/scheduler/types.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import type { ActionTransactionRouteInput } from "../src/storage/v2.ts";

// W2.16 — per-builtin MATERIALIZER descriptors for the container-minting list
// builtins map/filter/flatMap. Each mints a result CONTAINER document distinct
// from its direct output and writes the whole output collection (array plus
// per-slot element links) into it. The descriptor's write surface is
// envelope-shaped: a root prefix over that container rides in
// `materializerWriteEnvelopes`, while `writes` carries only the declared surface
// plus the direct output. Fail-closed: a run writing anywhere else (a first
// reconcile instantiating per-element children) de-claims at the firewall.

const SPACE = "did:key:z6Mk-materializer-descriptor" as const;
const RUNTIME_FP = "runner:scheduler:v3";

function link(
  id: string,
  overrides: Partial<NormalizedFullLink> = {},
): NormalizedFullLink {
  return {
    space: SPACE,
    id: id as NormalizedFullLink["id"],
    path: [],
    scope: "space",
    ...overrides,
  } as NormalizedFullLink;
}

function valueAddress(
  id: string,
  overrides: Partial<IMemorySpaceAddress> = {},
): IMemorySpaceAddress {
  return {
    space: SPACE,
    scope: "space",
    id: id as IMemorySpaceAddress["id"],
    path: ["value"],
    ...overrides,
  };
}

function descriptor(
  id: ServerBuiltinMaterializerDescriptor["id"],
  overrides: Partial<ServerBuiltinMaterializerDescriptor> = {},
): ServerBuiltinMaterializerDescriptor {
  return {
    version: 1,
    id,
    piece: link("of:piece"),
    reads: [link("of:items")],
    // The direct output redirect the collection link is written into.
    writes: [link("of:output")],
    directOutputs: [link("of:output")],
    // Root prefix over the result container (the output collection doc).
    materializerWriteEnvelopes: [link("of:container")],
    ...overrides,
  };
}

function observation(
  id: ServerBuiltinMaterializerDescriptor["id"],
  overrides: Partial<SchedulerActionObservation> = {},
): SchedulerActionObservation {
  return buildSchedulerActionObservation({
    ownerSpace: SPACE,
    branch: "",
    pieceId: "space:of:piece",
    processGeneration: 0,
    actionId: `cf:builtin/${id}:v1:instance-1`,
    actionKind: "computation",
    implementationFingerprint: `impl:${builtinImplementationHash(id)}`,
    runtimeFingerprint: RUNTIME_FP,
    observedAtSeq: 0,
    transactionKind: "action-run",
    transactionLog: {
      reads: [valueAddress("of:items")],
      shallowReads: [],
      // A steady-state reconcile's writes: the container's value array plus one
      // slot, and the direct output link. All inside the `["value"]` subtree the
      // container envelope covers (the `["result"]` meta write only happens on
      // first-reconcile container creation, which de-claims anyway).
      writes: [
        valueAddress("of:container"),
        valueAddress("of:container", { path: ["value", "0"] }),
        valueAddress("of:container", { path: ["value", "length"] }),
        valueAddress("of:output"),
      ],
    },
    currentKnownWrites: [valueAddress("of:output")],
    // The registered container envelope, from the materializer index — the
    // servability firewall bounds this against the summary. `getCell(...).path`
    // is the value root, which `toMemorySpaceAddress` renders as `["value"]`.
    materializerWriteEnvelopes: [valueAddress("of:container")],
    ...overrides,
  });
}

describe("per-builtin materializer descriptors (W2.16)", () => {
  it("keeps the descriptor registry exact to the container-minting list builtins", () => {
    expect([...SERVER_MATERIALIZER_BUILTIN_IDS]).toEqual([
      "map",
      "filter",
      "flatMap",
    ]);
    for (const id of ["map", "filter", "flatMap"]) {
      expect(isServerMaterializerBuiltinId(id)).toBe(true);
    }
    for (const id of ["ifElse", "when", "unless", "wish", "generateText"]) {
      expect(isServerMaterializerBuiltinId(id)).toBe(false);
    }
  });

  for (const id of ["map", "filter", "flatMap"] as const) {
    it(`assembles a claim-ready envelope summary for ${id} with the v1 fingerprint`, () => {
      const obs = observation(id);
      const summary = serverBuiltinMaterializerScopeSummary(
        obs,
        descriptor(id),
      );
      expect(summary).toBeDefined();
      expect(summary!.implementationFingerprint).toBe(
        `impl:cf:builtin/${id}:v1`,
      );
      // Direct output + declared surface in `writes`; the container is the
      // envelope, not an exact write. The container's value-root envelope is
      // lifted to a DOCUMENT-root prefix (path `[]`, not the `["value"]`
      // rendering) so the mint branch's `["result"]`/`["pattern"]` meta
      // writes and the `["cfc"]` label envelope stay covered (CA6/FB19).
      expect(summary!.writes).toEqual([valueAddress("of:output")]);
      expect(summary!.directOutputs).toEqual([valueAddress("of:output")]);
      expect(summary!.materializerWriteEnvelopes).toEqual([
        valueAddress("of:container", { path: [] }),
      ]);
      expect(summary!.piece).toEqual(valueAddress("of:piece"));

      expect(
        classifyStaticActionServability(
          { ...obs, completeActionScopeSummary: summary },
          SPACE,
        ),
      ).toEqual({ status: "claim-ready", actionKind: "computation" });
    });
  }

  it("returns no summary without a descriptor (map stays incomplete-static-surface)", () => {
    const obs = observation("map", { materializerWriteEnvelopes: [] });
    expect(serverBuiltinMaterializerScopeSummary(obs, undefined))
      .toBeUndefined();
    expect(classifyStaticActionServability(obs, SPACE)).toEqual({
      status: "unservable",
      reason: "incomplete-static-surface",
    });
  });

  it("returns no summary for a descriptor with an empty envelope (not a materializer)", () => {
    const obs = observation("map");
    const forged = descriptor("map", { materializerWriteEnvelopes: [] });
    expect(serverBuiltinMaterializerScopeSummary(obs, forged)).toBeUndefined();
  });

  it("rejects a descriptor whose id is not a container-minting list builtin", () => {
    const obs = observation("map", {
      implementationFingerprint: "impl:cf:builtin/ifElse:v1",
      actionId: "cf:builtin/ifElse:v1:instance-1",
    });
    const forged = {
      ...descriptor("map"),
      id: "ifElse",
    } as unknown as ServerBuiltinMaterializerDescriptor;
    expect(serverBuiltinMaterializerScopeSummary(obs, forged)).toBeUndefined();
  });

  it("rejects a descriptor whose fingerprint does not match the observation", () => {
    const obs = observation("map", {
      implementationFingerprint: "impl:cf:builtin/filter:v1",
    });
    // Descriptor says map, observation carries filter's fingerprint: no summary.
    expect(serverBuiltinMaterializerScopeSummary(obs, descriptor("map")))
      .toBeUndefined();
  });

  it("does not assemble for an effect action", () => {
    const obs = observation("map", { actionKind: "effect" });
    expect(serverBuiltinMaterializerScopeSummary(obs, descriptor("map")))
      .toBeUndefined();
  });

  it("does not override an existing certificate summary", () => {
    const obs = observation("map", {
      completeActionScopeSummary: {
        version: 1,
        complete: true,
        implementationFingerprint: "impl:cf:builtin/map:v1",
        runtimeFingerprint: RUNTIME_FP,
        piece: valueAddress("of:piece"),
        reads: [valueAddress("of:items")],
        writes: [valueAddress("of:output")],
        materializerWriteEnvelopes: [valueAddress("of:container")],
        directOutputs: [valueAddress("of:output")],
      },
    });
    expect(serverBuiltinMaterializerScopeSummary(obs, descriptor("map")))
      .toBeUndefined();
  });

  it("folds framework (scheduler-ignored) reads and cfc siblings into the summary", () => {
    const obs = observation("map");
    const frameworkRead = valueAddress("of:argument-doc", { path: [] });
    const foreignRead = valueAddress("of:foreign-doc", {
      space: "did:key:z6Mk-elsewhere" as IMemorySpaceAddress["space"],
      path: [],
    });
    const summary = serverBuiltinMaterializerScopeSummary(
      obs,
      descriptor("map"),
      [frameworkRead, foreignRead],
    );
    expect(summary).toBeDefined();
    const covers = (target: IMemorySpaceAddress) =>
      summary!.reads.some((entry) =>
        entry.space === target.space && entry.id === target.id &&
        target.path.join(" ").startsWith(entry.path.join(" "))
      );
    expect(covers(frameworkRead)).toBe(true);
    expect(covers(foreignRead)).toBe(false);
    // CFC label siblings for the direct output AND the container envelope.
    expect(covers(valueAddress("of:output", { path: ["cfc"] }))).toBe(true);
    expect(covers(valueAddress("of:container", { path: ["cfc"] }))).toBe(true);
    // Folding must not widen the write envelope.
    expect(summary!.writes.some((entry) => entry.id === frameworkRead.id))
      .toBe(false);
  });

  it("bounds the container: a per-slot write inside the envelope is served, a foreign write is not", () => {
    const obs = observation("map");
    const summary = serverBuiltinMaterializerScopeSummary(
      obs,
      descriptor("map"),
    );
    const observed: SchedulerActionObservation = {
      ...obs,
      completeActionScopeSummary: summary,
    };
    // A deeply-nested slot write is covered by the container root prefix.
    const okInput: ActionTransactionRouteInput = {
      space: SPACE,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "of:output", scope: "space", value: { value: 1 } },
          {
            op: "set",
            id: "of:container",
            scope: "space",
            value: { value: [1, 2, 3] },
          },
        ],
        schedulerObservation: observed,
      },
      sourceAction: {},
    };
    expect(
      dynamicActionTransactionUnservableReason(okInput, observed, {
        servedSpace: SPACE,
        branch: "",
      }),
    ).toBeUndefined();
  });

  it("is fail-closed: a first-reconcile child write outside the container is rejected once", async () => {
    // map's first reconcile instantiates per-element children (a separate
    // provenance-covered doc, NOT this node's writes). That run writes outside
    // the container envelope, so the whole transaction is rejected fail-closed
    // and reported exactly once across identical reruns (the W2.7 dedupe),
    // leaving the action client-primary for that run.
    const withSummary = (): SchedulerActionObservation => {
      const base = observation("map", {
        actualChangedWrites: [
          valueAddress("of:container"),
          valueAddress("of:output"),
          // The per-element child pattern doc — outside the envelope.
          valueAddress("of:child", { path: ["argument"] }),
        ],
      });
      const summary = serverBuiltinMaterializerScopeSummary(
        base,
        descriptor("map"),
      );
      expect(summary).toBeDefined();
      return { ...base, completeActionScopeSummary: summary };
    };
    const commit = (): ClientCommit => ({
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [
        { op: "set", id: "of:output", scope: "space", value: { value: 1 } },
        {
          op: "set",
          id: "of:container",
          scope: "space",
          value: { value: [1] },
        },
        {
          op: "set",
          id: "of:child",
          scope: "space",
          value: { argument: {} },
        },
      ],
      schedulerObservation: withSummary(),
    });

    const diagnostics: ExecutorCandidateDiagnostic[] = [];
    const sourceAction = {};
    const router = createExecutorActionTransactionRouter({
      servedSpace: SPACE,
      branch: "",
      claimForAction: () => undefined,
      onCandidate: () => {
        throw new Error(
          "a write-outside-container action must not become a candidate",
        );
      },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const first = await router({
      space: SPACE,
      commit: commit(),
      sourceAction,
    });
    expect(first).toEqual({ disposition: "local", kind: "executor-shadow" });
    const second = await router({
      space: SPACE,
      commit: commit(),
      sourceAction,
    });
    expect(second).toEqual({ disposition: "local", kind: "executor-shadow" });

    expect(diagnostics.map((entry) => entry.diagnosticCode)).toEqual([
      "dynamic-write-outside-static-surface",
    ]);
  });
});

const integrationSigner = await Identity.fromPassphrase(
  "materializer-descriptor-integration",
);
const integrationSpace = integrationSigner.did();

describe("per-builtin materializer descriptors — end to end (W2.16)", () => {
  let runtime: Runtime | undefined;
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("attaches materializer descriptors and makes a real map claim-ready with a container envelope", async () => {
    storageManager = StorageManager.emulate({ as: integrationSigner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

    const capturedActions: Action[] = [];
    const sched = runtime.scheduler as unknown as {
      subscribe: (...args: unknown[]) => unknown;
    };
    const originalSubscribe = sched.subscribe.bind(sched);
    sched.subscribe = (...args: unknown[]) => {
      capturedActions.push(args[0] as Action);
      return originalSubscribe(...args);
    };

    const observations: SchedulerActionObservation[] = [];
    const originalEdit = runtime.edit.bind(runtime);
    runtime.edit = ((...args: Parameters<typeof originalEdit>) => {
      const actionTx = originalEdit(...args);
      const originalSet = (actionTx as IExtendedStorageTransaction)
        .setSchedulerObservation?.bind(actionTx);
      (actionTx as IExtendedStorageTransaction).setSchedulerObservation = (
        obs: unknown,
      ) => {
        if (isSchedulerActionObservation(obs)) observations.push(obs);
        originalSet?.(obs as SchedulerActionObservation);
      };
      return actionTx;
    }) as typeof runtime.edit;

    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern } from 'commonfabric';",
          "export default pattern<{ items: number[] }>(",
          "  ({ items }) => {",
          "    const doubled = items.map((n: any) => n * 2);",
          "    return { doubled };",
          "  },",
          ");",
        ].join("\n"),
      }],
    });
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      integrationSpace,
      "materializer-e2e",
      undefined,
      tx,
    );
    const handle = runtime.run(tx, compiled, { items: [1, 2, 3] }, resultCell);
    await tx.commit();
    for (let k = 0; k < 6; k++) {
      await handle.pull();
      await runtime.idle();
    }

    // The map action carries the trusted materializer descriptor with a
    // non-empty container envelope.
    const mapDescriptors = capturedActions
      .filter((action) =>
        (action as { module?: { debugName?: string } }).module?.debugName ===
          "map"
      )
      .map((action) =>
        (action as {
          serverBuiltinMaterializer?: {
            version?: number;
            id?: string;
            materializerWriteEnvelopes?: unknown[];
          };
        }).serverBuiltinMaterializer
      );
    expect(mapDescriptors.length).toBeGreaterThan(0);
    for (const d of mapDescriptors) {
      expect(d?.version).toBe(1);
      expect(d?.id).toBe("map");
      expect((d?.materializerWriteEnvelopes ?? []).length).toBeGreaterThan(0);
    }

    // The real observations map produced are claim-ready and carry the envelope.
    const mapMatches = observations.filter((o) =>
      o.implementationFingerprint === "impl:cf:builtin/map:v1"
    );
    expect(mapMatches.length).toBeGreaterThan(0);
    for (const obs of mapMatches) {
      expect(obs.completeActionScopeSummary).toBeDefined();
      expect(obs.completeActionScopeSummary!.materializerWriteEnvelopes.length)
        .toBeGreaterThan(0);
      expect(classifyStaticActionServability(obs, integrationSpace)).toEqual({
        status: "claim-ready",
        actionKind: "computation",
      });
    }
  });
});
