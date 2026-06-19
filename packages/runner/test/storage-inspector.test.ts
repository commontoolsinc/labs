import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as Inspector from "../src/storage/inspector.ts";

const did = "did:key:z6Mk-storage-inspector";

function command(cmd: string, id: string, args: Record<string, unknown> = {}) {
  return {
    invocation: {
      iss: did,
      cmd,
      sub: did,
      args,
      prf: [],
    },
    authorization: {
      signature: new Uint8Array(),
      access: {
        [id]: {},
      },
    },
  } as any;
}

function taskReturn(id: string, is: Record<string, unknown>) {
  return {
    the: "task/return",
    of: `job:${id}`,
    is,
  } as any;
}

function taskEffect(id: string, is: unknown) {
  return {
    the: "task/effect",
    of: `job:${id}`,
    is,
  } as any;
}

describe("storage inspector model", () => {
  it("tracks connection transitions", () => {
    const model = Inspector.create(1);

    Inspector.update(model, {
      time: 2,
      connect: { attempt: 3 },
    });
    expect(model.connection).toEqual({
      ready: { ok: { attempt: 3 } },
      time: 2,
    });

    Inspector.update(model, {
      time: 3,
      disconnect: { reason: "error", message: "socket closed" },
    });
    expect(model.connection.pending?.error?.message).toBe("socket closed");
    expect(model.connection.pending?.error?.reason).toBe("error");
    expect(model.connection.time).toBe(3);

    Inspector.update(model, {
      time: 4,
      disconnect: { reason: "timeout", message: "retry" },
    });
    expect(model.connection.pending?.error?.message).toBe("retry");
    expect(model.connection.pending?.error?.reason).toBe("timeout");
    expect(model.connection.time).toBe(4);
  });

  it("tracks outbound push, pull, and subscription commands", () => {
    const model = Inspector.create(10);

    Inspector.update(model, {
      time: 11,
      send: command("/memory/transact", "tx"),
    });
    expect(model.push["job:tx"].ok?.invocation.cmd).toBe("/memory/transact");

    Inspector.update(model, {
      time: 12,
      send: command("/memory/query", "query"),
    });
    expect(model.pull["job:query"].ok?.invocation.cmd).toBe("/memory/query");

    Inspector.update(model, {
      time: 13,
      send: command("/memory/graph/query", "graph", { subscribe: true }),
    });
    expect(model.pull["job:graph"].ok?.invocation.cmd).toBe(
      "/memory/graph/query",
    );
    expect(model.subscriptions["job:graph"].opened).toBe(13);

    Inspector.update(model, {
      time: 14,
      send: command("/memory/query/subscribe", "sub"),
    });
    expect(model.subscriptions["job:sub"].opened).toBe(14);

    Inspector.update(model, {
      time: 15,
      send: command("/memory/query/unsubscribe", "sub"),
    });
    expect(model.subscriptions["job:sub"]).toBeUndefined();
  });

  it("tracks remote completions and effects", () => {
    const model = Inspector.create(20);

    Inspector.update(model, {
      time: 21,
      send: command("/memory/transact", "push-ok"),
    });
    Inspector.update(model, {
      time: 22,
      receive: taskReturn("push-ok", { ok: {} }),
    });
    expect(model.push["job:push-ok"]).toBeUndefined();

    Inspector.update(model, {
      time: 23,
      send: command("/memory/transact", "push-error"),
    });
    Inspector.update(model, {
      time: 24,
      receive: taskReturn("push-error", {
        error: Object.assign(new Error("conflict"), { name: "ConflictError" }),
      }),
    });
    expect(model.push["job:push-error"].error?.message).toBe("conflict");
    expect(model.push["job:push-error"].error?.time).toBe(24);

    Inspector.update(model, {
      time: 25,
      send: command("/memory/query", "pull-error"),
    });
    Inspector.update(model, {
      time: 26,
      receive: taskReturn("pull-error", {
        error: Object.assign(new Error("bad query"), { name: "QueryError" }),
      }),
    });
    expect(model.pull["job:pull-error"].error?.message).toBe("bad query");
    expect(model.pull["job:pull-error"].error?.time).toBe(26);

    Inspector.update(model, {
      time: 27,
      send: command("/memory/query/subscribe", "sub"),
    });
    Inspector.update(model, {
      time: 28,
      receive: taskEffect("sub", { value: 42 }),
    });
    expect(model.subscriptions["job:sub"].updated).toBe(28);
    expect(model.subscriptions["job:sub"].value).toEqual({ value: 42 });

    Inspector.update(model, {
      time: 29,
      receive: taskReturn("sub", { ok: {} }),
    });
    expect(model.subscriptions["job:sub"]).toBeUndefined();
  });
});
