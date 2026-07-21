import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CODEC } from "@commonfabric/data-model/codec-common";
import {
  DataUnavailable,
  FabricError,
} from "@commonfabric/data-model/fabric-instances";

import { fetchProgram } from "../src/builtins/fetch-program.ts";
import { computeInputHashFromValue } from "../src/builtins/fetch-utils.ts";
import type { Cell } from "../src/cell.ts";
import type { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

class FakeCell<T = unknown> {
  readonly space = "did:key:test";

  constructor(readonly id: string, public value: T) {}

  withTx(): this {
    return this;
  }

  asSchema(): this {
    return this;
  }

  get(): T {
    return this.value;
  }

  getRaw(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
  }

  setRaw(value: T): void {
    this.value = value;
  }

  update(value: Partial<T>): void {
    this.value = { ...(this.value as object), ...value } as T;
  }

  sync(): Promise<this> {
    return Promise.resolve(this);
  }

  key(key: PropertyKey): FakeCell<unknown> {
    return new FakeCell(`${this.id}:${String(key)}`, undefined);
  }

  setMetaRaw(): void {}

  getAsWriteRedirectLink(): Record<string, never> {
    return {};
  }

  getAsNormalizedFullLink() {
    return {
      space: this.space,
      id: this.id,
      path: [] as const,
      scope: "space" as const,
    };
  }
}

function makeAction(cacheState: Record<string, unknown>) {
  const inputs = new FakeCell("inputs", {
    url: "https://example.test/main.ts",
  });
  const pending = new FakeCell("pending", false);
  const result = new FakeCell<unknown>("result", undefined);
  const error = new FakeCell<unknown>("error", undefined);
  const cache = new FakeCell("cache", cacheState);
  const parent = new FakeCell("parent", undefined);
  const cancels: Array<() => void> = [];
  const cells = { pending, result, error, cache };
  const runtime = {
    getCell(
      _space: unknown,
      cause: { fetchProgram: Record<string, unknown> },
    ) {
      const key = Object.keys(cause.fetchProgram)[0] as keyof typeof cells;
      return cells[key];
    },
  } as unknown as Runtime;
  const tx = {
    resetNarrowestReadScope() {},
    getNarrowestReadScope() {
      return "space";
    },
  } as unknown as IExtendedStorageTransaction;
  let sent: Record<string, Cell<unknown>> | undefined;
  const action = fetchProgram(
    inputs as unknown as Cell<any>,
    (_tx, value) => sent = value,
    (cancel) => cancels.push(cancel),
    [],
    parent as unknown as Cell<any>,
    runtime,
  );
  return {
    action,
    tx,
    inputs,
    pending,
    result,
    error,
    cache,
    cancels,
    sent: () => sent,
  };
}

describe("fetchProgram state-machine edge paths", () => {
  it("parks behind a live persisted claim and arms its lease retry", () => {
    const startTime = Date.now();
    const inputHash = computeInputHashFromValue({
      url: "https://example.test/main.ts",
    });
    const fixture = makeAction({
      [inputHash]: {
        inputHash,
        state: { type: "fetching", requestId: "other-owner", startTime },
      },
    });

    fixture.action(fixture.tx);

    expect(fixture.sent()).toBeDefined();
    expect(fixture.pending.value).toBe(true);
    expect(fixture.result.value).toBe(DataUnavailable.pending());
    fixture.cancels.forEach((cancel) => cancel());
  });

  it("expires a stale persisted claim back to idle", () => {
    const inputHash = computeInputHashFromValue({
      url: "https://example.test/main.ts",
    });
    const fixture = makeAction({
      [inputHash]: {
        inputHash,
        state: { type: "fetching", requestId: "stale-owner", startTime: 0 },
      },
    });

    fixture.action(fixture.tx);

    expect((fixture.cache.value as any)[inputHash].state.type).toBe("idle");
    expect(fixture.result.value).toBe(DataUnavailable.pending());
    fixture.cancels.forEach((cancel) => cancel());
  });

  it("decodes a durable terminal error into the direct result marker", () => {
    const inputHash = computeInputHashFromValue({
      url: "https://example.test/main.ts",
    });
    const fabricError = new FabricError({
      type: "TypeError",
      name: "TypeError",
      message: "durable failure",
      stack: undefined,
      cause: undefined,
    });
    const fixture = makeAction({
      [inputHash]: {
        inputHash,
        state: {
          type: "error",
          error: FabricError[CODEC].encode(fabricError),
        },
      },
    });

    fixture.action(fixture.tx);

    expect(fixture.pending.value).toBe(false);
    expect((fixture.result.value as DataUnavailable).reason).toBe("error");
    expect((fixture.result.value as DataUnavailable).error?.message).toBe(
      "durable failure",
    );
    expect(fixture.error.value).toBeInstanceOf(FabricError);
    fixture.cancels.forEach((cancel) => cancel());
  });
});
