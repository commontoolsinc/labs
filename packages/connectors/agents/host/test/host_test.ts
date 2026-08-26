import {
  AGENT_CONNECTOR_SCHEMAS,
  type AgentDriver,
  type AgentSessionCommandReceipt,
  type AgentSourceConfig,
  type CollectedSource,
  type CommandExecutionResult,
  CommandLedger,
  type NativeSessionSnapshot,
  type PromptInput,
  type SessionPage,
} from "@commonfabric/agents-connector";
import { assertEquals, assertExists, assertRejects } from "@std/assert";
import {
  AgentsHost,
  type AgentsHostTarget,
  type AgentsHostTargetDescription,
} from "../src/host.ts";
import { join } from "@std/path";

const TARGET_DESCRIPTION: AgentsHostTargetDescription = {
  spaceDid: "did:key:test-space",
  ownerDid: "did:key:test-owner",
  debugPieceId: "debug-piece",
  cells: {
    recentIndex: "recent-cell",
    allIndex: "all-cell",
    health: "health-cell",
    commands: "command-cell",
    receipts: "receipt-cell",
  },
};

function sourceConfig(
  id: string,
  enabled = true,
): AgentSourceConfig {
  return { id, driver: "codex-app-server", enabled };
}

class FakeDriver implements AgentDriver {
  readonly source;
  readonly snapshot: NativeSessionSnapshot;
  started = false;
  stopped = false;
  failStart = false;
  stopFailures = 0;
  refreshCount = 0;
  activeLists = 0;
  maxActiveLists = 0;
  activePrompt = false;
  stoppedWhilePromptActive = false;
  startGate?: {
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  };
  listGate?: {
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  };
  promptGate?: {
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  };

  constructor(id: string) {
    this.source = {
      id,
      driver: "codex-app-server" as const,
      capabilities: {
        inventory: true,
        read: true,
        prompt: true,
        cancel: true,
        rename: true,
        setMode: false,
        setConfigOption: false,
      },
    };
    this.snapshot = {
      summary: {
        nativeSessionId: `${id}-session`,
        title: `${id} session`,
        cwd: "/work",
        createdAt: "2026-07-20T00:00:00.000Z",
        updatedAt: "2026-07-20T00:01:00.000Z",
        archived: false,
        active: true,
        raw: { provider: id },
      },
      events: [{ type: "message", text: "hello" }],
      normalizedMessages: [{
        id: "message-1",
        role: "assistant",
        kind: "message",
        createdAt: "2026-07-20T00:01:00.000Z",
        textPreview: "hello",
        rawIndex: 0,
      }],
      complete: true,
    };
  }

  async start(): Promise<void> {
    this.startGate?.entered.resolve();
    await this.startGate?.release.promise;
    if (this.failStart) throw new Error("startup rejected");
    this.started = true;
  }

  stop(): Promise<void> {
    if (this.stopFailures > 0) {
      this.stopFailures--;
      throw new Error("stop rejected synchronously");
    }
    this.stoppedWhilePromptActive ||= this.activePrompt;
    this.stopped = true;
    return Promise.resolve();
  }

  async listSessions(): Promise<SessionPage> {
    this.activeLists++;
    this.maxActiveLists = Math.max(this.maxActiveLists, this.activeLists);
    const gate = this.listGate;
    this.listGate = undefined;
    gate?.entered.resolve();
    if (gate) await gate.release.promise;
    this.activeLists--;
    return { sessions: [this.snapshot.summary] };
  }

  readSession(): Promise<NativeSessionSnapshot> {
    this.refreshCount++;
    return Promise.resolve(structuredClone(this.snapshot));
  }

  async prompt(
    _nativeSessionId: string,
    _input: PromptInput,
  ): Promise<CommandExecutionResult> {
    this.activePrompt = true;
    try {
      this.promptGate?.entered.resolve();
      await this.promptGate?.release.promise;
    } finally {
      this.activePrompt = false;
    }
    return {
      status: "succeeded",
      providerOperationId: "operation-1",
    };
  }

  cancel(): Promise<CommandExecutionResult> {
    return Promise.resolve({ status: "succeeded" });
  }

  renameSession(): Promise<CommandExecutionResult> {
    return Promise.resolve({ status: "succeeded" });
  }

  setMode(): Promise<CommandExecutionResult> {
    return Promise.resolve({ status: "unsupported" });
  }

  setConfigOption(): Promise<CommandExecutionResult> {
    return Promise.resolve({ status: "unsupported" });
  }
}

class FakeTarget implements AgentsHostTarget {
  healthValues: Record<string, unknown>[] = [];
  publications: CollectedSource[][] = [];
  allocatedObservationSequences: number[] = [];
  observationSequences: number[] = [];
  checkoutDirectories: string[][] = [];
  receipts: AgentSessionCommandReceipt[] = [];
  commandCallback?: (commands: unknown[]) => void;
  subscriptionCancelled = false;
  failSubscriptionCancel = false;
  failRefresh = false;
  failNextHealth = false;
  refreshCount = 0;
  terminalReceiptFailures = 0;
  terminalReceipt = Promise.withResolvers<AgentSessionCommandReceipt>();
  failedTerminalAttempt = Promise.withResolvers<void>();
  commandFailureHealth = Promise.withResolvers<Record<string, unknown>>();
  afterPublish?: () => void;
  healthGate?: {
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  };
  subscriptionGate?: {
    entered: PromiseWithResolvers<void>;
    release: PromiseWithResolvers<void>;
  };
  #nextObservationSequence = 1;

  beginSessionObservation(): number {
    const sequence = this.#nextObservationSequence++;
    this.allocatedObservationSequences.push(sequence);
    return sequence;
  }

  publish(
    collected: CollectedSource[],
    options?: {
      observationSequence?: number;
      checkoutDirectories?: string[];
      signal?: AbortSignal;
      onCommit?: () => void;
    },
  ): Promise<number> {
    this.publications.push(structuredClone(collected));
    if (options?.observationSequence !== undefined) {
      this.observationSequences.push(options.observationSequence);
    }
    if (options?.checkoutDirectories !== undefined) {
      this.checkoutDirectories.push([...options.checkoutDirectories]);
    }
    options?.onCommit?.();
    this.afterPublish?.();
    return Promise.resolve(
      collected.reduce((count, source) => count + source.sessions.length, 0),
    );
  }

  validateCheckout(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async publishHealth(value: Record<string, unknown>): Promise<void> {
    this.healthValues.push(structuredClone(value));
    const commandProcessing = value.commandProcessing as
      | { failedCommands?: number }
      | undefined;
    if ((commandProcessing?.failedCommands ?? 0) > 0) {
      this.commandFailureHealth.resolve(structuredClone(value));
    }
    const gate = this.healthGate;
    this.healthGate = undefined;
    gate?.entered.resolve();
    await gate?.release.promise;
    if (this.failNextHealth) {
      this.failNextHealth = false;
      throw new Error("health publication rejected");
    }
  }

  async subscribeCommands(
    callback: (commands: unknown[]) => void,
  ): Promise<() => void> {
    this.commandCallback = callback;
    const gate = this.subscriptionGate;
    this.subscriptionGate = undefined;
    gate?.entered.resolve();
    await gate?.release.promise;
    return () => {
      if (this.failSubscriptionCancel) {
        throw new Error("subscription cancellation rejected");
      }
      this.subscriptionCancelled = true;
      this.commandCallback = undefined;
    };
  }

  readReceipt(
    commandId: string,
  ): Promise<AgentSessionCommandReceipt | undefined> {
    return Promise.resolve(
      structuredClone(
        [...this.receipts].reverse().find((receipt) =>
          receipt.commandId === commandId
        ),
      ),
    );
  }

  publishReceipt(receipt: AgentSessionCommandReceipt): Promise<void> {
    if (receipt.status === "succeeded" && this.terminalReceiptFailures > 0) {
      this.terminalReceiptFailures--;
      this.failedTerminalAttempt.resolve();
      return Promise.reject(new Error("terminal receipt publication rejected"));
    }
    this.receipts.push(structuredClone(receipt));
    if (receipt.status === "succeeded") {
      this.terminalReceipt.resolve(structuredClone(receipt));
    }
    return Promise.resolve();
  }

  refreshSession(): Promise<void> {
    this.refreshCount++;
    if (this.failRefresh) {
      return Promise.reject(new Error("refresh publication rejected"));
    }
    return Promise.resolve();
  }

  sendCommands(commands: unknown[]): void {
    if (!this.commandCallback) {
      throw new Error("command subscription is absent");
    }
    this.commandCallback(commands);
  }
}

async function openLedger(directory: string): Promise<CommandLedger> {
  return await CommandLedger.open(join(directory, "ledger.json"));
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 20, 0, 0, tick++));
}

Deno.test("AgentsHost publishes sessions, health, and lifecycle activity", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
      checkoutRoots: ["/workspace/checkouts"],
      discoverCheckouts: (roots) => {
        assertEquals(roots, ["/workspace/checkouts"]);
        return Promise.resolve(["/workspace/checkouts/project"]);
      },
    });

    assertEquals(await host.start(), 1);
    assertEquals(target.publications.length, 1);
    assertEquals(target.publications[0][0].source.id, "codex");
    assertEquals(target.checkoutDirectories, [[
      "/workspace/checkouts/project",
    ]]);
    assertEquals(host.health().status, "ready");
    assertEquals(host.health().target.debugPieceId, "debug-piece");
    assertEquals(host.health().sources[0].sessionCount, 1);
    assertEquals(
      host.health().activity.some((event) => event.type === "sync-completed"),
      true,
    );
    assertEquals(
      target.healthValues.some((value) =>
        value.status === "starting" &&
        (value.sources as Array<{ status: string }>)[0].status === "starting"
      ),
      true,
    );

    await host.stop("test-complete");
    assertEquals(driver.stopped, true);
    assertEquals(target.subscriptionCancelled, true);
    assertEquals(host.health().status, "stopped");
    assertEquals(
      target.healthValues.some((value) => value.status === "stopping"),
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost continues when one configured source fails to start", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const healthy = new FakeDriver("healthy");
    const failed = new FakeDriver("failed");
    failed.failStart = true;
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("healthy"), sourceConfig("failed")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: (config) => config.id === "healthy" ? healthy : failed,
      clock: clock(),
    });

    assertEquals(await host.start(), 1);
    assertEquals(host.health().status, "degraded");
    assertEquals(target.publications[0].map((source) => source.source.id), [
      "healthy",
    ]);
    assertEquals(target.checkoutDirectories, [[]]);
    const failedHealth = host.health().sources.find((source) =>
      source.id === "failed"
    );
    assertExists(failedHealth);
    assertEquals(failedHealth.status, "failed");
    assertEquals(failedHealth.lastError, "startup rejected");
    await host.stop();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost serializes explicit full collections", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });
    await host.start({ acceptCommands: false });

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    driver.listGate = { entered, release };
    const first = host.synchronize("first");
    const second = host.synchronize("second");
    await entered.promise;
    assertEquals(driver.maxActiveLists, 1);
    assertEquals(target.publications.length, 1);
    assertEquals(target.allocatedObservationSequences, [1, 2]);
    release.resolve();
    await Promise.all([first, second]);
    assertEquals(driver.maxActiveLists, 1);
    assertEquals(target.publications.length, 3);
    assertEquals(target.allocatedObservationSequences, [1, 2, 3]);
    assertEquals(target.observationSequences, [1, 2, 3]);
    await host.stop();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost remains stopping while an admitted collection finishes", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });
    await host.start({ acceptCommands: false });

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    driver.listGate = { entered, release };
    const collection = host.synchronize("shutdown-race");
    await entered.promise;
    const firstShutdownHealth = target.healthValues.length;
    const stopping = host.stop("test-complete");
    assertEquals(host.health().status, "stopping");

    release.resolve();
    await Promise.all([collection, stopping]);

    const shutdownStatuses = target.healthValues.slice(firstShutdownHealth)
      .map((value) => value.status);
    assertEquals(shutdownStatuses.includes("stopping"), true);
    assertEquals(
      shutdownStatuses.every((status) =>
        status === "stopping" || status === "stopped"
      ),
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost records command receipt activity without prompt contents", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });
    await host.start();
    target.sendCommands([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      ownerDid: "did:key:test-owner",
      id: "command-1",
      createdAt: "2026-07-20T00:05:00.000Z",
      sourceId: "codex",
      nativeSessionId: "codex-session",
      type: "prompt",
      payload: { text: "private prompt text" },
    }]);

    const receipt = await target.terminalReceipt.promise;
    assertEquals(receipt.status, "succeeded");
    assertEquals(target.receipts.map((value) => value.status), [
      "in-flight",
      "succeeded",
    ]);
    const activityText = JSON.stringify(host.health().activity);
    assertEquals(activityText.includes("private prompt text"), false);
    assertEquals(activityText.includes("command-1"), true);
    await host.stop();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost drains admitted commands before stopping drivers", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });
    await host.start();

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    driver.promptGate = { entered, release };
    target.sendCommands([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      ownerDid: "did:key:test-owner",
      id: "command-during-shutdown",
      createdAt: "2026-07-20T00:05:00.000Z",
      sourceId: "codex",
      nativeSessionId: "codex-session",
      type: "prompt",
      payload: { text: "finish before shutdown" },
    }]);

    await entered.promise;
    const stopping = host.stop("test-complete");
    release.resolve();
    await stopping;

    assertEquals(driver.stoppedWhilePromptActive, false);
    assertEquals(target.receipts.map((receipt) => receipt.status), [
      "in-flight",
      "succeeded",
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost stops startup before collection after cancellation", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    driver.startGate = { entered, release };
    const controller = new AbortController();

    const starting = host.start({
      signal: controller.signal,
      acceptCommands: false,
    });
    await entered.promise;
    controller.abort(new Error("startup cancelled"));
    release.resolve();

    await assertRejects(() => starting, Error, "startup cancelled");
    assertEquals(target.publications.length, 0);
    await host.stop("startup-cancelled");
    assertEquals(driver.stopped, true);
    assertEquals(host.health().sources[0].status, "stopped");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost defers health until startup owns the ready state", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    const healthEntered = Promise.withResolvers<void>();
    const healthRelease = Promise.withResolvers<void>();
    target.healthGate = { entered: healthEntered, release: healthRelease };
    const controller = new AbortController();
    let healthOwnership = false;
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });

    const starting = host.start({
      signal: controller.signal,
      acceptCommands: false,
      deferHealthUntilReady: true,
      onHealthOwnership: () => {
        healthOwnership = true;
      },
    });
    await healthEntered.promise;
    assertEquals(healthOwnership, true);
    assertEquals(target.healthValues.map((value) => value.status), ["ready"]);
    controller.abort(new Error("stop after ready ownership"));
    healthRelease.resolve();

    assertEquals(await starting, 1);
    await host.stop("signal-after-ready");
    assertEquals(target.healthValues.map((value) => value.status), [
      "ready",
      "stopping",
      "stopped",
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost cancellation publishes no deferred startup health", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const listEntered = Promise.withResolvers<void>();
    const listRelease = Promise.withResolvers<void>();
    driver.listGate = { entered: listEntered, release: listRelease };
    const target = new FakeTarget();
    const controller = new AbortController();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });

    const starting = host.start({
      signal: controller.signal,
      acceptCommands: false,
      deferHealthUntilReady: true,
    });
    await listEntered.promise;
    assertEquals(target.healthValues, []);
    controller.abort(new Error("cancel deferred startup"));
    await assertRejects(() => starting, Error, "cancel deferred startup");

    const stopping = host.stop("startup-cancelled", {
      flushPendingReceipts: false,
      interruptInFlight: true,
      publishHealth: false,
    });
    listRelease.resolve();
    await stopping;
    assertEquals(target.healthValues, []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost reports late subscription cleanup failures", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const subscriptionEntered = Promise.withResolvers<void>();
    const subscriptionRelease = Promise.withResolvers<void>();
    const target = new FakeTarget();
    target.subscriptionGate = {
      entered: subscriptionEntered,
      release: subscriptionRelease,
    };
    target.failSubscriptionCancel = true;
    const controller = new AbortController();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });

    const starting = host.start({
      signal: controller.signal,
      deferHealthUntilReady: true,
    });
    await subscriptionEntered.promise;
    controller.abort(new Error("cancel pending subscription"));
    await assertRejects(
      () => starting,
      Error,
      "cancel pending subscription",
    );

    const stopping = host.stop("startup-cancelled", {
      flushPendingReceipts: false,
      interruptInFlight: true,
      publishHealth: false,
    });
    subscriptionRelease.resolve();
    await assertRejects(
      () => stopping,
      AggregateError,
      "subscription cancellation rejected",
    );
    assertEquals(driver.stopped, true);
    assertEquals(target.healthValues, []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost reports failed post-command session refreshes", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    target.failRefresh = true;
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });
    await host.start();
    target.sendCommands([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      ownerDid: "did:key:test-owner",
      id: "command-with-stale-refresh",
      createdAt: "2026-07-20T00:05:00.000Z",
      sourceId: "codex",
      nativeSessionId: "codex-session",
      type: "rename",
      payload: { title: "Updated title" },
    }]);

    await target.terminalReceipt.promise;
    await host.stop("test-complete");

    assertEquals(target.refreshCount, 1);
    assertEquals(
      host.health().activity.some((event) =>
        event.type === "session-refresh-failed" &&
        event.details?.error === "refresh publication rejected"
      ),
      true,
    );
    assertEquals(
      host.health().sources[0].lastError?.includes(
        "refresh publication rejected",
      ),
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost flushes unpublished receipts before stopping", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    target.terminalReceiptFailures = 1;
    const ledger = await openLedger(directory);
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger,
      createDriver: () => driver,
      clock: clock(),
    });
    await host.start();
    target.sendCommands([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      ownerDid: "did:key:test-owner",
      id: "command-with-publication-failure",
      createdAt: "2026-07-20T00:05:00.000Z",
      sourceId: "codex",
      nativeSessionId: "codex-session",
      type: "rename",
      payload: { title: "Updated title" },
    }]);

    await target.failedTerminalAttempt.promise;
    const failureHealth = await target.commandFailureHealth.promise;
    assertEquals(failureHealth.commandProcessing, {
      accepting: true,
      pendingReceiptPublications: 1,
      failedCommands: 1,
      lastError: "terminal receipt publication rejected",
    });
    await host.synchronize("pending-receipt-check");
    assertEquals(host.health().status, "degraded");
    assertEquals(
      host.health().commandProcessing.pendingReceiptPublications,
      1,
    );
    await assertRejects(
      () => host.stop("test-complete"),
      AggregateError,
      "command worker operations failed",
    );

    assertEquals(target.receipts.map((receipt) => receipt.status), [
      "in-flight",
      "succeeded",
    ]);
    assertEquals(await ledger.recoverUnpublishedReceipts(), []);
    assertEquals(
      host.health().activity.some((event) =>
        event.type === "receipt-flush-completed"
      ),
      true,
    );
    assertEquals(driver.stopped, true);
    assertEquals(target.refreshCount, 1);
    assertEquals(
      host.health().activity.some((event) =>
        event.type === "receipt-publication-failed" &&
        event.details?.commandId === "command-with-publication-failure"
      ),
      true,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost checks startup cancellation after initial collection", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    const controller = new AbortController();
    target.afterPublish = () => {
      controller.abort(new Error("cancelled during initial publication"));
    };
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });

    await assertRejects(
      () =>
        host.start({
          signal: controller.signal,
          acceptCommands: false,
        }),
      Error,
      "cancelled during initial publication",
    );
    assertEquals(
      host.health().activity.some((event) => event.type === "host-started"),
      false,
    );
    await host.stop("startup-cancelled");
    assertEquals(driver.stopped, true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost completes a sync committed before cancellation", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });
    await host.start({ acceptCommands: false });

    const controller = new AbortController();
    target.afterPublish = () => {
      controller.abort(new Error("cancelled after publication commit"));
    };
    assertEquals(
      await host.synchronize("committed", controller.signal),
      1,
    );
    assertEquals(host.health().sync?.status, "complete");
    assertEquals(host.health().sync?.reason, "committed");
    assertEquals(
      host.health().activity.some((event) => event.type === "sync-cancelled"),
      false,
    );
    await host.stop();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost reports post-commit health failure", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });
    await host.start({ acceptCommands: false });

    const controller = new AbortController();
    target.afterPublish = () => {
      target.failNextHealth = true;
      controller.abort(new Error("cancelled after publication commit"));
    };
    await assertRejects(
      () => host.synchronize("health-failure", controller.signal),
      Error,
      "health publication rejected",
    );
    assertEquals(host.health().sync?.status, "failed");
    assertEquals(
      host.health().activity.at(-1)?.type,
      "sync-failed",
    );
    await host.stop();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost cancels a pending initial provider collection", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    driver.listGate = { entered, release };
    const target = new FakeTarget();
    const controller = new AbortController();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });

    const starting = host.start({
      signal: controller.signal,
      acceptCommands: false,
    });
    await entered.promise;
    controller.abort(new Error("cancelled pending collection"));
    await assertRejects(
      () => starting,
      Error,
      "cancelled pending collection",
    );
    let stopped = false;
    const stopping = host.stop("startup-cancelled", {
      flushPendingReceipts: false,
    }).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    assertEquals(stopped, false);
    release.resolve();
    await stopping;
    assertEquals(driver.stopped, true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a canceled collection remains serialized until provider work stops", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });
    await host.start({ acceptCommands: false });

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    driver.listGate = { entered, release };
    const controller = new AbortController();
    const canceled = host.synchronize("cancelled", controller.signal);
    await entered.promise;
    controller.abort(new Error("cancel collection"));
    await assertRejects(() => canceled, Error, "cancel collection");

    const next = host.synchronize("after-cancellation");
    await Promise.resolve();
    assertEquals(driver.activeLists, 1);
    assertEquals(driver.maxActiveLists, 1);
    release.resolve();
    await next;

    assertEquals(driver.maxActiveLists, 1);
    assertEquals(host.health().status, "ready");
    assertEquals(host.health().sync?.reason, "after-cancellation");
    await host.stop();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost completes shutdown when subscription cancellation fails", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const driver = new FakeDriver("codex");
    const target = new FakeTarget();
    target.failSubscriptionCancel = true;
    const host = new AgentsHost({
      sources: [sourceConfig("codex")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: () => driver,
      clock: clock(),
    });
    await host.start();

    await assertRejects(
      () => host.stop("test-complete"),
      AggregateError,
      "subscription cancellation rejected",
    );
    assertEquals(driver.stopped, true);
    assertEquals(host.health().status, "stopped");
    assertEquals(
      host.health().activity.some((event) =>
        event.type === "command-subscription-stop-failed"
      ),
      true,
    );
    const receiptCount = target.receipts.length;
    target.sendCommands([{
      schema: AGENT_CONNECTOR_SCHEMAS.command,
      ownerDid: "did:key:test-owner",
      id: "command-after-stop",
      createdAt: "2026-07-20T00:06:00.000Z",
      sourceId: "codex",
      nativeSessionId: "codex-session",
      type: "rename",
      payload: { title: "Must not run" },
    }]);
    await Promise.resolve();
    assertEquals(target.receipts.length, receiptCount);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost rejects startup when failed-source cleanup fails", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const healthy = new FakeDriver("healthy");
    const failed = new FakeDriver("failed");
    failed.failStart = true;
    failed.stopFailures = 1;
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("healthy"), sourceConfig("failed")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: (config) => config.id === "healthy" ? healthy : failed,
      clock: clock(),
    });

    await assertRejects(
      () => host.start({ acceptCommands: false }),
      AggregateError,
      "one or more sources did not complete startup safely",
    );
    assertEquals(
      host.health().activity.some((event) =>
        event.type === "source-start-cleanup-failed"
      ),
      true,
    );
    await host.stop();
    assertEquals(healthy.stopped, true);
    assertEquals(failed.stopped, true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("AgentsHost continues stopping after a synchronous driver failure", async () => {
  const directory = await Deno.makeTempDir();
  try {
    const first = new FakeDriver("first");
    const second = new FakeDriver("second");
    first.stopFailures = 1;
    const target = new FakeTarget();
    const host = new AgentsHost({
      sources: [sourceConfig("first"), sourceConfig("second")],
      target,
      targetDescription: TARGET_DESCRIPTION,
      ledger: await openLedger(directory),
      createDriver: (config) => config.id === "first" ? first : second,
      clock: clock(),
    });
    await host.start({ acceptCommands: false });

    await assertRejects(
      () => host.stop(),
      AggregateError,
      "stop rejected synchronously",
    );
    assertEquals(second.stopped, true);
    assertEquals(host.health().status, "stopped");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
