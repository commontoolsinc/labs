import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { shapableWakeGroupKey } from "../src/scheduler/invalidation.ts";
import { shaperInstanceGroupKey } from "../src/scheduler/wake-shaping.ts";

// deno-lint-ignore no-explicit-any
const anyOf = <T>(v: unknown) => v as T;

// The classifier that keys the cell-notification token bucket. Only renderer
// keystroke input is shaped; server pushes must NOT be, because deferring a
// push's mark-dirty breaks incremental observation adoption (the writer's
// observations arrive in the same synchronous turn as the integrate whose dirt
// they clear). The bucket key is space-qualified so two instances of one pattern
// in different spaces (which can share a content-addressed pieceId) do not
// collide.
describe("shapableWakeGroupKey", () => {
  const rendererInputTx = { marker: "renderer-input" };
  const state = anyOf<Parameters<typeof shapableWakeGroupKey>[0]>({
    isRendererInputSource: (source: object | undefined) =>
      source === rendererInputTx,
  });
  const identity = { ownerSpace: "did:key:zSpaceA", pieceId: "space:piece-1" };
  const instanceKey = shaperInstanceGroupKey(identity)!;
  const withPiece = anyOf<Parameters<typeof shapableWakeGroupKey>[2]>({
    schedulerObservationIdentity: identity,
  });
  const noPiece = anyOf<Parameters<typeof shapableWakeGroupKey>[2]>({});

  const notif = (type: string, source?: object) =>
    anyOf<Parameters<typeof shapableWakeGroupKey>[1]>({ type, source });

  it("routes a renderer-input commit to the pattern's |input bucket", () => {
    expect(
      shapableWakeGroupKey(state, notif("commit", rendererInputTx), withPiece),
    ).toBe(`${instanceKey}|input`);
  });

  // Deferring a server push's wake would move its mark-dirty off the sync's
  // synchronous turn, so adoptRemoteObservations would find no dirt to clear and
  // the receiver would re-run every computation the writer already ran. See
  // shapableWakeGroupKey and docs/specs/scheduler-v2/incremental-observation-adoption.md.
  it("never shapes server pushes (pull / integrate) — adoption needs them synchronous", () => {
    expect(shapableWakeGroupKey(state, notif("pull"), withPiece)).toBe(
      undefined,
    );
    expect(shapableWakeGroupKey(state, notif("integrate"), withPiece)).toBe(
      undefined,
    );
  });

  it("gives two instances in different spaces distinct buckets despite a shared pieceId", () => {
    const inSpaceB = anyOf<Parameters<typeof shapableWakeGroupKey>[2]>({
      schedulerObservationIdentity: {
        ownerSpace: "did:key:zSpaceB",
        pieceId: "space:piece-1",
      },
    });
    const keyA = shapableWakeGroupKey(
      state,
      notif("commit", rendererInputTx),
      withPiece,
    );
    const keyB = shapableWakeGroupKey(
      state,
      notif("commit", rendererInputTx),
      inSpaceB,
    );
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBeDefined();
  });

  it("does not shape an ordinary internal commit (no renderer-input mark)", () => {
    expect(
      shapableWakeGroupKey(state, notif("commit", { other: true }), withPiece),
    ).toBe(undefined);
  });

  it("does not shape a reader that is not a pattern instance (no pieceId)", () => {
    expect(shapableWakeGroupKey(state, notif("pull"), noPiece)).toBe(undefined);
    expect(
      shapableWakeGroupKey(state, notif("commit", rendererInputTx), noPiece),
    ).toBe(undefined);
  });
});
