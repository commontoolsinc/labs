/** Exercises CellHandle capability adaptation, including scoped resources. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import {
  $conn,
  $onCellUpdate,
  CellHandle,
  type CellRef,
  RequestType,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import {
  createCellContextBridge,
  resolveCellContextBridge,
} from "./cell-bridge.ts";

describe("cf-iframe cell bridge", () => {
  const ref: CellRef = {
    id: "of:context" as CellRef["id"],
    space: "did:key:test" as CellRef["space"],
    scope: "space",
    path: [],
    schema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Shared counter" },
        locked: {
          type: "string",
          asCell: ["readonly"],
          description: "Read-only value",
        },
        events: {
          type: "object",
          asCell: ["stream"],
          description: "Application events",
        },
        database: {
          type: "object",
          asCell: ["sqlite"],
          description: "Notes database",
        },
      },
    },
  };

  it("turns context properties into described cell capabilities", async () => {
    const requests: unknown[] = [];
    const runtime = {
      [$conn]: () => ({
        request: (request: { type: RequestType }) => {
          requests.push(request);
          if (request.type === RequestType.CellGet) {
            return Promise.resolve({ value: 2 });
          }
          return Promise.resolve({});
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const context = new CellHandle(runtime, ref, {
      count: 1,
      database: { id: "db-1" },
    });

    const bridge = createCellContextBridge(context);
    const count = bridge.resources.count;
    expect(count.kind).toBe("cell");
    expect(count.description).toBe("Shared counter");
    await expect(count.read!()).resolves.toBe(2);
    await count.write!(3);
    expect(requests).toEqual([{
      type: RequestType.CellGet,
      cell: {
        ...ref,
        path: ["count"],
        schema: { type: "number", description: "Shared counter" },
      },
    }, {
      type: RequestType.CellSet,
      cell: {
        ...ref,
        path: ["count"],
        schema: { type: "number", description: "Shared counter" },
      },
      value: 3,
      awaitCommit: true,
    }]);
  });

  it("adapts plain object properties without a runtime connection", async () => {
    const runtime = {
      [$conn]: () => ({
        request: () => Promise.reject(new Error("request should not be used")),
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const linked = new CellHandle(runtime, ref);
    const marker = new Date(0);
    const context = {
      count: 1,
      nested: { linked },
      marker,
    };

    const bridge = createCellContextBridge(context);

    expect(Object.keys(bridge.resources)).toEqual([
      "count",
      "nested",
      "marker",
    ]);
    expect(bridge.resources.nested.read!()).toEqual({
      linked: linked.toJSON(),
    });
    expect(bridge.resources.marker.read!()).toBe(marker);
    await bridge.resources.count.write!(2);
    expect(context.count).toBe(2);
  });

  it("discovers context properties that materialize after bridge creation", async () => {
    const requests: unknown[] = [];
    const runtime = {
      [$conn]: () => ({
        request: (request: { type: RequestType }) => {
          requests.push(request);
          return Promise.resolve({});
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const lateRef: CellRef = {
      ...ref,
      schema: { type: "object" },
    };
    const context = new CellHandle<Record<string, unknown>>(
      runtime,
      lateRef,
      {},
    );
    const bridge = createCellContextBridge(context);

    expect(Object.keys(bridge.resources)).toEqual([]);
    await context.setStrict({ command: "" });
    context[$onCellUpdate]({ command: "" });

    expect(Object.keys(bridge.resources)).toEqual(["command"]);
    expect(bridge.resources.missing).toBeUndefined();
    expect(bridge.resources.constructor).toBeUndefined();
    expect(bridge.resources.__proto__).toBeUndefined();
    expect(
      Object.getOwnPropertyDescriptor(
        bridge.resources,
        Symbol.iterator,
      ),
    ).toBeUndefined();
    const command = bridge.resources.command;
    expect(command.kind).toBe("cell");
    await command.write!("next");
    const write = requests.at(-1) as {
      type: RequestType;
      cell: CellRef;
      value: unknown;
    };
    expect(write.type).toBe(RequestType.CellSet);
    expect(write.cell.path).toEqual(["command"]);
    expect(write.value).toBe("next");
  });

  it("resolves sparse scoped aliases before exposing resources", async () => {
    const requests: Array<{ type: RequestType; cell: CellRef }> = [];
    const resolved = {
      command: {
        scope: "session" as const,
        schema: { type: "string" },
      },
      database: {
        scope: "space" as const,
        schema: { type: "object", properties: {} },
      },
    };
    const databaseSchema = { $ref: "cid:fid1:sqlite-schema" };
    const runtime = {
      [$conn]: () => ({
        request: (request: { type: RequestType; cell: CellRef }) => {
          requests.push(request);
          if (request.type === RequestType.CellGet) {
            return Promise.resolve({
              value: {
                command: undefined,
                database: {
                  id: "fid1:database",
                  tables: { notes: { type: "object" } },
                  scope: "space",
                },
              },
            });
          }
          if (request.type === RequestType.CellPull) {
            return Promise.resolve({
              value: request.cell.path[0] === "database" ||
                  request.cell.id === "of:database"
                ? {
                  id: "fid1:database",
                  tables: { notes: { type: "object" } },
                  scope: "space",
                }
                : undefined,
            });
          }
          if (request.type === RequestType.SqliteQuery) {
            return Promise.resolve({ rows: [] });
          }
          if (request.type === RequestType.CellResolveAsCell) {
            if (request.cell.path.length === 0) {
              return Promise.resolve({
                cell: {
                  ...request.cell,
                  id: "of:resolved-context",
                  schema: {
                    type: "object",
                    properties: {
                      command: resolved.command.schema,
                      database: databaseSchema,
                    },
                  },
                },
              });
            }
            const name = request.cell.path[0] as keyof typeof resolved;
            return Promise.resolve({
              cell: {
                ...request.cell,
                id: `of:${name}`,
                scope: resolved[name].scope,
                path: [],
                schema: resolved[name].schema,
              },
            });
          }
          return Promise.resolve({});
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const context = new CellHandle<Record<string, unknown>>(runtime, {
      ...ref,
      schema: true,
    });

    const bridge = await resolveCellContextBridge(context, {
      database: "sqlite",
    });

    expect(Object.keys(bridge.resources)).toEqual(["command", "database"]);
    expect(bridge.resources.command.kind).toBe("cell");
    expect(bridge.resources.database.kind).toBe("sqlite");
    await expect(
      bridge.resources.database.methods!.query({ sql: "SELECT 1" }),
    ).resolves.toEqual({ rows: [] });
    expect(
      requests.filter(({ type }) => type === RequestType.CellPull).map(
        ({ cell }) => cell.path,
      ),
    ).toEqual([["database"], ["database"], []]);
    expect(
      requests.filter(({ type, cell }) =>
        type === RequestType.CellResolveAsCell && cell.path.length > 0
      ).map(({ cell }) => ({
        path: cell.path,
        scope: cell.scope,
        schema: cell.schema,
      })),
    ).toEqual([
      { path: ["command"], scope: "space", schema: undefined },
      {
        path: ["database"],
        scope: "space",
        schema: undefined,
      },
      {
        path: ["database"],
        scope: "space",
        schema: undefined,
      },
    ]);
  });

  it("demands a lazy scoped SQLite handle before its first query", async () => {
    const subscriptions: CellRef[] = [];
    const databaseValue = {
      id: "fid1:user-database",
      scope: "user",
      owner: "did:key:user",
      tables: {},
    };
    let materialized = false;
    let retargeted = false;
    let sqliteQueries = 0;
    const runtime = {
      [$conn]: () => ({
        request: (request: { type: RequestType; cell: CellRef }) => {
          if (request.type === RequestType.CellGet) {
            return Promise.resolve({ value: { database: undefined } });
          }
          if (request.type === RequestType.CellPull) {
            return Promise.resolve({
              value: materialized && request.cell.id === "of:user-database"
                ? databaseValue
                : undefined,
            });
          }
          if (request.type === RequestType.CellResolveAsCell) {
            return Promise.resolve({
              cell: request.cell.path.length === 0
                ? {
                  ...request.cell,
                  id: "of:resolved-context",
                  schema: {
                    type: "object",
                    properties: {
                      database: { type: "object", properties: {} },
                    },
                  },
                }
                : {
                  ...request.cell,
                  id: retargeted
                    ? "of:other-user-database"
                    : "of:user-database",
                  scope: "user",
                  path: [],
                  schema: { type: "object", properties: {} },
                },
            });
          }
          if (request.type === RequestType.SqliteQuery) {
            sqliteQueries++;
            if (!materialized) {
              return Promise.reject(
                new TypeError(
                  "SQLite operations require a valid SqliteDb cell handle.",
                ),
              );
            }
            return Promise.resolve({ rows: [] });
          }
          return Promise.resolve({});
        },
        subscribe: (cell: CellHandle<unknown>) => {
          subscriptions.push(cell.ref());
          if (cell.ref().path[0] === "database") {
            queueMicrotask(() => {
              materialized = true;
              cell[$onCellUpdate](databaseValue);
            });
          }
          return Promise.resolve();
        },
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const context = new CellHandle<Record<string, unknown>>(runtime, {
      ...ref,
      schema: true,
    });

    const bridge = await resolveCellContextBridge(context, {
      database: "sqlite",
    });

    await expect(
      bridge.resources.database.methods!.query({ sql: "SELECT 1" }),
    ).resolves.toEqual({ rows: [] });
    expect(subscriptions.map(({ path }) => path)).toContainEqual(["database"]);
    retargeted = true;
    await expect(
      bridge.resources.database.methods!.query({ sql: "SELECT 2" }),
    ).rejects.toThrow("resolved outside its granted capability");
    expect(sqliteQueries).toBe(1);
  });

  it("ignores inherited resource-kind hints", async () => {
    const requests: Array<{ type: RequestType; cell: CellRef }> = [];
    const runtime = {
      [$conn]: () => ({
        request: (request: { type: RequestType; cell: CellRef }) => {
          requests.push(request);
          if (request.type === RequestType.CellGet) {
            return Promise.resolve({ value: { database: "ordinary" } });
          }
          if (request.type === RequestType.CellResolveAsCell) {
            return Promise.resolve({
              cell: {
                ...request.cell,
                id: request.cell.path.length === 0
                  ? "of:resolved-context"
                  : "of:database",
                path: [],
                schema: request.cell.path.length === 0
                  ? { type: "object", properties: { database: true } }
                  : true,
              },
            });
          }
          return Promise.resolve({});
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const context = new CellHandle<Record<string, unknown>>(runtime, {
      ...ref,
      schema: true,
    });
    const inheritedHints = Object.create({ database: "sqlite" }) as Record<
      string,
      "sqlite"
    >;

    const bridge = await resolveCellContextBridge(context, inheritedHints);

    expect(bridge.resources.database.kind).toBe("cell");
    expect(bridge.resources.database.methods).toBeUndefined();
    expect(
      requests.some(({ type }) => type === RequestType.CellPull),
    ).toBe(false);
  });

  it("reports a cell write the runtime refuses", async () => {
    const runtime = {
      [$conn]: () => ({
        request: () => Promise.reject(new Error("write refused")),
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const context = new CellHandle(runtime, ref, {
      count: 1,
      database: { id: "db-1" },
    });

    const count = createCellContextBridge(context).resources.count;

    await expect(count.write!(3)).rejects.toThrow("write refused");
  });

  it("omits writes from read-only cell capabilities", async () => {
    const runtime = {
      [$conn]: () => ({
        request: (request: { type: RequestType }) =>
          request.type === RequestType.CellGet
            ? Promise.resolve({ value: "fixed" })
            : Promise.resolve({}),
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const context = new CellHandle(runtime, ref, { locked: "fixed" });

    const locked = createCellContextBridge(context).resources.locked;

    expect(locked.kind).toBe("cell");
    expect(locked.description).toBe("Read-only value");
    await expect(locked.read!()).resolves.toBe("fixed");
    expect(locked.write).toBeUndefined();
  });

  it("publishes cell changes after suppressing the initial value", () => {
    let subscribed: CellHandle<number> | undefined;
    const runtime = {
      [$conn]: () => ({
        request: () => Promise.resolve({}),
        subscribe: (cell: CellHandle<number>) => {
          subscribed = cell;
          return Promise.resolve();
        },
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const context = new CellHandle(runtime, ref, {
      count: 1,
      database: { id: "db-1" },
    });
    const count = createCellContextBridge(context).resources.count;
    const changes: unknown[] = [];

    const unsubscribe = count.subscribe!((value) => changes.push(value));
    subscribed?.[$onCellUpdate](2);

    expect(changes).toEqual([2]);
    unsubscribe();
  });

  it("reports a stream event the runtime refuses", async () => {
    const runtime = {
      [$conn]: () => ({
        request: () => Promise.reject(new Error("event refused")),
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const context = new CellHandle(runtime, ref, {
      count: 1,
      database: { id: "db-1" },
    });

    const events = createCellContextBridge(context).resources.events;

    await expect(events.methods!.send({ type: "refresh" })).rejects.toThrow(
      "event refused",
    );
  });

  it("exposes SQLite query and exec as methods on one database resource", async () => {
    const requests: unknown[] = [];
    let subscribed: CellHandle<Record<string, unknown>> | undefined;
    const runtime = {
      [$conn]: () => ({
        request: (request: { type: RequestType }) => {
          requests.push(request);
          if (request.type === RequestType.SqliteQuery) {
            return Promise.resolve({
              rows: [Object.fromEntries([
                ["title", realmFromFabricValue("One")],
                ["constructor", realmFromFabricValue("safe-constructor")],
                ["__proto__", realmFromFabricValue("safe-prototype")],
              ])],
            });
          }
          return Promise.resolve({});
        },
        subscribe: (cell: CellHandle<Record<string, unknown>>) => {
          subscribed = cell;
          return Promise.resolve();
        },
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const context = new CellHandle(runtime, ref, {
      count: 1,
      database: { id: "db-1" },
    });

    const database = createCellContextBridge(context).resources.database;
    expect(database.kind).toBe("sqlite");
    let invalidations = 0;
    const unsubscribe = database.subscribe!(() => invalidations++);
    expect(subscribed?.ref().schema).toEqual({
      type: "object",
      additionalProperties: true,
    });
    subscribed?.[$onCellUpdate]({ id: "db-1", rev: 1 });
    expect(invalidations).toBe(1);
    unsubscribe();
    await expect(database.methods!.query({
      sql: "SELECT title FROM notes WHERE id = ?",
      params: [1],
    })).resolves.toEqual({
      rows: [[
        ["title", "One"],
        ["constructor", "safe-constructor"],
        ["__proto__", "safe-prototype"],
      ]],
    });
    await database.methods!.exec({
      sql: "SELECT :constructor, :__proto__",
      namedParams: [["constructor", "New"], ["__proto__", "Prototype"]],
    });

    const databaseRef = {
      ...ref,
      path: ["database"],
      schema: {
        type: "object",
        asCell: ["sqlite"],
        description: "Notes database",
      },
    };
    expect(requests).toEqual([{
      type: RequestType.SqliteQuery,
      cell: databaseRef,
      sql: "SELECT title FROM notes WHERE id = ?",
      params: {
        kind: "positional",
        values: [realmFromFabricValue(1)],
      },
    }, {
      type: RequestType.SqliteExec,
      cell: databaseRef,
      sql: "SELECT :constructor, :__proto__",
      params: {
        kind: "named",
        entries: [
          ["constructor", realmFromFabricValue("New")],
          ["__proto__", realmFromFabricValue("Prototype")],
        ],
      },
    }]);
  });

  it("rejects malformed SQLite operation inputs before sending a request", async () => {
    const runtime = {
      [$conn]: () => ({
        request: () => {
          throw new Error("request should not be sent");
        },
        subscribe: () => Promise.resolve(),
        unsubscribe: () => Promise.resolve(),
        signal: { aborted: false },
      }),
    } as unknown as RuntimeClient;
    const context = new CellHandle(runtime, ref, {
      database: { id: "db-1" },
    });
    const query = createCellContextBridge(context).resources.database.methods!
      .query;

    await expect(query(undefined)).rejects.toThrow("object input");
    await expect(query({ params: [] })).rejects.toThrow("string `sql`");
    await expect(query({ sql: "SELECT 1", params: 1 })).rejects.toThrow(
      "array or object",
    );
    await expect(
      query({ sql: "SELECT 1", namedParams: [[1, "bad"]] }),
    ).rejects.toThrow("key-value entries");
  });
});
