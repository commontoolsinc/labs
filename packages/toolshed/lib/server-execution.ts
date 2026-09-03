// Server-execution v2 stage F (docs/specs/server-side-execution/
// serving-loop.md §1): the ExecutorHost bootstrap. Under
// EXPERIMENTAL_SERVER_EXECUTION this process hosts one committing runtime
// per ACTIVE space — the serving loop — wired to the co-hosted memory
// server: the admission-side observer (plane b) activates spaces, lease
// writes ride the direct engine plane (plane c), and the serving
// runtimes' storage sessions are in-process loopback connections with the
// SAME signed session-open production clients present (plane a). OFF,
// whether selected by the default or an explicit override, nothing here
// runs and toolshed is byte-identical to the pre-v2 behavior.

import {
  type EnvReader,
  type ExperimentalOptions,
  experimentalOptionsFromEnv,
  Runtime,
} from "@commonfabric/runner";
import { publishServingExperimentalOverrides } from "./experimental-posture.ts";
import { serverExecutionEnabledFromEnv } from "./server-execution-flag.ts";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import type { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import type { Identity } from "@commonfabric/identity";

let host: ExecutorHost | undefined;

/**
 * The flags a SERVING runtime runs regardless of the environment. Written
 * once because two consumers need the same answer: the runtime factory
 * below, and `/api/meta`, which reports the posture this deployment actually
 * serves at so a client adopting it does not run a flag the deployment
 * abandoned (docs/development/EXPERIMENTAL_OPTIONS.md).
 */
const SERVING_RUNTIME_EXPERIMENTAL = {
  serverExecution: true,
} as const satisfies ExperimentalOptions;

/** The production default for the per-space outstanding-network-effect
 * cap (serving-loop.md §5; README §3.8's multi-tenancy contract needs a
 * bound ON by default — a runaway LLM fan-out must degrade only its own
 * space). An operator-tunable posture, not a spec constant. */
export const DEFAULT_MAX_OUTSTANDING_EFFECTS = 16;

/** The Phase-6 policy knobs the toolshed bootstrap threads into the
 * ExecutorHost (`SpaceServerPolicy`'s env-overridable subset). */
export type ServerExecutionEnvPolicy = {
  flushDeadlineMs?: number;
  maxOutstandingEffects?: number;
  egressRatePerSecond?: number;
};

/**
 * Resolve the Phase-6 policy knobs from env (serving-loop.md §3's
 * T_flush "tuned in Phase 6 with the other budgets"; §5's per-space
 * budgets). Each is env-overridable; the defaults are the production
 * posture:
 * - T_flush stays the SpaceServer's built-in default (100 ms, the ruled
 *   50–100 ms order) unless overridden;
 * - the outstanding-network-effect cap defaults to
 *   `DEFAULT_MAX_OUTSTANDING_EFFECTS` per space; the LITERAL `0` is the
 *   operator's explicit opt-out (unbounded);
 * - egress pacing defaults OFF (the cap alone bounds concurrency; a rate
 *   value is a deliberate operator choice).
 *
 * Parsing is FAIL-CLOSED for the cap: an unparseable or negative value
 * ("abc", "-1", "1.5") falls back to the default and warns, instead of
 * being silently indistinguishable from the explicit `0` opt-out (a
 * typo must never disable the production bound). The other two knobs
 * have no dangerous "absent" meaning — absent = the built-in default —
 * so garbage there simply reads as unset (also warned).
 */
export function serverExecutionPolicyFromEnv(
  envGet: EnvReader,
  warn: (message: string) => void = (message) => console.warn(message),
): ServerExecutionEnvPolicy {
  /** A strictly non-negative decimal integer, or undefined for anything
   * else (garbage, sign, fraction, exponent — `parseInt` would accept
   * prefixes of those). */
  const strictNonNegativeInt = (raw: string): number | undefined =>
    /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined;

  const readRaw = (name: string): string | undefined => {
    const raw = envGet(name);
    return raw === undefined || raw === "" ? undefined : raw;
  };

  /** Positive-int knobs whose absence means the built-in default. */
  const positiveOrDefault = (name: string): number | undefined => {
    const raw = readRaw(name);
    if (raw === undefined) return undefined;
    const value = strictNonNegativeInt(raw);
    if (value === undefined || value <= 0) {
      warn(
        `Server-execution v2: ignoring ${name}=${JSON.stringify(raw)} ` +
          "(expected a positive integer); using the built-in default",
      );
      return undefined;
    }
    return value;
  };

  const flushDeadlineMs = positiveOrDefault(
    "SERVER_EXECUTION_FLUSH_DEADLINE_MS",
  );
  const egressRatePerSecond = positiveOrDefault(
    "SERVER_EXECUTION_EGRESS_RATE_PER_S",
  );
  const capRaw = readRaw("SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS");
  let maxOutstandingEffects: number | undefined;
  if (capRaw === undefined) {
    maxOutstandingEffects = DEFAULT_MAX_OUTSTANDING_EFFECTS;
  } else {
    const value = strictNonNegativeInt(capRaw);
    if (value === undefined) {
      warn(
        "Server-execution v2: ignoring SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS=" +
          `${JSON.stringify(capRaw)} (expected a non-negative integer; ` +
          "the literal 0 means unbounded); using the default " +
          `${DEFAULT_MAX_OUTSTANDING_EFFECTS}`,
      );
      maxOutstandingEffects = DEFAULT_MAX_OUTSTANDING_EFFECTS;
    } else if (value === 0) {
      // The explicit opt-out: unbounded (absent from the policy).
      maxOutstandingEffects = undefined;
    } else {
      maxOutstandingEffects = value;
    }
  }
  return {
    ...(flushDeadlineMs !== undefined ? { flushDeadlineMs } : {}),
    ...(maxOutstandingEffects !== undefined ? { maxOutstandingEffects } : {}),
    ...(egressRatePerSecond !== undefined ? { egressRatePerSecond } : {}),
  };
}

/**
 * The RULED test switch for the serving loop's space-root ensure (OW45
 * arm-B stage 1, RULED 2026-08-24 — the owner: production spaces always
 * get a default pattern; "for tests this is annoying overhead", so test
 * harnesses may switch the ensure off). `SERVER_EXECUTION_ENSURE_SPACE_ROOTS`:
 * unset or "true" = ON (the production posture); the literal "false" =
 * OFF for every space this toolshed serves (a whole-instance switch —
 * per-space discrimination is deferred by the same ruling). Parsing is
 * FAIL-TO-PRODUCTION: garbage reads as ON with a warning, so a typo can
 * never silently strip production spaces of their roots.
 */
export function ensureSpaceRootsFromEnv(
  envGet: EnvReader,
  warn: (message: string) => void = (message) => console.warn(message),
): boolean {
  const raw = envGet("SERVER_EXECUTION_ENSURE_SPACE_ROOTS");
  if (raw === undefined || raw === "" || raw === "true") return true;
  if (raw === "false") return false;
  warn(
    "Server-execution v2: ignoring SERVER_EXECUTION_ENSURE_SPACE_ROOTS=" +
      `${JSON.stringify(raw)} (expected "true" or "false"); the space-root ` +
      "ensure stays ON (the production posture)",
  );
  return true;
}

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
  // The process's ONE flag resolution (server-execution-flag.ts): the
  // explicit env value, else the first-party default — the same answer
  // the memory route used for its service-principal grant.
  if (!serverExecutionEnabledFromEnv(envGet)) {
    return undefined;
  }
  // The other experimental flags still reach the serving runtimes from env.
  const experimental = experimentalOptionsFromEnv(envGet);
  console.log(
    `Server-execution v2: serving loop ON (service ${options.identity.did()})`,
  );
  // Phase 6 policy knobs — see `serverExecutionPolicyFromEnv`.
  const ensureSpaceRoots = ensureSpaceRootsFromEnv(envGet);
  if (!ensureSpaceRoots) {
    console.log(
      "Server-execution v2: space-root ensure OFF by " +
        "SERVER_EXECUTION_ENSURE_SPACE_ROOTS=false (test posture; " +
        "production default is ON)",
    );
  }
  host = new ExecutorHost({
    policy: serverExecutionPolicyFromEnv(envGet),
    ensureSpaceRoots,
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
        experimental: { ...experimental, ...SERVING_RUNTIME_EXPERIMENTAL },
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
  // Only now, with the loop actually up: what `/api/meta` adds to the base
  // posture, so a client adopting this deployment's flags gets the ones the
  // SERVING runtimes run rather than only the generic webhook runtime's.
  publishServingExperimentalOverrides(SERVING_RUNTIME_EXPERIMENTAL);
  return host;
}

export async function stopServerExecutionHost(): Promise<void> {
  await host?.close();
  host = undefined;
  // Nothing serves any more, so `/api/meta` reports the base posture again.
  publishServingExperimentalOverrides(null);
}
