/** Exercises request acceptance, withdrawal, and refusal without model I/O. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { LLMClient, type LLMResponse } from "@commonfabric/llm";

import { generateObject, generateText, llm } from "../../src/builtins/llm.ts";
import type { Cell } from "../../src/cell.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

/** Output fields shared by the three LLM builtins. */
type Result = {
  /** Whether the model response remains pending. */
  pending: boolean;

  /** Completed model output. */
  result?: unknown;

  /** Terminal model or dispatch failure. */
  error?: string;

  /** Selected or completed request. */
  requestHash?: string;
};

const identity = await Identity.fromPassphrase("llm lifecycle unit");
const builtins = { llm, generateText, generateObject };

/** Builds a real transaction fixture with a model response held by the test. */
async function fixture(
  name: keyof typeof builtins,
  served = true,
) {
  const storage = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: { serverExecution: served },
    servingPosture: served,
    cfcFlowLabels: "off",
  });
  const input = runtime.getCell<any>(
    identity.did(),
    "lifecycle-input",
  );
  const parent = runtime.getCell(identity.did(), "lifecycle-parent");
  let output: Cell<Result>;
  const instanceMaps = new Set<Map<unknown, unknown>>();
  const mapSet = Map.prototype.set;
  const send = LLMClient.prototype.sendRequest;
  const object = LLMClient.prototype.generateObject;
  try {
    await input.sync();
    Map.prototype.set = function (key, value) {
      if (
        value && typeof value === "object" &&
        Object.hasOwn(value, "currentRun") &&
        Object.hasOwn(value, "lastRequestQueued")
      ) {
        instanceMaps.add(this);
      }
      return mapSet.call(this, key, value);
    };
    const action = builtins[name](
      input,
      (tx, result) => {
        output = result;
        parent.withTx(tx).set({ announced: true, output: result });
      },
      () => {},
      "lifecycle",
      parent,
      runtime,
    );
    const requests: Array<
      ReturnType<typeof Promise.withResolvers<LLMResponse>>
    > = [];
    const works: Promise<unknown>[] = [];
    let changed = Promise.withResolvers<void>();
    LLMClient.prototype.sendRequest = () => {
      const response = Promise.withResolvers<LLMResponse>();
      requests.push(response);
      changed.resolve();
      changed = Promise.withResolvers<void>();
      return response.promise;
    };
    LLMClient.prototype.generateObject = async () => {
      const response = Promise.withResolvers<LLMResponse>();
      requests.push(response);
      changed.resolve();
      changed = Promise.withResolvers<void>();
      const result = await response.promise;
      return { object: { answer: result.content }, id: "response" };
    };
    runtime.asyncWorkObserver = (work) => works.push(work);

    /** Stages the builtin's request in the selected transaction. */
    const stage = (tx: IExtendedStorageTransaction, prompt: unknown) => {
      input.withTx(tx).set(
        name === "llm"
          ? { messages: [{ role: "user", content: prompt }] }
          : name === "generateObject"
          ? { prompt, schema: { type: "object" } }
          : { prompt },
      );
      action(tx);
    };

    /** Commits a request and waits for its post-commit dispatch boundary. */
    const run = async (prompt: unknown) => {
      const tx = runtime.edit();
      stage(tx, prompt);
      expect((await tx.commit()).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      await runtime.idle();
    };

    const wave = new WaveAccumulator({
      space: identity.did(),
      basisSeq: 0,
      scopeKeyIdentity: runtime.scopeKeyIdentity,
      replicaFor: (space) => storage.open(space).replica,
    });
    const deferred: Array<() => void> = [];
    const refusals: Array<() => void> = [];

    return {
      runtime,
      requests,
      works,
      run,
      async clear() {
        const tx = runtime.edit();
        input.withTx(tx).set(
          name === "llm"
            ? { messages: [] }
            : { prompt: "", schema: { type: "object" } },
        );
        action(tx);
        expect((await tx.commit()).error).toBeUndefined();
        await tx.postCommitEffectsSettled();
        await runtime.idle();
      },
      stage,
      parent,
      wave,
      deferred,
      refusals,
      async issued(count: number) {
        while (requests.length < count) await changed.promise;
      },
      get instanceCount() {
        return [...instanceMaps].reduce((sum, map) => sum + map.size, 0);
      },
      get output() {
        return output;
      },
      async seal(prompt: unknown) {
        runtime.installSealDestination({
          seal: (tx) => wave.seal(tx),
          deferSealedEffects: (tx, effects) => {
            for (const effect of effects) {
              deferred.push(() => effect.flush(tx));
              refusals.push(() =>
                effect.abandon?.({
                  name: "StorageTransactionAborted",
                  message: "Withdrawn request refused",
                  reason: "Withdrawn request refused",
                })
              );
            }
            return true;
          },
        });
        const tx = runtime.edit();
        stampWaveRunContext(tx, { actionId: "held-llm", kind: "derivation" });
        stage(tx, prompt);
        expect((await tx.commit()).error).toBeUndefined();
        runtime.clearSealDestination();
        expect(waveSettlementOf(tx)).toBeDefined();
        return { settlement: waveSettlementOf(tx)! };
      },
      release(text = "A-result") {
        requests.at(-1)!.resolve({
          role: "assistant",
          content: text,
          id: "response",
        });
      },
      async close() {
        runtime.clearSealDestination();
        wave.abandon("Fixture complete");
        await wave.settled();
        for (const request of requests) {
          request.resolve({
            role: "assistant",
            content: "cleanup",
            id: "cleanup",
          });
        }
        try {
          await runtime.settled();
          await runtime.dispose();
          await storage.close();
        } finally {
          Map.prototype.set = mapSet;
          LLMClient.prototype.sendRequest = send;
          LLMClient.prototype.generateObject = object;
        }
      },
    };
  } catch (error) {
    Map.prototype.set = mapSet;
    LLMClient.prototype.sendRequest = send;
    LLMClient.prototype.generateObject = object;
    await runtime.dispose();
    await storage.close();
    throw error;
  }
}

describe("llm-served-lifecycle", () => {
  for (const name of Object.keys(builtins) as Array<keyof typeof builtins>) {
    it(`retires ${name} state after each completed request`, async () => {
      const f = await fixture(name);
      try {
        for (let index = 0; index < 5; index++) {
          await f.run(`request-${index}`);
          await f.issued(index + 1);
          expect(f.instanceCount).toBe(1);
          f.release();
          await f.runtime.settled();
          expect(f.instanceCount).toBe(0);
        }
        expect(f.requests).toHaveLength(5);
      } finally {
        await f.close();
      }
    });

    it(`retains ${name} ownership while newer staging is uncommitted`, async () => {
      const f = await fixture(name);
      const tx = f.runtime.edit();
      try {
        await f.run("A");
        await f.issued(1);
        const firstWork = f.works.at(-1)!;
        f.stage(tx, "B");
        f.release();
        await firstWork;
        expect(f.instanceCount).toBe(1);
        const refusal = {
          name: "StorageTransactionAborted",
          message: "Newer staging refused",
          reason: "Newer staging refused",
        } as const;
        tx.abort(refusal);
        tx.abandonStagedWork(refusal);
        await f.runtime.settled();
        expect(f.instanceCount).toBe(0);
        expect(f.output.key("error").get()).toBe(
          `${name} request was refused before it started`,
        );
      } finally {
        tx.abort();
        await f.close();
      }
    });

    it(`retires ${name} state for empty inputs`, async () => {
      const f = await fixture(name);
      try {
        await f.clear();
        expect(f.requests).toHaveLength(0);
        expect(f.instanceCount).toBe(0);
      } finally {
        await f.close();
      }
    });

    it(`retires ${name} memo-hit state without another model request`, async () => {
      const f = await fixture(name);
      try {
        await f.run("A");
        await f.issued(1);
        f.release();
        await f.runtime.settled();
        expect(f.instanceCount).toBe(0);
        await f.run("A");
        await f.runtime.settled();
        expect(f.instanceCount).toBe(0);
        expect(f.requests).toHaveLength(1);
      } finally {
        await f.close();
      }
    });

    it(`settles ${name} refusal after wave withdrawal`, async () => {
      const f = await fixture(name);
      try {
        const { settlement } = await f.seal("A");
        f.wave.abandon("Request withdrawn");
        expect((await settlement).error).toBeDefined();
        await f.wave.settled();
        for (const refuse of f.refusals) refuse();
        await f.runtime.settled();
        expect(f.parent.get()).toMatchObject({ announced: true });
        expect(f.output.key("error").get()).toBe(
          `${name} request was refused before it started`,
        );
        expect(f.requests).toHaveLength(0);
        expect(f.instanceCount).toBe(0);
      } finally {
        await f.close();
      }
    });

    it(`does not let a retired ${name} refusal replace a newer scoped binding`, async () => {
      const f = await fixture(name);
      const tx = f.runtime.edit();
      try {
        f.stage(tx, "refused");
        const refusal = {
          name: "StorageTransactionAborted",
          message: "Delayed refusal",
          reason: "Delayed refusal",
        } as const;
        tx.abort(refusal);
        await f.run("A");
        await f.issued(1);
        f.release();
        await f.runtime.settled();
        expect(f.instanceCount).toBe(0);
        const scoped = f.runtime.getCell<string>(
          identity.did(),
          "new-scope",
          undefined,
          undefined,
          "user",
        );
        await scoped.sync();
        const seed = f.runtime.edit();
        scoped.withTx(seed).set("new scope");
        expect((await seed.commit()).error).toBeUndefined();
        await f.run(scoped);
        await f.issued(2);
        f.release("current-scope");
        await f.runtime.settled();
        tx.abandonStagedWork(refusal);
        await f.runtime.settled();
        expect(f.parent.key("output").key("result").get()).toEqual(
          name === "generateObject"
            ? { answer: "current-scope" }
            : "current-scope",
        );
        expect(f.instanceCount).toBe(0);
      } finally {
        tx.abort();
        await f.close();
      }
    });

    for (const served of [false, true]) {
      it(`republishes ${name} when its output returns to an earlier scope with serving ${served ? "on" : "off"}`, async () => {
        const f = await fixture(name, served);
        try {
          const scoped = f.runtime.getCell<string>(
            identity.did(),
            "scope-return-user",
            undefined,
            undefined,
            "user",
          );
          const shared = f.runtime.getCell<string>(
            identity.did(),
            "scope-return-space",
          );
          await Promise.all([scoped.sync(), shared.sync()]);
          const seed = f.runtime.edit();
          scoped.withTx(seed).set("B");
          shared.withTx(seed).set("C");
          expect((await seed.commit()).error).toBeUndefined();
          let index = 0;
          for (const prompt of ["A", scoped, shared]) {
            await f.run(prompt);
            await f.issued(++index);
            f.release(`${["A", "B", "C"][index - 1]}-result`);
            await f.runtime.settled();
          }
          expect(f.requests).toHaveLength(3);
          expect(f.parent.key("output").key("result").get()).toEqual(
            name === "generateObject" ? { answer: "C-result" } : "C-result",
          );
        } finally {
          await f.close();
        }
      });
    }

    for (const superseded of [false, true]) {
      it(`settles ${name} refusal${superseded ? " without replacing a newer result" : " and announces its result"}`, async () => {
        const f = await fixture(name);
        try {
          const tx = f.runtime.edit();
          f.stage(tx, "refused");
          const refusal = {
            name: "StorageTransactionAborted",
            message: "Controlled request refusal",
            reason: "Controlled request refusal",
          } as const;
          tx.abort(refusal);
          if (superseded) {
            await f.run("A");
            await f.issued(1);
            f.release();
            await f.runtime.settled();
            expect(f.parent.key("output").key("result").get()).toEqual(
              name === "generateObject" ? { answer: "A-result" } : "A-result",
            );
          }
          tx.abandonStagedWork(refusal);
          await f.runtime.settled();
          expect(f.parent.get()).toMatchObject({ announced: true });
          expect(f.requests).toHaveLength(superseded ? 1 : 0);
          expect(f.output.get()).toMatchObject(
            superseded
              ? {
                pending: false,
                result: name === "generateObject"
                  ? { answer: "A-result" }
                  : "A-result",
              }
              : {
                pending: false,
                error: `${name} request was refused before it started`,
              },
          );
          if (superseded) expect(f.output.key("error").get()).toBeUndefined();
        } finally {
          await f.close();
        }
      });
    }

    it(`does not dispatch ${name} from a withdrawn wave`, async () => {
      const f = await fixture(name);
      try {
        const { settlement } = await f.seal("A");
        f.wave.abandon("Request withdrawn");
        expect((await settlement).error).toBeDefined();
        await f.wave.settled();
        expect(f.deferred).toHaveLength(1);
        for (const flush of f.deferred) flush();
        await f.runtime.settled();
        expect(f.requests).toHaveLength(0);
        await f.run("A");
        await f.issued(1);
        expect(f.requests).toHaveLength(1);
        f.release();
        await f.runtime.settled();
        expect(f.parent.get()).toMatchObject({ announced: true });
        expect(f.output.get()).toMatchObject({
          pending: false,
          result: name === "generateObject"
            ? { answer: "A-result" }
            : "A-result",
        });
      } finally {
        await f.close();
      }
    });

    it(`reissues ${name} after a newer sealed request is withdrawn`, async () => {
      const f = await fixture(name);
      try {
        await f.run("A");
        await f.issued(1);
        expect(f.requests).toHaveLength(1);
        const firstWork = f.works.at(-1)!;
        const { settlement } = await f.seal("B");
        f.release();
        await firstWork;
        f.wave.abandon("Newer request withdrawn");
        expect((await settlement).error).toBeDefined();
        await f.wave.settled();
        await f.run("A");
        await f.issued(2);
        expect(f.requests).toHaveLength(2);
        f.release();
        await f.runtime.settled();
        expect(f.parent.get()).toMatchObject({ announced: true });
        expect(f.output.get()).toMatchObject({
          pending: false,
          result: name === "generateObject"
            ? { answer: "A-result" }
            : "A-result",
        });
      } finally {
        await f.close();
      }
    });
  }
});
