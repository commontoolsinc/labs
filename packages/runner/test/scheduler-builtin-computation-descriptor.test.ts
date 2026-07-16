import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  buildSchedulerActionObservation,
  isSchedulerActionObservation,
  type SchedulerActionObservation,
} from "../src/scheduler/persistent-observation.ts";
import { serverBuiltinComputationScopeSummary } from "../src/scheduler/run.ts";
import { classifyStaticActionServability } from "../src/scheduler/servability.ts";
import {
  builtinImplementationHash,
  isServerComputationBuiltinId,
  SERVER_COMPUTATION_BUILTIN_IDS,
  type ServerBuiltinComputationDescriptor,
} from "../src/builtins/server-execution.ts";
import type { Action } from "../src/scheduler/types.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

// W2.15a — per-builtin COMPUTATION descriptors for the pure structural
// selectors ifElse/when/unless. Mirrors the effect descriptor path: a trusted
// runner-authored descriptor keyed on the exact `impl:cf:builtin/<id>:v1`
// fingerprint (W2.11) is assembled into a claim-ready summary. The registry is
// deliberately exact — map/filter/flatMap/wish have no descriptor and stay
// incomplete-static-surface.

const SPACE = "did:key:z6Mk-builtin-computation" as const;
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
  id: ServerBuiltinComputationDescriptor["id"],
  overrides: Partial<ServerBuiltinComputationDescriptor> = {},
): ServerBuiltinComputationDescriptor {
  return {
    version: 1,
    id,
    piece: link("of:piece"),
    reads: [link("of:condition")],
    writes: [link("of:output")],
    directOutputs: [link("of:output")],
    ...overrides,
  };
}

function observation(
  id: ServerBuiltinComputationDescriptor["id"],
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
      reads: [valueAddress("of:condition")],
      shallowReads: [],
      writes: [valueAddress("of:output")],
    },
    currentKnownWrites: [valueAddress("of:output")],
    materializerWriteEnvelopes: [],
    ...overrides,
  });
}

describe("per-builtin computation descriptors (W2.15a)", () => {
  it("keeps the descriptor registry exact to the pure selectors", () => {
    expect([...SERVER_COMPUTATION_BUILTIN_IDS]).toEqual([
      "ifElse",
      "when",
      "unless",
    ]);
    for (const id of ["ifElse", "when", "unless"]) {
      expect(isServerComputationBuiltinId(id)).toBe(true);
    }
    for (const id of ["map", "filter", "flatMap", "wish", "generateText"]) {
      expect(isServerComputationBuiltinId(id)).toBe(false);
    }
  });

  for (const id of ["ifElse", "when", "unless"] as const) {
    it(`assembles a claim-ready summary for ${id} with the v1 fingerprint`, () => {
      const obs = observation(id);
      const summary = serverBuiltinComputationScopeSummary(obs, descriptor(id));
      expect(summary).toBeDefined();
      expect(summary!.implementationFingerprint).toBe(
        `impl:cf:builtin/${id}:v1`,
      );
      expect(summary!.directOutputs).toEqual([valueAddress("of:output")]);
      // Fail-closed: the envelope is exactly the declared output, no more.
      expect(summary!.writes).toEqual([valueAddress("of:output")]);
      expect(summary!.materializerWriteEnvelopes).toEqual([]);
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
    // A map candidate carries the v1 fingerprint (W2.11) but no descriptor.
    const mapObs = buildSchedulerActionObservation({
      ownerSpace: SPACE,
      branch: "",
      pieceId: "space:of:piece",
      processGeneration: 0,
      actionId: "cf:builtin/map:v1:instance-1",
      actionKind: "computation",
      implementationFingerprint: "impl:cf:builtin/map:v1",
      runtimeFingerprint: RUNTIME_FP,
      observedAtSeq: 0,
      transactionKind: "action-run",
      transactionLog: {
        reads: [valueAddress("of:items")],
        shallowReads: [],
        writes: [valueAddress("of:output")],
      },
      currentKnownWrites: [valueAddress("of:output")],
      materializerWriteEnvelopes: [],
    });
    expect(serverBuiltinComputationScopeSummary(mapObs, undefined))
      .toBeUndefined();
    expect(classifyStaticActionServability(mapObs, SPACE)).toEqual({
      status: "unservable",
      reason: "incomplete-static-surface",
    });
  });

  it("rejects a descriptor whose id is not a pure selector", () => {
    const obs = observation("ifElse", {
      implementationFingerprint: "impl:cf:builtin/map:v1",
      actionId: "cf:builtin/map:v1:instance-1",
    });
    // A forged descriptor claiming `map` must not assemble.
    const forged = {
      ...descriptor("ifElse"),
      id: "map",
    } as unknown as ServerBuiltinComputationDescriptor;
    expect(serverBuiltinComputationScopeSummary(obs, forged)).toBeUndefined();
  });

  it("rejects a descriptor whose fingerprint does not match the observation", () => {
    const obs = observation("ifElse", {
      implementationFingerprint: "impl:cf:builtin/when:v1",
    });
    // Descriptor says ifElse, observation carries when's fingerprint: no summary.
    expect(serverBuiltinComputationScopeSummary(obs, descriptor("ifElse")))
      .toBeUndefined();
  });

  it("does not override an existing certificate summary", () => {
    const obs = observation("ifElse", {
      completeActionScopeSummary: {
        version: 1,
        complete: true,
        implementationFingerprint: "impl:cf:builtin/ifElse:v1",
        runtimeFingerprint: RUNTIME_FP,
        piece: valueAddress("of:piece"),
        reads: [valueAddress("of:condition")],
        writes: [valueAddress("of:output")],
        materializerWriteEnvelopes: [],
        directOutputs: [valueAddress("of:output")],
      },
    });
    expect(serverBuiltinComputationScopeSummary(obs, descriptor("ifElse")))
      .toBeUndefined();
  });

  it("folds framework (scheduler-ignored) reads and cfc siblings into the summary", () => {
    // Claimed-commit admission requires every commit read covered by
    // observation ∪ summary reads; the argument-resolution reads are absent
    // from the reactive log, so the descriptor summary must fold them in.
    const obs = observation("ifElse");
    const frameworkRead = valueAddress("of:argument-doc", { path: [] });
    const foreignRead = valueAddress("of:foreign-doc", {
      space: "did:key:z6Mk-elsewhere" as IMemorySpaceAddress["space"],
      path: [],
    });
    const summary = serverBuiltinComputationScopeSummary(
      obs,
      descriptor("ifElse"),
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
    // CFC label sibling for the output doc, mirroring the certified path.
    expect(covers(valueAddress("of:output", { path: ["cfc"] }))).toBe(true);
    // Folding must not widen the write envelope.
    expect(summary!.writes.some((entry) => entry.id === frameworkRead.id))
      .toBe(false);
  });
});

const integrationSigner = await Identity.fromPassphrase(
  "builtin-computation-descriptor-integration",
);
const integrationSpace = integrationSigner.did();

describe("per-builtin computation descriptors — end to end (W2.15a)", () => {
  let runtime: Runtime | undefined;
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("attaches selector descriptors and makes real ifElse/when/unless claim-ready; map is served by a materializer descriptor, not a selector one", async () => {
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
        observation: unknown,
      ) => {
        if (isSchedulerActionObservation(observation)) {
          observations.push(observation);
        }
        originalSet?.(observation as SchedulerActionObservation);
      };
      return actionTx;
    }) as typeof runtime.edit;

    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          "import { pattern, ifElse, when, unless } from 'commonfabric';",
          "export default pattern<{ flag: boolean; items: number[] }>(",
          "  ({ flag, items }) => {",
          "    const chosen = ifElse(flag, 'yes', 'no');",
          "    const gated = when(flag, 'shown');",
          "    const fallback = unless(flag, 'default');",
          "    const doubled = items.map((n: any) => n * 2);",
          "    return { chosen, gated, fallback, doubled };",
          "  },",
          ");",
        ].join("\n"),
      }],
    });
    const tx = runtime.edit();
    const resultCell = runtime.getCell(
      integrationSpace,
      "selectors-e2e",
      undefined,
      tx,
    );
    const handle = runtime.run(
      tx,
      compiled,
      { flag: true, items: [1, 2, 3] },
      resultCell,
    );
    await tx.commit();
    for (let k = 0; k < 6; k++) {
      await handle.pull();
      await runtime.idle();
    }

    // Every selector action carries the trusted COMPUTATION descriptor; map
    // does not (the selector registry is exact) — it carries the separate
    // MATERIALIZER descriptor instead (W2.16).
    const computationById = new Map<string, unknown>();
    const materializerById = new Map<string, unknown>();
    for (const action of capturedActions) {
      const debugName = (action as { module?: { debugName?: string } }).module
        ?.debugName;
      if (
        !debugName || !["ifElse", "when", "unless", "map"].includes(debugName)
      ) {
        continue;
      }
      computationById.set(
        debugName,
        (action as { serverBuiltinComputation?: unknown })
          .serverBuiltinComputation,
      );
      materializerById.set(
        debugName,
        (action as { serverBuiltinMaterializer?: unknown })
          .serverBuiltinMaterializer,
      );
    }
    for (const id of ["ifElse", "when", "unless"]) {
      const descriptor = computationById.get(id) as
        | { version?: number; id?: string }
        | undefined;
      expect(descriptor?.version).toBe(1);
      expect(descriptor?.id).toBe(id);
      // Selectors are not materializers.
      expect(materializerById.get(id)).toBeUndefined();
    }
    // map carries a materializer descriptor (envelope surface), not a selector
    // one.
    expect(computationById.get("map")).toBeUndefined();
    const mapMaterializer = materializerById.get("map") as
      | {
        version?: number;
        id?: string;
        materializerWriteEnvelopes?: unknown[];
      }
      | undefined;
    expect(mapMaterializer?.version).toBe(1);
    expect(mapMaterializer?.id).toBe("map");
    expect((mapMaterializer?.materializerWriteEnvelopes ?? []).length)
      .toBeGreaterThan(0);

    // The real observation each selector produced (carrying its real pieceId) is
    // claim-ready; map is now claim-ready too, served by its materializer
    // descriptor (W2.16) rather than staying incomplete-static-surface.
    const byFingerprint = (fingerprint: string) =>
      observations.filter((o) => o.implementationFingerprint === fingerprint);

    for (const id of ["ifElse", "when", "unless"] as const) {
      const matches = byFingerprint(`impl:cf:builtin/${id}:v1`);
      expect(matches.length).toBeGreaterThan(0);
      for (const obs of matches) {
        expect(obs.completeActionScopeSummary).toBeDefined();
        expect(classifyStaticActionServability(obs, integrationSpace)).toEqual({
          status: "claim-ready",
          actionKind: "computation",
        });
      }
    }

    const mapMatches = byFingerprint("impl:cf:builtin/map:v1");
    expect(mapMatches.length).toBeGreaterThan(0);
    for (const obs of mapMatches) {
      expect(obs.completeActionScopeSummary).toBeDefined();
      // The summary carries the container envelope, not an empty one.
      expect(obs.completeActionScopeSummary!.materializerWriteEnvelopes.length)
        .toBeGreaterThan(0);
      expect(classifyStaticActionServability(obs, integrationSpace)).toEqual({
        status: "claim-ready",
        actionKind: "computation",
      });
    }
  });
});
