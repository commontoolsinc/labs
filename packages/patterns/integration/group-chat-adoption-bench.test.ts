/**
 * Multi-user group-chat action-count benchmark (manual; not run in CI).
 *
 * Measures the per-message receiver-side cost of the reactive cascade:
 * alice sends N messages; bob and alice-tab2 are PURE RECEIVERS. For each
 * session it reports the scheduler run-start delta, the adoption count, and
 * the wall time of the message phase — the acceptance metric for
 * docs/specs/scheduler-v2/incremental-observation-adoption.md (flag-ON must
 * beat main on receiver-side work).
 *
 * Run (from packages/patterns):
 *
 *   CF_GROUPCHAT_BENCH=1 [EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true] \
 *     deno test -A integration/group-chat-adoption-bench.test.ts
 *
 * Output: greppable `BENCH_METRIC ...` lines, one per session plus a total.
 * Compare configs by running the same file on each checkout/flag setting.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const BENCH = Deno.env.get("CF_GROUPCHAT_BENCH") === "1";
const MESSAGES = Number(Deno.env.get("CF_GROUPCHAT_BENCH_MESSAGES") ?? "10");
const TAG = Deno.env.get("CF_BENCH_TAG") ??
  (Deno.env.get("EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE") === "true"
    ? "flag-on"
    : "flag-off");

const PROFILE_SURFACE = "TrustedGroupChatProfileSurface";
const SAVE_PROFILE_ACTION = "TrustedGroupChatSaveProfile";
const SEND_SURFACE = "TrustedGroupChatSendSurface";
const SEND_ACTION = "TrustedGroupChatSendMessage";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "..",
  "cfc-group-chat-demo",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

async function saveProfile(
  session: MultiRuntimeSession,
  name: string,
): Promise<void> {
  await session.send("setProfileDraft", name);
  await session.send("saveProfile", {}, {
    surface: PROFILE_SURFACE,
    action: SAVE_PROFILE_ACTION,
  });
}

async function sendMessage(
  session: MultiRuntimeSession,
  body: string,
): Promise<void> {
  await session.send("setMessageDraft", body);
  await session.send("sendTrustedMessage", {}, {
    surface: SEND_SURFACE,
    action: SEND_ACTION,
  });
}

// deno-lint-ignore no-explicit-any
async function messageCount(session: MultiRuntimeSession): Promise<number> {
  // deno-lint-ignore no-explicit-any
  return (((await session.read(["messages"])) as any[]) ?? []).length;
}

type Counts = Record<string, Record<string, { total?: number }>>;

async function schedulerCounts(
  session: MultiRuntimeSession,
): Promise<{ runStart: number; adoptOk: number; conflicts: number }> {
  const counts = (await session.loggerCounts()) as Counts;
  const scheduler = counts.scheduler ?? {};
  const storage = counts["storage.v2"] ?? {};
  return {
    runStart: scheduler["schedule-run-start"]?.total ?? 0,
    adoptOk: scheduler["adopt/ok"]?.total ?? 0,
    conflicts: storage["commit-conflict"]?.total ?? 0,
  };
}

(BENCH ? describe : describe.ignore)("group-chat adoption bench", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;
  let aliceTab2: MultiRuntimeSession;

  beforeAll(async () => {
    const aliceIdentity = await Identity.fromPassphrase("bench alice", {
      implementation: "noble",
    });
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        { label: "alice", identity: aliceIdentity },
        { label: "bob" },
        { label: "alice-tab2", identity: aliceIdentity },
      ],
    });
    alice = harness.session("alice");
    bob = harness.session("bob");
    aliceTab2 = harness.session("alice-tab2");
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it(`measures ${MESSAGES} sends (${TAG})`, async () => {
    // Warm-up: profiles + one message so every session's piece is fully
    // live before the measured phase.
    await saveProfile(alice, "Alice");
    await saveProfile(bob, "Bob");
    await sendMessage(alice, "warm-up");
    await harness.waitFor(
      "receivers see the warm-up message",
      async () =>
        (await messageCount(bob)) >= 1 &&
        (await messageCount(aliceTab2)) >= 1,
    );
    await harness.settle(2);

    const sessions = [alice, bob, aliceTab2];
    const before = await Promise.all(sessions.map(schedulerCounts));
    const baseCount = await messageCount(alice);
    const startedAt = performance.now();

    for (let i = 1; i <= MESSAGES; i++) {
      await sendMessage(alice, `message ${i}`);
      const expected = baseCount + i;
      await harness.waitFor(
        `receivers see message ${i}`,
        async () =>
          (await messageCount(bob)) >= expected &&
          (await messageCount(aliceTab2)) >= expected,
      );
    }
    await harness.settle(2);

    const wallMs = Math.round(performance.now() - startedAt);
    const after = await Promise.all(sessions.map(schedulerCounts));
    const labels = ["alice(sender)", "bob(receiver)", "tab2(receiver)"];
    let totalRuns = 0;
    let receiverRuns = 0;
    for (let i = 0; i < sessions.length; i++) {
      const runStart = after[i].runStart - before[i].runStart;
      const adoptOk = after[i].adoptOk - before[i].adoptOk;
      const conflicts = after[i].conflicts - before[i].conflicts;
      totalRuns += runStart;
      if (i > 0) receiverRuns += runStart;
      console.log(
        `BENCH_METRIC tag=${TAG} session=${labels[i]} messages=${MESSAGES}` +
          ` runStart=${runStart} adoptOk=${adoptOk} conflicts=${conflicts}`,
      );
    }
    console.log(
      `BENCH_METRIC tag=${TAG} session=TOTAL messages=${MESSAGES}` +
        ` runStart=${totalRuns} receiverRunStart=${receiverRuns}` +
        ` wallMs=${wallMs}`,
    );
  });
});
