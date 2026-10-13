import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONValue } from "@commonfabric/api";
import { deepFreeze, type FabricValue } from "@commonfabric/data-model";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { UnknownValue } from "@commonfabric/data-model/codec-common";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { valueFromDataUri } from "@commonfabric/data-model/codec-data-uri";

import {
  bindImmutableCells,
  immutableCellsFor,
  ImmutableCellStore,
  immutableSnapshot,
} from "../src/immutable-cell.ts";
import { decomposeSchema } from "../src/schema-decompose.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import { load } from "../src/storage/transaction/attestation.ts";
import { TraverseCaptureRecorder } from "../src/traverse-recorder.ts";
import { replayFixture } from "./traverse-replay/replay.ts";
import {
  dataUriFromValueWithResolvedLinks,
  findAndInlineDataUriLinks,
  immutableContentId,
  portableSnapshotId,
} from "../src/data-uri.ts";
import {
  areLinksSame,
  createSigilLinkFromParsedLink,
  parseLink,
} from "../src/link-utils.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

describe("immutable-cell", () => {
  for (const timing of ["before", "after"] as const) {
    it(`retains schema-default snapshots when their closure arrives ${timing} adoption`, () => {
      const release = acquireSchemaRegistryLease();
      const source = new ImmutableCellStore();
      const receiver = new ImmutableCellStore();
      try {
        const nested = source.create({ schemaDefault: timing });
        const schema = decomposeSchema({
          // Schema defaults carry links in either cell representation.
          default: linkRefFrom({ id: nested.id }) as JSONValue,
        });
        const register = () => {
          for (const [hash, document] of schema.documents) {
            registerSchemaDocument(hash, document);
          }
        };
        if (timing === "before") register();
        const outer = receiver.create({
          ref: linkRefFrom({
            id: "of:target",
            schema: { $ref: schema.rootRef },
          }),
        });
        immutableContentId(outer.id);
        if (timing === "after") register();
        source.dispose();
        expect(immutableSnapshot(nested.id).value).toEqual({
          schemaDefault: timing,
        });
        expect(
          areLinksSame(
            linkRefFrom({ id: outer.id }),
            linkRefFrom({ id: portableSnapshotId(outer.id) }),
          ),
        ).toBe(true);
        receiver.dispose();
        expect(() => immutableSnapshot(nested.id)).toThrow(/expired/);
      } finally {
        source.dispose();
        receiver.dispose();
        release();
      }
    });
  }

  it("keeps an expired hidden reference from interrupting other pending owners", () => {
    const release = acquireSchemaRegistryLease();
    const source = new ImmutableCellStore();
    const expired = source.create({ expiredSchemaDefault: true });
    source.dispose();
    const liveSource = new ImmutableCellStore();
    const badOwner = new ImmutableCellStore();
    const goodOwner = new ImmutableCellStore();
    try {
      const live = liveSource.create({ liveSchemaDefault: true });
      const schema = decomposeSchema({
        default: {
          bad: linkRefFrom({ id: expired.id }) as JSONValue,
          good: linkRefFrom({ id: live.id }) as JSONValue,
        },
      });
      const value = {
        ref: linkRefFrom({ id: "of:target", schema: { $ref: schema.rootRef } }),
      };
      badOwner.create(value);
      goodOwner.create(value);
      for (const [hash, document] of schema.documents) {
        registerSchemaDocument(hash, document);
      }
      liveSource.dispose();
      expect(immutableSnapshot(live.id).value).toEqual({
        liveSchemaDefault: true,
      });
    } finally {
      liveSource.dispose();
      badOwner.dispose();
      goodOwner.dispose();
      release();
    }
  });

  it("does not freeze caller-owned codec state while rewriting links", () => {
    const cause = {
      kept: { mutable: true },
      ref: linkRefFrom({ path: ["target"] }),
    };
    const failure = new FabricError({
      type: "Error",
      message: "boom",
      stack: undefined,
      cause,
      extras: undefined,
    });
    dataUriFromValueWithResolvedLinks(failure, { id: "of:origin", path: [] });
    expect(Object.isFrozen(cause.kept)).toBe(false);
    cause.kept.mutable = false;
    expect(cause.kept.mutable).toBe(false);
  });

  it("retains snapshots in codec state and schema defaults", () => {
    const source = new ImmutableCellStore();
    const receiver = new ImmutableCellStore();
    const nested = source.create({ n: 9 });
    const ref = linkRefFrom({ id: nested.id });
    const outer = receiver.create({
      carried: new UnknownValue("SnapshotFixture@1", deepFreeze({ ref })),
      link: linkRefFrom({ id: "of:target", schema: { default: ref } }),
    });
    source.dispose();
    try {
      expect(valueFromDataUri(portableSnapshotId(outer.id))).toBeDefined();
      expect(immutableSnapshot(nested.id).value).toEqual({ n: 9 });
    } finally {
      receiver.dispose();
    }
    expect(() => immutableSnapshot(nested.id)).toThrow(/expired/);
  });

  it("compares native and portable content transitively without losing relative origins", () => {
    const store = new ImmutableCellStore();
    try {
      const baseA = {
        id: "of:a" as const,
        space: "did:key:test" as const,
        path: [],
      };
      const baseB = { ...baseA, id: "of:b" as const };
      const a = store.create({ n: 1 }, baseA);
      const b = store.create({ n: 1 }, baseB);
      const link = (id: typeof a.id) => linkRefFrom({ id });
      const portable = link(portableSnapshotId(a.id));
      expect(areLinksSame(link(a.id), portable)).toBe(true);
      expect(areLinksSame(link(b.id), portable)).toBe(true);
      expect(areLinksSame(link(a.id), link(b.id))).toBe(true);
      const relative = linkRefFrom({ path: ["target"] });
      const relativeA = store.create({ relative }, baseA);
      const relativeB = store.create({ relative }, baseB);
      expect(areLinksSame(link(relativeA.id), link(relativeB.id))).toBe(false);
      expect(
        areLinksSame(
          link(relativeA.id),
          link(portableSnapshotId(relativeA.id)),
        ),
      ).toBe(true);
    } finally {
      store.dispose();
    }
  });

  it("retains a native relative origin without an explicit snapshot link", () => {
    const source = new ImmutableCellStore();
    const receiver = new ImmutableCellStore();
    const parent = source.create({ target: 8 });
    const child = receiver.create({ ref: linkRefFrom({ path: ["target"] }) }, {
      id: parent.id,
      path: [],
    });
    source.dispose();
    try {
      expect(findAndInlineDataUriLinks(linkRefFrom({ id: child.id }))).toEqual({
        ref: 8,
      });
    } finally {
      receiver.dispose();
    }
  });

  it("retains nested snapshots after their original store is disposed", () => {
    const source = new ImmutableCellStore();
    const receiver = new ImmutableCellStore();
    const inner = source.create({ count: 7 });
    const outer = receiver.create({ child: linkRefFrom({ id: inner.id }) });
    source.dispose();
    try {
      expect(findAndInlineDataUriLinks(linkRefFrom({ id: outer.id })))
        .toEqual({ child: { count: 7 } });
      expect(valueFromDataUri(portableSnapshotId(outer.id))).toBeDefined();
    } finally {
      receiver.dispose();
    }
    expect(() => immutableSnapshot(inner.id)).toThrow(/expired/);
  });

  it("reports an expired snapshot as a transaction error", () => {
    const store = new ImmutableCellStore();
    const snapshot = store.create({ expired: true });
    store.dispose();
    const result = load({
      id: snapshot.id,
      type: "application/json",
    });
    expect(result.error).toBeDefined();
  });

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
