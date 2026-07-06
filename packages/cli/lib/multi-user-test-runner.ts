/**
 * Multi-user mode for `cf test`.
 *
 * A multi-user test file exports a descriptor as its default export:
 *
 * ```tsx
 * export const setup = pattern(() => ({ chat: GroupChatDemo({}) }));
 * export const alice = pattern<{ setup: Setup }>(({ setup }) => ({
 *   tests: [
 *     { action: action_save_alice },
 *     { label: "alice-saved" },
 *     { await: "bob-saved" },
 *     { assertion: assert_sees_bob },
 *   ],
 * }));
 * export const bob = pattern<{ setup: Setup }>(({ setup }) => ({
 *   tests: [
 *     { await: "alice-saved" },
 *     { assertion: assert_sees_alice },
 *     { action: action_save_bob },
 *     { label: "bob-saved" },
 *   ],
 * }));
 * export default { setup, participants: { alice, bob } };
 * ```
 *
 * Each participant runs in its own worker realm with its own identity
 * (`{ pattern, user: "alice" }` shares an identity for a second session of
 * the same user), all against one shared space on an in-process storage
 * server. The `setup` pattern instantiates the shared piece once; every
 * worker runs that same instance locally (like every browser tab does), so
 * per-user scoped state behaves like production.
 *
 * Coordination: a participant's steps run in order until an
 * `{ await: marker }` for a marker no other participant has announced via
 * `{ label: marker }` yet; the orchestrator then switches to the next
 * runnable participant. If every unfinished participant is parked, the test
 * fails with a deadlock report. Assertions retry (with settling) until the
 * step timeout, since asserted state may still be propagating from another
 * runtime.
 */

import { Identity } from "@commonfabric/identity";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import type {
  TestResult,
  TestRunnerOptions,
  TestRunResult,
} from "./test-runner.ts";
import type {
  ParticipantInitResult,
  StepMeta,
  WorkerRequest,
  WorkerResponse,
} from "./multi-user-test-worker.ts";

export interface MultiUserParticipantSpec {
  name: string;
  /** Identity seed; participants with the same `user` share an identity. */
  user: string;
}

export interface MultiUserDescriptorMeta {
  participants: MultiUserParticipantSpec[];
}

/**
 * Recognize a multi-user descriptor (default export with a `participants`
 * record of pattern factories or `{ pattern, user? }` entries). Returns the
 * orchestration metadata, or undefined for ordinary single-runtime tests.
 */
export function multiUserDescriptorMeta(
  defaultExport: unknown,
): MultiUserDescriptorMeta | undefined {
  if (
    typeof defaultExport !== "object" || defaultExport === null ||
    typeof (defaultExport as { participants?: unknown }).participants !==
      "object"
  ) {
    return undefined;
  }
  const raw = (defaultExport as { participants: Record<string, unknown> })
    .participants;
  const participants: MultiUserParticipantSpec[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry === "function") {
      participants.push({ name, user: name });
    } else if (
      typeof entry === "object" && entry !== null &&
      typeof (entry as { pattern?: unknown }).pattern === "function"
    ) {
      const user = (entry as { user?: unknown }).user;
      participants.push({
        name,
        user: typeof user === "string" ? user : name,
      });
    } else {
      return undefined;
    }
  }
  return participants.length > 0 ? { participants } : undefined;
}

const RPC_TIMEOUT_MS = 120_000;
const ASSERTION_RETRY_DELAY_MS = 100;

class ParticipantWorker {
  readonly name: string;
  #worker: Worker;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(name: string) {
    this.name = name;
    this.#worker = new Worker(
      new URL("./multi-user-test-worker.ts", import.meta.url),
      { type: "module", name: `cf-test:${name}` },
    );
    this.#worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      if ("error" in event.data) {
        pending.reject(new Error(`[${this.name}] ${event.data.error}`));
      } else {
        pending.resolve(event.data.ok);
      }
    };
    this.#worker.onerror = (event) => {
      const error = new Error(`[${this.name}] worker error: ${event.message}`);
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
  }

  call(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.#nextId++;
    const request: WorkerRequest = { id, cmd, args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `[${this.name}] ${cmd} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#worker.postMessage(request);
    });
  }

  terminate(): void {
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error(`[${this.name}] worker terminated`));
    }
    this.#pending.clear();
  }
}

interface ParticipantState {
  spec: MultiUserParticipantSpec;
  worker: ParticipantWorker;
  steps: StepMeta[];
  cursor: number;
  actionCount: number;
  assertionCount: number;
  lastActionName: string | null;
  allowRuntimeErrors: boolean;
  expectNonIdempotent: boolean;
  allowConsoleErrors: boolean;
  allowConsoleWarnings: boolean;
}

export async function runMultiUserTestPattern(
  testPath: string,
  meta: MultiUserDescriptorMeta,
  options: TestRunnerOptions = {},
): Promise<TestRunResult> {
  const startTime = performance.now();
  const stepTimeout = options.timeout ?? 5000;
  const results: TestResult[] = [];
  const runtimeErrors: string[] = [];
  const nonIdempotent: string[] = [];

  const server = StandaloneMemoryServer.start();
  const spaceName = crypto.randomUUID();
  const participants: ParticipantState[] = [];

  try {
    const identities = new Map<string, Identity>();
    for (const spec of meta.participants) {
      if (!identities.has(spec.user)) {
        identities.set(
          spec.user,
          await Identity.fromPassphrase(`test-runner ${spec.user}`, {
            implementation: "noble",
          }),
        );
      }
    }

    // Sequential init: the first worker materializes the shared setup
    // instance (and the wish("#default") seed); the rest resume it.
    for (const [index, spec] of meta.participants.entries()) {
      const worker = new ParticipantWorker(spec.name);
      try {
        const init = await worker.call("init", {
          rawIdentity: identities.get(spec.user)!.serialize(),
          spaceName,
          apiUrl: server.url.href,
          testPath,
          root: options.root,
          patternCoverageDir: options.patternCoverageDir,
          participant: spec.name,
          seedDefaults: index === 0,
        }) as ParticipantInitResult;
        participants.push({
          spec,
          worker,
          steps: init.steps,
          cursor: 0,
          actionCount: 0,
          assertionCount: 0,
          lastActionName: null,
          allowRuntimeErrors: init.allowRuntimeErrors,
          expectNonIdempotent: init.expectNonIdempotent,
          allowConsoleErrors: init.allowConsoleErrors,
          allowConsoleWarnings: init.allowConsoleWarnings,
        });
        if (options.verbose) {
          console.log(
            `  [${spec.name}] ${init.steps.length} step(s), user "${spec.user}"`,
          );
        }
      } catch (error) {
        await worker.call("dispose").catch(() => {});
        worker.terminate();
        throw error;
      }
    }

    // Marker scheduler: round-robin in declaration order; each turn runs a
    // participant's steps until it parks on an unannounced marker or ends.
    const announced = new Set<string>();
    while (participants.some((p) => p.cursor < p.steps.length)) {
      let progressed = false;
      for (const participant of participants) {
        while (participant.cursor < participant.steps.length) {
          const index = participant.cursor;
          const step = participant.steps[index];
          if (step.kind === "await" && !step.skip) {
            if (!announced.has(step.marker!)) break; // parked
            participant.cursor++;
            progressed = true;
            if (options.verbose) {
              console.log(`  [${participant.spec.name}] ⇣ ${step.marker}`);
            }
            continue;
          }
          participant.cursor++;
          progressed = true;
          if (step.skip) {
            recordSkip(participant, step, results, options);
            continue;
          }
          if (step.kind === "label") {
            announced.add(step.marker!);
            if (options.verbose) {
              console.log(`  [${participant.spec.name}] ⇡ ${step.marker}`);
            }
            continue;
          }
          if (step.kind === "action") {
            participant.actionCount++;
            participant.lastActionName = `action_${participant.actionCount}`;
            const stepStart = performance.now();
            // Per-action deadline, matching the single-runtime runner's use
            // of --timeout (an action is a local send + settle; a slow one is
            // a bug, not propagation latency).
            await participant.worker.call("action", { index }, stepTimeout);
            if (options.verbose) {
              console.log(
                `  [${participant.spec.name}] ${participant.lastActionName} (${
                  Math.round(performance.now() - stepStart)
                }ms)`,
              );
            }
            continue;
          }
          // Assertion: retry with settling until the step timeout — the
          // asserted state may still be propagating from another runtime.
          participant.assertionCount++;
          const name =
            `${participant.spec.name}/assertion_${participant.assertionCount}`;
          const stepStart = performance.now();
          let passed = false;
          let error: string | undefined;
          while (true) {
            try {
              const outcome = await participant.worker.call("assertion", {
                index,
              }) as { passed: boolean };
              passed = outcome.passed;
              error = undefined;
            } catch (assertionError) {
              passed = false;
              error = String(
                (assertionError as Error).message ?? assertionError,
              );
            }
            if (passed || performance.now() - stepStart >= stepTimeout) break;
            await participant.worker.call("settle");
            await new Promise((resolve) =>
              setTimeout(resolve, ASSERTION_RETRY_DELAY_MS)
            );
          }
          const durationMs = performance.now() - stepStart;
          // runTests prints each result; no per-step echo here.
          results.push({
            name,
            passed,
            afterAction: participant.lastActionName === null
              ? null
              : `${participant.spec.name}/${participant.lastActionName}`,
            ...(error !== undefined ? { error } : {}),
            durationMs,
          });
        }
      }
      if (!progressed) {
        const parked = participants
          .filter((p) => p.cursor < p.steps.length)
          .map((p) => `${p.spec.name} awaits "${p.steps[p.cursor].marker}"`)
          .join("; ");
        throw new Error(
          `Deadlock: every remaining participant is parked (${parked}). ` +
            `Check {label}/{await} markers for a cycle or a missing label.`,
        );
      }
    }

    // Apply allowRuntimeErrors / expectNonIdempotent / allowConsoleErrors /
    // allowConsoleWarnings PER participant — one participant opting out must
    // not mask another participant's failures — so the aggregate result reports
    // only unallowed entries with the flags left off.
    let anyExpectNonIdempotent = false;
    let expectedNonIdempotentDetected = false;
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    for (const participant of participants) {
      const health = await participant.worker.call("health") as {
        runtimeErrors: string[];
        consoleErrors: string[];
        consoleWarnings: string[];
        nonIdempotent: string[];
      };
      if (!participant.allowRuntimeErrors) {
        runtimeErrors.push(
          ...health.runtimeErrors.map((e) => `[${participant.spec.name}] ${e}`),
        );
      }
      if (!participant.allowConsoleErrors) {
        consoleErrors.push(
          ...health.consoleErrors.map((e) => `[${participant.spec.name}] ${e}`),
        );
      }
      if (!participant.allowConsoleWarnings) {
        consoleWarnings.push(
          ...health.consoleWarnings.map((e) =>
            `[${participant.spec.name}] ${e}`
          ),
        );
      }
      if (participant.expectNonIdempotent) {
        anyExpectNonIdempotent = true;
        if (health.nonIdempotent.length > 0) {
          expectedNonIdempotentDetected = true;
        }
      } else {
        nonIdempotent.push(
          ...health.nonIdempotent.map((e) => `[${participant.spec.name}] ${e}`),
        );
      }
    }
    // expectNonIdempotent asserts the detector fires. Which runtime re-runs
    // the offending computation depends on sync/scheduling, so the
    // expectation is satisfied when ANY flagged participant saw a violation;
    // it fails as a synthetic result when none did (the aggregate's flag
    // field stays unset, so runTests applies no result-level expectation).
    if (anyExpectNonIdempotent && !expectedNonIdempotentDetected) {
      results.push({
        name: "expectNonIdempotent",
        passed: false,
        afterAction: null,
        error: "expected non-idempotent computation(s), none detected",
        durationMs: 0,
      });
    }

    return {
      path: testPath,
      results,
      totalDurationMs: performance.now() - startTime,
      navigations: [],
      runtimeErrors,
      nonIdempotent,
      consoleErrors,
      consoleWarnings,
    };
  } catch (error) {
    return {
      path: testPath,
      results,
      totalDurationMs: performance.now() - startTime,
      navigations: [],
      runtimeErrors,
      nonIdempotent,
      consoleErrors: [],
      consoleWarnings: [],
      error: error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`
        : String(error),
    };
  } finally {
    for (const participant of participants) {
      if (options.patternCoverageDir) {
        await participant.worker.call("writeCoverage").catch((error) => {
          console.error(
            `[cf test] failed to write pattern coverage for ${participant.spec.name}: ${
              formatError(error)
            }`,
          );
        });
      }
      await participant.worker.call("dispose").catch(() => {});
      participant.worker.terminate();
    }
    await server.close().catch(() => {});
  }
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? error.stack || error.message || String(error)
    : String(error);
}

function recordSkip(
  participant: ParticipantState,
  step: StepMeta,
  results: TestResult[],
  options: TestRunnerOptions,
): void {
  if (step.kind === "assertion") {
    participant.assertionCount++;
    const name =
      `${participant.spec.name}/assertion_${participant.assertionCount}`;
    results.push({
      name,
      passed: true,
      skipped: true,
      afterAction: null,
      durationMs: 0,
    });
  } else if (step.kind === "action") {
    participant.actionCount++;
    if (options.verbose) {
      console.log(
        `  [${participant.spec.name}] ⊘ action_${participant.actionCount} (skipped)`,
      );
    }
  }
}
