import { describe, expect, it } from "./scheduler-test-utils.ts";
import type { TransactionReactivityLog } from "../src/storage/interface.ts";
import {
  buildSchedulerActionObservation,
  type SchedulerActionObservation,
} from "../src/scheduler/persistent-observation.ts";

const readAddress = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:source" as const,
  path: ["value", "input"],
};

const shallowReadAddress = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:list" as const,
  path: ["value", "items"],
};

const writeAddress = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:target" as const,
  path: ["value", "output"],
};

const declaredWrite = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:declared" as const,
  path: ["value"],
};

const materializerEnvelope = {
  space: "did:key:space" as const,
  scope: "space" as const,
  id: "of:materialized" as const,
  path: ["value"],
};

describe("persistent scheduler observations", () => {
  it("builds scheduler observations without attemptedWrites", () => {
    const transactionLog: TransactionReactivityLog = {
      reads: [readAddress],
      shallowReads: [shallowReadAddress],
      writes: [writeAddress],
      attemptedWrites: [{
        space: "did:key:space" as const,
        scope: "space",
        id: "of:attempted-only" as const,
        path: ["value", "secret"],
      }],
    };

    const observation = buildSchedulerActionObservation({
      actionId: "pattern.tsx:computed:1",
      actionKind: "computation",
      branch: "",
      pieceId: "of:piece",
      processGeneration: 3,
      implementationFingerprint: "impl:v1",
      runtimeFingerprint: "runtime:test",
      observedAtSeq: 42,
      transactionKind: "action-run",
      transactionLog,
      currentKnownWrites: [writeAddress],
      declaredWrites: [declaredWrite],
      materializerWriteEnvelopes: [materializerEnvelope],
      actionOptions: {
        debounceMs: 25,
      },
    });

    expect(observation).toMatchObject(
      {
        version: 1,
        actionId: "pattern.tsx:computed:1",
        actionKind: "computation",
        observedAtSeq: 42,
        reads: [readAddress],
        shallowReads: [shallowReadAddress],
        actualChangedWrites: [writeAddress],
        currentKnownWrites: [writeAddress],
        declaredWrites: [declaredWrite],
        materializerWriteEnvelopes: [materializerEnvelope],
        actionOptions: { debounceMs: 25 },
      } satisfies Partial<SchedulerActionObservation>,
    );
    expect("attemptedWrites" in observation).toBe(false);
  });
});
