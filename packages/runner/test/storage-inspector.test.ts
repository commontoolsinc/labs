import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import type {
  Conflict,
  ConflictError,
  ConsumerCommandInvocation,
  EnhancedCommit,
  InvocationURL,
  MemorySpace,
  Proof,
  Protocol,
  ProviderCommand,
  Query,
  QueryError,
  SchemaQuery,
  Signature,
  Subscribe,
  SystemError,
  Transaction,
  UCAN,
  Unsubscribe,
} from "@commonfabric/memory/interface";
import * as Inspector from "../src/storage/inspector.ts";

const did: MemorySpace = "did:key:z6Mk-storage-inspector";

type ConsumerInvocation = ConsumerCommandInvocation<Protocol>;
type ConsumerUCAN = UCAN<ConsumerInvocation>;
type ProviderReceipt = ProviderCommand<Protocol>;
type ProviderReturnValue = Extract<
  ProviderReceipt,
  { the: "task/return" }
>["is"];

function signature(): Signature<Proof<ConsumerInvocation>> {
  return new Uint8Array() as Signature<Proof<ConsumerInvocation>>;
}

function job(id: string): InvocationURL<FabricHash> {
  return `job:${id}` as InvocationURL<FabricHash>;
}

function ucan(id: string, invocation: ConsumerInvocation): ConsumerUCAN {
  return {
    invocation,
    authorization: {
      signature: signature(),
      access: {
        [id]: {},
      },
    },
  } satisfies ConsumerUCAN;
}

function transactionCommand(id: string): ConsumerUCAN {
  return ucan(
    id,
    {
      iss: did,
      cmd: "/memory/transact",
      sub: did,
      args: { changes: {} },
      prf: [],
    } satisfies Transaction,
  );
}

function queryCommand(id: string): ConsumerUCAN {
  return ucan(
    id,
    {
      iss: did,
      cmd: "/memory/query",
      sub: did,
      args: { select: {} },
      prf: [],
    } satisfies Query,
  );
}

function schemaQueryCommand(
  id: string,
  args: Pick<SchemaQuery["args"], "subscribe"> = {},
): ConsumerUCAN {
  return ucan(
    id,
    {
      iss: did,
      cmd: "/memory/graph/query",
      sub: did,
      args: { selectSchema: {}, ...args },
      prf: [],
    } satisfies SchemaQuery,
  );
}

function subscribeCommand(id: string): ConsumerUCAN {
  return ucan(
    id,
    {
      iss: did,
      cmd: "/memory/query/subscribe",
      sub: did,
      args: { select: {} },
      prf: [],
    } satisfies Subscribe,
  );
}

function unsubscribeCommand(id: string): ConsumerUCAN {
  return ucan(
    id,
    {
      iss: did,
      cmd: "/memory/query/unsubscribe",
      sub: did,
      args: { source: job(id) },
      prf: [],
    } satisfies Unsubscribe,
  );
}

function taskReturn(
  id: string,
  is: ProviderReturnValue,
): ProviderReceipt {
  return {
    the: "task/return",
    of: job(id),
    is,
  } satisfies ProviderReceipt;
}

function taskEffect(id: string, is: EnhancedCommit): ProviderReceipt {
  return {
    the: "task/effect",
    of: job(id),
    is,
  } satisfies ProviderReceipt;
}

function systemError(message: string): SystemError {
  return Object.assign(new Error(message), { code: 1 });
}

function conflictError(message: string): ConflictError {
  const conflict = {
    space: did,
    the: "application/json",
    of: "of:storage-inspector-conflict",
    expected: null,
    actual: null,
    existsInHistory: false,
    history: [],
  } satisfies Conflict;

  return Object.assign(new Error(message), {
    name: "ConflictError" as const,
    transaction: {
      iss: did,
      cmd: "/memory/transact",
      sub: did,
      args: { changes: {} },
      prf: [],
    } satisfies Transaction,
    conflict,
  });
}

function queryError(message: string): QueryError {
  return Object.assign(new Error(message), {
    name: "QueryError" as const,
    cause: systemError(message),
    space: did,
    selector: {},
  });
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
      send: transactionCommand("tx"),
    });
    expect(model.push["job:tx"].ok?.invocation.cmd).toBe("/memory/transact");

    Inspector.update(model, {
      time: 12,
      send: queryCommand("query"),
    });
    expect(model.pull["job:query"].ok?.invocation.cmd).toBe("/memory/query");

    Inspector.update(model, {
      time: 13,
      send: schemaQueryCommand("graph", { subscribe: true }),
    });
    expect(model.pull["job:graph"].ok?.invocation.cmd).toBe(
      "/memory/graph/query",
    );
    expect(model.subscriptions["job:graph"].opened).toBe(13);

    Inspector.update(model, {
      time: 14,
      send: subscribeCommand("sub"),
    });
    expect(model.subscriptions["job:sub"].opened).toBe(14);

    Inspector.update(model, {
      time: 15,
      send: unsubscribeCommand("sub"),
    });
    expect(model.subscriptions["job:sub"]).toBeUndefined();
  });

  it("tracks remote completions and effects", () => {
    const model = Inspector.create(20);

    Inspector.update(model, {
      time: 21,
      send: transactionCommand("push-ok"),
    });
    Inspector.update(model, {
      time: 22,
      receive: taskReturn("push-ok", { ok: {} }),
    });
    expect(model.push["job:push-ok"]).toBeUndefined();

    Inspector.update(model, {
      time: 23,
      send: transactionCommand("push-error"),
    });
    Inspector.update(model, {
      time: 24,
      receive: taskReturn("push-error", {
        error: conflictError("conflict"),
      }),
    });
    expect(model.push["job:push-error"].error?.message).toBe("conflict");
    expect(model.push["job:push-error"].error?.time).toBe(24);

    Inspector.update(model, {
      time: 25,
      send: queryCommand("pull-error"),
    });
    Inspector.update(model, {
      time: 26,
      receive: taskReturn("pull-error", {
        error: queryError("bad query"),
      }),
    });
    expect(model.pull["job:pull-error"].error?.message).toBe("bad query");
    expect(model.pull["job:pull-error"].error?.time).toBe(26);

    Inspector.update(model, {
      time: 27,
      send: subscribeCommand("sub"),
    });
    const effect = { revisions: [], commit: {} } satisfies EnhancedCommit;
    Inspector.update(model, {
      time: 28,
      receive: taskEffect("sub", effect),
    });
    expect(model.subscriptions["job:sub"].updated).toBe(28);
    expect(model.subscriptions["job:sub"].value).toEqual(effect);

    Inspector.update(model, {
      time: 29,
      receive: taskReturn("sub", { ok: {} }),
    });
    expect(model.subscriptions["job:sub"]).toBeUndefined();
  });
});
