#!/usr/bin/env -S deno run --allow-read
/**
 * Accumulate calls and time per key segment from emitted timing measures.
 *
 * Reads the measures a run produced with `CF_TIMING_MEASURES=1` — either a JSON
 * array of `PerformanceEntry`-shaped objects on stdin, or a file named as the
 * first argument — and rolls them up by key prefix.
 *
 * The roll-up is the point. A logger records a span against its full joined key
 * path and against nothing shorter, so `cell/get/user-data` never contributes
 * to `cell/get`. That is the right call for the statistics, and it is exactly
 * what hides a call explosion: the count that matters is the one at the level
 * where it starts multiplying, and no stored row holds it. This computes those
 * levels after the fact.
 *
 * This groups by how keys are NAMED, not by who called whom, so `calls` counts
 * every span at a prefix or below it and can only fall as you descend. Read
 * `ms/call` to find where time concentrates, and the two `self` columns to tell
 * a level that is itself expensive from one that merely contains expensive
 * children. For who called whom — and for a count that can rise — use
 * `attribute-measures.ts`, which reconstructs the call tree from the
 * intervals.
 *
 *   deno run --allow-read aggregate-measures.ts measures.json
 *   deno run --allow-read aggregate-measures.ts < measures.json
 *   deno run --allow-read aggregate-measures.ts measures.json --sort=calls
 *
 * One caveat about a `cf test` capture: `withPhase` emits its own measure under
 * a `cf-test/` prefix as well as recording the span through a logger, so those
 * phases appear twice — once as `cf-test/<keys>` and once as `<keys>`. Read one
 * branch or the other rather than summing across both.
 */

interface MeasureEntry {
  name: string;
  duration: number;
  startTime?: number;
}

/** One key segment's accumulation, and the segments below it. */
interface Bucket {
  path: string;
  depth: number;
  /** Spans recorded at this exact path. */
  own: number;
  ownTime: number;
  /** Spans recorded at this path or anywhere beneath it. */
  calls: number;
  time: number;
  children: Map<string, Bucket>;
}

/** `cf:cell/get/user-data#4127` names the span `cell/get/user-data`. */
const MEASURE_PREFIX = "cf:";
function keyOf(name: string): string {
  const body = name.startsWith(MEASURE_PREFIX)
    ? name.slice(MEASURE_PREFIX.length)
    : name;
  const hash = body.lastIndexOf("#");
  return hash === -1 ? body : body.slice(0, hash);
}

function emptyBucket(path: string, depth: number): Bucket {
  return {
    path,
    depth,
    own: 0,
    ownTime: 0,
    calls: 0,
    time: 0,
    children: new Map(),
  };
}

export function aggregate(entries: readonly MeasureEntry[]): Bucket {
  const root = emptyBucket("", 0);
  for (const entry of entries) {
    const segments = keyOf(entry.name).split("/").filter(Boolean);
    if (segments.length === 0) continue;
    let bucket = root;
    bucket.calls++;
    bucket.time += entry.duration;
    let path = "";
    for (const [index, segment] of segments.entries()) {
      path = path ? `${path}/${segment}` : segment;
      let child = bucket.children.get(segment);
      if (!child) {
        child = emptyBucket(path, index + 1);
        bucket.children.set(segment, child);
      }
      child.calls++;
      child.time += entry.duration;
      bucket = child;
    }
    bucket.own++;
    bucket.ownTime += entry.duration;
  }
  return root;
}

export function render(root: Bucket, sortBy: "time" | "calls"): string {
  const lines: string[] = [
    "  calls      total ms     ms/call    self n   self ms  key",
    "  -----      --------     -------    ------   -------  ---",
  ];
  const walk = (bucket: Bucket) => {
    const kids = [...bucket.children.values()].sort((a, b) =>
      sortBy === "calls" ? b.calls - a.calls : b.time - a.time
    );
    for (const child of kids) {
      const perCall = child.calls === 0 ? 0 : child.time / child.calls;
      // Spans recorded at this exact level, where there are any, separate
      // "this level is slow" from "this level fans out into slow children".
      const selfN = child.own === 0 ? "" : String(child.own);
      const selfMs = child.own === 0 ? "" : child.ownTime.toFixed(1);
      lines.push(
        `${String(child.calls).padStart(7)} ${
          child.time.toFixed(1).padStart(11)
        } ${perCall.toFixed(3).padStart(11)} ${selfN.padStart(9)} ${
          selfMs.padStart(9)
        }  ${"  ".repeat(child.depth - 1)}${child.path.split("/").pop()}`,
      );
      walk(child);
    }
  };
  walk(root);
  lines.push("");
  lines.push(
    `${root.calls} spans, ${root.time.toFixed(1)}ms total across ` +
      `${root.children.size} top-level key(s).`,
  );
  return lines.join("\n");
}

async function readInput(path?: string): Promise<string> {
  if (path) return await Deno.readTextFile(path);
  const chunks: Uint8Array[] = [];
  for await (const chunk of Deno.stdin.readable) chunks.push(chunk);
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

if (import.meta.main) {
  const args = Deno.args.filter((arg) => !arg.startsWith("--"));
  const sortBy = Deno.args.includes("--sort=calls") ? "calls" : "time";
  const raw = await readInput(args[0]);
  const parsed = JSON.parse(raw);
  const entries: MeasureEntry[] = Array.isArray(parsed)
    ? parsed
    : parsed.measures ?? [];
  if (entries.length === 0) {
    console.error(
      "No measures found. Run with CF_TIMING_MEASURES=1 and pass the entries " +
        'from performance.getEntriesByType("measure").',
    );
    Deno.exit(1);
  }
  console.log(render(aggregate(entries), sortBy));
}
