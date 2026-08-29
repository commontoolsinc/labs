/**
 * Deployed-topology posture gate for the `bg-piece-service` BINARY
 * (server-execution v2 Phase 7's flip PR — the plan's own obligation, and
 * the P7 independent review's finding 8: the deployed-topology binaries the
 * presets flip were built by CI but exercised ON by no gate).
 *
 * What it proves, on the real compiled binary against the lane's
 * default-built toolshed: the binary STARTS, initializes its service (a
 * genuine flow — identity, session open, and the BG-pieces read/watch
 * against the toolshed), and RESOLVES the first-party server-execution
 * default — OFF again under the flip-OFF lever (the `productionServer`
 * preset's env-else-`SERVER_EXECUTION_DEFAULT_ENABLED` resolution —
 * exactly the path a flip changes, which explicit-env lanes never
 * exercise). The binary has no HTTP surface, so its startup posture log
 * line is the probe. It then shuts down cleanly on SIGTERM.
 *
 * The gate FOLLOWS the default in both directions — it is the flip's own
 * tripwire, so its expected arm moves with the constant and with nothing
 * else. Under the flip PR it expected ON; rolled back it expects OFF, and
 * a serving-loop default would fail it loudly.
 *
 * Runs only in the "Deployed Topology Posture Gates" CI job (deno.yml),
 * which provides the two env inputs; it is in `integration/`, which the
 * package's `test` task does not match, so the workspace Test job never
 * runs it. Locally:
 *   BG_PIECE_SERVICE_BIN=./dist/bg-piece-service \
 *   API_URL=http://localhost:8000 \
 *   deno test --allow-env --allow-run --allow-net integration/posture-gate.test.ts
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defer } from "@commonfabric/utils/defer";

const BIN = Deno.env.get("BG_PIECE_SERVICE_BIN");
const API_URL = Deno.env.get("API_URL");

const STARTED_LINE = "Background Piece Service started successfully";
const POSTURE_LINE =
  /Background Piece Service server-execution posture: (ON|OFF)/;
/**
 * A bounded DIAGNOSTIC backstop, never the wait itself: the startup wait
 * below resolves on the line the stream reader delivers, raced against the
 * child's own exit, so a slow runner cannot fail a healthy startup. This
 * bound only exists to report a startup signal that never arrived at all
 * (docs/development/waiting-in-tests.md: an event where one exists; a bound
 * only where none does).
 */
const STARTUP_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Collects a stream's lines into `sink`, resolving when the stream ends, and
 * hands every line to `onLine` as it arrives — which is what lets the caller
 * settle a deferred the instant the startup line is delivered, instead of
 * re-reading the collected lines on a timer.
 */
const drain = async (
  stream: ReadableStream<Uint8Array>,
  sink: string[],
  onLine: (line: string) => void,
): Promise<void> => {
  const decoder = new TextDecoder();
  let buffered = "";
  const take = (line: string) => {
    sink.push(line);
    onLine(line);
  };
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) take(line);
  }
  if (buffered.length > 0) take(buffered);
};

describe(
  "bg-piece-service deployed-topology posture gate",
  { ignore: !BIN || !API_URL },
  () => {
    it("the binary starts against the lane's toolshed, resolves the default posture OFF, and stops cleanly", async () => {
      // The gate exercises the DEFAULT resolution (unset flag → the
      // first-party constant). An inherited explicit value would make it
      // vacuously test the env path instead — refuse to run that way.
      expect(Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION")).toBe(undefined);

      const child = new Deno.Command(BIN!, {
        args: [],
        env: {
          API_URL: API_URL!,
          OPERATOR_PASS: "deployed-topology-posture-gate",
        },
        stdout: "piped",
        stderr: "piped",
        stdin: "null",
      }).spawn();

      const lines: string[] = [];
      // The startup wait is an EVENT, not a poll: the stream readers settle
      // this the instant the line is delivered.
      const started = defer();
      const noticeStartup = (line: string) => {
        if (line.includes(STARTED_LINE)) started.resolve();
      };
      const stdoutDone = drain(child.stdout, lines, noticeStartup);
      const stderrDone = drain(child.stderr, lines, noticeStartup);

      // Raced against the child's own exit — the other way this wait ends —
      // with the deadline as the diagnostic backstop only.
      let backstopTimer: ReturnType<typeof setTimeout> | undefined;
      const backstopFired = new Promise<"backstop">((resolve) => {
        backstopTimer = setTimeout(
          () => resolve("backstop"),
          STARTUP_TIMEOUT_MS,
        );
      });
      const startup = await Promise.race([
        started.promise.then(() => "started" as const),
        child.status.then((status) => ({ exited: status })),
        backstopFired,
      ]);
      clearTimeout(backstopTimer);

      if (startup !== "started") {
        if (startup === "backstop") {
          child.kill("SIGKILL");
          await Promise.allSettled([stdoutDone, stderrDone, child.status]);
          throw new Error(
            `bg-piece-service never reported its startup signal ` +
              `("${STARTED_LINE}"); the ${STARTUP_TIMEOUT_MS} ms diagnostic ` +
              `backstop fired. Output:\n${lines.join("\n")}`,
          );
        }
        // The child ended the wait by exiting. Flush both streams first, so
        // the report carries everything it printed on the way down. The
        // wording covers both shapes this takes — never started, or started
        // and died — because either way the gate never got to read the
        // posture of a running service.
        await Promise.allSettled([stdoutDone, stderrDone]);
        throw new Error(
          `bg-piece-service exited (code ${startup.exited.code}) before the ` +
            `gate could read its posture. Output:\n${lines.join("\n")}`,
        );
      }

      try {
        const postures = lines
          .map((line) => POSTURE_LINE.exec(line)?.[1])
          .filter((arm): arm is string => arm !== undefined);
        expect(
          postures,
          `expected exactly one posture line in:\n${lines.join("\n")}`,
        ).toEqual(["OFF"]);
      } finally {
        // Clean shutdown is part of the gate: the SIGTERM handler stops the
        // service and exits 0.
        child.kill("SIGTERM");
        const shutdownTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, SHUTDOWN_TIMEOUT_MS);
        const status = await child.status;
        clearTimeout(shutdownTimer);
        await Promise.allSettled([stdoutDone, stderrDone]);
        expect(status.code).toBe(0);
      }
    });
  },
);
