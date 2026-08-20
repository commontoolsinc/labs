import { assertEquals, assertRejects } from "@std/assert";
import type {
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionModeRequest,
} from "@agentclientprotocol/sdk";
import { AcpDriver, type AcpTransport } from "../../src/drivers/acp.ts";

Deno.test("ACP driver enumerates and loads persisted sessions", async () => {
  const calls: string[] = [];
  let notify: ((notification: SessionNotification) => void) | undefined;
  const transport: AcpTransport = {
    setSessionUpdateSink(sink) {
      notify = sink;
    },
    initialize(): Promise<InitializeResponse> {
      return Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {} },
        },
        agentInfo: { name: "fake-acp", version: "1" },
      });
    },
    listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
      calls.push(`list:${params.cursor ?? ""}`);
      return Promise.resolve({
        sessions: [{
          sessionId: "session-1",
          cwd: "/tmp/project",
          title: "Persisted task",
          updatedAt: "2026-07-09T00:00:00Z",
        }],
      });
    },
    loadSession(params: LoadSessionRequest) {
      calls.push(`load:${params.sessionId}`);
      notify?.({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "hello" },
        },
      });
      return Promise.resolve({});
    },
    resumeSession: () => Promise.resolve({}),
    prompt(_params: PromptRequest): Promise<PromptResponse> {
      return Promise.resolve({ stopReason: "end_turn" });
    },
    cancel: () => Promise.resolve(),
    setSessionMode(_params: SetSessionModeRequest) {
      return Promise.resolve({});
    },
    setSessionConfigOption(_params: SetSessionConfigOptionRequest) {
      return Promise.resolve({ configOptions: [] });
    },
    stop: () => Promise.resolve(),
  };
  const driver = new AcpDriver(
    { id: "other:default", driver: "acp", enabled: true, command: ["fake"] },
    transport,
  );

  await driver.start();
  const page = await driver.listSessions();
  assertEquals(page.sessions[0].title, "Persisted task");
  const snapshot = await driver.readSession("session-1");
  assertEquals(snapshot.complete, true);
  assertEquals(snapshot.events.length, 1);
  assertEquals(snapshot.normalizedMessages[0].role, "user");
  assertEquals(snapshot.normalizedMessages[0].textPreview, "hello");
  let cancellationReadyCalls = 0;
  let sessionActiveCalls = 0;
  assertEquals(
    (await driver.prompt("session-1", { text: "continue" }, {
      onCancellationReady: () => {
        cancellationReadyCalls++;
      },
      onSessionActive: () => {
        sessionActiveCalls++;
        return Promise.resolve();
      },
    })).status,
    "succeeded",
  );
  assertEquals(cancellationReadyCalls, 1);
  assertEquals(sessionActiveCalls, 1);
  assertEquals(calls, ["list:", "load:session-1"]);
  assertEquals(driver.source.capabilities.rename, false);
  await driver.stop();
});

Deno.test("ACP controls are discovered and enforced per session", async () => {
  const modeCalls: SetSessionModeRequest[] = [];
  const configCalls: SetSessionConfigOptionRequest[] = [];
  let firstLoads = 0;
  let inventoryIncludesSecond = true;
  const transport: AcpTransport = {
    setSessionUpdateSink() {},
    initialize: () =>
      Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
        },
      }),
    listSessions: () =>
      Promise.resolve({
        sessions: [
          { sessionId: "first", cwd: "/tmp/first" },
          ...(inventoryIncludesSecond
            ? [{ sessionId: "second", cwd: "/tmp/second" }]
            : []),
        ],
      }),
    loadSession: (params) => {
      if (params.sessionId === "first") firstLoads++;
      return Promise.resolve(
        params.sessionId === "first"
          ? firstLoads === 1
            ? {
              modes: {
                currentModeId: "plan",
                availableModes: [{ id: "plan", name: "Plan" }],
              },
              configOptions: [{
                id: "thinking",
                name: "Thinking",
                type: "boolean" as const,
                currentValue: false,
              }],
            }
            : {}
          : {
            modes: {
              currentModeId: "build",
              availableModes: [{ id: "build", name: "Build" }],
            },
            configOptions: [],
          },
      );
    },
    resumeSession: () => Promise.resolve({}),
    prompt: () => Promise.resolve({ stopReason: "end_turn" }),
    cancel: () => Promise.resolve(),
    setSessionMode: (params) => {
      modeCalls.push(params);
      return Promise.resolve({});
    },
    setSessionConfigOption: (params) => {
      configCalls.push(params);
      return Promise.resolve({ configOptions: [] });
    },
    stop: () => Promise.resolve(),
  };
  const driver = new AcpDriver(
    { id: " ACP:Default ", driver: "acp", enabled: true, command: ["fake"] },
    transport,
  );

  await driver.start();
  await driver.listSessions();
  await driver.readSession("first");
  await driver.readSession("second");
  assertEquals(driver.source.id, "acp:default");
  assertEquals(driver.source.capabilities.modes, ["build", "plan"]);
  assertEquals(
    (await driver.setMode("first", "build")).status,
    "unsupported",
  );
  assertEquals((await driver.setMode("first", "plan")).status, "succeeded");
  assertEquals(
    (await driver.setConfigOption("second", "thinking", true)).status,
    "unsupported",
  );
  assertEquals(
    (await driver.setConfigOption("first", "thinking", "yes")).status,
    "unsupported",
  );
  assertEquals(
    (await driver.setConfigOption("first", "thinking", true)).status,
    "succeeded",
  );
  assertEquals(modeCalls.length, 1);
  assertEquals(configCalls.length, 1);
  await driver.readSession("first");
  assertEquals(driver.source.capabilities.modes, ["build"]);
  assertEquals(driver.source.capabilities.configOptions, {});
  assertEquals(
    (await driver.setMode("first", "plan")).status,
    "unsupported",
  );
  inventoryIncludesSecond = false;
  await driver.listSessions();
  assertEquals(driver.source.capabilities.modes, []);
  assertEquals(driver.source.capabilities.setMode, false);
});

Deno.test("ACP startup stops transports missing required capabilities", async () => {
  for (
    const agentCapabilities of [
      { loadSession: true },
      { sessionCapabilities: { list: {} } },
    ]
  ) {
    let stops = 0;
    const transport: AcpTransport = {
      setSessionUpdateSink() {},
      initialize: () =>
        Promise.resolve({ protocolVersion: 1, agentCapabilities }),
      listSessions: () => Promise.resolve({ sessions: [] }),
      loadSession: () => Promise.resolve({}),
      resumeSession: () => Promise.resolve({}),
      prompt: () => Promise.resolve({ stopReason: "end_turn" }),
      cancel: () => Promise.resolve(),
      setSessionMode: () => Promise.resolve({}),
      setSessionConfigOption: () => Promise.resolve({ configOptions: [] }),
      stop: () => {
        stops++;
        return Promise.resolve();
      },
    };
    const driver = new AcpDriver(
      { id: "acp:invalid", driver: "acp", enabled: true, command: ["fake"] },
      transport,
    );
    await assertRejects(() => driver.start(), Error, "must advertise");
    assertEquals(stops, 1);
  }
});

Deno.test("ACP driver stops an adapter blocked during initialization", async () => {
  const initializationStarted = Promise.withResolvers<void>();
  const initialization = Promise.withResolvers<InitializeResponse>();
  let observedSignal: AbortSignal | undefined;
  let stopCount = 0;
  const transport: AcpTransport = {
    setSessionUpdateSink() {},
    initialize(signal): Promise<InitializeResponse> {
      observedSignal = signal;
      initializationStarted.resolve();
      return initialization.promise;
    },
    listSessions: () => Promise.resolve({ sessions: [] }),
    loadSession: () => Promise.resolve({}),
    resumeSession: () => Promise.resolve({}),
    prompt: () => Promise.resolve({ stopReason: "end_turn" }),
    cancel: () => Promise.resolve(),
    setSessionMode: () => Promise.resolve({}),
    setSessionConfigOption: () => Promise.resolve({ configOptions: [] }),
    stop: () => {
      stopCount++;
      return Promise.resolve();
    },
  };
  const driver = new AcpDriver(
    { id: "other:blocked", driver: "acp", enabled: true, command: ["fake"] },
    transport,
  );
  const controller = new AbortController();
  const started = driver.start(controller.signal);
  await initializationStarted.promise;
  controller.abort();
  const outcome = await started.then(
    () => ({ ok: true as const }),
    (error) => ({ ok: false as const, error }),
  );

  assertEquals(outcome.ok, false);
  if (outcome.ok) throw new Error("ACP initialization completed after abort");
  assertEquals((outcome.error as Error).name, "AbortError");
  assertEquals(observedSignal, controller.signal);
  assertEquals(stopCount, 1);
});

Deno.test("ACP driver serializes overlapping loads of the same session", async () => {
  let notify: ((notification: SessionNotification) => void) | undefined;
  const firstLoadStarted = Promise.withResolvers<void>();
  const releaseFirstLoad = Promise.withResolvers<void>();
  const promptLoadStarted = Promise.withResolvers<void>();
  const releasePromptLoad = Promise.withResolvers<void>();
  let loadCount = 0;
  let activeLoads = 0;
  let maximumActiveLoads = 0;
  const transport: AcpTransport = {
    setSessionUpdateSink(sink) {
      notify = sink;
    },
    initialize: () =>
      Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
        },
      }),
    listSessions: () =>
      Promise.resolve({
        sessions: [{
          sessionId: "session-1",
          cwd: "/tmp/project",
        }],
      }),
    async loadSession(params) {
      loadCount++;
      const ordinal = loadCount;
      activeLoads++;
      maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
      try {
        notify?.({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `load-${ordinal}` },
          },
        });
        if (ordinal === 1) {
          firstLoadStarted.resolve();
          await releaseFirstLoad.promise;
        }
        if (ordinal === 4) {
          promptLoadStarted.resolve();
          await releasePromptLoad.promise;
        }
        return {};
      } finally {
        activeLoads--;
      }
    },
    resumeSession: () => Promise.resolve({}),
    prompt: () => Promise.resolve({ stopReason: "end_turn" }),
    cancel: () => Promise.resolve(),
    setSessionMode: () => Promise.resolve({}),
    setSessionConfigOption: () => Promise.resolve({ configOptions: [] }),
    stop: () => Promise.resolve(),
  };
  const driver = new AcpDriver(
    { id: "other:default", driver: "acp", enabled: true, command: ["fake"] },
    transport,
  );

  await driver.start();
  await driver.listSessions();
  const first = driver.readSession("session-1");
  await firstLoadStarted.promise;
  const firstPrompt = driver.prompt("session-1", { text: "continue" });
  assertEquals(
    (await driver.prompt("session-1", { text: "duplicate" })).status,
    "needs-confirmation",
  );
  const second = driver.readSession("session-1");
  assertEquals(loadCount, 1);
  assertEquals(maximumActiveLoads, 1);
  releaseFirstLoad.resolve();

  const [firstSnapshot, firstPromptResult, secondSnapshot] = await Promise.all([
    first,
    firstPrompt,
    second,
  ]);
  assertEquals(firstPromptResult.status, "succeeded");
  assertEquals(loadCount, 3);
  assertEquals(
    firstSnapshot.normalizedMessages.map((message) => message.textPreview),
    ["load-1"],
  );
  assertEquals(
    secondSnapshot.normalizedMessages.map((message) => message.textPreview),
    ["load-3"],
  );

  const secondPrompt = driver.prompt("session-1", { text: "continue" });
  await promptLoadStarted.promise;
  const third = driver.readSession("session-1");
  assertEquals(loadCount, 4);
  assertEquals(maximumActiveLoads, 1);
  releasePromptLoad.resolve();
  const [secondPromptResult, thirdSnapshot] = await Promise.all([
    secondPrompt,
    third,
  ]);
  assertEquals(secondPromptResult.status, "succeeded");
  assertEquals(loadCount, 5);
  assertEquals(
    thirdSnapshot.normalizedMessages.map((message) => message.textPreview),
    ["load-5"],
  );
  assertEquals(maximumActiveLoads, 1);
  await driver.stop();
});
