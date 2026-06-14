#!/usr/bin/env deno run -A
/**
 * FUSE benchmark harness — CT-1408
 *
 * Measures multiple operation types across a whole space through a FUSE mount.
 * Assumes FUSE is already mounted before running.
 *
 * Usage:
 *   deno run -A scripts/fuse-bench.ts \
 *     --mount /tmp/cf-bench \
 *     --space bench-20260327-143022 \
 *     --n 10 \
 *     [--timeout 5000] \
 *     [--ops readdir,stat,read_scalar,read_json,write,grep,concurrent_read] \
 *     [--write-piece "Standup 2026-03-27"] \
 *     [--input-path input/content] \
 *     [--result-path result/content]
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function percentile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = Math.ceil((p / 100) * n) - 1;
  return sorted[Math.max(0, Math.min(idx, n - 1))];
}

function statsFromSamples(samples: number[]): {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    min: sorted.length > 0 ? sorted[0] : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
  };
}

async function readFileSafe(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Help & argument parsing
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`fuse-bench — FUSE multi-op benchmark harness

USAGE:
  deno run -A scripts/fuse-bench.ts [OPTIONS]

OPTIONS:
  --mount <path>        FUSE mount root (required)
  --space <name>        Space name (required)
  --n <count>           Iteration count for latency ops (default: 10)
  --timeout <ms>        Per-iteration timeout ms for write op (default: 5000)
  --ops <list>          Comma-separated ops to run (default: all)
                        Available: readdir,stat,read_scalar,read_json,write,grep,concurrent_read
  --write-piece <name>  Piece name for write benchmark (default: first piece found)
  --input-path <rel>    Relative path to write (default: input/content)
  --result-path <rel>   Relative path to poll  (default: result/content)
  --help                Print this help and exit

EXAMPLE:
  deno run -A scripts/fuse-bench.ts \\
    --mount /tmp/cf-bench \\
    --space bench-20260327-143022 \\
    --n 10 \\
    --ops readdir,stat,read_scalar,read_json \\
    --write-piece "Standup 2026-03-27"
`);
}

const ALL_OPS = [
  "readdir",
  "stat",
  "read_scalar",
  "read_json",
  "write",
  "grep",
  "concurrent_read",
] as const;
type Op = typeof ALL_OPS[number];

interface ParsedArgs {
  mount: string;
  space: string;
  n: number;
  timeout: number;
  ops: Set<Op>;
  writePiece: string | undefined;
  inputPath: string;
  resultPath: string;
}

function parseArgs(args: string[]): ParsedArgs | null {
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

  if (!parsed.mount || !parsed.space) {
    console.error("Error: --mount and --space are required.\n");
    printHelp();
    return null;
  }

  let ops: Set<Op>;
  if (parsed.ops) {
    const requested = parsed.ops.split(",").map((s) => s.trim()) as Op[];
    const invalid = requested.filter((o) => !ALL_OPS.includes(o));
    if (invalid.length > 0) {
      console.error(`Error: unknown ops: ${invalid.join(", ")}`);
      console.error(`Available: ${ALL_OPS.join(", ")}`);
      return null;
    }
    ops = new Set(requested);
  } else {
    ops = new Set(ALL_OPS);
  }

  const n = parsed.n ? parseInt(parsed.n, 10) : 10;
  const timeout = parsed.timeout ? parseInt(parsed.timeout, 10) : 5000;
  if (!Number.isFinite(n) || n < 1) {
    console.error(`Error: --n must be a positive integer, got: ${parsed.n}`);
    return null;
  }
  if (!Number.isFinite(timeout) || timeout < 1) {
    console.error(
      `Error: --timeout must be a positive integer (ms), got: ${parsed.timeout}`,
    );
    return null;
  }

  return {
    mount: parsed.mount,
    space: parsed.space,
    n,
    timeout,
    ops,
    writePiece: parsed["write-piece"],
    inputPath: parsed["input-path"] ?? "input/content",
    resultPath: parsed["result-path"] ?? "result/content",
  };
}

// ---------------------------------------------------------------------------
// Piece discovery
// ---------------------------------------------------------------------------

async function discoverPieces(piecesDir: string): Promise<string[]> {
  const pieces: string[] = [];
  for await (const entry of Deno.readDir(piecesDir)) {
    if (entry.isDirectory && entry.name !== ".") {
      pieces.push(entry.name);
    }
  }
  return pieces.sort();
}

// ---------------------------------------------------------------------------
// Benchmark operations
// ---------------------------------------------------------------------------

interface LatencyResult {
  latency_ms: {
    min: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  errors: number;
  samples: number[];
}

function benchReaddir(
  piecesDir: string,
  n: number,
): LatencyResult {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    Array.from(Deno.readDirSync(piecesDir));
    const elapsed = performance.now() - t0;
    samples.push(Math.round(elapsed));
  }
  console.error("[readdir] done");
  return { latency_ms: statsFromSamples(samples), errors: 0, samples };
}

async function benchStat(
  piecesDir: string,
  pieces: string[],
  n: number,
): Promise<LatencyResult> {
  const samples: number[] = [];
  let errors = 0;
  for (let i = 0; i < n; i++) {
    const piece = randomPick(pieces);
    const path = join(piecesDir, piece, "result.json");
    const t0 = performance.now();
    try {
      await Deno.stat(path);
      const elapsed = performance.now() - t0;
      samples.push(Math.round(elapsed));
    } catch {
      errors++;
    }
  }
  console.error("[stat] done");
  return { latency_ms: statsFromSamples(samples), errors, samples };
}

async function benchReadScalar(
  piecesDir: string,
  pieces: string[],
  n: number,
): Promise<LatencyResult> {
  const samples: number[] = [];
  let errors = 0;
  for (let i = 0; i < n; i++) {
    const piece = randomPick(pieces);
    const path = join(piecesDir, piece, "result/content");
    const t0 = performance.now();
    try {
      await Deno.readTextFile(path);
      const elapsed = performance.now() - t0;
      samples.push(Math.round(elapsed));
    } catch {
      // Skip silently — file may not exist for all pieces
      errors++;
    }
  }
  console.error("[read_scalar] done");
  return { latency_ms: statsFromSamples(samples), errors, samples };
}

async function benchReadJson(
  piecesDir: string,
  pieces: string[],
  n: number,
): Promise<LatencyResult> {
  const samples: number[] = [];
  let errors = 0;
  for (let i = 0; i < n; i++) {
    const piece = randomPick(pieces);
    const path = join(piecesDir, piece, "result.json");
    const t0 = performance.now();
    try {
      await Deno.readTextFile(path);
      const elapsed = performance.now() - t0;
      samples.push(Math.round(elapsed));
    } catch {
      errors++;
    }
  }
  console.error("[read_json] done");
  return { latency_ms: statsFromSamples(samples), errors, samples };
}

interface WriteResult extends LatencyResult {
  piece: string;
}

async function benchWrite(
  piecesDir: string,
  piece: string,
  inputPath: string,
  resultPath: string,
  n: number,
  timeout: number,
): Promise<WriteResult> {
  const fullInputPath = join(piecesDir, piece, inputPath);
  const fullResultPath = join(piecesDir, piece, resultPath);

  const samples: number[] = [];
  let errors = 0;

  for (let i = 0; i < n; i++) {
    // Read baseline content of result file before writing
    const baseline = await readFileSafe(fullResultPath);

    const t0 = Date.now();
    const payload = JSON.stringify({ ts: t0, iter: i });

    // Write to input path — retry a few times since the FUSE tree briefly
    // tears down input/ during reactive rebuilds, causing transient ENOENT.
    let writeOk = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await Deno.writeTextFile(fullInputPath, payload);
        writeOk = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!writeOk) {
      console.error(`[write iter ${i}] Failed to write input after retries`);
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

      const current = await readFileSafe(fullResultPath);
      if (current !== null && current !== baseline) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (timedOut) {
      console.error(`[write iter ${i}] Timed out after ${timeout}ms`);
      errors++;
    } else {
      const latency = Date.now() - t0;
      samples.push(latency);
    }
  }

  console.error("[write] done");
  return { piece, latency_ms: statsFromSamples(samples), errors, samples };
}

interface BulkResult {
  files_read: number;
  total_bytes: number;
  elapsed_ms: number;
}

async function benchGrep(
  piecesDir: string,
  pieces: string[],
): Promise<BulkResult> {
  const t0 = performance.now();
  const results = await Promise.all(
    pieces.map(async (piece) => {
      const path = join(piecesDir, piece, "result/content");
      const content = await readFileSafe(path);
      return content ? content.length : 0;
    }),
  );
  const elapsed = Math.round(performance.now() - t0);
  const filesRead = results.filter((b) => b > 0).length;
  const totalBytes = results.reduce((acc, b) => acc + b, 0);
  console.error("[grep] done");
  return {
    files_read: filesRead,
    total_bytes: totalBytes,
    elapsed_ms: elapsed,
  };
}

async function benchConcurrentRead(
  piecesDir: string,
  pieces: string[],
): Promise<BulkResult> {
  const t0 = performance.now();
  const results = await Promise.all(
    pieces.map(async (piece) => {
      const path = join(piecesDir, piece, "result.json");
      const content = await readFileSafe(path);
      return content ? content.length : 0;
    }),
  );
  const elapsed = Math.round(performance.now() - t0);
  const filesRead = results.filter((b) => b > 0).length;
  const totalBytes = results.reduce((acc, b) => acc + b, 0);
  console.error("[concurrent_read] done");
  return {
    files_read: filesRead,
    total_bytes: totalBytes,
    elapsed_ms: elapsed,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const opts = parseArgs(Deno.args);
if (!opts) {
  Deno.exit(1);
}

const piecesDir = join(opts.mount, opts.space, "pieces");

// Discover pieces
const pieces = await discoverPieces(piecesDir);

if (pieces.length === 0) {
  console.error(
    "No pieces found in space. Is FUSE mounted and the space populated?",
  );
  Deno.exit(1);
}

// Filter any non-directory stragglers (discoverPieces uses isDirectory, but be safe)
const pieceDirs = pieces.filter((p) => p !== "pieces.json");

// Determine write target piece
const writePiece = opts.writePiece ?? pieceDirs[0];

console.error(
  `Benchmarking space "${opts.space}" — ${pieceDirs.length} pieces, n=${opts.n}`,
);

const ops = opts.ops;
const results: Record<string, unknown> = {};

if (ops.has("readdir")) {
  results.readdir = await benchReaddir(piecesDir, opts.n);
}
if (ops.has("stat")) {
  results.stat = await benchStat(piecesDir, pieceDirs, opts.n);
}
if (ops.has("read_scalar")) {
  results.read_scalar = await benchReadScalar(piecesDir, pieceDirs, opts.n);
}
if (ops.has("read_json")) {
  results.read_json = await benchReadJson(piecesDir, pieceDirs, opts.n);
}
if (ops.has("write")) {
  results.write = await benchWrite(
    piecesDir,
    writePiece,
    opts.inputPath,
    opts.resultPath,
    opts.n,
    opts.timeout,
  );
}
if (ops.has("grep")) {
  results.grep = await benchGrep(piecesDir, pieceDirs);
}
if (ops.has("concurrent_read")) {
  results.concurrent_read = await benchConcurrentRead(piecesDir, pieceDirs);
}

console.log(
  JSON.stringify(
    {
      space: opts.space,
      mount: opts.mount,
      pieces_count: pieceDirs.length,
      n: opts.n,
      timestamp: new Date().toISOString(),
      ops: results,
    },
    null,
    2,
  ),
);
