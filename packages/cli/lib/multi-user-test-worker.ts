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

import { type Cell, Engine, type Pattern, Runtime } from "@commonfabric/runner";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
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
}

const SETUP_CAUSE = "multi-user-test-setup";
const SETTLE_FAST_MS = 2;

let runtime: Runtime | undefined;
let storageManager:
  | { synced(): Promise<void>; close(): Promise<void> }
  | undefined;
let engine: Engine | undefined;
let stepCells: Cell<unknown>[] = [];
const runtimeErrors: string[] = [];

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
      address: new URL("/api/storage/memory", args.apiUrl as string),
    });
    runtime = new Runtime({
      storageManager: storageManager as never,
      // Same default as single-runtime pattern tests: actions are invoked
      // directly rather than through the trusted renderer event path.
      cfcEnforcementMode: "observe",
      apiUrl: new URL(import.meta.url),
      errorHandlers: [(error: Error) => runtimeErrors.push(String(error))],
    });
    runtime.enableIdempotencyCheck();
    engine = new Engine(runtime);

    const program = await engine.resolve(
      new FileSystemProgramResolver(
        args.testPath as string,
        args.root as string | undefined,
      ),
    );
    const { jsScript, id } = await engine.compile(program);
    const { main } = await engine.evaluate(id, jsScript, program.files);
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
    stream.send(undefined);
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
    return Promise.resolve({
      runtimeErrors: [...runtimeErrors],
      nonIdempotent: rt().getIdempotencyViolations?.()?.map((violation) =>
        String(
          (violation as { actionId?: string }).actionId ?? violation,
        )
      ) ?? [],
    });
  },

  async dispose() {
    stepCells = [];
    engine?.dispose();
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
    engine = undefined;
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
    (error: unknown) =>
      respond({
        id,
        error: error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : String(error),
      }),
  );
};
