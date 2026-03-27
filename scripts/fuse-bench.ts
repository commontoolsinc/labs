#!/usr/bin/env deno run -A
/**
 * FUSE benchmark harness — CT-1408
 *
 * Measures write→result latency through a FUSE mount.
 * Assumes FUSE is already mounted before running.
 *
 * Usage:
 *   deno run -A scripts/fuse-bench.ts --mount /tmp/ct-spike9 --space agent-spike-9 --piece "Wishes" --n 20
 */

function printHelp(): void {
  console.log(`fuse-bench — FUSE write→result latency benchmark

USAGE:
  deno run -A scripts/fuse-bench.ts [OPTIONS]

OPTIONS:
  --mount <path>      FUSE mount root (required)
  --space <name>      Space name (required)
  --piece <name>      Piece name to benchmark (required)
  --n <count>         Iteration count (default: 20)
  --timeout <ms>      Per-iteration timeout in ms (default: 5000)
  --help              Print this help and exit

EXAMPLE:
  deno run -A scripts/fuse-bench.ts --mount /tmp/ct-spike9 --space agent-spike-9 --piece "Wishes" --n 20
`);
}

function parseArgs(args: string[]): {
  mount: string;
  space: string;
  piece: string;
  n: number;
  timeout: number;
} | null {
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help") {
      printHelp();
      Deno.exit(0);
    }
    if (args[i].startsWith("--") && i + 1 < args.length) {
      parsed[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }

  if (!parsed.mount || !parsed.space || !parsed.piece) {
    console.error("Error: --mount, --space, and --piece are required.\n");
    printHelp();
    return null;
  }

  return {
    mount: parsed.mount,
    space: parsed.space,
    piece: parsed.piece,
    n: parsed.n ? parseInt(parsed.n, 10) : 20,
    timeout: parsed.timeout ? parseInt(parsed.timeout, 10) : 5000,
  };
}

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = Math.ceil((p / 100) * n) - 1;
  return sorted[Math.max(0, Math.min(idx, n - 1))];
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function runBenchmark(opts: {
  mount: string;
  space: string;
  piece: string;
  n: number;
  timeout: number;
}): Promise<void> {
  const { mount, space, piece, n, timeout } = opts;

  const inputPath = `${mount}/${space}/pieces/${piece}/input/benchmark.json`;
  const resultPath = `${mount}/${space}/pieces/${piece}/result/benchmark.json`;

  const samples: number[] = [];
  let errors = 0;
  const startAll = Date.now();

  for (let i = 0; i < n; i++) {
    // Read baseline content of result file before writing
    const baseline = await readFileSafe(resultPath);

    const t0 = Date.now();
    const payload = JSON.stringify({ ts: t0, iter: i });

    // Write to input path
    try {
      await Deno.writeTextFile(inputPath, payload);
    } catch (err) {
      console.error(`[iter ${i}] Failed to write input: ${err}`);
      errors++;
      continue;
    }

    // Poll result path until content differs from baseline or timeout
    let timedOut = false;
    while (true) {
      const elapsed = Date.now() - t0;
      if (elapsed >= timeout) {
        timedOut = true;
        break;
      }

      const current = await readFileSafe(resultPath);
      if (current !== null && current !== baseline) {
        break;
      }

      // Wait 50ms before next poll
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (timedOut) {
      console.error(`[iter ${i}] Timed out after ${timeout}ms`);
      errors++;
    } else {
      const latency = Date.now() - t0;
      samples.push(latency);
    }
  }

  const elapsed = Date.now() - startAll;

  // Compute stats
  const sorted = [...samples].sort((a, b) => a - b);
  const min = sorted.length > 0 ? sorted[0] : 0;
  const max = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);

  const result = {
    mount,
    space,
    piece,
    n,
    elapsed_ms: elapsed,
    errors,
    latency_ms: {
      min,
      p50,
      p95,
      p99,
      max,
    },
    samples,
  };

  console.log(JSON.stringify(result, null, 2));
}

// Main
const opts = parseArgs(Deno.args);
if (!opts) {
  Deno.exit(1);
}

await runBenchmark(opts);
