/**
 * Read-only host checks for console health. Responses establish only the fact
 * each row names; an unreadable response leaves that fact unknown.
 */

import {
  type HarnessPatternIndexClientFactory,
  PatternIndexError,
} from "../src/pattern-index/client.ts";
import { DEFAULT_DOCKER_BINARY } from "../src/sandbox/docker-runsc.ts";
import { readDockerRuntimes } from "../src/sandbox/docker-runtimes.ts";
import {
  type ConsoleHealthFact,
  type ConsoleHealthProbe,
  type ConsoleHealthRow,
  consoleHealthUrl,
} from "./health.ts";

/** Checks the running daemon's registration without starting a sandbox. */
export const consoleSandboxHealthProbe = (
  readRuntimes = () => readDockerRuntimes(DEFAULT_DOCKER_BINARY),
): ConsoleHealthProbe => {
  const source = "docker info";
  const detail = "docker info --format '{{json .Runtimes}}'";
  const initial: ConsoleHealthFact[] = [{
    id: "sandbox.docker",
    group: "sandbox",
    label: "Docker Daemon",
    value: "not checked",
    source,
    detail,
  }, {
    id: "sandbox.runtime",
    group: "sandbox",
    label: "Sandbox Runtime",
    value: "not checked",
    source,
    detail,
  }];
  const unavailable = (checkedAt: string): ConsoleHealthRow[] =>
    initial.map((row) => ({
      ...row,
      state: "unknown",
      checkedAt,
      value: "not verified",
      reason: "The Docker runtime table could not be read.",
      remedy: "Start Docker and check its runsc-cfc runtime registration.",
    }));
  return {
    id: "sandbox",
    initial,
    unavailable,
    read: async () => {
      const result = await readRuntimes();
      const checkedAt = new Date().toISOString();
      if (
        typeof result.runtimes !== "object" || result.runtimes === null ||
        Array.isArray(result.runtimes)
      ) {
        return unavailable(checkedAt).map((row) => ({
          ...row,
          reason: result.unreadable ??
            "Docker returned an invalid runtime table.",
        }));
      }
      const registered = Object.hasOwn(result.runtimes, "runsc-cfc");
      return [{
        ...initial[0],
        state: "ok",
        checkedAt,
        value: "responding",
      }, {
        ...initial[1],
        state: registered ? "ok" : "failed",
        checkedAt,
        value: registered ? "runsc-cfc registered" : "runsc-cfc not registered",
        ...(registered ? {} : {
          reason: "The running daemon has no runsc-cfc entry.",
          remedy:
            "Install the runsc-cfc runtime and reload Docker's runtime registration.",
        }),
      }];
    },
  };
};

/** Checks health and membership independently using the console's client. */
export const consolePatternIndexHealthProbes = (
  baseUrl: string,
  clientFactory: HarnessPatternIndexClientFactory,
): readonly ConsoleHealthProbe[] => {
  const displayUrl = consoleHealthUrl(baseUrl);
  const facts: ConsoleHealthFact[] = [{
    id: "index.reachable",
    group: "index",
    label: "Pattern Index Reachability",
    value: "not checked",
    source: "index /health",
    detail: `GET health at ${displayUrl}`,
  }, {
    id: "index.enrolled",
    group: "index",
    label: "Pattern Index Enrollment",
    value: "not checked",
    source: "index /enrollmentStatus",
    detail: `GET enrollmentStatus at ${displayUrl}, for the console identity`,
  }];
  return facts.map((fact, index) => {
    const unavailable = (
      checkedAt: string,
      error?: unknown,
    ): ConsoleHealthRow[] => [{
      ...fact,
      state: "unknown",
      checkedAt,
      value: "not verified",
      reason: error instanceof PatternIndexError
        ? `The index answered HTTP ${error.status}; this does not establish ${
          index === 0 ? "health" : "membership"
        }.`
        : "The index observation could not be completed or its response was not valid.",
      remedy:
        "Check the configured index URL, network access, and console identity file.",
    }];
    return {
      id: fact.id,
      initial: [fact],
      unavailable,
      read: async () => {
        const client = await clientFactory();
        const result =
          await (index === 0 ? client.health() : client.enrollmentStatus());
        const checkedAt = new Date().toISOString();
        if (
          typeof result !== "object" || result === null || Array.isArray(result)
        ) return unavailable(checkedAt);
        const record = result as Record<string, unknown>;
        const field = index === 0 ? "ok" : "enrolled";
        if (
          !Object.hasOwn(record, field) || typeof record[field] !== "boolean" ||
          (index !== 0 &&
            (!Object.hasOwn(record, "did") || record.did !== client.did))
        ) return unavailable(checkedAt);
        const confirmed = record[field];
        return [{
          ...fact,
          state: confirmed ? "ok" : "failed",
          checkedAt,
          value: index === 0
            ? confirmed ? "responding" : "reports unhealthy"
            : confirmed
            ? "console identity enrolled"
            : "console identity not enrolled",
          ...(confirmed ? {} : {
            remedy: index === 0
              ? "Check the pattern index deployment."
              : `Enroll the console's identity through ${
                displayUrl.replace(/\/+$/, "")
              }/enroll.`,
          }),
        }];
      },
    };
  });
};
