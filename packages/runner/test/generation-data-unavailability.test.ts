import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type {
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
} from "@commonfabric/api";
import { DataUnavailable } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import {
  addMockObjectResponse,
  addMockResponse,
  clearMockResponses,
  enableMockMode,
  LLMClient,
} from "@commonfabric/llm/client";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Action } from "../src/scheduler.ts";
import type { Cell } from "../src/cell.ts";
import { generateObject, generateText } from "../src/builtins/llm.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "generation data unavailability test",
);
const space = signer.did();

enableMockMode();

describe("generation data unavailability", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let nextId = 0;

  beforeEach(() => {
    clearMockResponses();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.idle();
    await runtime?.dispose();
    await storageManager?.close();
  });

  async function makeTextAction(params: BuiltInGenerateTextParams) {
    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      `generation-text-parent-${nextId}`,
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<BuiltInGenerateTextParams>(
      space,
      `generation-text-inputs-${nextId++}`,
      undefined,
      setupTx,
    );
    inputsCell.set(params);
    await setupTx.commit();

    let state: Cell<any> | undefined;
    const action = generateText(
      inputsCell,
      (_tx, result) => state = result,
      () => {},
      [],
      parentCell,
      runtime,
    );
    return {
      action,
      inputsCell,
      parentCell,
      get state(): Cell<any> {
        if (!state) throw new Error("generateText state was not initialized");
        return state;
      },
    };
  }

  async function makeObjectAction(params: BuiltInGenerateObjectParams) {
    const setupTx = runtime.edit();
    const parentCell = runtime.getCell(
      space,
      `generation-object-parent-${nextId}`,
      undefined,
      setupTx,
    );
    const inputsCell = runtime.getCell<BuiltInGenerateObjectParams>(
      space,
      `generation-object-inputs-${nextId++}`,
      undefined,
      setupTx,
    );
    inputsCell.set(params);
    await setupTx.commit();

    let state: Cell<any> | undefined;
    const action = generateObject(
      inputsCell,
      (_tx, result) => state = result,
      () => {},
      [],
      parentCell,
      runtime,
    );
    return {
      action,
      inputsCell,
      parentCell,
      get state(): Cell<any> {
        if (!state) throw new Error("generateObject state was not initialized");
        return state;
      },
    };
  }

  function invoke(action: Action): IExtendedStorageTransaction {
    const tx = runtime.edit();
    action(tx);
    return tx;
  }

  function rawResult(state: Cell<any>, tx?: IExtendedStorageTransaction) {
    return state.key("result").withTx(tx).resolveAsCell().getRaw();
  }

  async function waitForPendingToBecomeFalse(state: Cell<any>): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      await runtime.idle();
      if ((state.key("pending").get() as unknown) === false) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timeout waiting for generation pending=false");
  }

  async function waitForResult(
    state: Cell<any>,
    predicate: (value: unknown) => boolean,
  ): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      await runtime.idle();
      if (predicate(rawResult(state))) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `Timeout waiting for generation result: ${
        JSON.stringify({
          result: rawResult(state),
          pending: state.key("pending").get(),
          error: state.key("error").get(),
        })
      }`,
    );
  }

  async function waitForCallCount(
    getCount: () => number,
    expected: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (getCount() >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timeout waiting for ${expected} provider calls`);
  }

  function rehydrateTextAction(
    inputsCell: Cell<BuiltInGenerateTextParams>,
    parentCell: Cell<any>,
  ) {
    let state: Cell<any> | undefined;
    const action = generateText(
      inputsCell,
      (_tx, result) => state = result,
      () => {},
      [],
      parentCell,
      runtime,
    );
    return {
      action,
      get state(): Cell<any> {
        if (!state) throw new Error("generateText state was not rehydrated");
        return state;
      },
    };
  }

  function rehydrateObjectAction(
    inputsCell: Cell<BuiltInGenerateObjectParams>,
    parentCell: Cell<any>,
  ) {
    let state: Cell<any> | undefined;
    const action = generateObject(
      inputsCell,
      (_tx, result) => state = result,
      () => {},
      [],
      parentCell,
      runtime,
    );
    return {
      action,
      get state(): Cell<any> {
        if (!state) throw new Error("generateObject state was not rehydrated");
        return state;
      },
    };
  }

  async function seedLegacyTerminalState(
    state: Cell<any>,
    error: string | undefined,
    pending: boolean,
  ): Promise<void> {
    const tx = runtime.edit();
    state.key("result").withTx(tx).setRawUntyped(undefined);
    state.key("error").withTx(tx).set(error);
    state.key("pending").withTx(tx).set(pending);
    tx.prepareCfc();
    const commit = await tx.commit();
    expect(commit.error).toBeUndefined();
  }

  it("uses a pending result for each text request and never exposes stale success", async () => {
    const firstPrompt = "availability text first";
    const secondPrompt = "availability text second";
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === firstPrompt),
      { role: "assistant", content: "first result", id: "first-result" },
    );
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === secondPrompt),
      { role: "assistant", content: "second result", id: "second-result" },
    );
    const originalSendRequest = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      calls++;
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const generation = await makeTextAction({ prompt: firstPrompt });
      const firstTx = invoke(generation.action);
      expect(rawResult(generation.state, firstTx)).toBe(
        DataUnavailable.pending(),
      );
      expect(generation.state.key("pending").withTx(firstTx).get()).toBe(true);
      await firstTx.commit();
      await waitForPendingToBecomeFalse(generation.state);
      expect(generation.state.key("result").get()).toBe("first result");

      const inputTx = runtime.edit();
      generation.inputsCell.withTx(inputTx).set({ prompt: secondPrompt });
      await inputTx.commit();

      const secondTx = runtime.edit();
      generation.action(secondTx);
      expect(rawResult(generation.state, secondTx)).toBe(
        DataUnavailable.pending(),
      );
      expect(generation.state.key("partial").withTx(secondTx).get()).toBe(
        undefined,
      );
      secondTx.prepareCfc();
      const secondCommit = await secondTx.commit();
      expect(secondCommit.error).toBeUndefined();
      await runtime.settled();
      await waitForResult(
        generation.state,
        (value) => value === "second result",
      );

      expect(rawResult(generation.state)).toBe("second result");
      expect(calls).toBe(2);
    } finally {
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("does not publish a stale queued text completion", async () => {
    const firstPrompt = "availability queued text first";
    const secondPrompt = "availability queued text second";
    const queue = "availability-text-queue";
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === firstPrompt),
      { role: "assistant", content: "stale queued text", id: "queued-first" },
    );
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === secondPrompt),
      { role: "assistant", content: "fresh queued text", id: "queued-second" },
    );

    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
    const secondGate = new Promise<void>((resolve) => releaseSecond = resolve);
    const originalSendRequest = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      const request = args[0] as {
        messages?: readonly { content?: unknown }[];
      };
      calls++;
      if (
        request.messages?.some((message) => message.content === firstPrompt)
      ) {
        await firstGate;
      }
      if (
        request.messages?.some((message) => message.content === secondPrompt)
      ) {
        await secondGate;
      }
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const generation = await makeTextAction({ prompt: firstPrompt, queue });
      await invoke(generation.action).commit();
      await waitForCallCount(() => calls, 1);

      const inputTx = runtime.edit();
      generation.inputsCell.withTx(inputTx).set({
        prompt: secondPrompt,
        queue,
      });
      await inputTx.commit();
      const secondTx = invoke(generation.action);
      expect(rawResult(generation.state, secondTx)).toBe(
        DataUnavailable.pending(),
      );
      await secondTx.commit();

      releaseFirst?.();
      await waitForCallCount(() => calls, 2);
      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rawResult(generation.state)).toBe(DataUnavailable.pending());
      expect(generation.state.key("pending").get()).toBe(true);

      releaseSecond?.();
      await waitForResult(
        generation.state,
        (value) => value === "fresh queued text",
      );
    } finally {
      releaseFirst?.();
      releaseSecond?.();
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("revalidates a stale text completion inside a conflict retry", async () => {
    const oldPrompt = "availability conflict old text";
    const newPrompt = "availability conflict new text";
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === oldPrompt),
      { role: "assistant", content: "stale conflict text", id: "conflict-old" },
    );
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === newPrompt),
      { role: "assistant", content: "fresh conflict text", id: "conflict-new" },
    );

    const releaseOld = Promise.withResolvers<void>();
    const releaseNew = Promise.withResolvers<void>();
    const retryCommitted = Promise.withResolvers<void>();
    const originalSendRequest = LLMClient.prototype.sendRequest;
    const originalRuntimeEdit = runtime.edit.bind(runtime);
    let calls = 0;
    let forceWritebackConflict = false;
    let observeRetryCommit = false;

    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      const request = args[0] as {
        messages?: readonly { content?: unknown }[];
      };
      calls++;
      if (
        request.messages?.some((message) => message.content === oldPrompt)
      ) {
        await releaseOld.promise;
      }
      if (
        request.messages?.some((message) => message.content === newPrompt)
      ) {
        await releaseNew.promise;
      }
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const generation = await makeTextAction({ prompt: oldPrompt });
      await invoke(generation.action).commit();
      await waitForCallCount(() => calls, 1);

      // Force the old completion's first editWithRetry commit to conflict.
      // Before editWithRetry invokes its callback again, publish a newer
      // request's pending state. The retried callback must re-check run
      // identity and become a no-op rather than replaying the stale success.
      runtime.edit = ((...args: Parameters<Runtime["edit"]>) => {
        const retryTx = originalRuntimeEdit(...args);
        if (forceWritebackConflict) {
          forceWritebackConflict = false;
          retryTx.commit = (async () => {
            retryTx.abort("forced stale generation writeback conflict");

            const inputTx = originalRuntimeEdit();
            generation.inputsCell.withTx(inputTx).set({ prompt: newPrompt });
            const inputCommit = await inputTx.commit();
            expect(inputCommit.error).toBeUndefined();

            const pendingTx = originalRuntimeEdit();
            generation.action(pendingTx);
            expect(rawResult(generation.state, pendingTx)).toBe(
              DataUnavailable.pending(),
            );
            pendingTx.prepareCfc();
            const pendingCommit = await pendingTx.commit();
            expect(pendingCommit.error).toBeUndefined();

            observeRetryCommit = true;
            return {
              error: {
                name: "ConflictError",
                message: "forced stale generation writeback conflict",
                readyToRetry: () => Promise.resolve(),
              },
            } as Awaited<ReturnType<typeof retryTx.commit>>;
          }) as typeof retryTx.commit;
        } else if (observeRetryCommit) {
          observeRetryCommit = false;
          const commit = retryTx.commit.bind(retryTx);
          retryTx.commit = (async () => {
            const result = await commit();
            retryCommitted.resolve();
            return result;
          }) as typeof retryTx.commit;
        }
        return retryTx;
      }) as typeof runtime.edit;

      forceWritebackConflict = true;
      releaseOld.resolve();
      await retryCommitted.promise;
      await waitForCallCount(() => calls, 2);

      expect(rawResult(generation.state)).toBe(DataUnavailable.pending());
      expect(generation.state.key("pending").get()).toBe(true);

      runtime.edit = originalRuntimeEdit;
      releaseNew.resolve();
      await waitForResult(
        generation.state,
        (value) => value === "fresh conflict text",
      );
      expect(calls).toBe(2);
    } finally {
      runtime.edit = originalRuntimeEdit;
      releaseOld.resolve();
      releaseNew.resolve();
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("propagates unavailable text inputs without invoking the provider", async () => {
    const marker = DataUnavailable.error(new Error("upstream prompt failed"));
    const originalSendRequest = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      calls++;
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const generation = await makeTextAction({
        prompt: marker as unknown as string,
      });
      const tx = invoke(generation.action);

      const result = rawResult(generation.state, tx) as DataUnavailable;
      expect(result.reason).toBe("error");
      expect(result.error?.message).toBe("upstream prompt failed");
      expect(generation.state.key("pending").withTx(tx).get()).toBe(false);
      expect(generation.state.key("error").withTx(tx).get()).toBe(
        "upstream prompt failed",
      );

      await tx.commit();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(0);
    } finally {
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("propagates a builder-linked text prompt without invoking the provider", async () => {
    const marker = DataUnavailable.pending();
    const originalSendRequest = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      calls++;
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const { commonfabric } = createTrustedBuilder(runtime);
      const testPattern = commonfabric.pattern(() => {
        const linkedPrompt = commonfabric.Cell.of(marker, true);
        return commonfabric.generateTextStream({
          prompt: linkedPrompt as any,
        });
      });
      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        `generation-linked-text-${nextId++}`,
        testPattern.resultSchema,
        tx,
      );
      const state = runtime.run(tx, testPattern, {}, resultCell);
      await tx.commit();
      await runtime.settled();

      expect(rawResult(state)).toBe(marker);
      expect(state.key("pending").get()).toBe(true);
      expect(calls).toBe(0);
    } finally {
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("stores provider failures as error results while retaining legacy error state", async () => {
    const generation = await makeTextAction({
      prompt: "availability missing mock response",
    });
    const tx = invoke(generation.action);
    await tx.commit();
    await waitForPendingToBecomeFalse(generation.state);

    const result = rawResult(generation.state) as DataUnavailable;
    expect(result.reason).toBe("error");
    expect(result.error?.message).toContain("no matching mock response");
    expect(generation.state.key("error").get()).toContain(
      "no matching mock response",
    );
  });

  it("upgrades a persisted legacy text error without retrying the provider", async () => {
    const prompt = "availability legacy text error";
    addMockResponse(
      (request) =>
        request.messages.some((message) => message.content === prompt),
      { role: "assistant", content: "seed text", id: "legacy-text-seed" },
    );
    const originalSendRequest = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      calls++;
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const generation = await makeTextAction({ prompt });
      await invoke(generation.action).commit();
      await waitForResult(generation.state, (value) => value === "seed text");
      expect(calls).toBe(1);

      await seedLegacyTerminalState(
        generation.state,
        "persisted legacy text failure",
        false,
      );
      expect(rawResult(generation.state)).toBeUndefined();

      const rehydrated = rehydrateTextAction(
        generation.inputsCell,
        generation.parentCell,
      );
      const tx = invoke(rehydrated.action);
      const result = rawResult(rehydrated.state, tx) as DataUnavailable;
      expect(result.reason).toBe("error");
      expect(result.error?.message).toBe("persisted legacy text failure");
      expect(rehydrated.state.key("pending").withTx(tx).get()).toBe(false);
      tx.prepareCfc();
      const commit = await tx.commit();
      expect(commit.error).toBeUndefined();

      expect(calls).toBe(1);
    } finally {
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("restarts a persisted legacy pending text request", async () => {
    const prompt = "availability legacy pending text";
    const matchesPrompt = (request: {
      messages: readonly { content?: unknown }[];
    }) => request.messages.some((message) => message.content === prompt);
    addMockResponse(matchesPrompt, {
      role: "assistant",
      content: "seed pending text",
      id: "legacy-pending-text-seed",
    });
    addMockResponse(matchesPrompt, {
      role: "assistant",
      content: "restarted pending text",
      id: "legacy-pending-text-restart",
    });
    const originalSendRequest = LLMClient.prototype.sendRequest;
    let calls = 0;
    LLMClient.prototype.sendRequest = async function (...args: unknown[]) {
      calls++;
      return await originalSendRequest.apply(this, args as never);
    };

    try {
      const generation = await makeTextAction({ prompt });
      await invoke(generation.action).commit();
      await waitForResult(
        generation.state,
        (value) => value === "seed pending text",
      );

      await seedLegacyTerminalState(generation.state, undefined, true);
      const rehydrated = rehydrateTextAction(
        generation.inputsCell,
        generation.parentCell,
      );
      const tx = invoke(rehydrated.action);
      expect(rawResult(rehydrated.state, tx)).toBe(DataUnavailable.pending());
      expect(rehydrated.state.key("pending").withTx(tx).get()).toBe(true);
      tx.prepareCfc();
      const commit = await tx.commit();
      expect(commit.error).toBeUndefined();
      await waitForResult(
        rehydrated.state,
        (value) => value === "restarted pending text",
      );

      expect(calls).toBe(2);
    } finally {
      LLMClient.prototype.sendRequest = originalSendRequest;
    }
  });

  it("uses pending then a usable object for a successful object request", async () => {
    const prompt = "availability object success";
    addMockObjectResponse(
      (request) =>
        request.messages.some((message) => message.content === prompt),
      { object: { title: "usable" }, id: "usable-object" },
    );
    const generation = await makeObjectAction({
      prompt,
      schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    });
    const tx = invoke(generation.action);

    expect(rawResult(generation.state, tx)).toBe(DataUnavailable.pending());
    await tx.commit();
    await waitForResult(
      generation.state,
      (value) =>
        typeof value === "object" && value !== null &&
        (value as { title?: unknown }).title === "usable",
    );
    expect(rawResult(generation.state)).toEqual({ title: "usable" });
  });

  it("does not publish a stale queued object completion", async () => {
    const firstPrompt = "availability queued object first";
    const secondPrompt = "availability queued object second";
    const queue = "availability-object-queue";
    const schema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    } as const;
    addMockObjectResponse(
      (request) =>
        request.messages.some((message) => message.content === firstPrompt),
      { object: { title: "stale queued object" }, id: "queued-object-first" },
    );
    addMockObjectResponse(
      (request) =>
        request.messages.some((message) => message.content === secondPrompt),
      { object: { title: "fresh queued object" }, id: "queued-object-second" },
    );

    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => releaseFirst = resolve);
    const secondGate = new Promise<void>((resolve) => releaseSecond = resolve);
    const originalGenerateObject = LLMClient.prototype.generateObject;
    let calls = 0;
    LLMClient.prototype.generateObject = async function (...args: unknown[]) {
      const request = args[0] as {
        messages?: readonly { content?: unknown }[];
      };
      calls++;
      if (
        request.messages?.some((message) => message.content === firstPrompt)
      ) {
        await firstGate;
      }
      if (
        request.messages?.some((message) => message.content === secondPrompt)
      ) {
        await secondGate;
      }
      return await originalGenerateObject.apply(this, args as never);
    };

    try {
      const generation = await makeObjectAction({
        prompt: firstPrompt,
        schema,
        queue,
      });
      await invoke(generation.action).commit();
      await waitForCallCount(() => calls, 1);

      const inputTx = runtime.edit();
      generation.inputsCell.withTx(inputTx).set({
        prompt: secondPrompt,
        schema,
        queue,
      });
      await inputTx.commit();
      const secondTx = invoke(generation.action);
      expect(rawResult(generation.state, secondTx)).toBe(
        DataUnavailable.pending(),
      );
      await secondTx.commit();

      releaseFirst?.();
      await waitForCallCount(() => calls, 2);
      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rawResult(generation.state)).toBe(DataUnavailable.pending());
      expect(generation.state.key("pending").get()).toBe(true);

      releaseSecond?.();
      await waitForResult(
        generation.state,
        (value) =>
          typeof value === "object" && value !== null &&
          (value as { title?: unknown }).title === "fresh queued object",
      );
    } finally {
      releaseFirst?.();
      releaseSecond?.();
      LLMClient.prototype.generateObject = originalGenerateObject;
    }
  });

  it("stores response-schema failures as schema-mismatch results", async () => {
    const prompt = "availability object schema mismatch";
    addMockObjectResponse(
      (request) =>
        request.messages.some((message) => message.content === prompt),
      { object: { count: 1 }, id: "invalid-object" },
    );
    const generation = await makeObjectAction({
      prompt,
      schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    });
    const tx = invoke(generation.action);
    await tx.commit();
    await waitForPendingToBecomeFalse(generation.state);

    const result = rawResult(generation.state) as DataUnavailable;
    expect(result.reason).toBe("schema-mismatch");
    expect(generation.state.key("error").get()).toContain(
      "failed schema validation",
    );
  });

  it("upgrades a persisted legacy object error without retrying the provider", async () => {
    const prompt = "availability legacy object error";
    const schema = {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    } as const;
    addMockObjectResponse(
      (request) =>
        request.messages.some((message) => message.content === prompt),
      { object: { title: "seed object" }, id: "legacy-object-seed" },
    );
    const originalGenerateObject = LLMClient.prototype.generateObject;
    let calls = 0;
    LLMClient.prototype.generateObject = async function (...args: unknown[]) {
      calls++;
      return await originalGenerateObject.apply(this, args as never);
    };

    try {
      const generation = await makeObjectAction({ prompt, schema });
      await invoke(generation.action).commit();
      await waitForResult(
        generation.state,
        (value) =>
          typeof value === "object" && value !== null &&
          (value as { title?: unknown }).title === "seed object",
      );
      expect(calls).toBe(1);

      await seedLegacyTerminalState(
        generation.state,
        "persisted legacy object failure",
        false,
      );
      expect(rawResult(generation.state)).toBeUndefined();

      const rehydrated = rehydrateObjectAction(
        generation.inputsCell,
        generation.parentCell,
      );
      const tx = invoke(rehydrated.action);
      const result = rawResult(rehydrated.state, tx) as DataUnavailable;
      expect(result.reason).toBe("error");
      expect(result.error?.message).toBe("persisted legacy object failure");
      expect(rehydrated.state.key("pending").withTx(tx).get()).toBe(false);
      tx.prepareCfc();
      const commit = await tx.commit();
      expect(commit.error).toBeUndefined();

      expect(calls).toBe(1);
    } finally {
      LLMClient.prototype.generateObject = originalGenerateObject;
    }
  });

  it("propagates unavailable object inputs without invoking the provider", async () => {
    const marker = DataUnavailable.pending();
    const originalGenerateObject = LLMClient.prototype.generateObject;
    let calls = 0;
    LLMClient.prototype.generateObject = async function (...args: unknown[]) {
      calls++;
      return await originalGenerateObject.apply(this, args as never);
    };

    try {
      const generation = await makeObjectAction({
        prompt: marker as unknown as string,
        schema: { type: "object" },
      });
      const tx = invoke(generation.action);

      expect(rawResult(generation.state, tx)).toBe(marker);
      expect(generation.state.key("pending").withTx(tx).get()).toBe(true);
      expect(generation.state.key("messages").withTx(tx).get()).toBeUndefined();

      await tx.commit();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(calls).toBe(0);
    } finally {
      LLMClient.prototype.generateObject = originalGenerateObject;
    }
  });

  it("propagates a builder-linked object prompt without invoking the provider", async () => {
    const marker = DataUnavailable.error(new Error("linked prompt failed"));
    const originalGenerateObject = LLMClient.prototype.generateObject;
    let calls = 0;
    LLMClient.prototype.generateObject = async function (...args: unknown[]) {
      calls++;
      return await originalGenerateObject.apply(this, args as never);
    };

    try {
      const { commonfabric } = createTrustedBuilder(runtime);
      const testPattern = commonfabric.pattern(() => {
        const linkedPrompt = commonfabric.Cell.of(marker, true);
        return commonfabric.generateObjectStream({
          prompt: linkedPrompt as any,
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        });
      });
      const tx = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        `generation-linked-object-${nextId++}`,
        testPattern.resultSchema,
        tx,
      );
      const state = runtime.run(tx, testPattern, {}, resultCell);
      await tx.commit();
      await runtime.settled();

      const result = rawResult(state) as DataUnavailable;
      expect(result.reason).toBe("error");
      expect(result.error?.message).toBe("linked prompt failed");
      expect(state.key("pending").get()).toBe(false);
      expect(calls).toBe(0);
    } finally {
      LLMClient.prototype.generateObject = originalGenerateObject;
    }
  });

  // Keep this last: compiling the fixture installs SES lockdown for the host
  // process, which is the boundary this regression deliberately exercises.
  it("publishes a terminal stream error to a guarded resultOf consumer", async () => {
    // This mirrors ChatNote's completion shape: one compute observes pending
    // and error on the request while consuming its policy-free usable
    // projection. The deterministic provider failure crosses the pre-SES /
    // post-lockdown Error boundary and must still become an error marker so the
    // guard can release the local generation latch.
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
          import {
            computed,
            generateTextStream,
            hasError,
            isPending,
            pattern,
            resultOf,
            Writable,
          } from "commonfabric";

          export default pattern(() => {
            const response = generateTextStream({
              prompt: "guarded resultOf terminal failure",
            });
            const result = resultOf(response.result);
            const isGenerating = new Writable(true);

            computed(() => {
              const generating = isGenerating.get();
              const pending = isPending(response.result);
              const value = result;
              if (hasError(response.result)) {
                if (generating) isGenerating.set(false);
                return;
              }
              if (!pending && value.length > 0 && generating) {
                isGenerating.set(false);
              }
            });

            return { isGenerating };
          });
        `,
      }],
    });
    const tx = runtime.edit();
    const resultCell = runtime.getCell<{ isGenerating: boolean }>(
      space,
      `guarded-result-stream-${nextId++}`,
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(tx, compiled, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    // Mock mode is deliberately enabled without a matching response. The
    // provider path deterministically publishes a terminal error marker.
    await runtime.settled();
    await runtime.idle();

    expect(await result.key("isGenerating").pull()).toBe(false);
  });
});
