# `cf view` language and syntax coverage plan

Status: In progress. Unknown named files now use plain text. Python files with
recognized extensions now have syntax highlighting. The order is provisional
because recent activity was
measured in six of the 24 active organization repositories.

This plan takes `cf view` from its current TypeScript and JavaScript, Markdown,
JSON and JSONC, YAML, extension-based Python highlighting, and diff support to
honest handling of every textual syntax in the active `commontoolsinc`
repositories.

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
- [ ] Preserve the intentional TypeScript default only for transformed
  compiler output that has no filename.
- [ ] Add `--language` and `--filename` overrides for piped input.
- [ ] Represent extensions, exact filenames, compound filename patterns,
  aliases, and shebang interpreters as language metadata.
- [ ] Keep content detection only for unambiguous containers such as unified
  diffs.
- [ ] Detect known binary files and NUL-containing input before source
  decoding.
- [ ] Build a fixture corpus with direct-file, diff, incomplete-edit, and
  selection cases from the survey.
- [ ] Run a parser-adapter spike on Python, Go, shell, and HTML.
- [ ] Record the parser decision before implementing Stage 2.

The parser spike must compare available Deno-compatible parsers with focused
scanners. Measure startup cost, dependency size, exact source preservation,
behavior on incomplete edits, state across lines, diff integration, and
maintenance cost. The YAML scanner's size demonstrates that repeated custom
implementations may be expensive. It does not settle the parser choice by
itself.

Completion gate: unknown text and binary input are no longer presented as
TypeScript. Exact names, compound names, shebangs, and explicit overrides use
one tested selection path. The parser decision is recorded with measurements.

## Stage 1: JSON aliases and line-oriented JSON

- [ ] Reuse the JSON tokenizer for `.jsonl` and `.ndjson`.
- [ ] Isolate malformed lines so one line cannot affect the next.
- [ ] Recognize `.webmanifest`, `.tldr`, Deno lock files, JSON-shaped `.cfg`
  files, VS Code workspace files, and Swift `Package.resolved`.
- [ ] Add Jupyter notebook container recognition for `.ipynb`.
- [ ] Leave notebook cell-language delegation for the matching language phase.

Completion gate: every JSON-shaped active-tree special case and recent-history
notebook selects JSON or line-oriented JSON without broad suffix guesses.

## Stage 2: Python

- [x] Highlight `.py`, `.pyi`, and `.pyw` files.
- [ ] Recognize extensionless programs from direct Python and `uv run`
  shebangs.
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
