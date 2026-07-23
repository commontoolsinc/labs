import { assertEquals, assertThrows } from "@std/assert";
import {
  casesFromArgs,
  configFromArgs,
  deriveTelemetry,
  rootOscillationMetadata,
  writePathShape,
} from "./topics-diagnose-config.ts";

Deno.test("Topics diagnostics validates explicit matrix arguments", () => {
  const config = configFromArgs([
    "--topics=2,4",
    "--users=1,3",
    "--rounds=2",
    "--typing-steps=3",
    "--sessions-per-user=2",
    "--ws-delay-ms=5",
    "--scenario=comments,bodies",
  ]);
  assertEquals(config.topicCounts, [2, 4]);
  assertEquals(config.userCounts, [1, 3]);
  assertEquals(config.scenarios, ["comments", "bodies"]);
  assertEquals(casesFromArgs(["--cases=2x1,4x3"], config), [
    { topics: 2, users: 1 },
    { topics: 4, users: 3 },
  ]);
  assertThrows(() => configFromArgs(["--topics="]));
  assertThrows(() => configFromArgs(["--users=0"]));
  assertThrows(() => configFromArgs(["--scenario=unknown"]));
  assertThrows(() => casesFromArgs(["--cases=2by3"], config));
});

Deno.test("Topics diagnostics rejects malformed and unsupported CLI tokens", () => {
  for (
    const args of [
      ["--quick=true"],
      ["--topics", "1"],
      ["--quick", "--quick"],
      ["--unknown=value"],
      ["stray"],
    ]
  ) {
    assertThrows(() => configFromArgs(args));
  }
});

Deno.test("Topics diagnostics applies profile and quick defaults", () => {
  const conflicts = configFromArgs(["--profile=conflicts"]);
  assertEquals(conflicts, {
    profile: "conflicts",
    program: "topics/main.tsx",
    topicCounts: [2],
    userCounts: [2],
    rounds: 4,
    typingSteps: 2,
    sessionsPerUser: 2,
    wsDelayMs: 10,
    scenarios: ["root-oscillation"],
  });
  assertEquals(configFromArgs(["--profile=conflicts", "--quick"]).rounds, 2);
  assertEquals(configFromArgs(["--quick"]).scenarios, [
    "create-topics",
    "noops",
    "titles",
    "comments",
    "links",
    "bodies",
    "crossrefs",
  ]);
  assertEquals(
    configFromArgs(["--quick", "--scenario=all"]).scenarios.at(-1),
    "root-oscillation",
  );
});

Deno.test("Topics diagnostics validates root oscillation topology", () => {
  assertThrows(() =>
    casesFromArgs([], configFromArgs(["--profile=conflicts", "--topics=1"]))
  );
  assertThrows(() =>
    casesFromArgs(
      [],
      configFromArgs([
        "--profile=conflicts",
        "--users=1",
        "--sessions-per-user=1",
      ]),
    )
  );
  assertThrows(() =>
    casesFromArgs([], configFromArgs(["--profile=conflicts", "--rounds=0"]))
  );
  assertEquals(
    casesFromArgs([], configFromArgs(["--profile=conflicts", "--rounds=1"])),
    [{ topics: 2, users: 2 }],
  );
});

Deno.test("Topics diagnostics derives content-free telemetry summaries", () => {
  const telemetry = {
    invocationCount: 2,
    distinctInvokedEventCount: 2,
    distinctSuccessfulEventCount: 1,
    distinctDroppedEventCount: 1,
    droppedEventsByReason: {
      "piece-load": 0,
      lineage: 1,
      preflight: 0,
      "load-gate": 0,
    },
    permanentRejectionsByReason: { "origin-committed": 0, "receipt-exists": 1 },
    commitMarkerCount: 3,
    directCommitCount: 0,
    successfulCommitCount: 2,
    failedAttemptCount: 1,
    terminalFailureCount: 0,
    retryMarkerCount: 1,
    maxRetryAttempt: 2,
    readCount: 4,
    writeCount: 5,
    changedWriteCount: 3,
    writesTruncatedCount: 0,
    writesByPathShape: { "value/*": 3 },
  };
  assertEquals(deriveTelemetry(telemetry, 2), {
    changedWritesPerSubmittedOperation: 1.5,
    attemptedWritesPerSubmittedOperation: 2.5,
    elidedNoopCandidateWrites: 2,
  });
  assertEquals(
    writePathShape("value/did:key:private/topic-content/17"),
    "value/*/*/#",
  );
  assertEquals(rootOscillationMetadata([0, 1, 0, 1]).twoStepRepeatRatio, 1);
  assertEquals(rootOscillationMetadata([0]).twoStepRepeatRatio, null);
});
