/**
 * Step-1 probe: resolve the SQLite "writes landed vs writes dropped" confound.
 *
 * The diagnose harness reads votes through each live runtime's reactive
 * `sqliteQuery` (`reactOn: db`). That read is downstream of the exact cross-
 * runtime invalidation gap under investigation, so a low surfaced-vote count
 * cannot distinguish:
 *   (a) writes landed in server SQLite but never re-surfaced (pure reactivity), vs
 *   (b) writes were dropped (retry exhaustion on the shared handle `rev` mutex).
 *
 * This probe drives the same join → add-options → concurrent-vote-rounds load,
 * then opens a FRESH ("cold") runtime that has never subscribed to the result
 * graph. Its first `sqliteQuery` issuance has an empty `requestHash`, so it
 * materializes directly from committed storage — canonical server truth,
 * independent of any `reactOn` re-trigger. The cold count decides (a) vs (b).
 *
 * Run:
 *   deno run -A packages/patterns/lunch-poll/probe-sqlite-landing.ts \
 *     --program=main-sqlite.tsx --case=3x5 --rounds=3
 */

import { MultiRuntimeHarness } from "../integration/multi-runtime-harness.ts";

const TEST_WEB_SEARCH_URL =
  "data:application/json,%7B%22results%22%3A%5B%5D%7D";
const VOTE_COLORS = ["green", "yellow", "red"] as const;
const ROOT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function stringArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((entry) => entry.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((entry) => entry.startsWith(prefix));
  if (!arg) return fallback;
  const parsed = Number(arg.slice(prefix.length));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

interface VoteView {
  voteCount: number;
  votesLen: number;
  myName: string;
}

function voteView(value: unknown): VoteView {
  if (!isRecord(value)) return { voteCount: 0, votesLen: 0, myName: "?" };
  return {
    voteCount: asNumber(value.voteCount),
    votesLen: Array.isArray(value.votes) ? value.votes.length : 0,
    myName: typeof value.myName === "string" ? value.myName : "?",
  };
}

async function main(): Promise<void> {
  const program = stringArg("program", "main-sqlite.tsx");
  const rounds = numberArg("rounds", 3);
  const caseArg = stringArg("case", "3x5");
  const match = caseArg.match(/^(\d+)x(\d+)$/);
  if (!match) throw new Error(`--case must be NxM (options x users); got ${caseArg}`);
  const optionCount = Number(match[1]);
  const userCount = Number(match[2]);

  console.log(
    `# probe-sqlite-landing program=${program} case=${optionCount}x${userCount} ` +
      `rounds=${rounds} (expect ${optionCount * userCount} votes if all land)`,
  );

  const labels = Array.from(
    { length: userCount },
    (_e, i) => `user-${i + 1}`,
  );

  const harness = await MultiRuntimeHarness.create({
    programPath: new URL(`./${program}`, import.meta.url).pathname,
    rootPath: ROOT_PATH,
    diagnostics: false,
    input: { webSearchUrl: TEST_WEB_SEARCH_URL },
    sessions: labels,
    spaceName: `probe-sqlite-landing-${userCount}u-${optionCount}o-${crypto.randomUUID()}`,
  });

  try {
    const sessions = labels.map((label) => harness.session(label));
    const host = sessions[0];

    // Join.
    await host.send("joinAs", { name: "User 1" });
    await Promise.all(
      sessions.slice(1).map((s, i) => s.send("joinAs", { name: `User ${i + 2}` })),
    );
    await harness.settle(3);

    // Host adds options.
    for (let i = 0; i < optionCount; i++) {
      await host.send("addOption", { title: `Restaurant ${i + 1}` });
    }
    await harness.settle(3);

    const hostPoll = await host.read();
    const optionIds =
      (isRecord(hostPoll) && Array.isArray(hostPoll.options))
        ? hostPoll.options
          .map((o) => (isRecord(o) ? o.id : undefined))
          .filter((id): id is string => typeof id === "string" && id !== "")
        : [];
    console.log(`# options created: ${optionIds.length}`);

    // Concurrent vote rounds — same rotation as diagnose.ts.
    for (let round = 0; round < rounds; round++) {
      await Promise.all(
        sessions.map((s, index) =>
          s.send("castVote", {
            optionId: optionIds[(round + index) % optionIds.length],
            voteType: VOTE_COLORS[(round + index) % VOTE_COLORS.length],
          })
        ),
      );
      await harness.settle(3);
    }

    // What each LIVE (long-subscribed) runtime currently surfaces.
    console.log("\n## live sessions (reactive read, post-votes):");
    for (const s of sessions) {
      const v = voteView(await s.read());
      console.log(
        `  ${s.label.padEnd(8)} myName=${v.myName.padEnd(8)} ` +
          `voteCount=${v.voteCount} votes.len=${v.votesLen}`,
      );
    }

    // THE DECISIVE READ: a cold runtime opening the piece for the first time.
    const cold = await harness.addColdSession("cold-auditor");
    const coldV = voteView(await cold.read());
    console.log("\n## cold auditor (fresh runtime, first sqliteQuery = server truth):");
    console.log(
      `  cold-auditor voteCount=${coldV.voteCount} votes.len=${coldV.votesLen}`,
    );

    // Re-read live sessions AFTER the cold open + a settle, in case the cold
    // open's fresh write-back or extra sync nudges their reactive reads.
    await harness.settle(3);
    console.log("\n## live sessions (re-read after cold open + settle):");
    for (const s of sessions) {
      const v = voteView(await s.read());
      console.log(`  ${s.label.padEnd(8)} voteCount=${v.voteCount} votes.len=${v.votesLen}`);
    }

    const expected = optionCount * userCount;
    console.log("\n## verdict:");
    if (coldV.voteCount >= expected) {
      console.log(
        `  WRITES LANDED — cold reader sees ${coldV.voteCount}/${expected}. ` +
          `Low live counts are a pure reactive-propagation gap, not lost writes.`,
      );
    } else {
      console.log(
        `  WRITES DROPPED — cold reader sees only ${coldV.voteCount}/${expected} ` +
          `in canonical storage. The low retry count is a lost-write artifact.`,
      );
    }
  } finally {
    await harness.dispose();
  }
}

if (import.meta.main) await main();
