/**
 * How long a room full of people voting at once takes to agree.
 *
 * Ten voters each cast a vote on each of ten lunch options, every one of the
 * hundred fired before any of them settles, and the measurement runs until
 * every one of the ten clients holds the whole result in its own vote list,
 * read at its runtime's quiescence: the moment each client's view is settled,
 * whichever arm served it. That is the quantity a person actually waits on at
 * lunchtime, and it is the one no other benchmark in the repository can see:
 * every other bench file drives a single runtime against its own private
 * storage server, where a second writer does not exist and a write conflict is
 * unreachable by construction.
 *
 * What it is sensitive to. A vote is a keyed write — `castVote` addresses one
 * vote by `(voter profile entity, option)` and adds it with `addUnique`, so a
 * commit carries no read of the vote list and two voters never collide. Written
 * instead as read-the-list, edit, write-the-list-back, every pair of votes in
 * the burst collides: each loser's optimistic write is rolled back, it waits
 * for the newer state, re-runs, and commits again. Both forms converge on the
 * same tally, which is why the pattern's own tests cannot tell them apart, and
 * why this is a benchmark rather than an assertion. The difference is entirely
 * in how long it takes and how much is thrown away getting there.
 *
 * Reading the series. One number per iteration: hundred votes dispatched, then
 * every client's list current. The keyed write throws nothing away, and the
 * same burst over a whole-list write cost 430 rejected commits and 558
 * rolled-back writes and dropped two votes for the length of one burst on the
 * way, at a time an order of magnitude longer.
 * `packages/patterns/integration/lunch-poll-keyed-votes.test.ts` is the
 * assertion half of the same property, requiring that a burst roll back no
 * write at all rather than timing one.
 *
 * Sample count is the weak point, and it is inherent. An iteration takes
 * seconds on a four-core CI host, so a run collects about a dozen samples. The 75th percentile the
 * dashboard trend reads discards only the slowest quarter of those, so a runner
 * that stalls twice moves this line without any code changing. Read it for the
 * shape of a move across several windows, not for one window against the last.
 *
 * The setup — ten Deno workers, ten joins, ten options, and a warm-up burst —
 * runs once at module scope, outside every measurement, because it costs some
 * twelve seconds and repeating it per iteration would leave a run with almost
 * no samples. Each iteration recolors every vote, so all hundred are genuine
 * changes and the vote count holds at a hundred throughout; no iteration leaves
 * a state the next one starts from differently.
 *
 * Ten runtimes is the largest footprint of any benchmark in the job. On a
 * default hosted runner — four cores, 15.6GB — the whole file takes 89 seconds
 * and peaks at 4.76GB resident, under a third of that host; the group the
 * benchmarks workflow runs on is larger still. The peak is held to the end of
 * the process, because the workers are released at exit rather than when this
 * file's benchmarks finish, so it is a floor under everything measured after
 * it.
 *
 * `CF_LUNCH_POLL_VOTERS` and `CF_LUNCH_POLL_OPTIONS` resize it for a local run
 * asking how the burst scales. The size is part of the measurement and names
 * the series, so changing it starts a new line rather than continuing this one;
 * CI leaves both unset. The size in force, and a contention accounting taken
 * over one untimed burst, are written to stderr and so into the run's
 * `diagnostics.log`.
 *
 * The harness hosts its own storage server, with a serving loop attached when
 * server execution is enabled. Both modes use ordinary worker clients without
 * renderer mounts, so the view-scoped web-client flag does not activate
 * selective replication here.
 * The poll uses the `lunch-poll-keyed-votes` fixture's identity seam because
 * these clients do not render the `#profile` create surface.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const GROUP = "lunch poll";
const ROOT_PATH = join(import.meta.dirname!, "..");
const PROGRAM_PATH = join(
  ROOT_PATH,
  "integration",
  "fixtures",
  "lunch-poll-keyed-votes",
  "main.tsx",
);

const COLORS = ["green", "yellow", "red"] as const;

function sizeFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer; got ${raw}`);
  }
  return value;
}

const VOTERS = sizeFromEnv("CF_LUNCH_POLL_VOTERS", 10);
const OPTIONS = sizeFromEnv("CF_LUNCH_POLL_OPTIONS", 10);

const NAMES = Array.from({ length: VOTERS }, (_, i) => `Voter ${i + 1}`);
const TITLES = Array.from({ length: OPTIONS }, (_, i) => `Place ${i + 1}`);

const harness = await MultiRuntimeHarness.create({
  programPath: PROGRAM_PATH,
  rootPath: ROOT_PATH,
  sessions: NAMES.map((_, index) => ({ label: `voter-${index + 1}` })),
});
const voters = harness.sessions;

// Each session claims its own profile and joins. The first to join hosts, and
// only the host may add options.
for (let i = 0; i < voters.length; i++) {
  await voters[i].send("claim", { name: NAMES[i] });
  await harness.settle();
  await voters[i].send("joinAs", {});
  await harness.settle();
}
for (const title of TITLES) {
  await voters[0].send("addOption", { title });
  await harness.settle();
}
const options = (await voters[0].read(["options"]) as { id: string }[])
  .map((option) => option.id);
expect(options).toHaveLength(OPTIONS);
expect(await voters[0].read(["userCount"])).toBe(VOTERS);

const votes = voters.length * options.length;

/** The vote each voter casts for each option in `round`. */
function colorOf(index: number, position: number, round: number): string {
  return COLORS[(index + position + round) % COLORS.length];
}

/** The tally every session's vote list holds once `round`'s votes are in. */
function tallyOf(round: number): Record<string, number> {
  const tally: Record<string, number> = {};
  voters.forEach((_, index) => {
    options.forEach((option, position) => {
      const group = `${option}\0${colorOf(index, position, round)}`;
      tally[group] = (tally[group] ?? 0) + 1;
    });
  });
  return tally;
}

/**
 * Fire every vote before any of them settles, then wait until every
 * session's own vote list holds the round's tally at quiescence: the moment
 * each client's view is settled, on the OFF arm through the others' pushed
 * votes and its own derivations, on the ON arm through the served
 * consequences and their delivery. That is the burst's measured end.
 */
async function burst(round: number): Promise<void> {
  await Promise.all(
    voters.flatMap((voter, index) =>
      options.map((option, position) =>
        voter.send(
          "castVote",
          { optionId: option, voteType: colorOf(index, position, round) },
          undefined,
          { idle: false },
        )
      )
    ),
  );
  const tally = tallyOf(round);
  await Promise.all(
    voters.map((voter) =>
      voter.waitForTally(["votes"], ["optionId", "voteType"], tally)
    ),
  );
}

/** What a burst leaves pending outside its measured end, before a check. */
async function afterBurst(): Promise<void> {
  await Promise.all(voters.map((voter) => voter.awaitEventConsequences()));
  await harness.settle();
}

/** Validate each replica's vote distribution outside the measured interval. */
async function verifyBurst(round: number): Promise<void> {
  const expected = options.map((_, position) =>
    COLORS.map((color) =>
      voters.filter((_, index) => colorOf(index, position, round) === color)
        .length
    )
  );
  await Promise.all(voters.map(async (voter) => {
    const result = await voter.read(["votes"]) as {
      optionId: string;
      voteType: string;
    }[];
    expect(result, voter.label).toHaveLength(votes);
    expect(
      options.map((optionId) =>
        COLORS.map((color) =>
          result.filter((vote) =>
            vote.optionId === optionId && vote.voteType === color
          ).length
        )
      ),
      voter.label,
    ).toEqual(expected);
  }));
}

/**
 * Rejected commits and rolled-back optimistic writes across every session so
 * far, and whether the counters they come from were there to read.
 *
 * A missing counter reads as zero, which is the same number a clean run
 * reports, so the two are distinguished here rather than left to look alike:
 * the accounting is the half of this benchmark a timing cannot show, and an
 * accounting that cannot fail is not one worth printing. `storage.v2` counts
 * these even when the logger is silent, so a session that reports no such
 * logger at all has stopped answering rather than stopped conflicting.
 */
async function reverts(sessions: readonly MultiRuntimeSession[]) {
  const each = await Promise.all(sessions.map(async (session) => {
    const counts = await session.loggerCounts();
    const storage = counts["storage.v2"];
    return {
      conflicts: storage?.["commit-conflict"]?.total ?? 0,
      reverts: storage?.["commit-revert"]?.total ?? 0,
      counted: storage !== undefined,
    };
  }));
  return each.reduce((total, one) => ({
    conflicts: total.conflicts + one.conflicts,
    reverts: total.reverts + one.reverts,
    counting: total.counting + (one.counted ? 1 : 0),
  }), { conflicts: 0, reverts: 0, counting: 0 });
}

// Warm-up: every session materializes the vote list and its own keyed vote
// entities, so no measured iteration pays a first-write cost.
await burst(0);
await afterBurst();
await verifyBurst(0);
await burst(1);
await afterBurst();
await verifyBurst(1);

// Contention accounting, over one burst that no measurement covers. What a
// regression in the vote write costs shows up here as writes thrown away,
// beside the wall-clock the benchmark reports.
const before = await reverts(voters);
await burst(2);
await afterBurst();
await verifyBurst(2);
const after = await reverts(voters);
console.error(
  `[lunch-poll vote burst] ${voters.length} voters x ${options.length} ` +
    `options = ${votes} votes per burst; one burst cost ` +
    `${after.conflicts - before.conflicts} rejected commit(s) and ` +
    `${after.reverts - before.reverts} rolled-back write(s), counted over ` +
    `${after.counting}/${voters.length} sessions`,
);

/**
 * The serving loop's side of one burst: how many waves it took and what a
 * wave's phases cost, from the loop's own counters and timing rows, read
 * before and after the burst. The rows are the loop's realm's, so under the
 * worker they are the loop's alone, while on this thread the scheduler rows
 * count the voters' runs as well. Nothing on the OFF arm, which serves
 * nothing.
 */
async function loopCost(run: () => Promise<void>): Promise<string> {
  const rows = [
    "executor/wave/cycle",
    "executor/wave/settle",
    "executor/wave/commit",
    "executor/wave/demand-pass",
    "executor/wave/publish",
    "scheduler/execute/event/handlerAction",
    "scheduler/execute/settle",
    "storage.v2:watchRefresh/watchAddSync",
  ];
  const snapshot = async () => {
    const stats = harness.servingStats();
    const timing = (await harness.servingDiagnostics()).timingStats as Record<
      string,
      Record<string, { count: number; totalTime: number }>
    >;
    const row = (name: string) => {
      const [group, key] = name.includes(":")
        ? name.split(":")
        : [name.split("/")[0], name];
      return timing[group]?.[key] ?? { count: 0, totalTime: 0 };
    };
    const all: Record<string, { count: number; totalTime: number }> = {};
    for (const [group, keys] of Object.entries(timing)) {
      for (const [key, value] of Object.entries(keys)) {
        all[`${group}:${key}`] = value;
      }
    }
    return {
      waves: stats?.waves ?? 0,
      exhausted: stats?.wavesBudgetExhausted ?? 0,
      lag: stats?.watermarkLag ?? 0,
      rows: Object.fromEntries(rows.map((name) => [name, row(name)])),
      all,
    };
  };
  const before = await snapshot();
  await run();
  const after = await snapshot();
  if (harness.servingStats() === undefined) return "no serving loop";
  const phases = rows.map((name) => {
    const count = after.rows[name].count - before.rows[name].count;
    const total = after.rows[name].totalTime - before.rows[name].totalTime;
    return `${name.replace("executor/wave/", "")} ${count} x ${
      count === 0 ? 0 : (total / count).toFixed(1)
    } ms`;
  });
  // The twelve rows that grew the most over the burst, whatever they are,
  // so a cost the list above does not name still shows.
  const grown = Object.entries(after.all).map(([name, row]) => {
    const earlier = before.all[name] ?? { count: 0, totalTime: 0 };
    return {
      name,
      count: row.count - earlier.count,
      total: row.totalTime - earlier.totalTime,
    };
  }).filter((row) => row.count > 0).sort((a, b) => b.total - a.total)
    .slice(0, 12).map((row) =>
      `${row.name} ${row.count} x ${(row.total / row.count).toFixed(1)} ms`
    );
  return `${after.waves - before.waves} waves (${
    after.exhausted - before.exhausted
  } at the deadline), watermark ${after.lag} behind at the end and ${before.lag} behind before the burst; ${
    phases.join(", ")
  }; top rows: ${grown.join(", ")}`;
}

console.error(
  `[lunch-poll vote burst] one burst on the serving side: ${await loopCost(
    async () => {
      await burst(3);
      await afterBurst();
      await verifyBurst(3);
    },
  )}`,
);

// `Deno.bench` has no hook for "the file's benchmarks are done", so the ten
// workers are released at process exit instead, where the listener runs
// synchronously and `terminate()` is the form that fits.
globalThis.addEventListener("unload", () => harness.terminate());

let round = 4;

Deno.bench({
  name: `vote burst ${voters.length}x${options.length}`,
  group: GROUP,
  async fn(b) {
    const current = round++;
    b.start();
    await burst(current);
    b.end();
    await afterBurst();
    await verifyBurst(current);
  },
});
