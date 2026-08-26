import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { OperationFieldSnapshot } from "@commonfabric/memory/v2";
import { RuntimeProcessor } from "../src/backends/runtime-processor.ts";
import type { CellHandle } from "../src/cell-handle.ts";
import { RuntimeClient } from "../src/runtime-client.ts";
import {
  type CellRef,
  NotificationType,
  RequestType,
} from "../src/protocol/mod.ts";

describe("RuntimeClient operation collaboration", () => {
  it("queries, applies, and subscribes through the worker protocol", async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const requests: unknown[] = [];
    const cellRef: CellRef = {
      space: "did:key:z6Mk-operation-client" as CellRef["space"],
      id: "of:operation-client",
      path: ["content"] as unknown as OperationFieldSnapshot["path"],
      scope: "space",
    };
    const initial: OperationFieldSnapshot = {
      branch: "",
      id: cellRef.id,
      scope: "space",
      scopeKey: "",
      path: cellRef.path as unknown as OperationFieldSnapshot["path"],
      active: false,
      codec: null,
      cursor: null,
      baselineHash: "baseline",
      materialized: "hello",
      operations: [],
    };
    const integrated: OperationFieldSnapshot = {
      ...initial,
      active: true,
      codec: "codemirror-changeset@1",
      cursor: { epoch: 1, version: 1 },
      materialized: "hello!",
      operations: [{
        opId: "op:1",
        cursor: { epoch: 1, version: 1 },
        submissionId: "submission-1",
        payload: { updates: [] },
      }],
    };
    const resolution = {
      operationIndex: 0,
      address: {
        branch: "",
        id: cellRef.id,
        scope: "space" as const,
        scopeKey: "",
        path: initial.path,
      },
      codec: "codemirror-changeset@1",
      submissionId: "submission-1",
      from: { epoch: 1, version: 0 },
      to: { epoch: 1, version: 1 },
      operations: integrated.operations,
      duplicate: false,
    };
    const wireField = (field: OperationFieldSnapshot) => ({
      ...field,
      materialized: realmFromFabricValue(field.materialized),
      operations: field.operations.map((operation) => ({
        ...operation,
        payload: realmFromFabricValue(operation.payload),
      })),
    });
    const wireResolution = {
      ...resolution,
      operations: resolution.operations.map((operation) => ({
        ...operation,
        payload: realmFromFabricValue(operation.payload),
      })),
    };
    const conn = {
      signal: new AbortController().signal,
      on: (event: string, handler: (data: unknown) => void) => {
        handlers.set(event, handler);
      },
      request: (request: { type: RequestType }) => {
        requests.push(request);
        switch (request.type) {
          case RequestType.OperationCapabilities:
            return Promise.resolve({ codecs: ["codemirror-changeset@1"] });
          case RequestType.OperationQuery:
            return Promise.resolve({ field: wireField(initial) });
          case RequestType.OperationApply:
            return Promise.resolve({ resolution: wireResolution });
          case RequestType.OperationRelease:
          case RequestType.OperationSubscribe:
          case RequestType.OperationUnsubscribe:
            return Promise.resolve({ value: true });
          default:
            throw new Error(`unexpected request: ${request.type}`);
        }
      },
    } as unknown as never;
    const client = new (RuntimeClient as unknown as {
      new (conn: never, options: unknown): RuntimeClient;
    })(conn, {});
    const cell = { ref: () => cellRef } as CellHandle<unknown>;

    expect(await client.operationCodecs(cell)).toEqual([
      "codemirror-changeset@1",
    ]);
    expect(await client.queryOperationField(cell)).toEqual(initial);
    expect(
      await client.applyOperation(cell, {
        codec: "codemirror-changeset@1",
        submissionId: "submission-1",
        base: null,
        baselineHash: "baseline",
        payload: { updates: [] },
      }),
    ).toEqual(resolution);
    await client.releaseOperationField(
      cell,
      "codemirror-changeset@1",
      { epoch: 1, version: 1 },
    );

    const delivered: OperationFieldSnapshot[] = [];
    const unsubscribe = await client.subscribeOperationField(
      cell,
      (field) => delivered.push(field),
    );
    const subscribe = requests.at(-1) as {
      type: RequestType;
      subscriptionId: string;
    };
    handlers.get("operationupdate")!({
      type: NotificationType.OperationUpdate,
      subscriptionId: subscribe.subscriptionId,
      field: wireField(integrated),
    });
    expect(delivered).toEqual([integrated]);

    unsubscribe();
    await Promise.resolve();

    expect(requests.map((request) => (request as { type: RequestType }).type))
      .toEqual([
        RequestType.OperationCapabilities,
        RequestType.OperationQuery,
        RequestType.OperationApply,
        RequestType.OperationRelease,
        RequestType.OperationSubscribe,
        RequestType.OperationUnsubscribe,
      ]);
    const apply = requests.find((request) =>
      (request as { type: RequestType }).type === RequestType.OperationApply
    ) as { payload: Parameters<typeof fabricFromRealmValue>[0] };
    expect(fabricFromRealmValue(apply.payload)).toEqual({ updates: [] });
  });

  it("compensates when the worker loses a subscribe response", async () => {
    const requests: Array<{ type: RequestType; subscriptionId?: string }> = [];
    const conn = {
      signal: new AbortController().signal,
      on: () => {},
      request: (request: { type: RequestType; subscriptionId?: string }) => {
        requests.push(request);
        if (request.type === RequestType.OperationSubscribe) {
          return Promise.reject(new Error("subscribe response lost"));
        }
        if (request.type === RequestType.OperationUnsubscribe) {
          return Promise.resolve({ value: true });
        }
        throw new Error(`unexpected request: ${request.type}`);
      },
    } as unknown as never;
    const client = new (RuntimeClient as unknown as {
      new (conn: never, options: unknown): RuntimeClient;
    })(conn, {});
    const cell = {
      ref: () => ({
        space: "did:key:z6Mk-operation-client",
        id: "of:operation-client",
        path: ["content"],
      }),
    } as unknown as CellHandle<unknown>;

    await expect(
      client.subscribeOperationField(cell, () => {}),
    ).rejects.toThrow("subscribe response lost");
    expect(requests.map(({ type }) => type)).toEqual([
      RequestType.OperationSubscribe,
      RequestType.OperationUnsubscribe,
    ]);
    expect(requests[1].subscriptionId).toBe(requests[0].subscriptionId);
  });

  it("encodes Fabric values across the worker operation boundary", async () => {
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    const address = {
      branch: "",
      id: "of:bytes",
      scopeKey: "space",
      path: [] as unknown as OperationFieldSnapshot["path"],
    };
    const field: OperationFieldSnapshot = {
      ...address,
      active: true,
      codec: "synthetic@1",
      cursor: { epoch: 1, version: 1 },
      baselineHash: "baseline",
      materialized: bytes,
      operations: [{
        opId: "op:bytes",
        cursor: { epoch: 1, version: 1 },
        submissionId: "bytes:1",
        payload: bytes,
      }],
    };
    let receivedPayload: unknown;
    const resolution = {
      operationIndex: 0,
      address,
      codec: "synthetic@1",
      submissionId: "bytes:1",
      from: { epoch: 1, version: 0 },
      to: { epoch: 1, version: 1 },
      operations: field.operations,
      duplicate: false,
    };
    const replica = {
      queryOperationField: () => Promise.resolve(field),
      applyOperation: (operation: { payload: unknown }) => {
        receivedPayload = operation.payload;
        return Promise.resolve(resolution);
      },
      operationCodecs: () => Promise.resolve(["synthetic@1"]),
      releaseOperationField: () => Promise.resolve(),
      subscribeOperationField: () => Promise.resolve(() => {}),
    };
    const processor = Object.assign(Object.create(RuntimeProcessor.prototype), {
      runtime: {
        storageManager: { open: () => ({ replica }) },
      },
    }) as RuntimeProcessor;
    const cell = {
      space: "did:key:z6Mk-operation-client",
      id: "of:bytes",
      path: [],
    };

    const queried = await RuntimeProcessor.prototype.handleOperationQuery.call(
      processor,
      { type: RequestType.OperationQuery, cell } as never,
    );
    expect(
      (fabricFromRealmValue(queried.field.materialized) as FabricBytes).slice(),
    ).toEqual(new Uint8Array([1, 2, 3]));
    const applied = await RuntimeProcessor.prototype.handleOperationApply.call(
      processor,
      {
        type: RequestType.OperationApply,
        cell,
        codec: "synthetic@1",
        submissionId: "bytes:1",
        base: { epoch: 1, version: 0 },
        payload: realmFromFabricValue(bytes),
      } as never,
    );
    expect((receivedPayload as FabricBytes).slice()).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(
      (fabricFromRealmValue(
        applied.resolution.operations[0].payload,
      ) as FabricBytes).slice(),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });
});
