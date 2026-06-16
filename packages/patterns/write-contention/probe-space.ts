/**
 * Space-level granularity probe — SQLite-free.
 *
 * Tests whether the write-conflict/serialization unit is the DOCUMENT or
 * something broader (the space). Two DISJOINT writer groups push UNIQUE markers
 * to two DISJOINT cells that are never co-written:
 *   - group A (size --groupA) pushes -> `list`
 *   - group B (size --groupB) pushes -> `listB`
 *
 * Run three configs and compare group A's drop rate:
 *   baseline   --groupA=10 --groupB=0   (listB idle)
 *   split      --groupA=10 --groupB=10  (listB busy, but DIFFERENT cell/writers)
 *   saturated  --groupA=20 --groupB=0   (all 20 on the SAME cell)
 *
 *   split ≈ saturated >> baseline  => SPACE-level conflict (disjoint cells collide)
 *   split ≈ baseline  << saturated => per-DOCUMENT conflict (no cross-cell effect)
 *
 *   deno run -A packages/patterns/write-contention/probe-space.ts \
 *     --groupA=10 --groupB=10 --rounds=5 2>/tmp/wcs.err
 */

import { MultiRuntimeHarness } from "../integration/multi-runtime-harness.ts";

const ROOT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((entry) => entry.startsWith(prefix));
  if (!arg) return fallback;
  const parsed = Number(arg.slice(prefix.length));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

async function readCell(
  read: () => Promise<unknown>,
  key: string,
): Promise<string[]> {
  const out = await read();
  return isRecord(out) ? asStringArray(out[key]) : [];
}

function report(
  groupName: string,
  cellName: string,
  attempted: string[],
  cold: string[],
  live: string[],
): void {
  const coldSet = new Set(cold);
  const landed = attempted.filter((m) => coldSet.has(m));
  const missing = attempted.length - landed.length;
  const pct = attempted.length > 0
    ? ((missing / attempted.length) * 100).toFixed(0)
    : "0";
  console.log(
    `  ${groupName} -> ${cellName}: attempted=${attempted.length} ` +
      `landed(cold)=${landed.length} MISSING=${missing} (${pct}%)  ` +
      `[cold=${coldSet.size} live=${new Set(live).size}]`,
  );
}

async function main(): Promise<void> {
  const groupA = numberArg("groupA", 10);
  const groupB = numberArg("groupB", 0);
  const rounds = numberArg("rounds", 5);

  console.log(
    `# space-probe  groupA=${groupA}->list  groupB=${groupB}->listB  ` +
      `rounds=${rounds}  (attempted: A=${groupA * rounds}, B=${groupB * rounds})`,
  );

  const aLabels = Array.from({ length: groupA }, (_e, i) => `a${i + 1}`);
  const bLabels = Array.from({ length: groupB }, (_e, i) => `b${i + 1}`);
  const harness = await MultiRuntimeHarness.create({
    programPath: new URL("./repro.tsx", import.meta.url).pathname,
    rootPath: ROOT_PATH,
    diagnostics: false,
    sessions: [...aLabels, ...bLabels],
    spaceName: `wc-space-${groupA}a-${groupB}b-${crypto.randomUUID()}`,
  });

  const attemptedA: string[] = [];
  const attemptedB: string[] = [];

  try {
    const aSessions = aLabels.map((l) => harness.session(l));
    const bSessions = bLabels.map((l) => harness.session(l));
    await harness.settle(2);

    for (let round = 0; round < rounds; round++) {
      await Promise.all([
        ...aSessions.map((s) => {
          const marker = `${s.label}#${round}`;
          attemptedA.push(marker);
          return s.send("append", { marker });
        }),
        ...bSessions.map((s) => {
          const marker = `${s.label}#${round}`;
          attemptedB.push(marker);
          return s.send("appendB", { marker });
        }),
      ]);
      await harness.settle(3);
    }

    const reader = (aSessions[0] ?? bSessions[0]);
    const cold = await harness.addColdSession("cold-auditor");
    const coldList = await readCell(() => cold.read(), "list");
    const coldListB = await readCell(() => cold.read(), "listB");
    await harness.settle(3);
    const liveList = await readCell(() => reader.read(), "list");
    const liveListB = await readCell(() => reader.read(), "listB");

    console.log("\n## storage truth (cold reader):");
    if (groupA > 0) report("groupA", "list ", attemptedA, coldList, liveList);
    if (groupB > 0) report("groupB", "listB", attemptedB, coldListB, liveListB);
    console.log(
      "\n   compare groupA->list MISSING across baseline / split / saturated runs.",
    );
  } finally {
    await harness.dispose();
  }
}

if (import.meta.main) await main();
