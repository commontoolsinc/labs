# Deno Memory Profiler

Analyze memory in a running Deno process via the V8 inspector CDP protocol.

## When to use

Use this skill when the user asks about:
- Memory usage of a running Deno process
- Memory leaks or growing heap
- Heap analysis or heap snapshots
- Allocation profiling
- Object retention or constructor counts

The target Deno process **must** be running with `--inspect` or `--inspect-brk`. The default inspector port is 9229.

## Prerequisites

The target process must be started with the inspect flag:
```bash
deno run --inspect main.ts          # default port 9229
deno run --inspect=0.0.0.0:9230 main.ts  # custom host/port
```

## Available commands

The script is at `.claude/skills/deno-memory-profiler/memory.ts`.

All commands accept `--port=<port>` (default 9229) and `--host=<host>` (default 127.0.0.1). Output is JSON to stdout; status messages go to stderr.

### `usage` — Quick heap stats
```bash
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts usage
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts usage --gc
```
Returns `usedSize`, `totalSize`, `usagePercent`. Use `--gc` to force garbage collection before measuring for a more accurate picture.

### `eval <expression>` — Evaluate in target process
```bash
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts eval "Deno.memoryUsage()"
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts eval "globalThis.myCache.size"
```
Runs an expression in the target via `Runtime.evaluate` and prints the result. Useful for inspecting specific objects.

### `sample` — Allocation sampling
```bash
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts sample --duration 10
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts sample --duration 5 --top 50 --interval 16384
```
Profiles allocations for the given duration. Returns the top allocation sites sorted by bytes allocated. Options:
- `--duration <seconds>` — sampling time (default 5)
- `--top <N>` — number of sites to show (default 30)
- `--interval <bytes>` — sampling interval (default 32768; lower = more detail, more overhead)

### `snapshot` — Full heap snapshot summary
```bash
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts snapshot
```
Takes a V8 heap snapshot and produces a summary: total size, top 20 constructors by shallow size, top 10 by instance count, and duplicate strings (>50 occurrences).

### `diff baseline` / `diff compare` — Leak detection
```bash
# Phase 1: capture baseline
deno run --allow-net --allow-write .claude/skills/deno-memory-profiler/memory.ts diff baseline

# ... user triggers suspected leaky operation ...

# Phase 2: compare
deno run --allow-net --allow-read .claude/skills/deno-memory-profiler/memory.ts diff compare
```
Two-phase leak detection. Baseline saves a snapshot summary to `/tmp/memory-baseline-{port}.json`. Compare takes a new snapshot and reports:
- Total heap growth (bytes and percent)
- New constructors not in baseline
- Constructors with increased instance count or size
- Constructors that disappeared

## Workflow examples

### Quick health check
```bash
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts usage --gc
```
Get the current heap state after GC. Good first step to see if memory is unexpectedly high.

### Allocation profiling
```bash
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts sample --duration 10
```
Run this while the user triggers their workload. Shows where allocations are happening — useful for finding hot allocation paths.

### Leak detection
```bash
# 1. Take baseline while idle
deno run --allow-net --allow-write .claude/skills/deno-memory-profiler/memory.ts diff baseline

# 2. Ask user to trigger the suspected leaky operation several times

# 3. Compare
deno run --allow-net --allow-read .claude/skills/deno-memory-profiler/memory.ts diff compare
```
The diff shows what grew. Focus on constructors with large deltaCount or deltaSize.

### Deep inspection
```bash
# Full snapshot breakdown
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts snapshot

# Then poke at specific objects
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts eval "Deno.memoryUsage()"
deno run --allow-net .claude/skills/deno-memory-profiler/memory.ts eval "globalThis.myMap?.size"
```

## Interpreting results

- **Large shallow size with high count**: Usually arrays, buffers, or string data being retained. Look at what constructor owns them and trace back to why they're kept alive.
- **Growing constructors between baseline and compare**: These are likely leaks — objects being created but not released. Focus on the ones with the highest `deltaCount`.
- **High allocation count in sampling**: Hot allocation paths that may benefit from object pooling, caching, or restructuring to reduce GC pressure.
- **Duplicate strings**: Many identical strings suggest opportunities for string interning or indicates a pattern creating redundant string copies.
- **New constructors in diff compare**: Types that didn't exist at baseline may indicate new subsystems being loaded, or leaked closures/objects from the triggered operation.

## Limitations

- **Snapshot size**: Snapshot parsing can be slow and memory-intensive for very large heaps (>500MB). The profiler process itself needs memory to parse the JSON.
- **Sampling is duration-based**: Coordinate with the user on timing — the sampling period should overlap with the workload being profiled.
- **No retained size**: Computing retained size requires building a dominator tree, which is expensive. Shallow size grouped by constructor is provided instead, which is still very useful for identifying leaks and large allocations.
- **Single target**: Connects to the first debuggable target. If multiple isolates are running, only the first is profiled.
- **Inspector must be enabled**: The target process must be running with `--inspect`. There's no way to attach to a process that wasn't started with this flag.
