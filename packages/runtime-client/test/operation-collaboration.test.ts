import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { OperationFieldSnapshot } from "@commonfabric/memory/v2";
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
            return Promise.resolve({ field: initial });
          case RequestType.OperationApply:
            return Promise.resolve({ resolution });
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
    expect(await client.queryOperationField(cell)).toBe(initial);
    expect(
      await client.applyOperation(cell, {
        codec: "codemirror-changeset@1",
        submissionId: "submission-1",
        base: null,
        baselineHash: "baseline",
        payload: { updates: [] },
      }),
    ).toBe(resolution);
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
      field: integrated,
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
  });
});
