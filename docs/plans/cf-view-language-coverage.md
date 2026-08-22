# `cf view` language and syntax coverage plan

Status: In progress. Unknown named files and filename-free source without a
recognized shebang use plain text, while filename-free transformed compiler
output keeps its TypeScript default. Piped source can select a language directly
or through a virtual filename. Declarative metadata can now describe extensions,
exact names, compound patterns, explicit aliases, and direct interpreter
shebangs. JSON Lines and NDJSON names use the JSON tokenizer. Python files with
recognized extensions now have syntax highlighting.
Automatic container detection is limited to structurally identified raw unified
diffs and standard Git commit output. Recognized shebangs and transformed
compiler headers remain explicit source selectors. Binary is a supported,
read-only language with raw-byte decoding and a hex-dump rendered view. Known
binary filenames, NUL-containing input, and invalid UTF-8 select it before text
decoding. Interactive binary views use a bounded preview, while redirected
output streams the complete dump. Text saves use the encoder paired with the
decoded source, including preservation of a UTF-8 byte order mark. Binary files
remain outside diff editing and semantic source loading.
Parser-backed Python, Go, shell, and HTML implementations use Tree-sitter
through a shared, language-neutral adapter and official grammar packages.
The order is provisional because recent activity was measured in six of the 26
active organization repositories.

This plan takes `cf view` from its current TypeScript and JavaScript, Markdown,
JSON, JSONC, JSON Lines, YAML, extension-based Python highlighting, and diff
support to honest handling of every textual syntax in the active
`commontoolsinc` repositories.

The frozen evidence is in the
[July 2026 coverage survey](../history/packages/cli/cf-view-language-coverage-2026-07.md).
Keep this plan current when support lands or newer repository evidence changes
the order. Do not update the historical survey.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent complete only after its completion gate passes. When all stages
land or the plan is abandoned, archive this document under
`docs/history/plans/` as described in `docs/README.md`.

## Goal

Full active-repository coverage means:

- every surveyed textual syntax selects from its real filename, compound
  filename, explicit override, or shebang;
- direct files, diffs, and live edits preserve the input exactly;
- highlighting tolerates incomplete input;
- unknown text is plain text, not false TypeScript;
- binary input is recognized without being decoded as source;
- every supported selection and highlighting path has representative tests
  drawn from the surveyed repositories.

Syntax highlighting is required. Structure navigation should ship when the
chosen parser exposes stable ranges. Cross-file semantic lookup remains
limited to languages where a real project model makes it reliable.

## Ordering rubric

Apply these rules in order:

1. Complete shared selection and fallback work before adding language
   implementations that depend on it.
2. Extend a proven parser to cheap aliases and line-oriented variants before
   introducing a new grammar.
3. Rank new source languages by measured recent activity, active file count,
   repository breadth, and operational risk.
4. Discount generated and vendored concentrations when they dominate raw
   counts.
5. Keep host syntaxes and their embedded syntaxes close together so one phase
   can test delegation.
6. Prefer work that unlocks several later families, when the earlier evidence
   is otherwise close.

The leading evidence is:

| Family | Recent path changes | Active files | Active repositories | Ordering effect |
| --- | ---: | ---: | ---: | --- |
| Python | at least 14,481 | at least 2,017 | 9 | First new programming language |
| Go | 2,129 | 2,568 | 6 | Second new programming language |
| Shell | at least 1,929 | at least 269 | 14 | Third; breadth and operational use outweigh the lower extension count |
| HTML and CSS or SCSS | 3,216 | 1,382 | 12 for HTML, 6 for CSS | After shell because generated Specs and Loom files inflate activity |
| Lean | 1,280 | 310 | 1 | After broadly shared web formats |
| Starlark and Bazel | 259 | 537 | 1 | Large static population, concentrated in gVisor |
| OpenTofu and HCL | 105 | 96 | 1 | Modest volume, but operationally sensitive in Infra |

The counted Python, Go, and shell filename forms account for 74 percent of the
activity that the audit found outside currently recognized extensions. They
would raise coverage of the measured activity from 66 percent to 91 percent.
Shebang recognition would add extensionless programs to that gain.

Before starting each numbered language group, refresh its active file count
and recent activity. Reorder later groups when the new evidence changes their
relative value. Record the reason in this plan.

## Stage 0: honest selection and implementation foundation

- [x] Add a plain-text language and select it for unknown named files.
- [x] Preserve the intentional TypeScript default only for transformed
  compiler output that has no filename.
- [x] Add `--language` and `--filename` overrides for piped input.
- [x] Represent extensions, exact filenames, compound filename patterns,
  aliases, and shebang interpreters as language metadata.
- [x] Keep content detection only for unambiguous containers such as unified
  diffs.
- [x] Detect known binary files and NUL-containing input before source
  decoding.
- [x] Build a fixture corpus with direct-file, diff, incomplete-edit, and
  selection cases from the survey.
- [x] Run a parser-adapter spike on Python, Go, shell, and HTML. The
  [August 2026 report](../history/packages/cli/cf-view-parser-adapter-spike-2026-08.md)
  records the measurements and leaves the decision to the next item.
- [x] Record the parser decision before the remaining Stage 2 work.
- [x] Before the first Tree-sitter-backed implementation, measure the lazy
  selected-language path and record accepted maximums for 95th-percentile
  initialization, full highlighting, and incremental editing; shipped parser
  bytes; downloaded or unpacked dependency bytes; owned non-generated adapter
  and workaround source lines; and parser-specific build and deployment steps.
  The
  [August 2026 operating-envelope report](../history/packages/cli/cf-view-tree-sitter-operating-envelope-2026-08.md)
  records the measurements and raw samples.

### Parser operating maximums

The common adapter and every parser-backed language must stay within these
limits on a comparable arm64 macOS machine. Timing uses a 100-kilobyte source
and a warm dependency cache. Initialization starts at the first statement in a
fresh Deno process and includes dynamic imports, runtime initialization, the
selected grammar and query, and one empty highlight.

| Dimension | Python measurement | Accepted maximum |
| --- | ---: | ---: |
| 95th-percentile lazy initialization | 40.36 ms | 75 ms |
| 95th-percentile full highlighting | 32.65 ms | 50 ms |
| 95th-percentile incremental edit and changed-line highlight | 1.44 ms | 5 ms |
| Compiled `cf` increase | 12.03 MiB | 14 MiB for runtime and first grammar |
| Unpacked dependencies | 11.96 MiB | 14 MiB for runtime and first grammar |
| Owned source | 131 probe lines | 500 shipped lines |
| Parser-specific build and deployment steps | 0 | 0 |

Each later host grammar may add at most 10 MiB to both byte measures and 200
owned source lines. The common runtime and the Python, Go, Bash, and HTML host
grammars together may occupy at most 40 MiB and 1,000 owned source lines. Tests,
fixtures, and generated code do not count toward the source limit. The separate
nested-HTML measurement sets the limits for its CSS and JavaScript grammars
before Stage 5.

### Parser decision

Use `web-tree-sitter` 0.26.12, with pinned official Tree-sitter grammar
packages, for parser-backed Python, Go, shell, and HTML implementations. Put
parser initialization, gapless range normalization, incomplete-input recovery,
incremental edits, and structure extraction behind one adapter that accepts
language-specific highlight-capture and structure mappings. Treat Tree-sitter
as the default for later source languages only after checking their grammar
coverage and integration cost.

The current language selection and parsing interfaces are synchronous, while
Tree-sitter initialization and grammar loading are asynchronous. Add and test an
asynchronous initialization boundary before adopting the adapter. Load the
runtime and only the grammars required by the selected language when a view
needs them. The spike's startup measurement loaded all four host grammars, so it
does not establish the cost of that lazy path.

The measured four-grammar setup initialized in 37.2 milliseconds and highlighted
about 100 kilobytes in 14.03 to 28.29 milliseconds at the 95th percentile. Its
incremental parses took 0.13 to 1.60 milliseconds at the 95th percentile. Those
costs leave enough room for an interactive view. Tree-sitter also preserved
complete, incomplete, edited, and diff source exactly. The measured mappings
exposed Python classes and functions; Go types, functions, and methods; shell
functions; and HTML elements and style and script host ranges. Each language
stage must extend and test that mapping for structures the spike did not cover,
including decorated Python definitions and Go packages.

Tree-sitter's official grammars cover Python, Go, Bash, and HTML. The Bash
grammar accepted the complete generated Bash fixture and classified its heredoc
body. The separately maintained Lezer Bash grammar marked that fixture as
containing an error and left the heredoc body unclassified. Lezer's smaller
runtime and built-in HTML nesting do not outweigh using two parser families or
accepting weaker shell coverage. Focused scanners remain suitable for simple
data formats, but the existing Python scanner's 862 lines and YAML scanner's 970
lines make one custom scanner per measured source language the larger
maintenance surface. They also require a second implementation for structure.

Depend on the complete npm packages rather than checking selected WebAssembly
artifacts into the repository. The measured packages occupy 35.66 MiB when
unpacked, while the JavaScript and WebAssembly files used at runtime occupy 2.30
MiB. Keeping the packages intact leaves grammar builds, licenses, and release
synchronization with their publishers. The adapter must pin the observed
JavaScript string-offset behavior with non-ASCII contract tests. HTML embedding
must dispatch the grammar's injection ranges to the official Tree-sitter CSS and
JavaScript grammars rather than treating the host grammar as if it parsed those
regions. The Tree-sitter startup and dependency-size measurements exclude those
two embedded grammars. The startup measurement does not describe the nested
setup, while the dependency-size measurements are lower bounds for the
cumulative parser packages. Measure and record the complete nested-HTML setup
before implementing Stage 5.

The focused Python scanner remains in place until the Stage 2 structure change
replaces it through the shared adapter. Do not add another focused scanner for
Python, Go, shell, or HTML.

#### Reconsidering the dependency

Reopen the parser decision for a language when any of these conditions becomes
true:

- the shared fixture contract or stage-specific tests cannot pass without a
  grammar fork or local grammar patch;
- measured initialization, full highlighting, incremental editing, shipped
  bytes, downloaded or unpacked dependency bytes, owned adapter or workaround
  source lines, or build and deployment work exceeds a recorded maximum;
- the runtime or grammar is archived, or has no release compatible with the
  supported Deno version or with a required security fix; or
- an unresolved license or security problem prevents shipping the dependency.

A trigger starts a new measured comparison; it does not select the replacement.
Before switching, require the focused implementation to pass the shared fixture
contract and every stage-specific selection, highlighting, structure, and
embedded-language test. If the dependency cannot ship or cannot meet those
contracts, switch when the focused implementation passes them and remains within
the recorded operating maximums.

Otherwise compare these dimensions separately: owned non-generated parser,
adapter, and workaround source lines; local patches or forks; 95th-percentile
initialization, full-highlight, and incremental-edit latency; shipped runtime
bytes; downloaded or unpacked dependency bytes; and parser-specific build and
deployment steps. Compare only the marginal costs that the proposed switch would
remove. Count language-specific grammar bytes, capture and structure mappings,
workarounds, and selected-language latency as marginal costs. Treat the common
adapter core, runtime package bytes, and shared deployment steps as unchanged
while another language still uses them; count them as removable only when the
switch removes their final consumer. Switch automatically only when the focused
implementation is no worse in every dimension and strictly better in at least
one. When the dimensions trade off, record a new parser decision with the
individual measurements and priorities instead of combining unlike units into a
single cost score. Carrying a grammar fork is sufficient to start the comparison
because it takes on grammar maintenance while retaining the external runtime and
integration costs.

The parser spike must compare available Deno-compatible parsers with focused
scanners. Measure startup cost, dependency size, exact source preservation,
behavior on incomplete edits, state across lines, diff integration, and
maintenance cost. The YAML scanner's size demonstrates that repeated custom
implementations may be expensive. It does not settle the parser choice by
itself.

Completion gate: unknown text and binary input are no longer presented as
TypeScript. Exact names, compound names, shebangs, and explicit overrides use
one tested selection path. The parser decision and operating maximums are
recorded with measurements.

## Stage 1: JSON aliases and line-oriented JSON

The August 18, 2026 refresh found 43 `.jsonl` and `.ndjson` files across seven
of the 26 active organization repositories. The six-repository history sample
contains 40 path-change events on current JSON Lines paths since February 18,
2026. This activity and the existing tokenizer reuse keep Stage 1 ahead of new
grammar work.

- [x] Reuse the JSON tokenizer for `.jsonl` and `.ndjson`.
- [ ] Isolate malformed lines so one line cannot affect the next.
- [ ] Recognize `.webmanifest`, `.tldr`, Deno lock files, JSON-shaped `.cfg`
  files, VS Code workspace files, and Swift `Package.resolved`.
- [ ] Add Jupyter notebook container recognition for `.ipynb`.
- [ ] Leave notebook cell-language delegation for the matching language phase.

Completion gate: every JSON-shaped active-tree special case and recent-history
notebook selects JSON or line-oriented JSON without broad suffix guesses.

## Stage 2: Python

- [x] Highlight `.py`, `.pyi`, and `.pyw` files.
- [x] Recognize extensionless programs from direct Python shebangs.
- [ ] Recognize extensionless programs from `uv run` shebangs.
- [ ] Add class, function, async function, and decorated-definition structure.
- [ ] Add representative Loom, Specs, Legibility, Raia, and gVisor fixtures.

Completion gate: direct files, diffs, and incomplete edits pass the shared
fixture contract without altering source text.

## Stage 3: Go and Go manifests

- [ ] Highlight `.go`.
- [ ] Add package, type, function, and method structure.
- [ ] Recognize `go.mod` and `go.sum` as separate data syntaxes.
- [ ] Add Common Cluster, Bay, Run Orchestrator, Raia, and gVisor fixtures.

Completion gate: Go source and both manifest formats select correctly in
direct and diff views.

## Stage 4: shell

- [ ] Cover Bash and POSIX shell with dialect selection from the shebang.
- [ ] Recognize `.sh`, `.command`, Git hooks, entrypoint scripts, and
  extensionless executables with shell shebangs.
- [ ] Highlight heredocs without guessing an embedded language unless the
  delimiter names it reliably.
- [ ] Add Infra and Loom fixtures that exercise operational scripts.

Completion gate: every surveyed shell selection form works in direct files,
diffs, and incomplete edits.

## Stage 5: web markup, styling, and XML

- [ ] Add HTML, CSS, and SCSS.
- [ ] Delegate HTML `style` and `script` regions to CSS and JavaScript.
- [ ] Add strict XML separately from permissive HTML.
- [ ] Route SVG, Apple property lists, and entitlement files through XML.
- [ ] Evaluate the HTML and CSS parsers already pinned by the UI package
  before adding a dependency.

Completion gate: host and embedded syntax ranges preserve the complete input,
including malformed and partially edited markup.

## Stage 6: Lean

- [ ] Highlight `.lean`.
- [ ] Recognize `lean-toolchain`.
- [ ] Add structure for namespaces, sections, declarations, definitions,
  theorems, and inductive types.

Completion gate: representative Specs source and diffs pass the shared fixture
contract.

## Stage 7: Starlark and Bazel

- [ ] Use one Starlark implementation for `BUILD`, `BUILD.bazel`,
  `MODULE.bazel`, workspace files, and `.bzl`.
- [ ] Add small selectors for `.bazelrc`, `.bazelignore`, and
  `.bazelversion`.
- [ ] Add representative gVisor build fixtures.

Completion gate: all 537 surveyed Starlark and Bazel files have an honest
selection path.

## Stage 8: OpenTofu, HCL, and infrastructure templates

- [ ] Add `.tf` and `.tfvars` HCL.
- [ ] Layer Terraform interpolation over the shell host in `.tftpl`.
- [ ] Layer Jinja delimiters over a separately selected host syntax.
- [ ] Cover the surveyed shell, systemd-unit, authorized-keys, and YAML Jinja
  hosts.

Completion gate: an extension such as `.j2` does not force one host language,
and every current Infra template has an explicit tested selection rule.

## Stage 9: build and operational configuration

- [ ] Add Dockerfile, including every `Dockerfile.*` variant.
- [ ] Add Makefile and `.mk`.
- [ ] Add Git, Docker, Deno, and Bazel ignore files.
- [ ] Add Git attributes, modules, hooks, and worktree-include syntax.
- [ ] Add dotenv files and compound examples.
- [ ] Add INI, Ansible configuration, and inventory files.
- [ ] Add systemd units, tmpfiles configuration, and surveyed directive
  configuration.

Completion gate: every surveyed exact-name and compound-name operational file
selects without content guessing.

## Stage 10: Swift, Rust, TOML, and native manifests

- [ ] Add Swift and Rust source.
- [ ] Add TOML.
- [ ] Recognize Cargo manifests and lock files.
- [ ] Recognize Swift package manifests and package-resolution JSON.
- [ ] Delegate embedded notebook cells when their language metadata names one
  of the implemented languages.

Completion gate: Fabric Mobile and surveyed gVisor native-language files have
complete source and manifest selection.

## Stage 11: TLA+ and TLC configuration

- [ ] Highlight `.tla`.
- [ ] Highlight TLC `.cfg`.
- [ ] Distinguish TLC configuration from JSON and INI `.cfg` files by filename
  and content evidence.

Completion gate: all Labs and Common Cluster formal files select correctly,
without claiming the unrelated gVisor and Infra configurations.

## Stage 12: systems-language group

- [ ] Add C, C++, headers, and CUDA.
- [ ] Add assembly and linker scripts.
- [ ] Add Protocol Buffers and protobuf text format.
- [ ] Add Packetdrill.
- [ ] Use a neutral C-family mode for ambiguous headers until project context
  establishes the dialect.

Completion gate: every systems-language family in the active gVisor branch
passes direct-file and diff fixtures.

## Stage 13: remaining active text formats

- [ ] Add Ruby, Rack, ERB, Gemfiles, and Bundler lock files.
- [ ] Add TeX and BibTeX.
- [ ] Add Org mode.
- [ ] Add SQL.
- [ ] Add CSV, TSV, numeric `.dat` tables, and structured JSON log records.
- [ ] Add Graphviz DOT.
- [ ] Add Handlebars and generic `.in` templates.
- [ ] Classify application-specific configuration when it has stable syntax.
- [ ] Keep prose, logs, checksums, versions, PID files, and opaque task records
  as plain text.

Completion gate: every textual syntax in the survey's 24 active repositories
has a tested selector and highlighter or an explicit plain-text classification.
