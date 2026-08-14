---
status: historical
created: 2026-08-11
archived: 2026-08-11
reason: "Measurements from the cf view parser-adapter spike."
---

# `cf view` parser-adapter spike

This report records the parser-adapter spike required by the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md).
It measures parser behavior and integration cost. It does not make the parser
decision, which remains a separate plan item.

## Candidates

The spike compared these approaches:

- [`web-tree-sitter` 0.26.12](https://www.npmjs.com/package/web-tree-sitter/v/0.26.12)
  with the official Python 0.25.0, Go 0.25.0, Bash 0.25.1, and HTML 0.23.2
  grammar packages;
- Lezer with Python 1.1.19, Go 1.0.1, HTML 1.3.13, CSS 1.3.6, and JavaScript
  1.5.4, the third-party `@fig/lezer-bash` 1.2.5 grammar, and the shared
  `@lezer/common` 1.5.2, `@lezer/lr` 1.4.10, and `@lezer/highlight` 1.2.3
  packages;
- the existing focused Python scanner in
  `packages/cli/lib/view/languages/python/python.ts`.

Tree-sitter and Lezer both expose concrete syntax trees with stable ranges.
Tree-sitter has official grammars for all four spike languages. Lezer also
covers all four. Its Bash grammar is published by Fig rather than the Lezer
project and was last released in February 2023.

The Lezer HTML parser was configured to nest its CSS parser in `style`
elements and its JavaScript parser in `script` elements. The Tree-sitter HTML
grammar identifies those elements, but embedded-language parsing would require
the adapter to run the injection query and invoke separate CSS and JavaScript
parsers.

## Method

The measurements ran on arm64 macOS with Deno 2.8.3, V8
14.9.207.2-rusty, and TypeScript 6.0.3. Every dependency was loaded from a warm,
isolated Deno cache.

Each language used a generated source slightly larger than 100,000 bytes:

| Language | Bytes | Forms exercised |
| --- | ---: | --- |
| Python | 100,009 | decorators, classes, async functions, type syntax, formatted strings, and non-ASCII text |
| Go | 100,206 | types, functions, goroutines, channels, composite literals, and non-ASCII text |
| shell | 100,127 | functions, strict mode, variables, arithmetic loops, substitutions, and heredocs |
| HTML | 100,178 | elements, attributes, entities, and embedded style and script elements |

Each input omitted its final newline. A second version added an unfinished
multiline construct. A third version made a same-length edit near the middle
of the source.

The adapter converted highlight ranges into gapless spans, filled unclassified
ranges as plain text, and split the result into the line topology expected by
`cf view`. It reconstructed the complete, incomplete, and edited source from
those lines. Candidate `Language` adapters also ran through the production
diff builder with unavailable files and complete workspace files. Those cases
exercised joined hunk fragments, diff-marker span shifts, a UTF-8 byte order
mark, complete old and new sides, and structure remapping.

The adjacent
[`cf-view-parser-adapter-spike-2026-08-methodology.md`](cf-view-parser-adapter-spike-2026-08-methodology.md)
records the source fixtures, adapter behavior, assertions, and sampling
procedure. The adjacent
[`cf-view-parser-adapter-spike-2026-08-results.json`](cf-view-parser-adapter-spike-2026-08-results.json)
contains every timing sample and recorded correctness result.

The sources included `café` before later tokens. With JavaScript string input,
`web-tree-sitter` 0.26.12 returned `.startIndex` and `.endIndex` values that
matched JavaScript string offsets. This differs from the binding's declaration
comments, which describe those values as byte offsets. An adapter using this
binding needs a non-ASCII contract test that pins the observed string-input
behavior.

Each timing group had one warm-up. Full parses and incremental parses used 30
measured iterations. End-to-end highlighting used 20 measured iterations. Each
startup result is the median of five candidate-specific fresh Deno processes.
No deadline, retry, or sleep participated in the measurements.

## Results

### Startup

| Candidate setup | Median initialization |
| --- | ---: |
| Tree-sitter runtime, four grammars, and four highlight queries | 37.2 ms |
| Lezer Python, Go, Bash, nested HTML, CSS, and JavaScript | 10.4 ms |
| Existing focused Python scanner | 0.9 ms |

The setups contain different numbers of languages. These figures measure the
viable setup for each candidate, not a per-language import.

### Complete and incremental work

Times are median and 95th percentile milliseconds for a source of about
100 kilobytes. "Highlight" includes parsing, the parser's highlight rules, and
the gapless-span adapter. "Incremental" includes editing the old tree and
parsing the changed source from it.

| Candidate | Language | Full parse | Highlight | Incremental |
| --- | --- | ---: | ---: | ---: |
| Tree-sitter | Python | 11.29 / 11.61 | 27.62 / 28.29 | 0.73 / 0.83 |
| Tree-sitter | Go | 11.55 / 11.78 | 21.23 / 21.62 | 0.26 / 0.27 |
| Tree-sitter | shell | 11.45 / 11.69 | 21.22 / 22.16 | 1.45 / 1.60 |
| Tree-sitter | HTML | 7.42 / 7.52 | 13.00 / 14.03 | 0.13 / 0.13 |
| Lezer | Python | 15.35 / 15.78 | 18.87 / 23.41 | 0.66 / 0.94 |
| Lezer | Go | 19.78 / 19.98 | 25.07 / 25.50 | 0.39 / 0.43 |
| Lezer | shell | 27.48 / 27.96 | 29.67 / 30.59 | 0.55 / 0.63 |
| Lezer | HTML with CSS and JavaScript | 16.49 / 17.74 | 21.41 / 21.95 | 0.10 / 0.19 |
| Focused scanner | Python | not applicable | 4.76 / 7.84 | full rescan |

Python's middle edit changed syntax within a function body repeated hundreds
of times. Tree-sitter reused less of that Python tree than it reused for the
other languages. Both parser families remained fast enough for an interactive
edit at this source size.

### Source preservation and incomplete input

Every tested adapter reconstructed the complete source, incomplete source, and
edited source exactly. This included the missing final newline and non-ASCII
text.

All four Tree-sitter grammars marked the unfinished input as containing a
syntax error. Every complete-input structure node retained the same kind,
label, start, and end in the unfinished parse. The same comparison passed for
Lezer Python, Go, shell, and HTML. Neither family threw or discarded the rest
of the file.

Tree-sitter and Lezer classified the Python and Go multiline string bodies as
strings. Tree-sitter classified the shell heredoc body as a string, while
Lezer Bash left it plain. Lezer's nested HTML parser classified the embedded
JavaScript template body as a string, while Tree-sitter HTML left it plain
because the spike did not add an injection dispatcher. The raw results also
record the token class retained at one recovery point in every unfinished
input.

The Lezer Bash grammar also marked the complete Bash input as containing an
error. The input uses common Bash extensions including `local` assignment and
an arithmetic `for` loop. Tree-sitter Bash accepted the same complete input.
This is a grammar-coverage cost, not an incomplete-input recovery failure.

Every candidate adapter also reconstructed the unified diff exactly in both
production diff paths. Each hunk retained candidate-produced structure. Its
first node began after both the context marker and decoded UTF-8 byte order
mark, which verifies the remapped range rather than only the enclosing hunk.

The parser trees exposed the structure needed by the plan:

- Python classes and functions;
- Go types, functions, and methods;
- shell functions;
- HTML elements and the style and script host ranges.

### Dependency size

The published unpacked size sums the unique npm packages and shared runtime
dependencies in each candidate setup. It includes source maps, native
prebuilds, generated C sources, declarations, and tests that are not all loaded
at runtime. The runtime payload counts only the JavaScript and WebAssembly
files used by the spike.

| Candidate setup | Published unpacked size | Runtime files used |
| --- | ---: | ---: |
| Tree-sitter runtime and four official grammar packages | 35.66 MiB | 2.30 MiB |
| Lezer Python, Go, Bash, nested HTML, and shared packages | 1.23 MiB | 384 KiB |
| Existing focused Python scanner | 20.9 KiB of repository source | no external dependency |

The Tree-sitter grammar packages publish useful highlight queries: 329 lines
and 4,152 bytes across the four languages. Their npm packages also declare the
native Tree-sitter binding and build helpers even though the spike loaded only
WebAssembly. Keeping only the runtime and grammar WebAssembly files would
reduce deployment size, but it would transfer grammar artifact building,
licensing, and release synchronization into this repository.

### Maintenance surface

A shared adapter can cover Tree-sitter parsing, query captures, range
normalization, error recovery, incremental edits, and structure extraction for
all four languages. Each language still needs a deliberate mapping from query
capture names and syntax node names into `TokenClass` and `StructureKind`.
HTML injection handling adds another parser-dispatch layer.

Lezer uses JavaScript string offsets directly and its highlight tags are
already normalized across its grammars. Its HTML nesting wrapper also handles
embedded CSS and JavaScript. The Fig Bash grammar fits the same adapter, but it
adds a separately maintained grammar whose complete-input coverage needs more
work than the three Lezer project grammars measured here.

The focused Python scanner is 862 lines. The focused YAML scanner is 970 lines.
They are fast, dependency-free, tolerant of incomplete input, and already fit
the pager's exact line model. They provide no syntax tree, so structure requires
another implementation. Repeating this approach for Go, shell, and HTML would
repeat both the lexical state machinery and later structure extraction.

## Facts the parser decision must resolve

The measurements leave these trade-offs for the next plan item:

- official Tree-sitter grammars for all four languages versus Lezer's smaller
  runtime and separately maintained Bash grammar;
- a 2.30 MiB Tree-sitter runtime payload versus 384 KiB for the measured Lezer
  stack or no external payload for focused scanners;
- Tree-sitter's complete handling of the Bash fixture versus Lezer's built-in
  HTML nesting;
- parser-provided structure versus the lower full-rescan cost of focused
  scanners;
- importing complete npm packages versus maintaining selected WebAssembly
  grammar artifacts in the repository.
