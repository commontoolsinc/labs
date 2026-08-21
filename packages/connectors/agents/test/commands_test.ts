import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { CommandLedger } from "../src/command-ledger.ts";
import {
  type AgentSessionCommandReceipt,
  type CommandTarget,
  CommandWorker,
  parseCommandReceipt,
} from "../src/commands.ts";
import { AGENT_CONNECTOR_SCHEMAS } from "../src/protocol.ts";
import type {
  AgentDriver,
  CommandExecutionOptions,
  PromptInput,
} from "../src/types.ts";

Deno.test("command worker claims before execution and deduplicates command ids", async () => {
  const dir = await Deno.makeTempDir();
  const ledger = await CommandLedger.open(`${dir}/ledger.json`);
  const statuses: string[] = [];
  const target: CommandTarget = {
    publishReceipt: (receipt) => {
      statuses.push(receipt.status);
      return Promise.resolve();
    },
    refreshSession: () => Promise.resolve(),
  };
  let renameCalls = 0;
  const driver = {
    source: {
      id: "fake:default",
      driver: "acp",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: false,
        setConfigOption: false,
      },
    },
    renameSession: () => {
      renameCalls++;
      return Promise.resolve({ status: "succeeded" as const });
    },
  } as unknown as AgentDriver;
  const worker = new CommandWorker(
    new Map([[driver.source.id, driver]]),
    [target],
    ledger,
  );
  const command = {
    schema: AGENT_CONNECTOR_SCHEMAS.command,
    id: "command-1",
    createdAt: "2026-07-09T00:00:00.000Z",
    sourceId: "fake:default",
    nativeSessionId: "session-1",
    type: "rename",
    payload: { title: "New name" },
  };

  await worker.handle([JSON.stringify(command), command]);
  await worker.drain();
  assertEquals(renameCalls, 1);
  assertEquals(statuses, ["in-flight", "succeeded"]);
  assertEquals(ledger.get("command-1")?.status, "succeeded");

  await worker.handle([command]);
  assertEquals(renameCalls, 1);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("commands run concurrently across sessions and cancel bypasses the session queue", async () => {
  const dir = await Deno.makeTempDir();
  const ledger = await CommandLedger.open(`${dir}/ledger.json`);
  const started = new Set<string>();
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => releaseFirst = resolve);
  let bothStarted!: () => void;
  const bothStartedPromise = new Promise<void>((resolve) =>
    bothStarted = resolve
  );
  const driver = {
    source: {
      id: "fake:default",
      driver: "acp",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: false,
        setMode: false,
        setConfigOption: false,
      },
    },
    prompt: async (
      sessionId: string,
      _input: PromptInput,
      options?: CommandExecutionOptions,
    ) => {
      started.add(sessionId);
      if (started.size === 2) bothStarted();
      await options?.onSessionActive?.();
      if (sessionId === "session-1") await firstBlocked;
      return { status: "succeeded" as const };
    },
    cancel: () => {
      releaseFirst();
      return Promise.resolve({ status: "succeeded" as const });
    },
  } as unknown as AgentDriver;
  const target: CommandTarget = {
    publishReceipt: () => Promise.resolve(),
    refreshSession: () => Promise.resolve(),
  };
  const worker = new CommandWorker(
    new Map([[driver.source.id, driver]]),
    [target],
    ledger,
  );
  const command = (id: string, sessionId: string, type = "prompt") => ({
    schema: AGENT_CONNECTOR_SCHEMAS.command,
    id,
    createdAt: "2026-07-09T00:00:00.000Z",
    sourceId: "fake:default",
    nativeSessionId: sessionId,
    type,
    payload: type === "prompt" ? { text: id } : {},
  });

  await worker.handle([
    command("prompt-1", "session-1"),
    command("prompt-2", "session-2"),
  ]);
  await bothStartedPromise;
  assertEquals([...started].sort(), ["session-1", "session-2"]);

  await worker.handle([command("cancel-1", "session-1", "cancel")]);
  await worker.drain();
  assertEquals(ledger.get("cancel-1")?.status, "succeeded");
  assertEquals(ledger.get("prompt-1")?.status, "succeeded");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("cancel waits for an earlier admitted prompt to become active", async () => {
  const dir = await Deno.makeTempDir();
  const ledger = await CommandLedger.open(`${dir}/ledger.json`);
  const invocations: string[] = [];
  const promptFinished = Promise.withResolvers<void>();
  const driver = {
    source: {
      id: "fake:default",
      driver: "acp",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: false,
        setMode: false,
        setConfigOption: false,
      },
    },
    prompt: async (
      _sessionId: string,
      _input: PromptInput,
      options?: CommandExecutionOptions,
    ) => {
      invocations.push("prompt");
      await options?.onSessionActive?.();
      await promptFinished.promise;
      return { status: "succeeded" as const };
    },
    cancel: () => {
      invocations.push("cancel");
      promptFinished.resolve();
      return Promise.resolve({ status: "succeeded" as const });
    },
  } as unknown as AgentDriver;
  const target: CommandTarget = {
    publishReceipt: () => Promise.resolve(),
    refreshSession: () => Promise.resolve(),
  };
  const worker = new CommandWorker(
    new Map([[driver.source.id, driver]]),
    [target],
    ledger,
  );
  const command = (id: string, type: "prompt" | "cancel") => ({
    schema: AGENT_CONNECTOR_SCHEMAS.command,
    id,
    createdAt: "2026-07-09T00:00:00.000Z",
    sourceId: driver.source.id,
    nativeSessionId: "session-1",
    type,
    payload: type === "prompt" ? { text: "continue" } : {},
  });

  try {
    await worker.handle([
      command("prompt-first", "prompt"),
      command("cancel-second", "cancel"),
    ]);
    await worker.drain();
    assertEquals(invocations, ["prompt", "cancel"]);
    assertEquals(ledger.get("prompt-first")?.status, "succeeded");
    assertEquals(ledger.get("cancel-second")?.status, "succeeded");
  } finally {
    promptFinished.resolve();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cancel reaches a prompt while provider metadata is pending", async () => {
  const dir = await Deno.makeTempDir();
  const ledger = await CommandLedger.open(`${dir}/ledger.json`);
  const lookupStarted = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  const cancellationReceived = Promise.withResolvers<void>();
  let cancelled = false;
  let queryStarted = false;
  const driver = {
    source: {
      id: "fake:default",
      driver: "claude-agent-sdk",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: false,
        setMode: false,
        setConfigOption: false,
      },
    },
    prompt: async (
      _sessionId: string,
      _input: PromptInput,
      options?: CommandExecutionOptions,
    ) => {
      options?.onCancellationReady?.();
      lookupStarted.resolve();
      await releaseLookup.promise;
      if (cancelled) {
        return {
          status: "failed" as const,
          error: {
            code: "cancelled",
            message: "prompt was cancelled during metadata lookup",
            retryable: false,
          },
        };
      }
      queryStarted = true;
      await options?.onSessionActive?.();
      return { status: "succeeded" as const };
    },
    cancel: () => {
      cancelled = true;
      cancellationReceived.resolve();
      return Promise.resolve({ status: "succeeded" as const });
    },
  } as unknown as AgentDriver;
  const target: CommandTarget = {
    publishReceipt: () => Promise.resolve(),
    refreshSession: () => Promise.resolve(),
  };
  const worker = new CommandWorker(
    new Map([[driver.source.id, driver]]),
    [target],
    ledger,
  );
  const command = (id: string, type: "prompt" | "cancel") => ({
    schema: AGENT_CONNECTOR_SCHEMAS.command,
    id,
    createdAt: "2026-07-09T00:00:00.000Z",
    sourceId: driver.source.id,
    nativeSessionId: "session-1",
    type,
    payload: type === "prompt" ? { text: "continue" } : {},
  });

  try {
    await worker.handle([
      command("prompt-with-metadata", "prompt"),
      command("cancel-during-metadata", "cancel"),
    ]);
    await lookupStarted.promise;
    await cancellationReceived.promise;
    assertEquals(queryStarted, false);
    releaseLookup.resolve();
    await worker.drain();
    assertEquals(ledger.get("prompt-with-metadata")?.status, "failed");
    assertEquals(ledger.get("cancel-during-metadata")?.status, "succeeded");
  } finally {
    releaseLookup.resolve();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prompt commands publish session state while running and after completion", async () => {
  const dir = await Deno.makeTempDir();
  const ledger = await CommandLedger.open(`${dir}/ledger.json`);
  let active = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  let allowStart!: () => void;
  const startAllowed = new Promise<void>((resolve) => allowStart = resolve);
  let markPromptEntered!: () => void;
  const promptEntered = new Promise<void>((resolve) =>
    markPromptEntered = resolve
  );
  let markRunningRefresh!: () => void;
  const runningRefresh = new Promise<void>((resolve) =>
    markRunningRefresh = resolve
  );
  const refreshedStates: boolean[] = [];
  const driver = {
    source: {
      id: "fake:default",
      driver: "acp",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: false,
        setMode: false,
        setConfigOption: false,
      },
    },
    prompt: async (
      _sessionId: string,
      _input: PromptInput,
      options?: CommandExecutionOptions,
    ) => {
      markPromptEntered();
      await startAllowed;
      active = true;
      await options?.onSessionActive?.();
      await blocked;
      active = false;
      return { status: "succeeded" as const };
    },
  } as unknown as AgentDriver;
  const target: CommandTarget = {
    publishReceipt: () => Promise.resolve(),
    refreshSession: () => {
      refreshedStates.push(active);
      if (active) markRunningRefresh();
      return Promise.resolve();
    },
  };
  const worker = new CommandWorker(
    new Map([[driver.source.id, driver]]),
    [target],
    ledger,
  );

  try {
    await worker.handle([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      id: "prompt-activity",
      createdAt: "2026-07-09T00:00:00.000Z",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      type: "prompt",
      payload: { text: "continue" },
    }]);
    await promptEntered;
    assertEquals(refreshedStates, []);
    allowStart();
    await runningRefresh;
    assertEquals(refreshedStates, [true]);
    release();
    await worker.drain();
    assertEquals(refreshedStates, [true, false]);
  } finally {
    allowStart();
    release();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("failed prompts publish terminal session state", async () => {
  const dir = await Deno.makeTempDir();
  const ledger = await CommandLedger.open(`${dir}/ledger.json`);
  let active = false;
  const refreshedStates: boolean[] = [];
  const driver = {
    source: {
      id: "fake:default",
      driver: "acp",
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: false,
        setMode: false,
        setConfigOption: false,
      },
    },
    prompt: async (
      _sessionId: string,
      _input: PromptInput,
      options?: CommandExecutionOptions,
    ) => {
      active = true;
      await options?.onSessionActive?.();
      active = false;
      return {
        status: "failed" as const,
        error: {
          code: "provider-rejected",
          message: "provider rejected prompt",
          retryable: false,
        },
      };
    },
  } as unknown as AgentDriver;
  const target: CommandTarget = {
    publishReceipt: () => Promise.resolve(),
    refreshSession: () => {
      refreshedStates.push(active);
      return Promise.resolve();
    },
  };
  const worker = new CommandWorker(
    new Map([[driver.source.id, driver]]),
    [target],
    ledger,
  );

  try {
    await worker.handle([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      id: "failed-prompt-activity",
      createdAt: "2026-07-09T00:00:00.000Z",
      sourceId: driver.source.id,
      nativeSessionId: "session-1",
      type: "prompt",
      payload: { text: "continue" },
    }]);
    await worker.drain();
    assertEquals(refreshedStates, [true, false]);
    assertEquals(ledger.get("failed-prompt-activity")?.status, "failed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("in-flight commands from a prior process become unknown", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/ledger.json`;
  const ledger = await CommandLedger.open(path);
  await ledger.put({
    schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
    commandId: "orphan",
    sourceId: "fake:default",
    nativeSessionId: "session-1",
    status: "in-flight",
    claimedAt: "2026-07-09T00:00:00.000Z",
  });

  const reopened = await CommandLedger.open(path);
  assertEquals(
    (await reopened.recoverUnpublishedReceipts()).map((receipt) =>
      receipt.status
    ),
    ["unknown"],
  );
  assertEquals(reopened.get("orphan")?.status, "unknown");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("terminal receipts that failed to publish are replayed after restart", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/ledger.json`;
  try {
    const ledger = await CommandLedger.open(path);
    let renameCalls = 0;
    let refreshCalls = 0;
    const driver = {
      source: {
        id: "fake:default",
        driver: "acp",
        capabilities: {
          inventory: true,
          read: true,
          prompt: true,
          cancel: true,
          rename: true,
          setMode: false,
          setConfigOption: false,
        },
      },
      renameSession: () => {
        renameCalls++;
        return Promise.resolve({ status: "succeeded" as const });
      },
    } as unknown as AgentDriver;
    const firstTarget: CommandTarget = {
      publishReceipt: (receipt) =>
        receipt.status === "succeeded"
          ? Promise.reject(new Error("receipt publication rejected"))
          : Promise.resolve(),
      refreshSession: () => {
        refreshCalls++;
        return Promise.resolve();
      },
    };
    const firstWorker = new CommandWorker(
      new Map([[driver.source.id, driver]]),
      [firstTarget],
      ledger,
    );
    await firstWorker.handle([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      id: "command-with-unpublished-terminal",
      createdAt: "2026-07-09T00:00:00.000Z",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      type: "rename",
      payload: { title: "New name" },
    }]);
    await assertRejects(
      () => firstWorker.drain(),
      AggregateError,
      "command worker operations failed",
    );
    assertEquals(renameCalls, 1);
    assertEquals(refreshCalls, 1);
    assertEquals(
      ledger.get("command-with-unpublished-terminal")?.status,
      "succeeded",
    );

    const replayedStatuses: string[] = [];
    const reopened = await CommandLedger.open(path);
    const recoveringWorker = new CommandWorker(
      new Map([[driver.source.id, driver]]),
      [{
        publishReceipt: (receipt) => {
          replayedStatuses.push(receipt.status);
          return Promise.resolve();
        },
        refreshSession: () => Promise.resolve(),
      }],
      reopened,
    );
    await recoveringWorker.recoverUnpublishedReceipts();
    assertEquals(replayedStatuses, ["succeeded"]);
    assertEquals(renameCalls, 1);

    const fullyPublished = await CommandLedger.open(path);
    assertEquals(await fullyPublished.recoverUnpublishedReceipts(), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("overlapping ledger writes all survive reopen", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/ledger.json`;
  const ledger = await CommandLedger.open(path);
  const commandIds = Array.from(
    { length: 24 },
    (_, index) => `command-${index}`,
  );

  await Promise.all(commandIds.map((commandId) =>
    ledger.put({
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      commandId,
      sourceId: "fake:default",
      nativeSessionId: `session-${commandId}`,
      status: "in-flight",
      claimedAt: "2026-07-09T00:00:00.000Z",
    })
  ));

  const reopened = await CommandLedger.open(path);
  assertEquals(
    commandIds.filter((commandId) => reopened.get(commandId) === undefined),
    [],
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("command ledger rejects obsolete formats", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/ledger.json`;
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        schema: "commonfabric.agent-connector.command-ledger.v1",
        receipts: {},
      }),
      { mode: 0o600 },
    );
    await assertRejects(
      () => CommandLedger.open(path),
      Error,
      "command ledger schema must be commonfabric.agent-connector.command-ledger.v2",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("command ledger validates receipt keys and contents", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/ledger.json`;
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        schema: AGENT_CONNECTOR_SCHEMAS.commandLedger,
        generation: 1,
        receipts: {
          "stored-key": {
            schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
            commandId: "different-command",
            sourceId: "fake:default",
            nativeSessionId: "session-1",
            status: "succeeded",
          },
        },
        pendingPublicationCommandIds: [],
      }),
      { mode: 0o600 },
    );
    await assertRejects(
      () => CommandLedger.open(path),
      Error,
      "command ledger receipt key does not match commandId: stored-key",
    );

    await Deno.writeTextFile(
      path,
      JSON.stringify({
        schema: AGENT_CONNECTOR_SCHEMAS.commandLedger,
        generation: 1,
        receipts: {
          command: {
            schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
            commandId: "command",
            sourceId: "fake:default",
            nativeSessionId: "session-1",
            status: "not-a-status",
          },
        },
        pendingPublicationCommandIds: [],
      }),
      { mode: 0o600 },
    );
    await assertRejects(
      () => CommandLedger.open(path),
      Error,
      "command ledger receipt status is invalid: command",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("command receipts require canonical identities and timestamps", () => {
  const receipt: AgentSessionCommandReceipt = {
    schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
    commandId: "command",
    sourceId: "fake:default",
    nativeSessionId: "session-1",
    status: "succeeded",
    claimedAt: "2026-07-20T00:00:00.000Z",
  };
  assertEquals(parseCommandReceipt("command", receipt), receipt);
  assertThrows(
    () =>
      parseCommandReceipt("command", {
        ...receipt,
        nativeSessionId: " session-1 ",
      }),
    Error,
    "nativeSessionId is not normalized",
  );
  assertThrows(
    () =>
      parseCommandReceipt("command", {
        ...receipt,
        claimedAt: "not-a-timestamp",
      }),
    Error,
    "claimedAt must be an ISO timestamp",
  );
});

Deno.test("command ledger writes private files in a private directory", async () => {
  const root = await Deno.makeTempDir();
  const directory = `${root}/state`;
  const path = `${directory}/ledger.json`;
  try {
    const ledger = await CommandLedger.open(path);
    await ledger.put({
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      commandId: "command",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      status: "in-flight",
    });
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(directory)).mode! & 0o077, 0);
      assertEquals((await Deno.stat(path)).mode! & 0o077, 0);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a published receipt prevents execution with a fresh local ledger", async () => {
  const directory = await Deno.makeTempDir();
  try {
    let renameCalls = 0;
    const receipts = new Map<
      string,
      Parameters<CommandTarget["publishReceipt"]>[0]
    >();
    const target: CommandTarget = {
      publishReceipt: (receipt) => {
        receipts.set(receipt.commandId, structuredClone(receipt));
        return Promise.resolve();
      },
      readReceipt: (commandId) =>
        Promise.resolve(structuredClone(receipts.get(commandId))),
      refreshSession: () => Promise.resolve(),
    };
    const driver = {
      source: {
        id: "fake:default",
        driver: "acp",
        capabilities: {
          inventory: true,
          read: true,
          prompt: false,
          cancel: false,
          rename: true,
          setMode: false,
          setConfigOption: false,
        },
      },
      renameSession: () => {
        renameCalls++;
        return Promise.resolve({ status: "succeeded" as const });
      },
    } as unknown as AgentDriver;
    const command = {
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      id: "shared-command",
      createdAt: "2026-07-20T00:00:00.000Z",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      type: "rename",
      payload: { title: "Shared claim" },
    };

    const first = new CommandWorker(
      new Map([[driver.source.id, driver]]),
      [target],
      await CommandLedger.open(`${directory}/first/ledger.json`),
    );
    await first.handle([command]);
    await first.drain();
    assertEquals(renameCalls, 1);

    const second = new CommandWorker(
      new Map([[driver.source.id, driver]]),
      [target],
      await CommandLedger.open(`${directory}/second/ledger.json`),
    );
    await second.handle([command]);
    await second.drain();
    assertEquals(renameCalls, 1);
    assertEquals(receipts.get(command.id)?.status, "succeeded");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("equivalent target receipts do not depend on object key order", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const receipt: AgentSessionCommandReceipt = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      commandId: "shared-command",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      status: "succeeded",
      completedAt: "2026-07-20T00:01:00.000Z",
      result: { renamed: true },
    };
    const reordered: AgentSessionCommandReceipt = {
      result: { renamed: true },
      completedAt: "2026-07-20T00:01:00.000Z",
      status: "succeeded",
      nativeSessionId: "session-1",
      sourceId: "fake:default",
      commandId: "shared-command",
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
    };
    const published: AgentSessionCommandReceipt[] = [];
    const target = (
      existing: AgentSessionCommandReceipt,
    ): CommandTarget => ({
      publishReceipt: (value) => {
        published.push(structuredClone(value));
        return Promise.resolve();
      },
      readReceipt: () => Promise.resolve(structuredClone(existing)),
      refreshSession: () => Promise.resolve(),
    });
    const ledger = await CommandLedger.open(`${directory}/ledger.json`);
    const worker = new CommandWorker(
      new Map(),
      [target(receipt), target(reordered)],
      ledger,
    );

    await worker.handle([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      id: "shared-command",
      createdAt: "2026-07-20T00:00:00.000Z",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      type: "rename",
      payload: { title: "Already applied" },
    }]);
    await worker.drain();

    assertEquals(published.length, 2);
    assertEquals(ledger.get("shared-command")?.status, "succeeded");
    assertEquals(ledger.pendingPublicationCount(), 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("commands reject control characters before creating a claim", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const ledger = await CommandLedger.open(`${directory}/ledger.json`);
    const worker = new CommandWorker(new Map(), [], ledger);
    await worker.handle([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      id: "bad\ncommand",
      createdAt: "2026-07-20T00:00:00.000Z",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      type: "cancel",
      payload: {},
    }, {
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      id: "bad-session-command",
      createdAt: "2026-07-20T00:00:00.000Z",
      sourceId: "fake:default",
      nativeSessionId: "bad\tsession",
      type: "cancel",
      payload: {},
    }]);
    await worker.drain();
    assertEquals(ledger.get("bad\ncommand"), undefined);
    assertEquals(ledger.get("bad-session-command"), undefined);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("commands reject non-record payloads before claiming", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const ledger = await CommandLedger.open(`${directory}/ledger.json`);
    const worker = new CommandWorker(new Map(), [], ledger);
    const base = {
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      createdAt: "2026-07-20T00:00:00.000Z",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      type: "cancel",
    };
    const commands = [
      undefined,
      null,
      "",
      1,
      false,
      [],
      new Date(0),
      new Map(),
    ].map(
      (payload, index) => ({ ...base, id: `bad-payload-${index}`, payload }),
    );
    await worker.handle(commands);
    await worker.drain();
    for (const command of commands) {
      assertEquals(ledger.get(command.id), undefined);
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("synchronous driver failures publish a terminal receipt", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const ledger = await CommandLedger.open(`${directory}/ledger.json`);
    const statuses: string[] = [];
    const driver = {
      source: {
        id: "fake:default",
        driver: "acp",
        capabilities: {
          inventory: true,
          read: true,
          prompt: false,
          cancel: false,
          rename: true,
          setMode: false,
          setConfigOption: false,
        },
      },
      renameSession: () => {
        throw new Error("synchronous provider failure");
      },
    } as unknown as AgentDriver;
    const target: CommandTarget = {
      publishReceipt: (receipt) => {
        statuses.push(receipt.status);
        return Promise.resolve();
      },
      refreshSession: () => Promise.resolve(),
    };
    const worker = new CommandWorker(
      new Map([[driver.source.id, driver]]),
      [target],
      ledger,
    );
    await worker.handle([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      id: "sync-failure",
      createdAt: "2026-07-20T00:00:00.000Z",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      type: "rename",
      payload: { title: "New title" },
    }]);
    await worker.drain();
    assertEquals(statuses, ["in-flight", "failed"]);
    assertEquals(
      ledger.get("sync-failure")?.error?.code,
      "provider-call-failed",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("receipt ownership compares `FabricValue`s", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const ledger = await CommandLedger.open(`${directory}/ledger.json`);
    const receipt: AgentSessionCommandReceipt = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      commandId: "fabric-receipt",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      status: "succeeded",
      result: { value: undefined },
    };
    const target = (result: Record<string, unknown>): CommandTarget => ({
      publishReceipt: () => Promise.resolve(),
      refreshSession: () => Promise.resolve(),
      readReceipt: () => Promise.resolve({ ...receipt, result }),
    });
    const worker = new CommandWorker(
      new Map(),
      [target({ value: undefined }), target({})],
      ledger,
    );
    await worker.handle([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      id: "fabric-receipt",
      createdAt: "2026-07-20T00:00:00.000Z",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      type: "cancel",
      payload: {},
    }]);
    await assertRejects(() => worker.drain(), AggregateError);
    assertEquals(ledger.get("fabric-receipt"), undefined);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("command ledger preserves Fabric receipt results across reopen", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/ledger.json`;
  try {
    const receipt: AgentSessionCommandReceipt = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
      commandId: "fabric-ledger-result",
      sourceId: "fake:default",
      nativeSessionId: "session-1",
      status: "succeeded",
      result: {
        omittedByJson: undefined,
        integer: 2n ** 80n,
        notANumber: NaN,
        infinity: Infinity,
        negativeZero: -0,
      },
    };
    await (await CommandLedger.open(path)).put(receipt);
    assertEquals(
      (await CommandLedger.open(path)).get(receipt.commandId),
      receipt,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
