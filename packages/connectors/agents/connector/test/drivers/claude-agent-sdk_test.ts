import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  ClaudeAgentSdkDriver,
  type ClaudeSdkAdapter,
} from "../../src/drivers/claude-agent-sdk.ts";

function fakeQuery(messages: unknown[]) {
  const generator = (async function* () {
    for (const message of messages) yield message;
  })();
  return Object.assign(generator, {
    interrupt: () => Promise.resolve(),
    setPermissionMode: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    close: () => undefined,
  });
}

Deno.test("Claude driver lists all-project sessions and reads system messages", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const sdk = {
    listSessions: (options?: Record<string, unknown>) => {
      calls.push({ method: "listSessions", args: [options] });
      return Promise.resolve([{
        sessionId: "session-1",
        summary: "First task",
        customTitle: "Renamed task",
        cwd: "/tmp/project",
        createdAt: 1_000,
        lastModified: 2_000,
      }]);
    },
    getSessionInfo: (id: string) => {
      calls.push({ method: "getSessionInfo", args: [id] });
      return Promise.resolve({
        sessionId: id,
        summary: "First task",
        customTitle: "Renamed task",
        cwd: "/tmp/project",
        createdAt: 1_000,
        lastModified: 2_000,
      });
    },
    getSessionMessages: (id: string, options?: Record<string, unknown>) => {
      calls.push({ method: "getSessionMessages", args: [id, options] });
      return Promise.resolve([{
        type: "system",
        uuid: "message-1",
        session_id: id,
        message: { content: "compacted" },
        parent_tool_use_id: null,
        parent_agent_id: null,
      }]);
    },
    renameSession: (id: string, title: string) => {
      calls.push({ method: "renameSession", args: [id, title] });
      return Promise.resolve();
    },
    query: () => {
      throw new Error("not used");
    },
  };
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  const page = await driver.listSessions();
  assertEquals(page.sessions[0].title, "Renamed task");
  assertEquals(page.sessions[0].nativeSessionId, "session-1");
  assertEquals(page.sessions[0].archived, null);
  assertEquals(page.sessions[0].active, null);

  const snapshot = await driver.readSession("session-1");
  assertEquals(snapshot.complete, true);
  assertEquals(snapshot.events.length, 1);
  assertEquals(snapshot.normalizedMessages[0].role, "system");
  assertEquals(
    calls.find((call) => call.method === "getSessionMessages")?.args[1],
    { includeSystemMessages: true },
  );

  assertEquals(
    (await driver.renameSession("session-1", "New title")).status,
    "succeeded",
  );
  assertEquals(calls.at(-1), {
    method: "renameSession",
    args: ["session-1", "New title"],
  });
  assertEquals((await driver.setMode("session-1", "plan")).status, "succeeded");
  assertEquals(
    (await driver.setConfigOption("session-1", "model", "claude-test")).status,
    "succeeded",
  );
});

Deno.test("Claude bypassPermissions mode requires explicit opt-in", () => {
  const source = {
    id: "claude-code:default",
    driver: "claude-agent-sdk" as const,
    enabled: true,
  };
  const safe = new ClaudeAgentSdkDriver(source);
  const dangerous = new ClaudeAgentSdkDriver({
    ...source,
    allowDangerFullAccess: true,
  });
  assertEquals(
    safe.source.capabilities.modes?.includes("bypassPermissions"),
    false,
  );
  assertEquals(
    dangerous.source.capabilities.modes?.includes("bypassPermissions"),
    true,
  );
});

Deno.test("Claude acknowledges bypass permission prompts", async () => {
  let queryOptions: Record<string, unknown> | undefined;
  const sdk = {
    getSessionInfo: () =>
      Promise.resolve({
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      }),
    query: (params: { options?: Record<string, unknown> }) => {
      queryOptions = params.options;
      return fakeQuery([{
        type: "result",
        subtype: "success",
        is_error: false,
      }]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver({
    id: "claude-code:default",
    driver: "claude-agent-sdk",
    enabled: true,
    allowDangerFullAccess: true,
  }, sdk);

  assertEquals(
    (await driver.setMode("session-1", "bypassPermissions")).status,
    "succeeded",
  );
  assertEquals(
    (await driver.prompt("session-1", { text: "continue" })).status,
    "succeeded",
  );
  assertEquals(queryOptions?.permissionMode, "bypassPermissions");
  assertEquals(queryOptions?.allowDangerouslySkipPermissions, true);
});

Deno.test("aborted Claude startup retains the stopped state", async () => {
  let queryCalls = 0;
  const sdk = {
    getSessionInfo: () => Promise.resolve(undefined),
    query: () => {
      queryCalls++;
      return fakeQuery([]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver({
    id: "claude-code:default",
    driver: "claude-agent-sdk",
    enabled: true,
  }, sdk);
  await driver.stop();
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () => driver.start(controller.signal),
    DOMException,
    "aborted",
  );
  assertEquals(
    (await driver.prompt("session-1", { text: "continue" })).error?.code,
    "claude-driver-stopped",
  );
  const started = driver.start();
  await driver.stop();
  await started;
  assertEquals(
    (await driver.prompt("session-1", { text: "continue" })).error?.code,
    "claude-driver-stopped",
  );
  assertEquals(queryCalls, 0);
});

Deno.test("Claude driver reports connector-owned queries as active", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  const info = {
    sessionId: "session-1",
    summary: "First task",
    cwd: "/tmp/project",
    createdAt: 1_000,
    lastModified: 2_000,
  };
  const sdk = {
    listSessions: () => Promise.resolve([info]),
    getSessionInfo: () => Promise.resolve(info),
    getSessionMessages: () => Promise.resolve([]),
    query: () => {
      const generator = (async function* () {
        await blocked;
        yield { type: "result", subtype: "success", is_error: false };
      })();
      return Object.assign(generator, {
        interrupt: () => Promise.resolve(),
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => undefined,
      });
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  await driver.listSessions();
  try {
    const prompt = driver.prompt("session-1", { text: "continue" });
    assertEquals((await driver.listSessions()).sessions[0].active, true);
    assertEquals(
      (await driver.readSession("session-1")).summary.active,
      true,
    );
    release();
    assertEquals((await prompt).status, "succeeded");
    assertEquals((await driver.listSessions()).sessions[0].active, null);
  } finally {
    release();
  }
});

Deno.test("Claude session reads retain activity observed when the read starts", async () => {
  let releasePrompt!: () => void;
  const promptBlocked = new Promise<void>((resolve) => releasePrompt = resolve);
  let releaseRead!: () => void;
  const readBlocked = new Promise<void>((resolve) => releaseRead = resolve);
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => markReadStarted = resolve);
  const info = {
    sessionId: "session-1",
    summary: "First task",
    cwd: "/tmp/project",
    createdAt: 1_000,
    lastModified: 2_000,
  };
  const sdk = {
    listSessions: () => Promise.resolve([info]),
    getSessionInfo: async () => {
      markReadStarted();
      await readBlocked;
      return info;
    },
    getSessionMessages: async () => {
      await readBlocked;
      return [];
    },
    query: () => {
      const generator = (async function* () {
        await promptBlocked;
        yield { type: "result", subtype: "success", is_error: false };
      })();
      return Object.assign(generator, {
        interrupt: () => Promise.resolve(),
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => undefined,
      });
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  await driver.listSessions();
  try {
    const prompt = driver.prompt("session-1", { text: "continue" });
    const read = driver.readSession("session-1");
    await readStarted;
    releasePrompt();
    assertEquals((await prompt).status, "succeeded");
    releaseRead();
    assertEquals((await read).summary.active, true);
  } finally {
    releasePrompt();
    releaseRead();
  }
});

Deno.test("Claude prompt maps terminal SDK errors to failed receipts", async () => {
  const sdk = {
    getSessionInfo: () =>
      Promise.resolve({
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      }),
    query: () =>
      fakeQuery([{
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["turn limit reached"],
      }]),
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );
  const result = await driver.prompt("session-1", { text: "continue" });
  assertEquals(result.status, "failed");
  assertEquals(result.error?.code, "claude-error_max_turns");
  assertStringIncludes(result.error?.message ?? "", "turn limit reached");
});

Deno.test("Claude resumes a session from its recorded working directory", async () => {
  let queryOptions: Record<string, unknown> | undefined;
  const sdk = {
    getSessionInfo: () =>
      Promise.resolve({
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      }),
    query: (params: { options?: Record<string, unknown> }) => {
      queryOptions = params.options;
      return fakeQuery([{
        type: "result",
        subtype: "success",
        is_error: false,
      }]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver({
    id: "claude-code:default",
    driver: "claude-agent-sdk",
    enabled: true,
    cwd: "/host/default",
  }, sdk);

  assertEquals(
    (await driver.prompt("session-1", { text: "continue" })).status,
    "succeeded",
  );
  assertEquals(queryOptions?.cwd, "/session/worktree");
});

Deno.test("Claude rejects a second prompt while resolving session metadata", async () => {
  let releaseLookup!: () => void;
  const lookupBlocked = new Promise<void>((resolve) => releaseLookup = resolve);
  let markLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) =>
    markLookupStarted = resolve
  );
  const sdk = {
    getSessionInfo: async () => {
      markLookupStarted();
      await lookupBlocked;
      return {
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      };
    },
    query: () =>
      fakeQuery([{
        type: "result",
        subtype: "success",
        is_error: false,
      }]),
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  try {
    const first = driver.prompt("session-1", { text: "First" });
    await lookupStarted;
    const second = await driver.prompt("session-1", { text: "Second" });
    assertEquals(second.status, "needs-confirmation");
    assertEquals(second.error?.code, "already-active");
    releaseLookup();
    assertEquals((await first).status, "succeeded");
  } finally {
    releaseLookup();
  }
});

Deno.test("Claude cancels a prompt while resolving session metadata", async () => {
  let releaseLookup!: () => void;
  const lookupBlocked = new Promise<void>((resolve) => releaseLookup = resolve);
  let markLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) =>
    markLookupStarted = resolve
  );
  let queryCalled = false;
  const sdk = {
    getSessionInfo: async () => {
      markLookupStarted();
      await lookupBlocked;
      return {
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      };
    },
    query: () => {
      queryCalled = true;
      return fakeQuery([]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );
  let cancellationReadyCalls = 0;

  try {
    const prompt = driver.prompt("session-1", { text: "continue" }, {
      onCancellationReady: () => {
        cancellationReadyCalls++;
      },
    });
    await lookupStarted;
    assertEquals(cancellationReadyCalls, 1);
    assertEquals((await driver.cancel("session-1")).status, "succeeded");
    releaseLookup();
    const result = await prompt;
    assertEquals(result.status, "failed");
    assertEquals(result.error?.code, "cancelled");
    assertEquals(queryCalled, false);
  } finally {
    releaseLookup();
  }
});

Deno.test("stopping Claude prevents pending and later prompts from starting", async () => {
  let releaseLookup!: () => void;
  const lookupBlocked = new Promise<void>((resolve) => releaseLookup = resolve);
  let markLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) =>
    markLookupStarted = resolve
  );
  let queryCalled = false;
  const sdk = {
    getSessionInfo: async () => {
      markLookupStarted();
      await lookupBlocked;
      return {
        sessionId: "session-1",
        summary: "First task",
        cwd: "/session/worktree",
        createdAt: 1_000,
        lastModified: 2_000,
      };
    },
    query: () => {
      queryCalled = true;
      return fakeQuery([]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  try {
    const pending = driver.prompt("session-1", { text: "continue" });
    await lookupStarted;
    await driver.stop();
    releaseLookup();
    const pendingResult = await pending;
    assertEquals(pendingResult.status, "failed");
    assertEquals(pendingResult.error?.code, "claude-driver-stopped");
    assertEquals(
      (await driver.prompt("session-2", { text: "later" })).error?.code,
      "claude-driver-stopped",
    );
    assertEquals(queryCalled, false);
  } finally {
    releaseLookup();
  }
});

Deno.test("a stopped Claude query cannot untrack its replacement", async () => {
  let releaseStopped!: () => void;
  const stoppedBlocked = new Promise<void>((resolve) =>
    releaseStopped = resolve
  );
  let releaseReplacement!: () => void;
  const replacementBlocked = new Promise<void>((resolve) =>
    releaseReplacement = resolve
  );
  let queryCount = 0;
  let replacementInterrupted = false;
  const info = {
    sessionId: "session-1",
    summary: "First task",
    cwd: "/session/worktree",
    createdAt: 1_000,
    lastModified: 2_000,
  };
  const sdk = {
    listSessions: () => Promise.resolve([info]),
    query: () => {
      const isReplacement = queryCount++ > 0;
      const generator = (async function* () {
        await (isReplacement ? replacementBlocked : stoppedBlocked);
        yield { type: "result", subtype: "success", is_error: false };
      })();
      return Object.assign(generator, {
        interrupt: () => {
          if (isReplacement) replacementInterrupted = true;
          return Promise.resolve();
        },
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => undefined,
      });
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  await driver.listSessions();
  try {
    const stoppedPrompt = driver.prompt("session-1", { text: "First" });
    await driver.stop();
    await driver.start();
    const replacementPrompt = driver.prompt("session-1", { text: "Second" });

    releaseStopped();
    assertEquals((await stoppedPrompt).status, "succeeded");
    assertEquals((await driver.cancel("session-1")).status, "succeeded");
    assertEquals(replacementInterrupted, true);

    releaseReplacement();
    assertEquals((await replacementPrompt).status, "succeeded");
  } finally {
    releaseStopped();
    releaseReplacement();
  }
});

Deno.test("Claude reports a missing prompt session before starting a query", async () => {
  let queryCalled = false;
  const sdk = {
    getSessionInfo: () => Promise.resolve(undefined),
    query: () => {
      queryCalled = true;
      return fakeQuery([]);
    },
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  const result = await driver.prompt("missing-session", { text: "continue" });
  assertEquals(result.status, "failed");
  assertEquals(result.error?.code, "claude-session-not-found");
  assertEquals(queryCalled, false);
});

Deno.test("Claude reports session lookup failures as retryable", async () => {
  const sdk = {
    getSessionInfo: () => Promise.reject(new Error("metadata unavailable")),
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  const result = await driver.prompt("session-1", { text: "continue" });
  assertEquals(result.status, "failed");
  assertEquals(result.error?.code, "claude-session-lookup-failed");
  assertEquals(result.error?.retryable, true);
  assertStringIncludes(result.error?.message ?? "", "metadata unavailable");
});

Deno.test("Claude interrupted query without a terminal result is unknown", async () => {
  let release!: () => void;
  let markStarted!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  const started = new Promise<void>((resolve) => markStarted = resolve);
  const generator = (async function* () {
    markStarted();
    await blocked;
  })();
  const query = Object.assign(generator, {
    interrupt: () => {
      release();
      return Promise.resolve();
    },
    setPermissionMode: () => Promise.resolve(),
    setModel: () => Promise.resolve(),
    close: () => release(),
  });
  const sdk = {
    getSessionInfo: () =>
      Promise.resolve({
        sessionId: "session-1",
        summary: "First task",
        cwd: "/tmp/project",
        createdAt: 1_000,
        lastModified: 2_000,
      }),
    query: () => query,
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );
  const prompt = driver.prompt("session-1", { text: "continue" });
  await started;
  assertEquals((await driver.cancel("session-1")).status, "succeeded");
  assertEquals((await prompt).status, "unknown");
});

Deno.test("multiple Claude sources isolate config directories for short SDK operations", async () => {
  const previous = Deno.env.get("CLAUDE_CONFIG_DIR");
  Deno.env.set("CLAUDE_CONFIG_DIR", "/sentinel");
  const observed: string[] = [];
  const sdk = {
    listSessions: async () => {
      observed.push(`list:${Deno.env.get("CLAUDE_CONFIG_DIR")}`);
      await Promise.resolve();
      return [];
    },
    renameSession: async () => {
      observed.push(`rename:${Deno.env.get("CLAUDE_CONFIG_DIR")}`);
      await Promise.resolve();
    },
  } as unknown as ClaudeSdkAdapter;
  const first = new ClaudeAgentSdkDriver({
    id: "claude-code:first",
    driver: "claude-agent-sdk",
    enabled: true,
    configDir: "/claude/first",
  }, sdk);
  const second = new ClaudeAgentSdkDriver({
    id: "claude-code:second",
    driver: "claude-agent-sdk",
    enabled: true,
    configDir: "/claude/second",
  }, sdk);
  try {
    await Promise.all([first.listSessions(), second.listSessions()]);
    await Promise.all([
      first.renameSession("session-1", "First"),
      second.renameSession("session-2", "Second"),
    ]);
    assertEquals(observed, [
      "list:/claude/first",
      "list:/claude/second",
      "rename:/claude/first",
      "rename:/claude/second",
    ]);
    assertEquals(Deno.env.get("CLAUDE_CONFIG_DIR"), "/sentinel");
  } finally {
    if (previous === undefined) Deno.env.delete("CLAUDE_CONFIG_DIR");
    else Deno.env.set("CLAUDE_CONFIG_DIR", previous);
  }
});

Deno.test("Claude prompts use explicit source env and run concurrently", async () => {
  const previous = Deno.env.get("CLAUDE_CONFIG_DIR");
  Deno.env.set("CLAUDE_CONFIG_DIR", "/sentinel");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) =>
    markFirstStarted = resolve
  );
  const observed: Array<{ prompt: string; env: Record<string, string> }> = [];
  const sdk = {
    listSessions: () => {
      const firstSource = Deno.env.get("CLAUDE_CONFIG_DIR") === "/claude/first";
      const sessionId = firstSource ? "session-1" : "session-2";
      return Promise.resolve([{
        sessionId,
        summary: sessionId,
        cwd: `/${sessionId}`,
        createdAt: 1_000,
        lastModified: 2_000,
      }]);
    },
    getSessionInfo: (sessionId: string) =>
      Promise.resolve({
        sessionId,
        summary: sessionId,
        cwd: `/${sessionId}`,
        createdAt: 1_000,
        lastModified: 2_000,
      }),
    query: (params: { prompt: string; options?: Record<string, unknown> }) => {
      observed.push({
        prompt: params.prompt,
        env: params.options?.env as Record<string, string>,
      });
      if (params.prompt === "First") markFirstStarted();
      const generator = (async function* () {
        await blocked;
        yield { type: "result", subtype: "success", is_error: false };
      })();
      return Object.assign(generator, {
        interrupt: () => Promise.resolve(),
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => undefined,
      });
    },
  } as unknown as ClaudeSdkAdapter;
  const first = new ClaudeAgentSdkDriver({
    id: "claude-code:first",
    driver: "claude-agent-sdk",
    enabled: true,
    configDir: "/claude/first",
    env: { SOURCE_TOKEN: "first" },
  }, sdk);
  const second = new ClaudeAgentSdkDriver({
    id: "claude-code:second",
    driver: "claude-agent-sdk",
    enabled: true,
    configDir: "/claude/second",
    env: { SOURCE_TOKEN: "second" },
  }, sdk);
  try {
    await Promise.all([first.listSessions(), second.listSessions()]);
    const firstPrompt = first.prompt("session-1", { text: "First" });
    await firstStarted;
    const secondPrompt = second.prompt("session-2", { text: "Second" });
    await Promise.resolve();
    const overlapped = observed.length === 2;
    release();
    await Promise.all([firstPrompt, secondPrompt]);
    assertEquals(overlapped, true);
    assertEquals(
      observed.map(({ prompt, env }) => ({
        prompt,
        configDir: env.CLAUDE_CONFIG_DIR,
        sourceToken: env.SOURCE_TOKEN,
      })),
      [
        { prompt: "First", configDir: "/claude/first", sourceToken: "first" },
        {
          prompt: "Second",
          configDir: "/claude/second",
          sourceToken: "second",
        },
      ],
    );
    assertEquals(Deno.env.get("CLAUDE_CONFIG_DIR"), "/sentinel");
  } finally {
    release();
    if (previous === undefined) Deno.env.delete("CLAUDE_CONFIG_DIR");
    else Deno.env.set("CLAUDE_CONFIG_DIR", previous);
  }
});

Deno.test("Claude driver handles message, cursor, and live control edges", async () => {
  const active = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const query = Object.assign(
    (async function* () {
      active.resolve();
      await release.promise;
      yield { type: "result", subtype: "success", result: "done" };
    })(),
    {
      interrupt: () => {
        calls.push("interrupt");
        return Promise.resolve();
      },
      setPermissionMode: (mode: string) => {
        calls.push(`mode:${mode}`);
        return Promise.resolve();
      },
      setModel: (model: string) => {
        calls.push(`model:${model}`);
        return Promise.resolve();
      },
      close: () => calls.push("close"),
    },
  );
  const sdk = {
    listSessions: () =>
      Promise.resolve([{
        sessionId: "session",
        firstPrompt: "First prompt",
        cwd: "/tmp/project",
        createdAt: Number.NaN,
      }]),
    getSessionInfo: (id: string) =>
      Promise.resolve(
        id === "missing" ? undefined : { sessionId: id, cwd: "/tmp/project" },
      ),
    getSessionMessages: () =>
      Promise.resolve([{
        type: "future",
        uuid: "nested",
        message: { content: ["one", { text: "two" }, null] },
      }]),
    renameSession: () => Promise.resolve(),
    query: () => query,
  } as unknown as ClaudeSdkAdapter;
  const driver = new ClaudeAgentSdkDriver(
    { id: "claude:edges", driver: "claude-agent-sdk", enabled: true },
    sdk,
  );

  await assertRejects(
    () => driver.listSessions("invalid"),
    Error,
    "invalid Claude cursor",
  );
  const page = await driver.listSessions();
  assertEquals(page.sessions[0].title, "First prompt");
  assertEquals(page.sessions[0].createdAt, null);
  await assertRejects(
    () => driver.readSession("missing"),
    Error,
    "Claude session not found",
  );
  const snapshot = await driver.readSession("session");
  assertEquals(snapshot.normalizedMessages[0].role, "unknown");
  assertEquals(snapshot.normalizedMessages[0].textPreview, "one\ntwo");
  assertEquals((await driver.cancel("session")).status, "unsupported");
  assertEquals(
    (await driver.setMode("session", "missing")).status,
    "unsupported",
  );
  assertEquals(
    (await driver.setConfigOption("session", "unknown", true)).status,
    "unsupported",
  );

  const prompt = driver.prompt("session", { text: "continue" });
  await active.promise;
  assertEquals((await driver.setMode("session", "plan")).status, "succeeded");
  assertEquals(
    (await driver.setConfigOption("session", "model", "claude-test")).status,
    "succeeded",
  );
  assertEquals((await driver.cancel("session")).status, "succeeded");
  release.resolve();
  assertEquals((await prompt).status, "succeeded");
  assertEquals(calls, [
    "mode:plan",
    "model:claude-test",
    "interrupt",
    "close",
  ]);
});

Deno.test("Claude prompt env excludes another source's temporary globals", async () => {
  const key = "CLAUDE_TEST_FIRST_SOURCE_ONLY";
  const previous = Deno.env.get(key);
  Deno.env.delete(key);
  let releaseInventory!: () => void;
  let markInventoryStarted!: () => void;
  const inventoryBlocked = new Promise<void>((resolve) =>
    releaseInventory = resolve
  );
  const inventoryStarted = new Promise<void>((resolve) =>
    markInventoryStarted = resolve
  );
  let promptEnv: Record<string, string> | undefined;
  const sdk = {
    listSessions: async () => {
      if (Deno.env.get(key) === "private-to-first") {
        markInventoryStarted();
        await inventoryBlocked;
        return [];
      }
      return [{
        sessionId: "session-2",
        summary: "Second",
        cwd: "/second",
        createdAt: 1_000,
        lastModified: 2_000,
      }];
    },
    query: (params: { options?: Record<string, unknown> }) => {
      promptEnv = params.options?.env as Record<string, string>;
      return fakeQuery([{
        type: "result",
        subtype: "success",
        is_error: false,
      }]);
    },
  } as unknown as ClaudeSdkAdapter;
  const first = new ClaudeAgentSdkDriver({
    id: "claude-code:first",
    driver: "claude-agent-sdk",
    enabled: true,
    env: { [key]: "private-to-first" },
  }, sdk);
  const second = new ClaudeAgentSdkDriver({
    id: "claude-code:second",
    driver: "claude-agent-sdk",
    enabled: true,
  }, sdk);
  try {
    await second.listSessions();
    const inventory = first.listSessions();
    await inventoryStarted;
    assertEquals(Deno.env.get(key), "private-to-first");
    assertEquals(
      (await second.prompt("session-2", { text: "Second" })).status,
      "succeeded",
    );
    assertEquals(promptEnv?.[key], undefined);
    releaseInventory();
    await inventory;
  } finally {
    releaseInventory();
    if (previous === undefined) Deno.env.delete(key);
    else Deno.env.set(key, previous);
  }
});

function sdkWithoutSessions(calls: Array<{ method: string; args: unknown[] }>) {
  return {
    listSessions: (options?: Record<string, unknown>) => {
      calls.push({ method: "listSessions", args: [options] });
      return Promise.resolve([]);
    },
    getSessionInfo: (id: string) => {
      calls.push({ method: "getSessionInfo", args: [id] });
      return Promise.resolve(undefined);
    },
    getSessionMessages: () => Promise.resolve([]),
    renameSession: (id: string, title: string) => {
      calls.push({ method: "renameSession", args: [id, title] });
      return Promise.resolve();
    },
    query: (params: { prompt: string; options?: Record<string, unknown> }) => {
      calls.push({ method: "query", args: [params] });
      return fakeQuery([
        { type: "system", subtype: "init", session_id: "ignored" },
        { type: "result", subtype: "success" },
      ]);
    },
  };
}

const NEW_SESSION_ID = "6f1a3c0e-9d2b-4c7a-8e5f-0123456789ab";

Deno.test("Claude driver lists the source directory's sessions when `cwd` is configured", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const scoped = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdkWithoutSessions(calls),
  );
  await scoped.listSessions();
  assertEquals(calls, [{
    method: "listSessions",
    args: [{ limit: 100, offset: 0, dir: "/work/labs" }],
  }]);

  calls.length = 0;
  const unscoped = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdkWithoutSessions(calls),
  );
  await unscoped.listSessions();
  assertEquals(calls, [{
    method: "listSessions",
    args: [{ limit: 100, offset: 0 }],
  }]);
});

Deno.test("Claude driver starts a session under a caller-chosen id, titles it, and remembers its directory", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const events: string[] = [];
  const sdk = {
    ...sdkWithoutSessions(calls),
    query: (params: { prompt: string; options?: Record<string, unknown> }) => {
      calls.push({ method: "query", args: [params] });
      const generator = (async function* () {
        events.push("yield:init");
        yield { type: "system", subtype: "init", session_id: NEW_SESSION_ID };
        events.push("yield:result");
        yield { type: "result", subtype: "success" };
      })();
      return Object.assign(generator, {
        interrupt: () => Promise.resolve(),
        setPermissionMode: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
        close: () => undefined,
      });
    },
  };
  const driver = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdk,
  );

  const outcome = await driver.startSession(NEW_SESSION_ID, {
    text: "Work on topic #7",
    cwd: "/work/labs/packages/patterns",
    title: "topic #7: the workbench",
  }, {
    onSessionActive: () => {
      events.push("active");
      return Promise.resolve();
    },
  });
  assertEquals(outcome.status, "succeeded");
  assertEquals(outcome.result, {
    nativeSessionId: NEW_SESSION_ID,
    cwd: "/work/labs/packages/patterns",
    title: "topic #7: the workbench",
    titled: true,
  });
  // The session is refreshed only once the SDK has emitted for it.
  assertEquals(events, ["yield:init", "active", "yield:result"]);
  const query = calls.find((call) => call.method === "query")?.args[0] as {
    prompt: string;
    options: Record<string, unknown>;
  };
  assertEquals(query.prompt, "Work on topic #7");
  assertEquals(query.options.sessionId, NEW_SESSION_ID);
  assertEquals(query.options.cwd, "/work/labs/packages/patterns");
  assertEquals(query.options.resume, undefined);
  assertEquals(calls.at(-1), {
    method: "renameSession",
    args: [NEW_SESSION_ID, "topic #7: the workbench"],
  });

  // A prompt that follows resumes in the started directory without a lookup.
  calls.length = 0;
  const followUp = await driver.prompt(NEW_SESSION_ID, { text: "Continue" });
  assertEquals(followUp.status, "succeeded");
  assertEquals(calls.map((call) => call.method), ["query"]);
  const resumed = calls[0].args[0] as { options: Record<string, unknown> };
  assertEquals(resumed.options.resume, NEW_SESSION_ID);
  assertEquals(resumed.options.cwd, "/work/labs/packages/patterns");
});

Deno.test("Claude driver refuses to start a session that already exists", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const sdk = {
    ...sdkWithoutSessions(calls),
    getSessionInfo: (id: string) => {
      calls.push({ method: "getSessionInfo", args: [id] });
      return Promise.resolve({
        sessionId: id,
        summary: "Existing",
        cwd: "/work/labs",
        lastModified: 1_000,
      });
    },
  };
  const driver = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdk,
  );
  const outcome = await driver.startSession(NEW_SESSION_ID, { text: "Hi" });
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.error?.code, "claude-session-exists");
  assertEquals(calls.map((call) => call.method), ["getSessionInfo"]);
});

Deno.test("Claude driver refuses a start whose id or directory is unusable", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const scoped = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdkWithoutSessions(calls),
  );
  assertEquals(
    (await scoped.startSession("not-a-uuid", { text: "Hi" })).error?.code,
    "claude-session-id-invalid",
  );
  assertEquals(
    (await scoped.startSession(NEW_SESSION_ID, {
      text: "Hi",
      cwd: "/work/other",
    })).error?.code,
    "claude-start-cwd-outside-source",
  );
  assertEquals(
    (await scoped.startSession(NEW_SESSION_ID, {
      text: "Hi",
      cwd: "/work/labs-sibling",
    })).error?.code,
    "claude-start-cwd-outside-source",
  );
  const unscoped = new ClaudeAgentSdkDriver(
    { id: "claude-code:default", driver: "claude-agent-sdk", enabled: true },
    sdkWithoutSessions(calls),
  );
  assertEquals(
    (await unscoped.startSession(NEW_SESSION_ID, { text: "Hi" })).error?.code,
    "claude-start-cwd-required",
  );
  assertEquals(calls, []);
});

Deno.test("Claude driver reports a start whose title could not be applied", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const sdk = {
    ...sdkWithoutSessions(calls),
    renameSession: () => Promise.reject(new Error("rename refused")),
  };
  const driver = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdk,
  );
  const outcome = await driver.startSession(NEW_SESSION_ID, {
    text: "Hi",
    title: "Untitled after all",
  });
  assertEquals(outcome.status, "succeeded");
  assertEquals(outcome.result?.titled, false);
  assertEquals(outcome.result?.titleError, "Error: rename refused");
});

Deno.test("Claude driver applies a start's mode to the first turn and refuses one it does not advertise", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const driver = new ClaudeAgentSdkDriver(
    {
      id: "claude-code:labs",
      driver: "claude-agent-sdk",
      enabled: true,
      cwd: "/work/labs",
    },
    sdkWithoutSessions(calls),
  );
  assertEquals(
    (await driver.startSession(NEW_SESSION_ID, {
      text: "Hi",
      mode: "bypassPermissions",
    })).status,
    "unsupported",
  );
  assertEquals(calls.map((call) => call.method), []);

  const outcome = await driver.startSession(NEW_SESSION_ID, {
    text: "Hi",
    mode: "acceptEdits",
  });
  assertEquals(outcome.status, "succeeded");
  const query = calls.find((call) => call.method === "query")?.args[0] as {
    options: Record<string, unknown>;
  };
  assertEquals(query.options.permissionMode, "acceptEdits");
  assertEquals(query.options.allowDangerouslySkipPermissions, undefined);
});
