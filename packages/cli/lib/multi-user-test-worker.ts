/**
 * Worker-side runtime host for multi-user pattern tests (`cf test`).
 *
 * Each worker owns one full client stack — Identity, StorageManager,
 * Runtime, Engine — in its own JS realm, exactly like one browser tab or
 * CLI process. All workers of a test share one storage server and one
 * space; each runs the test file's `setup` pattern on the SAME result cell
 * (local-first: every client runs the shared instance, so per-user scoped
 * outputs are computed under this worker's principal) and then its own
 * participant pattern, whose `tests` steps the orchestrator drives via a
 * small request/response protocol.
 *
 * Realm isolation is required, not an optimization: two runtimes in one
 * realm cross-talk through module-level state (verified-load registries,
 * frame stack).
 */

import {
  type Cell,
  type ConsoleHandler,
  ConsoleMethod,
  type Engine,
  experimentalOptionsFromEnv,
  type Pattern,
  PatternCoverageCollector,
  patternCoverageOutputPath,
  Runtime,
  runtimePresets,
  writePatternCoverageLcov,
} from "@commonfabric/runner";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import {
  flushDefaultModuleByteCache,
  getDefaultModuleByteCache,
} from "./compile-byte-cache.ts";
import { buildActionEvent } from "./trusted-test-event.ts";
import {
  appendLoggerDeltaMessages,
  type LoggerErrorWarnSnapshot,
  snapshotLoggerErrorWarnCounts,
} from "./console-capture.ts";
import {
  createSession,
  Identity,
  type KeyPairRaw,
} from "@commonfabric/identity";

export interface WorkerRequest {
  id: number;
  cmd: string;
  args: Record<string, unknown>;
}

export type WorkerResponse =
  | { id: number; ok: unknown }
  | { id: number; error: string };

export type StepKind = "action" | "assertion" | "label" | "await";

export interface StepMeta {
  kind: StepKind;
  /** Marker name for label/await steps. */
  marker?: string;
  skip?: boolean;
}

export interface ParticipantInitResult {
  steps: StepMeta[];
  allowRuntimeErrors: boolean;
  expectNonIdempotent: boolean;
  allowConsoleErrors: boolean;
  allowConsoleWarnings: boolean;
}

const SETUP_CAUSE = "multi-user-test-setup";
const SETTLE_FAST_MS = 2;

let runtime: Runtime | undefined;
let storageManager:
  | { synced(): Promise<void>; close(): Promise<void> }
  | undefined;
let engine: Engine | undefined;
let stepCells: Cell<unknown>[] = [];
let patternCoverage: PatternCoverageCollector | undefined;
let patternCoveragePath: string | undefined;
let patternCoverageRoot: string | undefined;
const runtimeErrors: string[] = [];
/** Channel 1: console.error/warn captured via the harness console event. */
const consoleErrors: string[] = [];
const consoleWarnings: string[] = [];
// Run-phase gate for channel 1 (mirrors test-runner.ts): flips true at the
// post-compile point where the channel-2 snapshot is taken, so compile-time
// module-evaluation console output does not fail tests.
let consoleCaptureActive = false;
/** Channel 2: logger error/warn count snapshot taken after compile, before run. */
let loggerCountsBeforeRun: LoggerErrorWarnSnapshot = new Map();

function rt(): Runtime {
  if (!runtime) throw new Error("worker not initialized");
  return runtime;
}

async function settle(maxIterations = 20): Promise<void> {
  for (let i = 0; i < maxIterations; i++) {
    const start = performance.now();
    await rt().idle();
    await storageManager!.synced();
    if (performance.now() - start < SETTLE_FAST_MS) return;
  }
}

const stepPeekSchema = {
  type: "object",
  properties: {
    action: { type: "unknown" },
    assertion: { type: "unknown" },
    label: { type: "string" },
    await: { type: "string" },
    event: { type: "unknown" },
    trustedUi: {
      type: "object",
      properties: {
        surface: { type: "string" },
        action: { type: "string" },
      },
    },
    skip: { type: "boolean" },
  },
} as const;

function classifyStep(stepCell: Cell<unknown>, index: number): StepMeta {
  const peek = stepCell.asSchema(stepPeekSchema).get() as {
    action?: unknown;
    assertion?: unknown;
    label?: string;
    await?: string;
    skip?: boolean;
  };
  const skip = peek?.skip === true ? { skip: true } : {};
  if (typeof peek?.label === "string") {
    return { kind: "label", marker: peek.label, ...skip };
  }
  if (typeof peek?.await === "string") {
    return { kind: "await", marker: peek.await, ...skip };
  }
  // Streams/computeds peek as present-but-opaque; key presence is the signal.
  if (Object.hasOwn(peek ?? {}, "action")) return { kind: "action", ...skip };
  if (Object.hasOwn(peek ?? {}, "assertion")) {
    return { kind: "assertion", ...skip };
  }
  throw new Error(
    `Test step ${index} has none of action/assertion/label/await ` +
      `(keys: ${Object.keys(peek ?? {}).join(",") || "none"})`,
  );
}

const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  /**
   * Boot the stack, run the shared `setup` pattern, run this worker's
   * participant pattern, and return the classified step list.
   */
  async init(args) {
    const identity = await Identity.deserialize(args.rawIdentity as KeyPairRaw);
    const session = await createSession({
      identity,
      spaceName: args.spaceName as string,
    });
    const space = session.space;
    const { StorageManager } = await import(
      "@commonfabric/runner/storage/cache.deno"
    );
    storageManager = StorageManager.open({
      as: session.as,
      spaceIdentity: session.spaceIdentity,
      // Host only — the storage path (/api/storage/memory) is joined
      // internally (see createStorageAddressResolver).
      memoryHost: new URL(args.apiUrl as string),
    });
    // `runtimePresets.patternTest` carries the shared first-party posture
    // (CT-1814), including the enforce-explicit CFC pin this site previously
    // restated — and the same env-honored experimental flags as the
    // single-user runner (this worker previously ignored EXPERIMENTAL_*, so
    // the two harness modes could run under different flags).
    runtime = new Runtime(runtimePresets.patternTest({
      apiUrl: new URL(import.meta.url),
      storageManager: storageManager as never,
      experimental: experimentalOptionsFromEnv(Deno.env.get),
      errorHandlers: [(error: Error) => runtimeErrors.push(String(error))],
      moduleByteCache: getDefaultModuleByteCache(),
    }));
    runtime.enableIdempotencyCheck();
    // Channel 1: capture pattern-code console.error / console.warn calls.
    runtime.scheduler.onConsole(
      (({ method, args }) => {
        if (!consoleCaptureActive) {
          return args;
        }
        if (method === ConsoleMethod.Error) {
          consoleErrors.push(
            `[console.error] ${args.map((a) => String(a)).join(" ")}`,
          );
        } else if (method === ConsoleMethod.Warn) {
          consoleWarnings.push(
            `[console.warn] ${args.map((a) => String(a)).join(" ")}`,
          );
        }
        return args;
      }) satisfies ConsoleHandler,
    );
    // Use the runtime's own harness (see test-runner.ts): a second Engine
    // splits verified-load/source-map state and breaks CFC verified-binding
    // identities under enforcement.
    engine = runtime.harness;
    patternCoverage = typeof args.patternCoverageDir === "string"
      ? new PatternCoverageCollector()
      : undefined;
    patternCoveragePath = typeof args.patternCoverageDir === "string"
      ? patternCoverageOutputPath(
        args.patternCoverageDir,
        args.testPath as string,
        args.participant as string,
      )
      : undefined;
    patternCoverageRoot = typeof args.root === "string" ? args.root : undefined;

    const program = await engine.resolve(
      new FileSystemProgramResolver(
        args.testPath as string,
        args.root as string | undefined,
      ),
    );
    // `compileAndRegisterModules` seals compile + evaluate + register (see
    // test-runner.ts): map/filter/flatMap ops resolve via their content-addressed
    // canonical artifact instead of the defer-corrupted embedded graph (CT-1811).
    const evalResult = await runtime.patternManager.compileAndRegisterModules(
      program,
      { patternCoverage },
    );
    const { main } = evalResult;
    // Channel 2: snapshot logger counts AFTER compile, before the run phase.
    loggerCountsBeforeRun = snapshotLoggerErrorWarnCounts();
    consoleCaptureActive = true;
    const descriptor = (main?.default ?? {}) as {
      setup?: Pattern;
      participants?: Record<string, Pattern | { pattern: Pattern }>;
    };
    const entry = descriptor.participants?.[args.participant as string];
    const participantFactory = typeof entry === "function"
      ? entry
      : (entry as { pattern?: Pattern } | undefined)?.pattern;
    if (typeof participantFactory !== "function") {
      throw new Error(
        `No participant pattern "${args.participant}" in test descriptor`,
      );
    }

    // Minimal wish("#default") environment, seeded once by the first worker.
    if (args.seedDefaults === true) {
      const setupTx = rt().edit();
      const spaceCell = rt().getCell(space, space, undefined, setupTx);
      const defaultPatternCell = rt().getCell(
        space,
        "default-pattern",
        undefined,
        setupTx,
      );
      (defaultPatternCell as any).key("allPieces").set([]);
      (defaultPatternCell as any).key("recentPieces").set([]);
      (defaultPatternCell as any).key("backlinksIndex").set({
        mentionable: [],
      });
      (spaceCell as any).key("defaultPattern").set(defaultPatternCell);
      rt().prepareTxForCommit?.(setupTx);
      await setupTx.commit();
      await rt().idle();
    }

    // Run the shared setup pattern on a cause-derived result cell: every
    // worker runs the SAME instance (the first materializes it, the rest
    // resume it from storage and compute their own per-user partitions).
    let setupCell: Cell<Record<string, unknown>> | undefined;
    if (typeof descriptor.setup === "function") {
      const tx = rt().edit();
      setupCell = rt().getCell<Record<string, unknown>>(
        space,
        SETUP_CAUSE,
        undefined,
        tx,
      );
      await setupCell.sync();
      rt().run(tx, descriptor.setup, {}, setupCell);
      rt().prepareTxForCommit?.(tx);
      await tx.commit();
      await settle();
    }

    const tx = rt().edit();
    const resultCell = rt().getCell<Record<string, unknown>>(
      space,
      `multi-user-test-${args.participant}`,
      undefined,
      tx,
    );
    rt().run(
      tx,
      participantFactory,
      setupCell !== undefined ? { setup: setupCell } : {},
      resultCell,
    );
    rt().prepareTxForCommit?.(tx);
    await tx.commit();
    await settle();

    const stepsValue = resultCell.key("tests").asSchema(
      {
        type: "array",
        items: { type: "object", asCell: ["cell"] },
        default: [],
      } as const,
    ).get();
    if (!Array.isArray(stepsValue)) {
      throw new Error(
        `Participant "${args.participant}" must return { tests: TestStep[] }`,
      );
    }
    stepCells = stepsValue as Cell<unknown>[];

    const result: ParticipantInitResult = {
      steps: stepCells.map((cell, index) => classifyStep(cell, index)),
      allowRuntimeErrors:
        await (resultCell.key("allowRuntimeErrors") as Cell<unknown>)
          .pull() === true,
      expectNonIdempotent:
        await (resultCell.key("expectNonIdempotent") as Cell<unknown>)
          .pull() === true,
      allowConsoleErrors:
        await (resultCell.key("allowConsoleErrors") as Cell<unknown>)
          .pull() === true,
      allowConsoleWarnings:
        await (resultCell.key("allowConsoleWarnings") as Cell<unknown>)
          .pull() === true,
    };
    return result;
  },

  /** Invoke an action step's stream and settle. */
  async action({ index }) {
    const stepCell = stepCells[index as number];
    const stream = stepCell.key("action" as never) as unknown as {
      send?: (value: unknown) => void;
    };
    if (typeof stream?.send !== "function") {
      throw new Error(`Test step ${index} action is not a stream`);
    }
    const meta = stepCell.asSchema(stepPeekSchema).get() as {
      event?: unknown;
      trustedUi?: unknown;
    };
    stream.send(buildActionEvent(meta?.event, meta?.trustedUi));
    await settle();
    return {};
  },

  /** Pull an assertion step's value; the orchestrator handles retries. */
  async assertion({ index }) {
    const stepCell = stepCells[index as number];
    const value = await (stepCell.key("assertion" as never) as Cell<unknown>)
      .pull();
    return { passed: value === true };
  },

  /** Let in-flight work and incoming subscription pushes land. */
  async settle() {
    await settle(6);
    return {};
  },

  /** Runtime health for end-of-run reporting. */
  health() {
    // Apply channel-2 logger deltas now (end of run) so they are included in
    // the health report returned to the orchestrator.
    appendLoggerDeltaMessages(
      loggerCountsBeforeRun,
      consoleErrors,
      consoleWarnings,
    );
    return Promise.resolve({
      runtimeErrors: [...runtimeErrors],
      consoleErrors: [...consoleErrors],
      consoleWarnings: [...consoleWarnings],
      nonIdempotent: rt().getIdempotencyViolations?.()?.map((violation) => {
        const { actionId, differingWriteKeys } = violation as {
          actionId?: string;
          differingWriteKeys?: string[];
        };
        const id = String(actionId ?? violation);
        return differingWriteKeys?.length
          ? `${id} (differing writes: ${differingWriteKeys.join(", ")})`
          : id;
      }) ?? [],
    });
  },

  async writeCoverage() {
    if (patternCoverage && patternCoveragePath) {
      await writePatternCoverageLcov(
        patternCoverage,
        patternCoveragePath,
        { root: patternCoverageRoot },
      );
    }
    return {};
  },

  async dispose() {
    stepCells = [];
    // `engine` is the runtime's own harness; runtime.dispose() disposes it.
    await runtime?.dispose();
    await storageManager?.close();
    flushDefaultModuleByteCache();
    runtime = undefined;
    storageManager = undefined;
    engine = undefined;
    patternCoverage = undefined;
    patternCoveragePath = undefined;
    patternCoverageRoot = undefined;
    return {};
  },
};

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { id, cmd, args } = event.data;
  const handler = handlers[cmd];
  const respond = (response: WorkerResponse) =>
    (self as unknown as Worker).postMessage(response);
  if (!handler) {
    respond({ id, error: `unknown command "${cmd}"` });
    return;
  }
  handler(args).then(
    (ok) => respond({ id, ok }),
    (error: unknown) => respond({ id, error: formatError(error) }),
  );
};

function formatError(error: unknown): string {
  return error instanceof Error
    ? error.stack || error.message || String(error)
    : String(error);
}
