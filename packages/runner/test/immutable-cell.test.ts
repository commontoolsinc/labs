import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { deepFreeze, type FabricValue } from "@commonfabric/data-model";
import { UnknownValue } from "@commonfabric/data-model/codec-common";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { valueFromDataUri } from "@commonfabric/data-model/codec-data-uri";

import {
  bindImmutableCells,
  immutableCellsFor,
  ImmutableCellStore,
  immutableSnapshot,
} from "../src/immutable-cell.ts";
import { TraverseCaptureRecorder } from "../src/traverse-recorder.ts";
import { replayFixture } from "./traverse-replay/replay.ts";
import {
  findAndInlineDataUriLinks,
  portableSnapshotId,
} from "../src/data-uri.ts";
import { createSigilLinkFromParsedLink, parseLink } from "../src/link-utils.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

describe("immutable-cell", () => {
  it("rejects frozen cycles before registering a snapshot", () => {
    const store = new ImmutableCellStore();
    const value: Record<string, FabricValue> = {};
    value.self = value;
    try {
      expect(() => store.create(deepFreeze(value))).toThrow(/cyclic/);
    } finally {
      store.dispose();
    }
  });
  it("shares a frozen graph and keeps its identifier bounded", () => {
    const store = new ImmutableCellStore();
    try {
      const value = deepFreeze({ text: "x".repeat(1_000_000) });
      const snapshot = store.create(value);
      expect(snapshot.value).toBe(value);
      expect(snapshot.id.length).toBeLessThan(100);
      expect(immutableSnapshot(snapshot.id)).toBe(snapshot);
      expect(store.create(value)).toBe(snapshot);
    } finally {
      store.dispose();
    }
  });

  it("isolates mutable input while sharing frozen children", () => {
    const store = new ImmutableCellStore();
    try {
      const child = deepFreeze({ n: 1 });
      const input = { child, n: 2 };
      const snapshot = store.create(input);
      input.n = 3;
      expect(snapshot.value).toEqual({ child, n: 2 });
      expect(Object.isFrozen(input)).toBe(false);
      expect(Object.isFrozen(snapshot.value)).toBe(true);
      expect(snapshot.value).toHaveProperty("child", child);
      expect((snapshot.value as { child: unknown }).child).toBe(child);
      expect(findAndInlineDataUriLinks(linkRefFrom({ id: snapshot.id })))
        .toEqual({ child, n: 2 });
    } finally {
      store.dispose();
    }
  });

  it("deduplicates equal content regardless of object key order", () => {
    const store = new ImmutableCellStore();
    try {
      expect(store.create({ a: 1, b: 2 }).id)
        .toBe(store.create({ b: 2, a: 1 }).id);
      expect(store.create(-0).id).not.toBe(store.create(0).id);
    } finally {
      store.dispose();
    }
  });

  it("resolves links at their saved origin and expands them on export", () => {
    const store = new ImmutableCellStore();
    try {
      const link = linkRefFrom({ path: ["target"] });
      const value = deepFreeze({ link });
      const base = {
        id: "of:source",
        path: ["rows", "0"],
        scope: "user",
      } as const;
      const snapshot = store.create(value, base);
      expect(snapshot.value).toBe(value);
      expect(parseLink(link, { id: snapshot.id, path: ["link"] }))
        .toMatchObject({ id: "of:source", path: ["target"], scope: "user" });
      const expanded = findAndInlineDataUriLinks(
        linkRefFrom({ id: snapshot.id }),
      );
      expect(parseLink(expanded.link)).toMatchObject({
        id: "of:source",
        path: ["target"],
        scope: "user",
      });
      expect(store.create(value, { ...base, path: ["rows", "1"] }).id)
        .toBe(snapshot.id);
      expect(store.create(value, { ...base, id: "of:other" }).id)
        .not.toBe(snapshot.id);
    } finally {
      store.dispose();
    }
  });

  it("keeps nested snapshots rooted in the original document", () => {
    const store = new ImmutableCellStore();
    try {
      const value = deepFreeze({
        child: { link: linkRefFrom({ path: ["x"] }) },
      });
      const parent = store.create(value, { id: "of:source", path: [] });
      const child = store.create(value.child, {
        id: parent.id,
        path: ["child"],
      });
      expect(parseLink(value.child.link, { id: child.id, path: ["link"] }).id)
        .toBe("of:source");
    } finally {
      store.dispose();
    }
  });

  it("expands snapshot links inside carried instance state", () => {
    const store = new ImmutableCellStore();
    try {
      const inner = store.create({ answer: 42 });
      const wrapped = new UnknownValue(
        "SnapshotFixture@1",
        deepFreeze({
          link: linkRefFrom({ id: inner.id }),
        }),
      );
      const outer = store.create({ wrapped });
      const expanded = findAndInlineDataUriLinks(linkRefFrom({ id: outer.id }));
      expect(expanded.wrapped).toBeInstanceOf(UnknownValue);
      expect(expanded.wrapped.state).toEqual({ link: { answer: 42 } });
      expect(wrapped.state).toEqual({ link: linkRefFrom({ id: inner.id }) });
    } finally {
      store.dispose();
    }
  });

  it("captures a portable invocation that replays after the owner is disposed", () => {
    const store = new ImmutableCellStore();
    const recorder = new TraverseCaptureRecorder();
    const snapshot = store.create({ n: 17 });
    const address = {
      id: snapshot.id,
      space: "did:key:fixture",
      path: ["value"],
    } as const;
    recorder.recordInvocation(
      { address },
      { path: ["value"], schema: true },
      undefined,
      { traverseCells: false },
      undefined,
    );
    const fixture = recorder.toFixture("native snapshot", "unit test");
    store.dispose();
    expect(fixture.invocations[0].address.id.startsWith("data:")).toBe(true);
    const replay = replayFixture(fixture, { collectOracle: true });
    expect(replay.oracle!.invocations[0]).toMatchObject({ ok: true });
  });

  it("expands and captures snapshot links held in link schema defaults", () => {
    const store = new ImmutableCellStore();
    const inner = store.create({ answer: 42 });
    const link = linkRefFrom({
      id: "of:target",
      schema: { default: linkRefFrom({ id: inner.id }) },
    });
    const referenced = createSigilLinkFromParsedLink({
      id: "of:target",
      path: [],
      schema: parseLink(link)!.schema,
    }, { includeSchema: true });
    const outer = store.create({ link, again: link, referenced });
    const expanded = findAndInlineDataUriLinks(linkRefFrom({ id: outer.id }));
    const portable = portableSnapshotId(outer.id);
    store.dispose();
    expect(parseLink(expanded.link)!.id).toBe("of:target");
    expect(parseLink(expanded.link)!.schema).toEqual({
      default: { answer: 42 },
    });
    expect(parseLink(expanded.referenced)!.schema).toEqual({
      default: { answer: 42 },
    });
    const decoded = valueFromDataUri(portable) as {
      link: typeof link;
      again: typeof link;
    };
    const schema = parseLink(decoded.link)!.schema as { default: typeof link };
    const capturedId = parseLink(schema.default)!.id!;
    expect(capturedId.startsWith("data:")).toBe(true);
    expect(valueFromDataUri(capturedId)).toEqual({ answer: 42 });
    expect(decoded.link).toEqual(decoded.again);
  });

  it("keeps capture transactions in their owner's snapshot store", () => {
    const store = new ImmutableCellStore();
    const tx = {} as IExtendedStorageTransaction;
    bindImmutableCells(tx, store);
    const wrapped = new TraverseCaptureRecorder().wrapTx(tx);
    const snapshot = immutableCellsFor(wrapped).create({ n: 1 });
    expect(immutableCellsFor(wrapped)).toBe(store);
    store.dispose();
    expect(() => immutableSnapshot(snapshot.id)).toThrow("expired");
  });

  it("keeps equal content stable across live runtimes and releases the last owner", () => {
    const first = new ImmutableCellStore();
    const second = new ImmutableCellStore();
    const a = first.create({ shared: 42 });
    const b = second.create({ shared: 42 });
    expect(b.id).toBe(a.id);
    first.dispose();
    expect(immutableSnapshot(b.id).value).toEqual({ shared: 42 });
    second.dispose();
    expect(() => immutableSnapshot(b.id)).toThrow("expired");
  });

  it("invalidates all identifiers when their runtime store is disposed", () => {
    const store = new ImmutableCellStore();
    const { id } = store.create({ n: 1 });
    store.dispose();
    expect(() => immutableSnapshot(id)).toThrow("expired");
    expect(() => store.create({ n: 2 })).toThrow("disposed");
  });
});
