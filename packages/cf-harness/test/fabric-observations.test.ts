/**
 * The per-runtime observer behind run_pattern's settle-window reads: piece
 * attribution through the canonical entity hash, the guard against errors
 * that arrive without a pattern frame, the exclusion of busy-window markers
 * that defer nothing, and sequence-scoped windows.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Runtime, RuntimeTelemetry } from "@commonfabric/runner";
import { fabricRuntimeObservations } from "../src/fabric-observations.ts";

type ErrorListener = (error: {
  pieceId?: string;
  patternId?: string;
  message: string;
}) => void;

// A stand-in carrying exactly the two surfaces the observer subscribes to.
const stubRuntime = (): {
  runtime: Runtime;
  emitError: ErrorListener;
  telemetry: RuntimeTelemetry;
} => {
  let listener: ErrorListener | undefined;
  const telemetry = new RuntimeTelemetry();
  const runtime = {
    scheduler: {
      onError: (fn: ErrorListener) => {
        listener = fn;
      },
    },
    telemetry,
  } as unknown as Runtime;
  return {
    runtime,
    telemetry,
    emitError: (error) => listener?.(error as Parameters<ErrorListener>[0]),
  };
};

describe("fabric-observations", () => {
  it("attributes errors through the canonical entity hash across the `of:` seam", () => {
    const { runtime, emitError } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    emitError({
      pieceId: "of:fid1:abc",
      patternId: "mod1",
      message: "boom",
    });
    expect(observations.errorsSince(start, "fid1:abc").map((e) => e.message))
      .toEqual(["boom"]);
    expect(observations.errorsSince(start, "fid1:other")).toEqual([]);
  });

  it("drops an error without a piece id rather than throwing in the handler", () => {
    const { runtime, emitError } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    emitError({ message: "frameless" });
    emitError({ pieceId: "of:fid1:abc", message: "attributed" });
    expect(observations.errorsSince(start, "fid1:abc").map((e) => e.message))
      .toEqual(["attributed"]);
  });

  it("never matches a kinded piece id against its `of:` sibling", () => {
    const { runtime, emitError } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    emitError({ pieceId: "computed:fid1:abc", message: "kinded" });
    expect(observations.errorsSince(start, "fid1:abc")).toEqual([]);
    expect(observations.errorsSince(start, "computed:fid1:abc")).toEqual([]);
  });

  it("records only convergence-budget episodes, not busy-window markers", () => {
    const { runtime, telemetry } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    telemetry.submit({
      type: "scheduler.non-settling",
      busyTime: 0,
      windowDuration: 1,
      busyRatio: 0,
    });
    telemetry.submit({
      type: "scheduler.non-settling",
      busyTime: 0,
      windowDuration: 1,
      busyRatio: 0,
      deferredActionCount: 0,
      deferredActions: [],
    });
    telemetry.submit({
      type: "scheduler.non-settling",
      busyTime: 0,
      windowDuration: 1,
      busyRatio: 0,
      deferredActions: ["cf:module/mod1:__cfLift_1:x"],
      deferredActionCount: 2,
    });
    const episodes = observations.episodesSince(start);
    expect(episodes.length).toBe(1);
    expect(episodes[0]!.deferredActionCount).toBe(2);
  });

  it("scopes reads to the window after the captured sequence", () => {
    const { runtime, emitError } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    emitError({ pieceId: "of:fid1:abc", message: "before" });
    const start = observations.sequence();
    emitError({ pieceId: "of:fid1:abc", message: "after" });
    expect(observations.errorsSince(start, "fid1:abc").map((e) => e.message))
      .toEqual(["after"]);
  });
});
