/**
 * Write-contention probe — SQLite-free.
 *
 * Drives N concurrent runtimes, each writing UNIQUE markers to a shared cell via
 * two paths (shared-list push vs distinct-key set), then opens a fresh COLD
 * runtime to read canonical storage truth. Reports, per path:
 *   - attempted vs landed (and the IDENTITY of every missing write), and
 *   - cold vs live (to separate real lost writes from any reactive-read lag).
 *
 * Pair with stderr to count retry exhaustions and answer the two crux questions:
 *   1. one mechanism or two? -> compare `missing` (cold storage) against the
 *      `exhausting all retries` stderr line count. missing > exhaustions implies
 *      a SECOND, silent path (a lost-update that never logs).
 *   2. coarse or fine conflict? -> does the distinct-KEY path drop as badly as
 *      the shared-LIST path? If yes, conflict detection is coarse-grained
 *      (independent writes still collide).
 *
 * Run (capture stderr to grep exhaustions):
 *   deno run -A packages/patterns/write-contention/probe.ts \
 *     --users=10 --rounds=5 --mode=both 2>/tmp/wc.err
 *   grep -c "exhausting all retries" /tmp/wc.err
 */

import { MultiRuntimeHarness } from "../integration/multi-runtime-harness.ts";

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
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/** Read (list, mapKeys) from a runtime's piece output. */
async function readView(
  read: () => Promise<unknown>,
): Promise<{ list: string[]; mapKeys: string[] }> {
  const out = await read();
  if (!isRecord(out)) return { list: [], mapKeys: [] };
  return {
    list: asStringArray(out.list),
    mapKeys: asStringArray(out.mapKeys),
  };
}

/** Accounting for one write path against the attempted marker set. */
function account(
  pathName: string,
  attempted: string[],
  landedColdRaw: string[],
  landedLiveRaw: string[],
): void {
  const attemptedSet = new Set(attempted);
  const cold = new Set(landedColdRaw);
  const live = new Set(landedLiveRaw);
  // landed-in-storage = cold reads that are genuine attempted markers
  const coldLanded = [...cold].filter((m) => attemptedSet.has(m));
  const missing = attempted.filter((m) => !cold.has(m));
  const dupes = landedColdRaw.length - new Set(landedColdRaw).size;

  console.log(`\n## ${pathName}`);
  console.log(
    `  attempted=${attempted.length}  landed(cold storage)=${coldLanded.length}` +
      `  MISSING=${missing.length}` +
      (dupes > 0 ? `  (note: ${dupes} duplicate entries in storage)` : ""),
  );
  console.log(
    `  cold=${cold.size} vs live=${live.size}` +
      (cold.size === live.size
        ? "  (cold==live: no reactive-read lag)"
        : "  (cold!=live: some reactive-read lag present)"),
  );
  if (missing.length > 0) {
    const sample = missing.slice(0, 8).join(", ");
    console.log(
      `  sample missing: ${sample}${missing.length > 8 ? ", …" : ""}`,
    );
  }
}

async function main(): Promise<void> {
  const users = numberArg("users", 10);
  const rounds = numberArg("rounds", 5);
  const mode = stringArg("mode", "both"); // both | list | map
  const doList = mode === "both" || mode === "list";
  const doMap = mode === "both" || mode === "map";

  console.log(
    `# write-contention probe  users=${users} rounds=${rounds} mode=${mode}  ` +
      `(attempted per active path = ${users * rounds})`,
  );

  const labels = Array.from({ length: users }, (_e, i) => `w${i + 1}`);
  const harness = await MultiRuntimeHarness.create({
    programPath: new URL("./repro.tsx", import.meta.url).pathname,
    rootPath: ROOT_PATH,
    diagnostics: false,
    sessions: labels,
    spaceName: `write-contention-${users}u-${crypto.randomUUID()}`,
  });

  const attempted: string[] = [];

  try {
    const sessions = labels.map((label) => harness.session(label));
    await harness.settle(2);

    // Concurrent write rounds: every runtime fires its writes for the round
    // simultaneously (max contention), using a UNIQUE marker per (runtime,round).
    for (let round = 0; round < rounds; round++) {
      await Promise.all(
        sessions.map((s) => {
          const marker = `${s.label}#${round}`;
          attempted.push(marker);
          const writes: Promise<void>[] = [];
          if (doList) writes.push(s.send("append", { marker }));
          if (doMap) writes.push(s.send("setKey", { id: marker, marker }));
          return Promise.all(writes).then(() => undefined);
        }),
      );
      await harness.settle(3);
    }
    // attempted currently has one entry per (runtime,round) but doMap/doList
    // share the same marker, so the attempted SET is exactly users*rounds.
    const attemptedUnique = [...new Set(attempted)];

    // Live reading (one long-subscribed runtime), then the decisive cold read.
    const live = await readView(() => sessions[0].read());
    const cold = await harness.addColdSession("cold-auditor");
    const coldView = await readView(() => cold.read());
    await harness.settle(3);
    const liveAfter = await readView(() => sessions[0].read());

    console.log(
      `\n# attempted unique markers: ${attemptedUnique.length}` +
        ` (expected ${users * rounds})`,
    );

    if (doList) {
      account("LIST (shared-leaf push)", attemptedUnique, coldView.list, liveAfter.list);
    }
    if (doMap) {
      account("MAP (distinct-key set)", attemptedUnique, coldView.mapKeys, liveAfter.mapKeys);
    }

    console.log(
      "\n## next: grep stderr for `exhausting all retries`; compare to MISSING above.",
    );
    console.log(
      "   missing > exhaustions  => a SECOND, silent (unlogged) drop path.",
    );
    console.log(
      "   map MISSING ~= list MISSING  => coarse-grained conflict (independent writes collide).",
    );
  } finally {
    await harness.dispose();
  }
}

if (import.meta.main) await main();
