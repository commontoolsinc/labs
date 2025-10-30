# API Type Profiling Harness

This directory contains self‑contained TypeScript projects that measure how
expensive particular exported types from `packages/api/index.ts` are to check.
Each scenario lives in its own `.ts` file with a matching `tsconfig.*.json` so
that we can profile the types independently.

## Prerequisites

The commands below assume you are inside the repo root (`labs-secondary`) and
that the vendored TypeScript binary at
`node_modules/.deno/typescript@5.8.3/node_modules/typescript/bin/tsc` is
available. Use `bash` to run the snippets exactly as shown.

## Quick Metrics

Run the compiler with `--extendedDiagnostics` to get counts of type
instantiations, memory usage, etc.

```bash
node_modules/.deno/typescript@5.8.3/node_modules/typescript/bin/tsc \
  --project packages/api/perf/tsconfig.key.json \
  --extendedDiagnostics --pretty false
```

Available projects:

- `tsconfig.baseline.json` – empty control case for the load cost of
  `packages/api/index.ts`.
- `tsconfig.key.json` – stresses `KeyResultType` + branded cell keying.
- `tsconfig.anycell.json` – focuses on `AnyCellWrapping` write helpers.
- `tsconfig.schema.json` – exercises the JSON schema conversion helpers.
- `tsconfig.ikeyable-cell.json` – heavy `IKeyable<Cell<…>>` stress case.
- `tsconfig.ikeyable-schema.json` – `IKeyable` over `Cell<Schema<…>>`.

Each run prints metrics; compare the “Instantiations”, “Types”, and “Check time”
fields against the baseline to see relative cost.

## CPU Profiles

Use `--generateCpuProfile` to capture where the checker spends time. The profile
is a Chromium CPU profile you can open via DevTools ▸ Performance ▸ “Load
profile…”.

```bash
NODE_OPTIONS=--max-old-space-size=4096 \
node_modules/.deno/typescript@5.8.3/node_modules/typescript/bin/tsc \
  --project packages/api/perf/tsconfig.ikeyable-cell.json \
  --generateCpuProfile packages/api/perf/traces/ikeyable-cell.cpuprofile
```

Generated profiles are stored under `packages/api/perf/traces/`. Existing ones
include:

- `ikeyable-cell.cpuprofile`
- `ikeyable-schema.cpuprofile`

## Event Traces (Caution: Large)

`--generateTrace <dir>` produces Chrome trace JSON (`trace.json`) plus a
snapshot of instantiated types (`types.json`). These files grow quickly and can
exceed V8’s heap limit on the heavy scenarios.

```bash
mkdir -p packages/api/perf/traces/ikeyable-cell \
  && NODE_OPTIONS=--max-old-space-size=4096 \
     node_modules/.deno/typescript@5.8.3/node_modules/typescript/bin/tsc \
       --project packages/api/perf/tsconfig.ikeyable-cell.json \
       --generateTrace packages/api/perf/traces/ikeyable-cell
```

If you hit an “out of memory” crash, try:

- Lowering `max-old-space-size` so the compiler bails faster (you still get
  partial traces), or
- Splitting the stress test into smaller files and tracing each individually.

The lighter `tsconfig.ikeyable-cell-trace.json` target exists specifically for
trace generation; it keeps the scenario minimal enough to succeed.

## Scripts / Analysis

There are no bespoke scripts yet; ad-hoc analysis can be performed with Node.js
like so:

```bash
node -e 'const trace=require("./packages/api/perf/traces/ikeyable-cell/trace.json");\
const totals=new Map();\
for (const e of trace) if (e.ph==="X") totals.set(e.name,(totals.get(e.name)||0)+e.dur);\
console.log([...totals.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10));'
```

Feel free to add your own utilities here if repeated analyses become necessary.

## Tips

- Always compare against `tsconfig.baseline.json` to understand the fixed cost
  of loading the module.
- When experimenting with type changes, re-run the relevant scenario(s) to watch
  how instantiation counts and profile hotspots move.
- For long-running traces, add `NODE_OPTIONS=--max-old-space-size=<MB>` to keep
  Node from running out of memory mid-run.
