import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { DataUnavailable } from "@commonfabric/data-model/fabric-instances";

import { fetchText } from "../src/builtins/fetch.ts";
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
    if (
      this.value !== null && typeof this.value === "object" &&
      key in (this.value as object)
    ) {
      return {
        get: () => (this.value as any)[key],
        set: (value: unknown) => (this.value as any)[key] = value,
        withTx() {
          return this;
        },
      } as unknown as FakeCell<unknown>;
    }
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

describe("fetch state-machine edge paths", () => {
  it("retains and monitors a live persisted request claim", () => {
    const url = "https://example.test/value.txt";
    const inputHash = computeInputHashFromValue({ url });
    const inputs = new FakeCell("inputs", { url });
    const pending = new FakeCell("pending", true);
    const result = new FakeCell<unknown>(
      "result",
      DataUnavailable.pending(),
    );
    const error = new FakeCell<unknown>("error", undefined);
    const internal = new FakeCell("internal", {
      inputHash,
      requestId: "persisted-owner",
      lastActivity: Date.now(),
    });
    const parent = new FakeCell("parent", undefined);
    const cells = { pending, result, error, internal };
    const runtime = {
      getCell(
        _space: unknown,
        cause: { fetchText: Record<string, unknown> },
      ) {
        const key = Object.keys(cause.fetchText)[0] as keyof typeof cells;
        return cells[key];
      },
      edit() {
        return {
          commit() {},
          abort() {},
        };
      },
      prepareTxForCommit() {},
    } as unknown as Runtime;
    const effects: unknown[] = [];
    const tx = {
      resetNarrowestReadScope() {},
      getNarrowestReadScope() {
        return "space";
      },
      recordCfcWritePolicyInput() {},
      enqueuePostCommitEffect(effect: unknown) {
        effects.push(effect);
      },
    } as unknown as IExtendedStorageTransaction;
    const cancels: Array<() => void> = [];
    let sent: unknown;
    const action = fetchText(
      inputs as unknown as Cell<any>,
      (_tx, value) => sent = value,
      (cancel) => cancels.push(cancel),
      [],
      parent as unknown as Cell<any>,
      runtime,
    );

    action(tx);

    expect(sent).toBeDefined();
    expect(result.value).toBe(DataUnavailable.pending());
    expect(internal.value.requestId).toBe("persisted-owner");
    expect(effects.length).toBe(1);
    cancels.forEach((cancel) => cancel());
  });
});
