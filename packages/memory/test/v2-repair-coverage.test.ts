import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";

import {
  type ClientCommit,
  type EntityDocument,
  type Operation,
  ProtocolError,
  type SessionSync,
  toDocumentPath,
} from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import { WatchView } from "../v2/client.ts";
import { createDocumentSnapshotReader, toDirtyKey } from "../v2/query.ts";
import { RepairCoverage } from "../v2/repair-coverage.ts";
import {
  cacheKeyForEntity,
  isEmptySync,
  type SessionCacheEntry,
} from "../v2/server-sync.ts";
import {
  compressSessionSyncSchemas,
  expandSessionSyncSchemas,
} from "../v2/sync-schema-table.ts";

const SPACE = "did:key:repair-space";
const IDENTITY = {
  principal: "did:key:repair-user",
  sessionId: "repair-session",
};

function commitFor(
  localSeq: number,
  ids: string[],
  scope: "space" | "user" | "session" = "space",
): ClientCommit {
  return {
    localSeq,
    reads: {
      confirmed: ids.map((id) => ({
        id,
        scope,
        path: toDocumentPath([]),
        seq: 0,
      })),
      pending: [],
    },
    operations: [],
  };
}

describe("transaction repair coverage", () => {
  let engine: Engine.Engine;
  let coverage: RepairCoverage;
  let seedSeq: number;

  beforeEach(async () => {
    engine = await Engine.open({ url: new URL("memory://repair-coverage") });
    coverage = new RepairCoverage(SPACE, IDENTITY);
    seedSeq = 0;
  });

  afterEach(() => Engine.close(engine));

  function write(operations: Operation[], branch = "") {
    return Engine.applyCommit(engine, {
      sessionId: IDENTITY.sessionId,
      principal: IDENTITY.principal,
      commit: {
        localSeq: ++seedSeq,
        branch,
        reads: { confirmed: [], pending: [] },
        operations,
      },
    });
  }

  function emptySync(): SessionSync {
    return {
      type: "sync",
      fromSeq: 0,
      toSeq: Engine.serverSeq(engine),
      upserts: [],
      removes: [],
    };
  }

  function prepare(
    sync = emptySync(),
    graphs = new Map<string, SessionCacheEntry>(),
  ) {
    return coverage.prepare(
      createDocumentSnapshotReader(SPACE, engine, IDENTITY),
      sync,
      graphs,
    );
  }

  function set(
    id: string,
    value: EntityDocument["value"],
    scope: "space" | "user" | "session" = "space",
  ): Operation {
    return { op: "set", id, scope, value: { value } };
  }

  it("delivers an unwatched user instance despite a space link pointing elsewhere", () => {
    write([
      set("of:output", { "/": { "link@1": { id: "of:alternate", path: [] } } }),
      set("of:output", null, "user"),
      set("of:alternate", "alternate value"),
    ]);
    const rejected = commitFor(10, ["of:output"], "user");
    rejected.operations.push(set("of:output", null));
    coverage.register(rejected, 1);
    const frame = prepare();
    expect(frame.sync.upserts.map((doc) => [doc.id, doc.scope])).toEqual([
      ["of:output", "space"],
      ["of:output", "user"],
    ]);
    expect(frame.sync.repairs).toEqual([{
      localSeq: 10,
      atSeq: 1,
      documents: [
        { branch: "", id: "of:output", scope: "space", seq: 1 },
        { branch: "", id: "of:output", scope: "user", seq: 1 },
      ],
      schemas: [],
    }]);
    expect(frame.sync.upserts.find((doc) => doc.scope === "user")?.doc).toEqual(
      { value: null },
    );
    expect(coverage.size).toBe(1);
  });

  it("distinguishes never-created absence from a durable tombstone", () => {
    write([set("of:deleted", "old")]);
    write([{ op: "delete", id: "of:deleted" }]);
    coverage.register(commitFor(10, ["of:absent", "of:deleted"]), 2);
    const sync = prepare().sync;
    expect(sync.repairs?.[0].documents).toEqual([
      { branch: "", id: "of:absent", scope: "space", seq: 0, deleted: true },
      { branch: "", id: "of:deleted", scope: "space", seq: 2, deleted: true },
    ]);
    expect(sync.upserts.every((entry) => entry.deleted)).toBe(true);
  });

  it("keeps document versions from different branches distinct", () => {
    write([set("of:shared", "main")]);
    Engine.createBranch(engine, "other");
    write([set("of:shared", "other")], "other");
    const commit = commitFor(10, ["of:shared"]);
    commit.reads.confirmed.push({
      id: "of:shared",
      branch: "other",
      path: toDocumentPath([]),
      seq: 0,
    });
    coverage.register(commit, 2);
    expect(prepare().sync.upserts.map((doc) => [doc.branch, doc.doc?.value]))
      .toEqual([
        ["", "main"],
        ["other", "other"],
      ]);
  });

  it("pins document and schema reads to one captured server cut", () => {
    write([set("of:doc", "before")]);
    const reader = createDocumentSnapshotReader(SPACE, engine, IDENTITY);
    write([set("of:doc", "after")]);
    const result = reader.read([{ branch: "", id: "of:doc" }]);
    expect(reader.atSeq).toBe(1);
    expect(result.documents[0].document).toEqual({ value: "before" });
    expect(result.documents[0].seq).toBe(1);
  });

  it("includes the verified transitive schema closure without following its value target", () => {
    const leaf = { type: "string", title: "repair-leaf" } as const;
    const leafHash = internSchemaAsTaggedHashString(leaf);
    const root = {
      type: "object",
      properties: { x: { $ref: `cid:${leafHash}` } },
    } as const;
    const rootHash = internSchemaAsTaggedHashString(root);
    write([
      set(`cid:${leafHash}`, leaf),
      set(`cid:${rootHash}`, root),
      set("of:carrier", {
        "/": {
          "link@1": {
            id: "of:target",
            path: [],
            schema: { $ref: `cid:${rootHash}` },
          },
        },
      }),
      set("of:target", "unread"),
    ]);
    coverage.register(commitFor(10, ["of:carrier"]), 1);
    const sync = prepare().sync;
    expect(sync.repairs?.[0].documents.map((entry) => entry.id)).toEqual([
      "of:carrier",
    ]);
    expect(sync.repairs?.[0].schemas.map((entry) => entry.id).sort()).toEqual(
      [`cid:${leafHash}`, `cid:${rootHash}`].sort(),
    );
    expect(sync.upserts.map((entry) => entry.id).sort()).toEqual(
      ["of:carrier", `cid:${leafHash}`, `cid:${rootHash}`].sort(),
    );
  });

  it("isolates a corrupt schema closure without publishing a partial repair", () => {
    const schema = { type: "string", title: "repair-corruption" } as const;
    const hash = internSchemaAsTaggedHashString(schema);
    write([
      set(`cid:${hash}`, schema),
      set("of:carrier", {
        "/": {
          "link@1": {
            id: "of:target",
            path: [],
            schema: { $ref: `cid:${hash}` },
          },
        },
      }),
      set("of:valid", "valid"),
    ]);
    // The commit API preserves schema closures. Removing the stored head
    // directly models corruption despite a warm process schema registry.
    engine.database.prepare("DELETE FROM head WHERE id = :id").run({
      id: `cid:${hash}`,
    });
    coverage.register(commitFor(10, ["of:carrier"]), 1);
    coverage.register(commitFor(11, ["of:valid"]), 1);
    const frame = prepare();
    expect(frame.sync.repairFailures).toEqual([{
      localSeq: 10,
      reason: "invalid-schema",
    }]);
    expect(frame.sync.repairs?.map((receipt) => receipt.localSeq)).toEqual([
      11,
    ]);
    expect(frame.sync.upserts.map((entry) => entry.id)).toEqual(["of:valid"]);
    frame.commit();
    expect(coverage.size).toBe(1);
  });

  it("rejects readers for another space or logical identity", () => {
    coverage.register(commitFor(10, ["of:doc"]), 0);
    for (
      const reader of [
        createDocumentSnapshotReader("did:key:other-space", engine, IDENTITY),
        createDocumentSnapshotReader(SPACE, engine, {
          ...IDENTITY,
          sessionId: "other-session",
        }),
        createDocumentSnapshotReader(SPACE, engine, {
          ...IDENTITY,
          principal: "did:key:other-user",
        }),
      ]
    ) {
      expect(() => coverage.prepare(reader, emptySync(), new Map())).toThrow(
        ProtocolError,
      );
    }
  });

  it("delivers shared bases once while retaining separate receipt identities", () => {
    write([set("of:shared", "value")]);
    coverage.register(commitFor(10, ["of:shared"]), 1);
    coverage.register(commitFor(12, ["of:shared"]), 1);
    const frame = prepare();
    expect(frame.sync.upserts).toHaveLength(1);
    expect(frame.sync.repairs?.map((receipt) => receipt.localSeq)).toEqual([
      10,
      12,
    ]);
    frame.commit();
    coverage.release(10);
    expect(coverage.needsSync(new Set())).toBe(true);
    const retained = prepare();
    expect(retained.sync.removes).toEqual([]);
    retained.commit();
    expect(coverage.size).toBe(1);
    coverage.release(12);
    const released = prepare();
    expect(released.sync.removes).toEqual([{
      branch: "",
      id: "of:shared",
      scope: "space",
    }]);
    released.commit();
    expect(coverage.size).toBe(0);
    expect(coverage.needsSync(new Set())).toBe(false);
  });

  it("forces first-delivery snapshots even when the graph cache remembers them", () => {
    write([set("of:shared", "value")]);
    const entry: SessionCacheEntry = {
      branch: "",
      id: "of:shared",
      scope: "space",
      scopeKey: "space",
      seq: 1,
      doc: { value: "value" },
    };
    const graphs = new Map([[cacheKeyForEntity("", entry.id), entry]]);
    coverage.register(commitFor(10, [entry.id]), 1);
    const frame = prepare(emptySync(), graphs);
    expect(frame.sync.upserts).toHaveLength(1);
    expect(graphs.size).toBe(1);
    frame.commit();
    coverage.release(10);
    expect(prepare(emptySync(), graphs).sync.removes).toEqual([]);
  });

  it("preserves repair ownership across ordinary watch removal", () => {
    write([set("of:shared", "value")]);
    coverage.register(commitFor(10, ["of:shared"]), 1);
    prepare().commit();
    const sync = emptySync();
    sync.removes.push({ branch: "", id: "of:shared", scope: "space" });
    expect(prepare(sync).sync.removes).toEqual([]);
    expect(coverage.size).toBe(1);
  });

  it("retains live wake coverage after delivering its receipt", () => {
    write([set("of:shared", "before")]);
    coverage.register(commitFor(10, ["of:shared"]), 1);
    prepare().commit();
    expect(coverage.needsSync(new Set([toDirtyKey("of:unrelated")]))).toBe(
      false,
    );
    expect(coverage.needsSync(new Set([toDirtyKey("of:shared")]))).toBe(true);
    write([set("of:shared", "after")]);
    const frame = prepare();
    expect(frame.sync.upserts[0].doc).toEqual({ value: "after" });
    expect(frame.sync.repairs).toBeUndefined();
    expect(coverage.size).toBe(1);
  });

  it("restages complete delivery when a rejected submission is replayed", () => {
    write([set("of:shared", "value")]);
    const commit = commitFor(10, ["of:shared"]);
    coverage.register(commit, 1);
    prepare().commit();
    expect(prepare().sync.upserts).toEqual([]);
    coverage.register(commit, 1);
    const replay = prepare();
    expect(replay.sync.upserts).toHaveLength(1);
    expect(replay.sync.repairs?.[0].localSeq).toBe(10);
  });

  it("retries a discarded frame with its complete receipts and bases", () => {
    write([set("of:shared", "value")]);
    coverage.register(commitFor(10, ["of:shared"]), 1);
    const dropped = prepare();
    const retry = prepare();
    expect(retry.sync).toEqual(dropped.sync);
    retry.commit();
    retry.commit();
    expect(prepare().sync.repairs).toBeUndefined();
  });

  it("refuses to commit a prepared frame after its ownership changes", () => {
    coverage.register(commitFor(10, ["of:absent"]), 0);
    const frame = prepare();
    coverage.release(10);
    expect(() => frame.commit()).toThrow(ProtocolError);
    expect(coverage.size).toBe(0);
  });

  it("refuses reused rejection identities with different dependencies", () => {
    coverage.register(commitFor(10, ["of:first"]), 0);
    expect(() => coverage.register(commitFor(10, ["of:second"]), 0)).toThrow(
      ProtocolError,
    );
  });

  it("rejects a cut older than rejection and mismatched graph cuts", () => {
    coverage.register(commitFor(10, ["of:absent"]), 1);
    expect(() => prepare()).toThrow(ProtocolError);
    write([set("of:doc", null)]);
    const sync = emptySync();
    sync.toSeq = 0;
    expect(() => prepare(sync)).toThrow(ProtocolError);
  });

  it("reports an unreadable branch without claiming the other repair failed", () => {
    const invalid = commitFor(10, ["of:missing"]);
    invalid.branch = "missing-branch";
    coverage.register(invalid, 0);
    coverage.register(commitFor(11, ["of:absent"]), 0);
    const frame = prepare();
    expect(frame.sync.repairFailures).toEqual([{
      localSeq: 10,
      reason: "unresolvable-address",
    }]);
    expect(frame.sync.repairs?.map((receipt) => receipt.localSeq)).toEqual([
      11,
    ]);
    frame.commit();
    expect(coverage.size).toBe(1);
  });

  it("reports an unresolvable user instance instead of substituting space data", () => {
    const anonymous = new RepairCoverage(SPACE, {});
    anonymous.register(commitFor(10, ["of:doc"], "user"), 0);
    const frame = anonymous.prepare(
      createDocumentSnapshotReader(SPACE, engine, {}),
      emptySync(),
      new Map(),
    );
    expect(frame.sync.repairFailures).toEqual([{
      localSeq: 10,
      reason: "unresolvable-address",
    }]);
    expect(frame.sync.repairs).toBeUndefined();
    expect(frame.sync.upserts).toEqual([]);
  });

  it("reports unsupported non-document recovery instead of an empty successful receipt", () => {
    coverage.register(commitFor(10, []), 0);
    const frame = prepare();
    expect(frame.sync.repairFailures).toEqual([{
      localSeq: 10,
      reason: "unsupported-dependency",
    }]);
    expect(frame.sync.repairs).toBeUndefined();
    expect(isEmptySync(frame.sync)).toBe(false);
    frame.commit();
    expect(coverage.size).toBe(0);
  });

  it("preserves receipt and failure fields through schema-table and watch-view delivery", async () => {
    const sync: SessionSync = {
      ...emptySync(),
      repairs: [{
        localSeq: 10,
        atSeq: 0,
        documents: [{
          branch: "",
          id: "of:absent",
          scope: "space",
          seq: 0,
          deleted: true,
        }],
        schemas: [],
      }],
      repairFailures: [{ localSeq: 11, reason: "unsupported-dependency" }],
    };
    expect(isEmptySync({ ...emptySync(), repairs: sync.repairs })).toBe(false);
    sync.upserts.push({
      branch: "",
      id: "of:watched",
      seq: 0,
      doc: {
        value: {
          "/": {
            "link@1": { id: "of:target", path: [], schema: { type: "string" } },
          },
        },
      },
    });
    const compressed = compressSessionSyncSchemas(sync);
    expect(compressed).not.toBe(sync);
    const roundTrip = expandSessionSyncSchemas(compressed);
    expect(roundTrip).toEqual(sync);
    expect(isEmptySync(roundTrip)).toBe(false);
    const view = WatchView.fromSync(emptySync());
    const subscription = view.subscribeSync();
    const delivered = subscription.next();
    view.applySync(roundTrip, true);
    expect((await delivered).value).toEqual(sync);
    await subscription.return?.();
  });
});
