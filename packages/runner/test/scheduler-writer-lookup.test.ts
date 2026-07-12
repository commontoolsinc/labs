import {
  type SchedulerWriterCandidate as DurableSchedulerWriterCandidate,
  type SchedulerWriterMatch,
  toDocumentPath,
} from "@commonfabric/memory/v2";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { NodeStatus } from "../src/scheduler/node-record.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import {
  type Action,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  type Runtime,
  space,
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";

const BRANCH = "";
const PIECE_ID = "space:of:scheduler-writer-lookup-piece";
const PROCESS_GENERATION = 0;
const RUNTIME_FINGERPRINT = "runner:scheduler:v3";

type LiveSchedulerMatchedWrite = {
  kind: "current-known" | "materializer";
  write: IMemorySpaceAddress;
};

type IntendedSchedulerWriterCandidate = {
  branch: string;
  ownerSpace?: string;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  actionKind: "computation" | "effect" | "event-handler";
  implementationFingerprint: string;
  runtimeFingerprint: string;
  source: "live" | "durable" | "live+durable";
  live?: {
    action: Action;
    status: NodeStatus;
    registrationOrdinal: number;
    matchedWrites: LiveSchedulerMatchedWrite[];
  };
  durable?: DurableSchedulerWriterCandidate;
};

type DurableWriterProvider = {
  writersForTargets(query: {
    branch?: string;
    targets: readonly IMemorySpaceAddress[];
  }): Promise<{
    serverSeq: number;
    writers: DurableSchedulerWriterCandidate[];
  }>;
};

type WriterAction = Action & {
  implementationHash: string;
  writes?: NormalizedFullLink[];
  materializerWriteEnvelopes?: NormalizedFullLink[];
};

function createWriterAction(
  actionId: string,
  options: {
    writes?: NormalizedFullLink[];
    materializerWriteEnvelopes?: NormalizedFullLink[];
  } = {},
): WriterAction {
  const action = ((_tx) => undefined) as WriterAction;
  // No schedulerInstanceKey: the implementation hash is also the exact stable
  // action id in these focused fixtures.
  action.implementationHash = actionId;
  if (options.writes) action.writes = options.writes;
  if (options.materializerWriteEnvelopes) {
    action.materializerWriteEnvelopes = options.materializerWriteEnvelopes;
  }
  return action;
}

function registerIdentifiedWriter(
  runtime: Runtime,
  action: Action,
  pieceId = PIECE_ID,
): void {
  runtime.scheduler.register(action, {
    rehydrateFromStorage: {
      space,
      pieceId,
      processGeneration: PROCESS_GENERATION,
    },
  });
}

function stubDurableWriters(
  runtime: Runtime,
  writers: DurableSchedulerWriterCandidate[],
): void {
  const provider = runtime.storageManager.open(
    space,
  ) as unknown as DurableWriterProvider;
  provider.writersForTargets = () =>
    Promise.resolve({
      serverSeq: 0,
      writers,
    });
}

async function writersForTargets(
  runtime: Runtime,
  targets: readonly IMemorySpaceAddress[],
): Promise<IntendedSchedulerWriterCandidate[]> {
  return await runtime.scheduler.writersForTargets(BRANCH, space, targets);
}

function durableWriter(
  actionId: string,
  target: IMemorySpaceAddress,
  overrides: Partial<DurableSchedulerWriterCandidate> = {},
): DurableSchedulerWriterCandidate {
  const matchedWrite: SchedulerWriterMatch = {
    kind: "current-known",
    write: {
      ...target,
      scope: target.scope ?? "space",
      scopeKey: "space",
      path: toDocumentPath([...target.path]),
    },
  };
  return {
    branch: BRANCH,
    ownerSpace: space,
    pieceId: PIECE_ID,
    processGeneration: PROCESS_GENERATION,
    actionId,
    executionContextKey: "space",
    observationId: 1,
    commitSeq: null,
    observedAtSeq: 0,
    actionKind: "computation",
    implementationFingerprint: `impl:${actionId}`,
    runtimeFingerprint: RUNTIME_FINGERPRINT,
    status: "success",
    matchedWrites: [matchedWrite],
    ...overrides,
  };
}

describe("scheduler writer lookup", () => {
  it("returns a never-run writer from its live static surface", async () => {
    const env = createSchedulerTestRuntime(import.meta.url);
    try {
      stubDurableWriters(env.runtime, []);
      const output = env.runtime.getCell<number>(
        space,
        "writer-lookup-never-ran-output",
        undefined,
        env.tx,
      );
      const outputLink = output.getAsNormalizedFullLink();
      const outputAddress = toMemorySpaceAddress(outputLink);
      const actionId = "writer-lookup:never-ran";
      const action = createWriterAction(actionId, { writes: [outputLink] });
      registerIdentifiedWriter(env.runtime, action);

      const candidates = await writersForTargets(env.runtime, [{
        ...outputAddress,
        path: [...outputAddress.path, "nested"],
      }]);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        branch: BRANCH,
        ownerSpace: space,
        pieceId: PIECE_ID,
        processGeneration: PROCESS_GENERATION,
        actionId,
        actionKind: "computation",
        implementationFingerprint: `impl:${actionId}`,
        runtimeFingerprint: RUNTIME_FINGERPRINT,
        source: "live",
        live: {
          status: "never-ran",
          matchedWrites: [{
            kind: "current-known",
            write: outputAddress,
          }],
        },
      });
      expect(candidates[0]?.live?.action).toBe(action);
      expect(candidates[0]?.durable).toBeUndefined();
    } finally {
      await disposeSchedulerTestRuntime(env);
    }
  });

  it("returns a live materializer for a target inside its envelope", async () => {
    const env = createSchedulerTestRuntime(import.meta.url);
    try {
      stubDurableWriters(env.runtime, []);
      const output = env.runtime.getCell<Record<string, unknown>>(
        space,
        "writer-lookup-materializer-output",
        undefined,
        env.tx,
      );
      const envelope = output.getAsNormalizedFullLink();
      const envelopeAddress = toMemorySpaceAddress(envelope);
      const action = createWriterAction("writer-lookup:materializer", {
        materializerWriteEnvelopes: [envelope],
      });
      registerIdentifiedWriter(env.runtime, action);

      const candidates = await writersForTargets(env.runtime, [{
        ...envelopeAddress,
        path: [...envelopeAddress.path, "items", "0"],
      }]);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.source).toBe("live");
      expect(candidates[0]?.live?.action).toBe(action);
      expect(candidates[0]?.live?.matchedWrites).toEqual([{
        kind: "materializer",
        write: envelopeAddress,
      }]);
    } finally {
      await disposeSchedulerTestRuntime(env);
    }
  });

  it("skips a live writer without durable piece identity", async () => {
    const env = createSchedulerTestRuntime(import.meta.url);
    try {
      stubDurableWriters(env.runtime, []);
      const output = env.runtime.getCell<number>(
        space,
        "writer-lookup-identityless-output",
        undefined,
        env.tx,
      );
      const outputLink = output.getAsNormalizedFullLink();
      const action = createWriterAction("writer-lookup:identityless", {
        writes: [outputLink],
      });
      env.runtime.scheduler.register(action);

      expect(
        await writersForTargets(env.runtime, [
          toMemorySpaceAddress(outputLink),
        ]),
      ).toEqual([]);
    } finally {
      await disposeSchedulerTestRuntime(env);
    }
  });

  it("merges an exact durable row with its live action without mixing statuses", async () => {
    const env = createSchedulerTestRuntime(import.meta.url);
    try {
      const output = env.runtime.getCell<number>(
        space,
        "writer-lookup-merged-output",
        undefined,
        env.tx,
      );
      const outputLink = output.getAsNormalizedFullLink();
      const outputAddress = toMemorySpaceAddress(outputLink);
      const actionId = "writer-lookup:merged";
      const durable = durableWriter(actionId, outputAddress, {
        status: "failed",
        errorFingerprint: "Error:previous failure",
        directDirtySeq: 9,
      });
      stubDurableWriters(env.runtime, [durable]);
      const action = createWriterAction(actionId, { writes: [outputLink] });
      registerIdentifiedWriter(env.runtime, action);

      const candidates = await writersForTargets(env.runtime, [outputAddress]);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        actionId,
        source: "live+durable",
        live: { status: "never-ran" },
        durable: {
          status: "failed",
          errorFingerprint: "Error:previous failure",
          directDirtySeq: 9,
        },
      });
      expect(candidates[0]?.live?.action).toBe(action);
    } finally {
      await disposeSchedulerTestRuntime(env);
    }
  });

  it("keeps a fingerprint-mismatched durable row separate from the live action", async () => {
    const env = createSchedulerTestRuntime(import.meta.url);
    try {
      const output = env.runtime.getCell<number>(
        space,
        "writer-lookup-mismatch-output",
        undefined,
        env.tx,
      );
      const outputLink = output.getAsNormalizedFullLink();
      const outputAddress = toMemorySpaceAddress(outputLink);
      const actionId = "writer-lookup:mismatch";
      stubDurableWriters(env.runtime, [durableWriter(
        actionId,
        outputAddress,
        { implementationFingerprint: "impl:writer-lookup:previous" },
      )]);
      registerIdentifiedWriter(
        env.runtime,
        createWriterAction(actionId, { writes: [outputLink] }),
      );

      const candidates = await writersForTargets(env.runtime, [outputAddress]);

      expect(candidates).toHaveLength(2);
      expect(
        candidates.map(({ source, implementationFingerprint }) => ({
          source,
          implementationFingerprint,
        })).toSorted((left, right) => left.source.localeCompare(right.source)),
      ).toEqual([{
        source: "durable",
        implementationFingerprint: "impl:writer-lookup:previous",
      }, {
        source: "live",
        implementationFingerprint: `impl:${actionId}`,
      }]);
    } finally {
      await disposeSchedulerTestRuntime(env);
    }
  });

  it("orders multiple live candidates by stable identity", async () => {
    const env = createSchedulerTestRuntime(import.meta.url);
    try {
      stubDurableWriters(env.runtime, []);
      const output = env.runtime.getCell<number>(
        space,
        "writer-lookup-shared-output",
        undefined,
        env.tx,
      );
      const outputLink = output.getAsNormalizedFullLink();
      for (
        const actionId of [
          "writer-lookup:z-last",
          "writer-lookup:\u{10000}",
          "writer-lookup:a-first",
          "writer-lookup:\uffff",
        ]
      ) {
        registerIdentifiedWriter(
          env.runtime,
          createWriterAction(actionId, { writes: [outputLink] }),
        );
      }

      const candidates = await writersForTargets(env.runtime, [
        toMemorySpaceAddress(outputLink),
      ]);

      expect(candidates.map((candidate) => candidate.actionId)).toEqual([
        "writer-lookup:a-first",
        "writer-lookup:z-last",
        "writer-lookup:\uffff",
        "writer-lookup:\u{10000}",
      ]);
    } finally {
      await disposeSchedulerTestRuntime(env);
    }
  });

  it("fails open for a mixed-space target set", async () => {
    const env = createSchedulerTestRuntime(import.meta.url);
    try {
      stubDurableWriters(env.runtime, []);
      const output = env.runtime.getCell<number>(
        space,
        "writer-lookup-mixed-space-output",
        undefined,
        env.tx,
      );
      const outputLink = output.getAsNormalizedFullLink();
      registerIdentifiedWriter(
        env.runtime,
        createWriterAction("writer-lookup:mixed-space", {
          writes: [outputLink],
        }),
      );

      expect(
        await writersForTargets(env.runtime, [
          toMemorySpaceAddress(outputLink),
          {
            ...toMemorySpaceAddress(outputLink),
            space: "did:key:other-space" as typeof space,
          },
        ]),
      ).toEqual([]);
    } finally {
      await disposeSchedulerTestRuntime(env);
    }
  });
});
