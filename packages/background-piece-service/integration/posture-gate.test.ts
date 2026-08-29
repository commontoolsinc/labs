/**
 * Deployed-topology posture gate for the `bg-piece-service` BINARY
 * (server-execution v2 Phase 7's flip PR — the plan's own obligation, and
 * the P7 independent review's finding 8: the deployed-topology binaries the
 * presets flip were built by CI but exercised ON by no gate).
 *
 * What it proves, on the real compiled binary against a real serving
 * toolshed: the binary STARTS, initializes its service (a genuine flow —
 * identity, session open, and the BG-pieces read/watch against the
 * toolshed), and RESOLVES the first-party server-execution default ON (the
 * `productionServer` preset's env-else-`SERVER_EXECUTION_DEFAULT_ENABLED`
 * resolution — exactly the path the flip changes, which explicit-env lanes
 * never exercise). The binary has no HTTP surface, so its startup posture
 * log line is the probe. It then shuts down cleanly on SIGTERM.
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

const BIN = Deno.env.get("BG_PIECE_SERVICE_BIN");
const API_URL = Deno.env.get("API_URL");

const STARTED_LINE = "Background Piece Service started successfully";
const POSTURE_LINE =
  /Background Piece Service server-execution posture: (ON|OFF)/;
const STARTUP_TIMEOUT_MS = 120_000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

/** Collects a stream's lines into `sink`, resolving when the stream ends. */
const drain = async (
  stream: ReadableStream<Uint8Array>,
  sink: string[],
): Promise<void> => {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    sink.push(...lines);
  }
  if (buffered.length > 0) sink.push(buffered);
};

describe(
  "bg-piece-service deployed-topology posture gate",
  { ignore: !BIN || !API_URL },
  () => {
    it("the binary starts against the serving toolshed, resolves the default posture ON, and stops cleanly", async () => {
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
      const stdoutDone = drain(child.stdout, lines);
      const stderrDone = drain(child.stderr, lines);

      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      let exited: Deno.CommandStatus | undefined;
      child.status.then((status) => {
        exited = status;
      });
      while (!lines.some((line) => line.includes(STARTED_LINE))) {
        if (exited !== undefined) {
          throw new Error(
            `bg-piece-service exited (code ${exited.code}) before startup ` +
              `completed. Output:\n${lines.join("\n")}`,
          );
        }
        if (Date.now() > deadline) {
          child.kill("SIGKILL");
          await Promise.allSettled([stdoutDone, stderrDone, child.status]);
          throw new Error(
            `bg-piece-service did not report startup within ` +
              `${STARTUP_TIMEOUT_MS} ms. Output:\n${lines.join("\n")}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      try {
        const postures = lines
          .map((line) => POSTURE_LINE.exec(line)?.[1])
          .filter((arm): arm is string => arm !== undefined);
        expect(
          postures,
          `expected exactly one posture line in:\n${lines.join("\n")}`,
        ).toEqual(["ON"]);
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
