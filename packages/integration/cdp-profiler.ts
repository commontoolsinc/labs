/**
 * CPU-profiles the runtime web-worker of a running integration browser via
 * the Chrome DevTools Protocol — no external tooling.
 *
 * Connects a second CDP client to the browser websocket endpoint (Chrome
 * supports multiple concurrent CDP sessions), discovers page targets, and
 * auto-attaches to their dedicated workers using the flattened session
 * protocol. `start()`/`stop()` then drive the V8 sampling profiler on the
 * worker whose script URL matches a substring (default: "worker").
 *
 * The resulting profile can be written as a `.cpuprofile` (loadable in Chrome
 * DevTools / speedscope) plus a ranked self-time text report, mirroring
 * `packages/runner/test/traverse-replay/profile-driver.ts`.
 */

export type CPUProfile = {
  nodes: Array<{
    id: number;
    hitCount?: number;
    callFrame: {
      functionName: string;
      url: string;
      lineNumber: number;
    };
    children?: number[];
  }>;
  samples?: number[];
  timeDeltas?: number[];
  startTime: number;
  endTime: number;
};

export interface CPUProfileSummary {
  /** Profiler interval. This is elapsed time, not CPU time. */
  wallUs: number;
  /** Sum of valid sample deltas, including V8's explicit idle samples. */
  sampledUs: number;
  /** Sample time attributed to V8's explicit `(idle)` node. */
  idleUs: number;
  /** Sample time attributed to V8's ambiguous `(program)` node. This can
   * include native event-loop work or otherwise unattributed time, so it is
   * not sufficient evidence of JavaScript CPU on its own. */
  programUs: number;
  /** Sample time attributed to a concrete JavaScript function or V8 garbage
   * collection. Excludes `(idle)`, `(program)`, and unknown sample ids. */
  attributedWorkUs: number;
  /** Sampling-derived worker CPU occupancy: sampledUs minus idleUs. */
  busyUs: number;
  /** busyUs / sampledUs, or zero when the profile has no samples. */
  busyFraction: number;
}

/**
 * Distill a worker CPU profile without mistaking the profiling interval for
 * CPU time. Chrome's `endTime - startTime` is wall time, while `timeDeltas`
 * attribute the sampling interval to nodes including an explicit `(idle)`
 * node. Only that node is excluded from busy time: garbage collection,
 * `(program)`, runtime overhead, and unknown node ids conservatively count as
 * worker occupancy. `attributedWorkUs` is the narrower CPU signal: it counts
 * only samples assigned to a concrete JavaScript function or V8 garbage
 * collection, excluding ambiguous `(program)` and unknown samples.
 *
 * CDP emits microseconds for both the profile interval and sample deltas, so
 * the summary keeps those units and leaves per-invalidation normalization to
 * the caller that owns the workload barrier.
 */
export function summarizeCPUProfile(
  profile: CPUProfile,
): CPUProfileSummary {
  const wallDelta = profile.endTime - profile.startTime;
  const wallUs = Number.isFinite(wallDelta) && wallDelta > 0 ? wallDelta : 0;
  const functionByNodeId = new Map(
    profile.nodes.map((node) => [node.id, node.callFrame.functionName]),
  );
  let sampledUs = 0;
  let idleUs = 0;
  let programUs = 0;
  let attributedWorkUs = 0;

  if (profile.samples !== undefined && profile.timeDeltas !== undefined) {
    for (let index = 0; index < profile.samples.length; index++) {
      const delta = profile.timeDeltas[index];
      if (delta === undefined || !Number.isFinite(delta) || delta <= 0) {
        continue;
      }
      sampledUs += delta;
      const functionName = functionByNodeId.get(profile.samples[index]!);
      if (functionName === "(idle)") {
        idleUs += delta;
      } else if (functionName === "(program)") {
        programUs += delta;
      } else if (functionName !== undefined) {
        attributedWorkUs += delta;
      }
    }
  }

  const busyUs = sampledUs - idleUs;
  return {
    wallUs,
    sampledUs,
    idleUs,
    programUs,
    attributedWorkUs,
    busyUs,
    busyFraction: sampledUs === 0 ? 0 : busyUs / sampledUs,
  };
}

type AttachedWorker = {
  sessionId: string;
  targetId: string;
  url: string;
  attachedAt: number;
};

const SEND_TIMEOUT_MS = 30_000;

export class CdpWorkerProfiler {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<
    number,
    {
      method: string;
      sessionId?: string;
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  #workers = new Map<string, AttachedWorker>();
  #profilingSessionId: string | undefined;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (event) => this.#onMessage(event);
    ws.onclose = () => this.#rejectAll("CDP websocket closed");
    ws.onerror = () => this.#rejectAll("CDP websocket error");
  }

  #rejectAll(reason: string, sessionId?: string) {
    for (const [id, pending] of [...this.#pending.entries()]) {
      if (sessionId !== undefined && pending.sessionId !== sessionId) continue;
      this.#pending.delete(id);
      pending.reject(new Error(`${pending.method}: ${reason}`));
    }
  }

  /**
   * Connect to the browser-level websocket endpoint (from
   * `AstralBrowser#wsEndpoint()`), discover all page targets, and auto-attach
   * to their dedicated workers.
   */
  static async connect(browserWsEndpoint: string): Promise<CdpWorkerProfiler> {
    const ws = new WebSocket(browserWsEndpoint);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Could not connect to browser CDP"));
    });
    const profiler = new CdpWorkerProfiler(ws);
    await profiler.#discoverAndAttach();
    return profiler;
  }

  #onMessage(event: MessageEvent) {
    const msg = JSON.parse(event.data as string) as {
      id?: number;
      error?: { message: string };
      result?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (!pending) return;
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method === "Target.attachedToTarget") {
      const params = msg.params as {
        sessionId: string;
        targetInfo: { targetId: string; type: string; url: string };
      };
      const { sessionId, targetInfo } = params;
      if (targetInfo.type === "worker") {
        this.#workers.set(sessionId, {
          sessionId,
          targetId: targetInfo.targetId,
          url: targetInfo.url,
          attachedAt: performance.now(),
        });
        // Workers wait for the debugger when auto-attached with
        // waitForDebuggerOnStart; resume just in case (no-op otherwise).
        this.#send("Runtime.runIfWaitingForDebugger", {}, sessionId)
          .catch(() => {});
      } else if (targetInfo.type === "page" || targetInfo.type === "iframe") {
        // Auto-attach to this page's (future and current) dedicated workers.
        this.#send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        }, sessionId).catch(() => {});
      }
    } else if (msg.method === "Target.detachedFromTarget") {
      const params = msg.params as { sessionId: string };
      this.#workers.delete(params.sessionId);
      // A command sent to a detached session never gets a response.
      this.#rejectAll("target detached", params.sessionId);
    } else if (msg.method === "Target.targetCreated") {
      const params = msg.params as {
        targetInfo: { targetId: string; type: string };
      };
      if (params.targetInfo.type === "page") {
        this.#send("Target.attachToTarget", {
          targetId: params.targetInfo.targetId,
          flatten: true,
        }).catch(() => {});
      }
    }
  }

  #send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP ${method}: websocket is not open`));
        return;
      }
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(
            new Error(
              `CDP ${method} (session ${
                sessionId ?? "browser"
              }) timed out after ${SEND_TIMEOUT_MS}ms`,
            ),
          );
        }
      }, SEND_TIMEOUT_MS);
      this.#pending.set(id, {
        method,
        sessionId,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async #discoverAndAttach(): Promise<void> {
    // Attach (flattened) to all current page targets; new pages arrive via
    // Target.targetCreated → attachToTarget below.
    const { targetInfos } = await this.#send("Target.getTargets") as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    for (const info of targetInfos) {
      if (info.type !== "page") continue;
      await this.#send("Target.attachToTarget", {
        targetId: info.targetId,
        flatten: true,
      });
    }
    // Discover pages created after us (fresh-page load measurements);
    // Target.targetCreated is handled in #onMessage.
    await this.#send("Target.setDiscoverTargets", { discover: true });
  }

  /** Worker sessions currently attached, most recent first. */
  workers(): AttachedWorker[] {
    return [...this.#workers.values()].sort(
      (a, b) => b.attachedAt - a.attachedAt,
    );
  }

  /** Wait until a worker whose URL contains `urlSubstring` is attached. */
  async waitForWorker(
    urlSubstring: string,
    timeoutMs = 30_000,
  ): Promise<AttachedWorker> {
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      const worker = this.workers().find((w) => w.url.includes(urlSubstring));
      if (worker) return worker;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `Timed out waiting for worker matching "${urlSubstring}". ` +
        `Attached workers: ${this.workers().map((w) => w.url).join(", ")}`,
    );
  }

  /**
   * Start the sampling profiler on the most recently attached worker whose
   * URL contains `urlSubstring`.
   */
  async start(
    urlSubstring = "worker",
    samplingIntervalUs = 250,
  ): Promise<void> {
    const worker = await this.waitForWorker(urlSubstring);
    this.#profilingSessionId = worker.sessionId;
    await this.#send("Profiler.enable", {}, worker.sessionId);
    await this.#send(
      "Profiler.setSamplingInterval",
      { interval: samplingIntervalUs },
      worker.sessionId,
    );
    await this.#send("Profiler.start", {}, worker.sessionId);
  }

  /** Stop the profiler started by `start()` and return the profile. */
  async stop(): Promise<CPUProfile> {
    const sessionId = this.#profilingSessionId;
    if (!sessionId) throw new Error("Profiler was not started.");
    this.#profilingSessionId = undefined;
    const { profile } = await this.#send(
      "Profiler.stop",
      {},
      sessionId,
    ) as { profile: CPUProfile };
    return profile;
  }

  close(): void {
    try {
      this.#ws.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * Render a ranked self-time report (top frames + by-file) from a profile.
 * Sample time is attributed via timeDeltas, like
 * test/traverse-replay/profile-driver.ts.
 */
export function renderProfileReport(
  profile: CPUProfile,
  label: string,
  options: { topFrames?: number; topFiles?: number } = {},
): string {
  const nodeTime = new Map<number, number>();
  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      const id = profile.samples[i];
      nodeTime.set(id, (nodeTime.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0));
    }
  }
  const totalUs = [...nodeTime.values()].reduce((a, b) => a + b, 0);

  const byFrame = new Map<string, number>();
  const byFile = new Map<string, number>();
  for (const node of profile.nodes) {
    const us = nodeTime.get(node.id) ?? 0;
    if (us === 0) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    const file = url.split("/").pop() || "(internal)";
    const frame = `${functionName || "(anonymous)"} @ ${file}:${
      lineNumber + 1
    }`;
    byFrame.set(frame, (byFrame.get(frame) ?? 0) + us);
    byFile.set(file, (byFile.get(file) ?? 0) + us);
  }

  const fmt = (us: number) =>
    `${(us / 1000).toFixed(0).padStart(7)}ms ${
      ((us / totalUs) * 100).toFixed(1).padStart(5)
    }%`;

  let report = `# Worker CPU profile: ${label}\n`;
  report +=
    `wall: ${((profile.endTime - profile.startTime) / 1000).toFixed(0)}ms, ` +
    `sampled: ${(totalUs / 1000).toFixed(0)}ms\n\n`;
  report += `## Top frames by self time\n`;
  for (
    const [frame, us] of [...byFrame.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, options.topFrames ?? 45)
  ) {
    report += `${fmt(us)}  ${frame}\n`;
  }
  report += `\n## By file\n`;
  for (
    const [file, us] of [...byFile.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, options.topFiles ?? 15)
  ) {
    report += `${fmt(us)}  ${file}\n`;
  }
  return report;
}
