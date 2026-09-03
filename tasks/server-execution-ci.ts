/**
 * Defines the two server-execution roles CI carries through a default flip.
 * The default role leaves the flag unset; the opposite role selects the other
 * arm explicitly, so one constant change moves their assignments together.
 */

import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";

/** Stable role of a server-execution CI lane. */
export type ServerExecutionCiRole = "default" | "opposite";

/** Complete posture of one server-execution CI lane. */
export interface ServerExecutionCiLane {
  /** Role which stays stable when the first-party default changes. */
  readonly role: ServerExecutionCiRole;

  /** Whether this lane runs the server-execution implementation. */
  readonly enabled: boolean;

  /** Human-readable form used by CI logs and job summaries. */
  readonly label: "ON" | "OFF";

  /** Explicit flag value for the opposite role; absent for the default role. */
  readonly experimentalValue?: "true" | "false";

  /** Test-record variant for the non-default role; default stays unmarked. */
  readonly recordVariant?: "server-execution" | "server-execution-off";
}

/** Returns the two-arm CI posture for `role`. */
export function serverExecutionCiLane(
  role: ServerExecutionCiRole,
  defaultEnabled = SERVER_EXECUTION_DEFAULT_ENABLED,
): ServerExecutionCiLane {
  const enabled = role === "default" ? defaultEnabled : !defaultEnabled;
  return {
    role,
    enabled,
    label: enabled ? "ON" : "OFF",
    ...(role === "default" ? {} : {
      experimentalValue: enabled ? "true" : "false",
      recordVariant: enabled ? "server-execution" : "server-execution-off",
    } as const),
  };
}

/** Returns the lines a workflow writes to `$GITHUB_ENV` for `role`. */
export function serverExecutionCiEnvironment(
  role: ServerExecutionCiRole,
  defaultEnabled = SERVER_EXECUTION_DEFAULT_ENABLED,
): string[] {
  const lane = serverExecutionCiLane(role, defaultEnabled);
  return [
    `SERVER_EXECUTION_ENABLED=${lane.enabled}`,
    `CF_TEST_RECORDS_VARIANT=${lane.recordVariant ?? ""}`,
    ...(lane.experimentalValue === undefined
      ? []
      : [`EXPERIMENTAL_SERVER_EXECUTION=${lane.experimentalValue}`]),
  ];
}

/** Verifies the server and baked shell both carry the requested lane posture. */
export function assertServerExecutionCiPosture(
  role: ServerExecutionCiRole,
  meta: Record<string, unknown>,
  stats: Record<string, unknown>,
  defaultEnabled = SERVER_EXECUTION_DEFAULT_ENABLED,
): void {
  const lane = serverExecutionCiLane(role, defaultEnabled);
  const experimental = meta.experimental as
    | Record<string, unknown>
    | undefined;
  const published = experimental?.serverExecution;
  if (published !== lane.enabled) {
    throw new Error(
      `${role} lane publishes serverExecution=${published}; expected ${lane.enabled}`,
    );
  }

  const expectedDefine = lane.experimentalValue ?? null;
  if (meta.shellServerExecutionDefine !== expectedDefine) {
    throw new Error(
      `${role} lane shell define is ${meta.shellServerExecutionDefine}; ` +
        `expected ${expectedDefine}`,
    );
  }

  const serving = stats.servingLoop !== null && stats.servingLoop !== undefined;
  if (serving !== lane.enabled) {
    throw new Error(
      `${role} lane serving loop is ${serving ? "present" : "absent"}; ` +
        `expected server execution ${lane.label}`,
    );
  }
}

/** Runs the small workflow-facing CLI. Exported so its error paths stay tested. */
export async function runServerExecutionCiCommand(
  args: readonly string[],
  fetcher: typeof fetch = fetch,
  log: (message: string) => void = console.log,
): Promise<void> {
  const [command, role, baseUrl] = args;
  if (role !== "default" && role !== "opposite") {
    throw new Error(
      "Expected server-execution CI role `default` or `opposite`.",
    );
  }
  if (command === "env") {
    log(serverExecutionCiEnvironment(role).join("\n"));
  } else if (command === "probe" && baseUrl !== undefined) {
    const url = baseUrl.replace(/\/$/, "");
    const [metaResponse, statsResponse] = await Promise.all([
      fetcher(`${url}/api/meta`),
      fetcher(`${url}/api/health/stats`),
    ]);
    if (!metaResponse.ok || !statsResponse.ok) {
      throw new Error(
        `Posture probe failed: meta=${metaResponse.status}, stats=${statsResponse.status}`,
      );
    }
    const meta = await metaResponse.json() as Record<string, unknown>;
    const stats = await statsResponse.json() as Record<string, unknown>;
    assertServerExecutionCiPosture(role, meta, stats);
    log(
      `Verified ${role} server-execution lane (${
        serverExecutionCiLane(role).label
      }).`,
    );
  } else {
    throw new Error(
      "Expected `env <role>` or `probe <role> <toolshed-url>`.",
    );
  }
}
