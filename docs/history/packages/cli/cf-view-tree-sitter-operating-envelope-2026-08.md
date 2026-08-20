---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Point-in-time measurements for the lazy cf view Tree-sitter path."
---

# `cf view` Tree-sitter operating envelope

This report records the measurement required before the first Tree-sitter
implementation in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md).
It measures the lazy Python path selected by that plan. It also records the
limits that will reopen the parser decision when an implementation exceeds
them.

## Environment and method

The probe ran on a MacBook Pro identified as `Mac17,6`. It had an Apple M5 Max
with 18 cores and 128 GB of memory. It ran arm64 macOS with Deno 2.9.4, V8
15.0.245.2-rusty, and TypeScript 6.0.3. It used `web-tree-sitter` 0.26.12 and
the official `tree-sitter-python` 0.25.0 package. The dependency cache was
warm.

The adjacent retained
[probe](cf-view-tree-sitter-operating-envelope-2026-08-probe.ts) performs the
timing and source-preservation work. It runs without changing the workspace
lockfile:

```sh
cd docs/history/packages/cli
deno run --allow-read --allow-run --no-config --no-lock \
  cf-view-tree-sitter-operating-envelope-2026-08-probe.ts
```

The Python source contained 100,009 UTF-8 bytes. It used the source
construction and same-length middle edit from the earlier
[parser-adapter spike](cf-view-parser-adapter-spike-2026-08-methodology.md).
The source included non-ASCII text before the edit and had no final newline.

Each initialization sample came from a fresh Deno process. The clock began at
the first statement. The measured path dynamically imported the adapter,
initialized the Tree-sitter runtime, read and loaded only the Python grammar
and highlight query, and highlighted an empty source. Deno process startup was
outside the clock.

Full highlighting parsed the source, ran the official highlight query,
normalized overlapping captures into gapless ranges, and split the result into
the pager's line topology. The probe reconstructed the original source from
those lines before collecting samples. Incremental editing edited a warm tree
and parsed the changed source from it. It then expanded the textual edit to its
complete line, ran the highlight query on that line, and normalized its
captures. Full highlighting and incremental editing each ran once before their
measured samples.

The retained probe run collected 40 fresh-process initialization samples, 50
full-highlight samples, and 50 incremental-edit samples. No deadline, retry,
or sleep participated. The adjacent raw
[results](cf-view-tree-sitter-operating-envelope-2026-08-results.json)
contains every sample and the byte counts.

## Timing results

| Operation | Median | 95th percentile | Accepted maximum |
| --- | ---: | ---: | ---: |
| Lazy selected-language initialization | 38.14 ms | 40.36 ms | 75 ms |
| Complete highlight of 100,009 bytes | 29.07 ms | 32.65 ms | 50 ms |
| Incremental edit and line highlight | 1.17 ms | 1.44 ms | 5 ms |

The initialization limit leaves room for slower comparable machines and for
the shipped adapter's additional validation. The full-highlight limit keeps an
initial large-file render below a perceptible delay. The incremental limit
keeps parser work below one third of a 60-hertz frame before the pager updates
the changed lines.

## Dependency and binary size

The complete npm package contents occupied 12,536,740 bytes. This count
includes `web-tree-sitter`, `tree-sitter-python`, `node-addon-api`, and
`node-gyp-build`. The JavaScript, WebAssembly, and highlight-query files used
at runtime occupied 814,610 bytes.

The shipped measurement used the repository's real `cf` binary build. The
expanded build ran after these two commands added only their generated direct
and transitive records to the workspace lockfile:

```sh
deno info npm:web-tree-sitter@0.26.12
deno info npm:tree-sitter-python@0.25.0
deno task build-binaries cf
stat -f %z dist/cf
```

No source import or build configuration changed. Deno 2.9.4's default
`compile` behavior embeds the complete managed npm snapshot from the lockfile.
The build's embedded-file listing named both parser packages. After the
generated lockfile records were removed, `git diff --exit-code -- deno.lock`
confirmed the original lockfile. The same build and `stat` commands then
produced the baseline.

The parser-package lockfile increased the compiled binary from 528,626,802
bytes to 541,241,970 bytes. The 12,615,168-byte increase is 12.03 MiB. This
compiled result, not the smaller runtime-file subset, is the shipped package
cost.

The unpacked count summed `stat -f %z` for every file under the cached
`web-tree-sitter`, `tree-sitter-python`, `node-addon-api`, and
`node-gyp-build` package directories. The runtime subset summed the production
`web-tree-sitter.js` and `web-tree-sitter.wasm`, the Python grammar WebAssembly,
and its highlight query.

The accepted maximum is 14 MiB for both the first compiled-binary increase and
the first unpacked dependency set. It leaves 1.97 MiB above the measured
compiled increase. Each later host grammar may add at most 10 MiB. The common
runtime and the Python, Go, Bash, and HTML host grammars may occupy at most
40 MiB together. The four-host spike measured 35.66 MiB of unpacked packages,
so the cumulative ceiling leaves room without allowing each grammar's
individual ceiling to accumulate unchecked. The CSS and JavaScript grammars
needed for nested HTML remain outside this measurement and require their own
limit before Stage 5.

## Owned source and release work

The retained probe uses 131 physical lines for parser types, runtime and Python
initialization, gapless range normalization, full and changed-line
highlighting, and cleanup. The `@owned-source-start` and `@owned-source-end`
markers delimit those lines. This command reproduces the count:

```sh
awk '/@owned-source-start/{on=1;next} /@owned-source-end/{on=0} on{n++} \
  END{print n}' cf-view-tree-sitter-operating-envelope-2026-08-probe.ts
```

Fixture construction and measurement drivers do not count toward the
implementation surface.

The shipped common adapter and Python loader may use at most 500 physical lines
of owned non-generated source. Each later host language may add at most 200
lines. The common adapter and all four host-language mappings and workarounds
may use at most 1,000 lines together. Tests, fixtures, and generated code do
not count toward these limits. The first ceiling remains below the existing
863-line Python scanner. The cumulative ceiling remains below the 1,834 lines
in the current Python and YAML scanners together.

Source runs resolve the complete npm packages through Deno. The normal
`deno task build-binaries cf` path embeds the same package contents in the
compiled binary. The probe found no parser-specific grammar build, artifact
copy, packaging, or deployment step. The accepted maximum is zero additional
parser-specific build and deployment steps.
