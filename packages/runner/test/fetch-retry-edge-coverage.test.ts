import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { DataUnavailable } from "@commonfabric/data-model/fabric-instances";

import { scheduleFetchProgramClaimRetry } from "../src/builtins/fetch-program.ts";
import {
  computeInputHashFromValue,
  releaseFetchMutexClaim,
  scheduleFetchMutexClaimRetry,
  tryWriteResult,
} from "../src/builtins/fetch-utils.ts";
import type { Cell } from "../src/cell.ts";
import type { Runtime } from "../src/runtime.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("fetch retry edge paths", () => {
  it("absorbs a rejected generic-fetch claim reconciliation", async () => {
    let attempts = 0;
    const runtime = {
      editWithRetry() {
        attempts++;
        return Promise.reject(new Error("runtime disposed"));
      },
    } as unknown as Runtime;

    const cancel = scheduleFetchMutexClaimRetry(
      runtime,
      {} as Cell<Record<string, unknown>>,
      () => ({ url: "/value" }),
      {} as Cell<unknown>,
      {} as Cell<any>,
      "hash",
      "owner",
      0,
      0,
    );
    await tick();
    cancel();

    expect(attempts).toBe(1);
  });

  it("leaves a generic-fetch claim parked while its input is unavailable", async () => {
    let updates = 0;
    const input = {
      withTx() {
        return this;
      },
      getRaw() {
        return DataUnavailable.syncing();
      },
    } as unknown as Cell<Record<string, unknown>>;
    const runtime = {
      editWithRetry<T>(action: (tx: unknown) => T) {
        return Promise.resolve({ ok: action({}) });
      },
    } as unknown as Runtime;

    const cancel = scheduleFetchMutexClaimRetry(
      runtime,
      input,
      () => ({ url: "/value" }),
      {} as Cell<unknown>,
      {
        withTx() {
          return this;
        },
        update() {
          updates++;
        },
      } as unknown as Cell<any>,
      "hash",
      "owner",
      0,
      0,
    );
    await tick();
    cancel();

    expect(updates).toBe(0);
  });

  it("rejects result publication while the live input is unavailable", async () => {
    const input = {
      withTx() {
        return this;
      },
      getRaw() {
        return DataUnavailable.pending();
      },
    } as unknown as Cell<Record<string, unknown>>;
    const runtime = {
      editWithRetry<T>(action: (tx: unknown) => T) {
        return Promise.resolve({ ok: action({}) });
      },
    } as unknown as Runtime;

    const wrote = await tryWriteResult(
      runtime,
      {} as Cell<any>,
      input,
      computeInputHashFromValue({ url: "/value" }),
      () => {
        throw new Error("must not publish");
      },
    );

    expect(wrote).toBe(false);
  });

  it("releases only the matching generic-fetch claim", async () => {
    const state = {
      inputHash: "input-hash",
      requestId: "owner",
      lastActivity: 42,
    };
    const internal = {
      withTx() {
        return this;
      },
      get() {
        return { ...state };
      },
      update(value: Partial<typeof state>) {
        Object.assign(state, value);
      },
    } as unknown as Cell<any>;
    const runtime = {
      editWithRetry<T>(action: (tx: unknown) => T) {
        return Promise.resolve({ ok: action({}) });
      },
    } as unknown as Runtime;

    await releaseFetchMutexClaim(runtime, internal, "input-hash", "owner");
    expect(state.requestId).toBe("");
    expect(state.lastActivity).toBe(0);

    state.requestId = "new-owner";
    state.lastActivity = 99;
    await releaseFetchMutexClaim(runtime, internal, "input-hash", "old-owner");
    expect(state.requestId).toBe("new-owner");
    expect(state.lastActivity).toBe(99);
  });

  it("absorbs a rejected fetchProgram claim reconciliation", async () => {
    let attempts = 0;
    const runtime = {
      editWithRetry() {
        attempts++;
        return Promise.reject(new Error("runtime disposed"));
      },
    } as unknown as Runtime;

    const cancel = scheduleFetchProgramClaimRetry(
      runtime,
      {} as Cell<Record<string, any>>,
      "hash",
      "owner",
      0,
      0,
    );
    await tick();
    cancel();

    expect(attempts).toBe(1);
  });
});
