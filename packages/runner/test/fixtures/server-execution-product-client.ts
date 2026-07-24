/// <reference lib="webworker" />

import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  ExecutionClaim,
  MemoryProtocolFlags,
} from "@commonfabric/memory/v2";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import { Runtime } from "../../src/runtime.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { NormalizedFullLink } from "../../src/link-utils.ts";
import { HostStorageManager } from "../../src/storage/v2-host-provider.ts";

type InitRequest = {
  type: "init";
  requestId: number;
  port: MessagePort;
  principal: MemorySpace;
  space: MemorySpace;
  clientId: string;
  program: RuntimeProgram;
  resultLink: NormalizedFullLink;
  targetLink: NormalizedFullLink;
  protocolFlags: Partial<MemoryProtocolFlags>;
};

type CommandRequest = {
  type:
    | "reset"
    | "measure"
    | "observe"
    | "quiesce"
    | "drain"
    | "reannounce-demand"
    | "dispose";
  requestId: number;
  actionId?: string;
  claim?: ExecutionClaim;
};

const worker = globalThis as unknown as DedicatedWorkerGlobalScope;
let storage: HostStorageManager | undefined;
let runtime: Runtime | undefined;
let resultLink: NormalizedFullLink | undefined;
let targetLink: NormalizedFullLink | undefined;
let cancelTargetSink: (() => void) | undefined;
let activeSpace: MemorySpace | undefined;
let suppressedBaseline = 0;
let upstreamBaseline = 0;

const routingCount = (key: string): number =>
  getLoggerCountsBreakdown()["storage.v2"]?.[key]?.debug ?? 0;

worker.addEventListener("message", (event: MessageEvent<unknown>) => {
  void handleRequest(event.data as InitRequest | CommandRequest).catch(
    (error) => {
      const requestId = typeof event.data === "object" && event.data !== null &&
          "requestId" in event.data
        ? Number((event.data as { requestId?: unknown }).requestId)
        : -1;
      worker.postMessage({
        type: "response",
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
});
worker.postMessage({ type: "booted" });

async function handleRequest(
  request: InitRequest | CommandRequest,
): Promise<void> {
  if (request.type === "init") {
    if (runtime !== undefined || storage !== undefined) {
      throw new Error("product client is already initialized");
    }
    storage = HostStorageManager.connect({
      port: request.port,
      principal: request.principal,
      space: request.space,
      id: request.clientId,
      protocolFlags: request.protocolFlags,
      supportsExecutionDemand: true,
    });
    runtime = new Runtime({
      apiUrl: new URL("https://toolshed.example/"),
      patternEnvironment: {
        apiUrl: new URL("https://toolshed.example/"),
      },
      storageManager: storage,
      experimental: {
        persistentSchedulerState: true,
        serverPrimaryExecution: true,
      },
    });
    resultLink = request.resultLink;
    targetLink = request.targetLink;
    activeSpace = request.space;
    await runtime.patternManager.compilePattern(request.program, {
      space: request.space,
    });
    const result = runtime.getCellFromLink(resultLink);
    await result.sync();
    if (!await runtime.start(result)) {
      throw new Error("product client could not resume the piece");
    }
    const target = runtime.getCellFromLink(targetLink);
    cancelTargetSink = target.sink(() => undefined);
    await target.pull();
    await runtime.settled();
    worker.postMessage({
      type: "response",
      requestId: request.requestId,
      ok: { ready: true },
    });
    return;
  }

  if (request.type === "dispose") {
    cancelTargetSink?.();
    cancelTargetSink = undefined;
    // Cross the host's accepted-commit barrier before Runtime closes the
    // underlying memory client. Otherwise an already-delivered scheduler
    // adoption can resume against that closed client during the next product
    // case in this same Deno process.
    await storage?.acceptedCommitsSettled();
    await runtime?.dispose();
    runtime = undefined;
    storage = undefined;
    resultLink = undefined;
    targetLink = undefined;
    activeSpace = undefined;
    worker.postMessage({
      type: "response",
      requestId: request.requestId,
      ok: { disposed: true },
    });
    return;
  }

  if (
    runtime === undefined || storage === undefined ||
    resultLink === undefined || activeSpace === undefined ||
    targetLink === undefined
  ) {
    throw new Error("product client is not initialized");
  }
  if (request.type === "reannounce-demand") {
    const accepted = await storage.open(activeSpace).setExecutionDemand?.(
      "",
      [resultLink.id],
    );
    worker.postMessage({
      type: "response",
      requestId: request.requestId,
      ok: { accepted: accepted === true },
    });
    return;
  }
  if (request.type === "quiesce") {
    cancelTargetSink?.();
    cancelTargetSink = undefined;
    await runtime.settled();
    runtime.runner.stopAll();
    await runtime.runner.executionDemandSettled();
    await runtime.scheduler.idle();
    await runtime.storageManager.synced();
    await storage.acceptedCommitsSettled();
    worker.postMessage({
      type: "response",
      requestId: request.requestId,
      ok: { quiesced: true },
    });
    return;
  }
  if (request.type === "drain") {
    await runtime.scheduler.idle();
    await runtime.storageManager.synced();
    await storage.acceptedCommitsSettled();
    worker.postMessage({
      type: "response",
      requestId: request.requestId,
      ok: { drained: true },
    });
    return;
  }
  if (typeof request.actionId !== "string") {
    throw new Error("product client command is missing actionId");
  }

  if (request.type === "reset") {
    runtime.scheduler.setActionRunTraceEnabled(false);
    runtime.scheduler.setActionRunTraceEnabled(true);
    suppressedBaseline = routingCount("execution-client-derived-suppressed");
    upstreamBaseline = routingCount(
      "execution-client-derived-upstream-commit",
    );
    worker.postMessage({
      type: "response",
      requestId: request.requestId,
      ok: { reset: true },
    });
    return;
  }

  await storage.acceptedCommitsSettled();
  if (request.type === "measure") {
    await runtime.storageManager.synced();
    await runtime.getCellFromLink(targetLink).pull();
    await runtime.settled();
    await storage.acceptedCommitsSettled();
  }
  const value = runtime.getCellFromLink(targetLink).get();
  const runs =
    runtime.scheduler.getActionRunTrace().filter((entry) =>
      entry.actionId === request.actionId && entry.actionType === "computation"
    ).length;
  const claimIntegrated = request.claim !== undefined &&
    (storage.open(activeSpace).replica as unknown as {
        executionClaimForActionKey(
          claim: ExecutionClaim,
        ): ExecutionClaim | undefined;
      }).executionClaimForActionKey(request.claim) !== undefined;
  worker.postMessage({
    type: "response",
    requestId: request.requestId,
    ok: {
      runs,
      value,
      claimIntegrated,
      suppressed: routingCount("execution-client-derived-suppressed") -
        suppressedBaseline,
      upstream: routingCount("execution-client-derived-upstream-commit") -
        upstreamBaseline,
    },
  });
}
