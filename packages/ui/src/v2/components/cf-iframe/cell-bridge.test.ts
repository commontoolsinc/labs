/** Exercises CellHandle capability adaptation, including scoped resources. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

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
    }]);
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

    expect(Object.keys(bridge.resources)).toEqual(["command"]);
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
    ]);
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
            return Promise.resolve({ rows: [{ title: "One" }] });
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
    })).resolves.toEqual({ rows: [{ title: "One" }] });
    await database.methods!.exec({
      sql: "INSERT INTO notes (title) VALUES (:title)",
      params: { title: "New" },
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
      params: [1],
    }, {
      type: RequestType.SqliteExec,
      cell: databaseRef,
      sql: "INSERT INTO notes (title) VALUES (:title)",
      params: { title: "New" },
    }]);
  });
});
