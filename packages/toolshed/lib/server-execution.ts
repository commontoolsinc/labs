// Server-execution v2 stage F (docs/specs/server-side-execution/
// serving-loop.md §1): the ExecutorHost bootstrap. Under
// EXPERIMENTAL_SERVER_EXECUTION this process hosts one committing runtime
// per ACTIVE space — the serving loop — wired to the co-hosted memory
// server: the admission-side observer (plane b) activates spaces, lease
// writes ride the direct engine plane (plane c), and the serving
// runtimes' storage sessions are in-process loopback connections with the
// SAME signed session-open production clients present (plane a). OFF (the
// default), nothing here runs and toolshed is byte-identical to today.

import {
  type EnvReader,
  experimentalOptionsFromEnv,
  Runtime,
} from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import type { Identity } from "@commonfabric/identity";

let host: ExecutorHost | undefined;

/**
 * Start the serving loop's host when the flag is on. Called once from
 * toolshed startup, after the memory server exists. Returns the host (or
 * undefined off the flag) so shutdown can close it.
 */
export function startServerExecutionHost(options: {
  server: MemoryServer;
  identity: Identity;
  /** The patterns/compile base — the serving runtimes' `apiUrl`. */
  apiUrl: URL;
  envGet?: EnvReader;
}): ExecutorHost | undefined {
  const envGet = options.envGet ?? Deno.env.get;
  const experimental = experimentalOptionsFromEnv(envGet);
  if (experimental.serverExecution !== true) {
    return undefined;
  }
  console.log(
    `Server-execution v2: serving loop ON (service ${options.identity.did()})`,
  );
  // Phase 6 policy knobs (serving-loop.md §3's T_flush "tuned in
  // Phase 6 with the other budgets"; §5's per-space budgets). Each is
  // env-overridable; the defaults are the production posture:
  // - T_flush stays the SpaceServer's built-in default (100 ms, the
  //   ruled 50–100 ms order) unless overridden;
  // - the outstanding-network-effect cap defaults to 16 per space (the
  //   §3.8 multi-tenancy contract needs a bound ON by default — a
  //   runaway LLM fan-out must degrade only its own space);
  // - egress pacing defaults OFF (the cap alone bounds concurrency;
  //   a rate value is a deliberate operator choice).
  const envInt = (name: string): number | undefined => {
    const raw = envGet(name);
    if (raw === undefined || raw === "") return undefined;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const flushDeadlineMs = envInt("SERVER_EXECUTION_FLUSH_DEADLINE_MS");
  // `0` (or any non-positive value) means UNBOUNDED — the operator's
  // explicit opt-out of the default cap; unset means the default.
  const maxOutstandingEffects =
    envGet("SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS") === undefined ||
      envGet("SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS") === ""
      ? 16
      : envInt("SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS");
  const egressRatePerSecond = envInt("SERVER_EXECUTION_EGRESS_RATE_PER_S");
  host = new ExecutorHost({
    policy: {
      ...(flushDeadlineMs !== undefined ? { flushDeadlineMs } : {}),
      ...(maxOutstandingEffects !== undefined ? { maxOutstandingEffects } : {}),
      ...(egressRatePerSecond !== undefined ? { egressRatePerSecond } : {}),
    },
    server: options.server,
    serviceIdentity: options.identity.did(),
    createRuntime: (space) => {
      const storageManager = LoopbackStorageManager.connect(options.server, {
        as: options.identity,
        // Phase 5 (protocol.md §2's grant-scoped read design): the
        // serving manager's FOREIGN-space providers refuse scoped
        // reads fail-closed — the producer half of the
        // delegated-scoped-read precondition.
        servingHomeSpace: space,
      });
      const runtime = new Runtime({
        apiUrl: options.apiUrl,
        storageManager,
        // The SpaceServer's own runtime (serving-loop.md §3): never the
        // Phase-2 speculation-overlay default — its factory-time loads
        // commit through the loopback plane, and the wave destination
        // takes over at activation.
        servingPosture: true,
        experimental: {
          ...experimental,
          serverExecution: true,
          // serving-loop.md §3e: the pattern-update posture flips
          // server-side — the SpaceServer owns the watcher and the swap
          // under the flag.
          systemPatternAutoUpdate: true,
        },
      });
      void space;
      return Promise.resolve({
        runtime,
        dispose: async () => {
          await runtime.dispose();
          await storageManager.close();
        },
      });
    },
  });
  return host;
}

export async function stopServerExecutionHost(): Promise<void> {
  await host?.close();
  host = undefined;
}
