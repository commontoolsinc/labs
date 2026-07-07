/**
 * Unit coverage for the `pullSnapshot` / `snapshotValue` test helpers: they must
 * (a) reproduce the old `JSON.parse(JSON.stringify(...))` result for plain JSON,
 * (b) fully detach (rebuild a fresh container tree), and (c) preserve a fabric
 * value that `JSON.stringify` would silently corrupt to `{}`.
 */
import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { fabricFromNativeValue } from "@commonfabric/data-model/fabric-value";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { pullSnapshot, snapshotValue } from "./support/pull-snapshot.ts";

describe("pull-snapshot test helper", () => {
  it("matches the JSON round-trip for plain-JSON input", () => {
    const plain = { a: 1, b: "two", c: [3, 4, { d: true }], e: null };
    assertEquals(snapshotValue(plain), JSON.parse(JSON.stringify(plain)));
    assertEquals(snapshotValue(plain), plain);
  });

  it("fully detaches: rebuilds a fresh container tree", () => {
    const plain = { nested: { x: 1 }, list: [{ y: 2 }] };
    const snap = snapshotValue(plain) as typeof plain;
    assert(snap !== plain);
    assert(snap.nested !== plain.nested);
    assert(snap.list !== plain.list);
    assert(snap.list[0] !== plain.list[0]);
    assertEquals(snap, plain);
  });

  it("preserves a fabric value that JSON.stringify would corrupt to {}", () => {
    // The runner stores writes via `fabricFromNativeValue`; a `Uint8Array`
    // becomes a `FabricBytes` primitive that carries its bytes internally with
    // no enumerable own properties. `JSON.stringify` therefore collapses it to
    // `{}` — a silent, total loss of the payload.
    const original = {
      label: "payload",
      bytes: fabricFromNativeValue(new Uint8Array([1, 2, 3])),
    };

    // Old idiom: the fabric field is corrupted to an empty object.
    const viaJson = JSON.parse(JSON.stringify(original)) as {
      label: string;
      bytes: unknown;
    };
    assertEquals(viaJson.bytes, {});

    // Helper: the plain container is rebuilt (detached) while the fabric value
    // survives intact — the same immutable, self-contained primitive, safe to
    // keep after the runtime is disposed.
    const snap = snapshotValue(original) as { label: string; bytes: unknown };
    assert(snap !== original);
    assertEquals(snap.label, "payload");
    assert(snap.bytes instanceof FabricBytes);
    assert(snap.bytes === original.bytes);
  });

  it("pullSnapshot awaits pull() and materializes before teardown", async () => {
    let torndown = false;
    const liveView = {
      note: "hi",
      bytes: fabricFromNativeValue(new Uint8Array([9])),
    };
    const result = {
      pull(): Promise<unknown> {
        assert(!torndown, "pull() must resolve before teardown");
        return Promise.resolve(liveView);
      },
    };
    const snap = await pullSnapshot(result) as { note: string; bytes: unknown };
    torndown = true; // stand-in for `runtime.dispose()` in the test's finally
    assertEquals(snap.note, "hi");
    assert(snap.bytes instanceof FabricBytes);
  });
});
