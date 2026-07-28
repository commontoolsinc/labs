---
status: historical
created: 2026-07-28
archived: 2026-07-28
reason: "Point-in-time audit of repository syntax coverage and cf view support."
---

# `cf view` language and syntax coverage survey

## Conclusion

`cf view` has first-class handling for the TypeScript and JavaScript family,
Markdown, JSON and JSONC, and YAML. It also understands unified diffs and
standard Git commit output as containers. It selects the language for each
file inside those containers from the file name.

Every other named file currently falls through to TypeScript. The fallback
displays text, but it is not support for the input language. MDX is a partial
case: it receives Markdown highlighting, but embedded TypeScript and JSX do
not receive TypeScript highlighting.

The 24 active repositories contained 21,424 tracked blobs at the audited
commits. The extensions that `cf view` recognizes accounted for 12,067 of
them. Python, Go, and shell were the clearest next source-language priorities.
Their counted filename forms accounted for 18,539 of the 25,042 measured
path-change events that did not use a supported extension. Adding those forms
would raise coverage of the measured activity from 66 percent to 91 percent.
Shebang recognition would cover additional extensionless programs.

The current implementation order is maintained in
[`docs/plans/cf-view-language-coverage.md`](../../../plans/cf-view-language-coverage.md).
This document freezes the evidence used to create that plan.

## Scope

The requested Labs 5 checkout, the INFRA1 worktree, and a fresh Loom worktree
were inspected locally. The survey interpreted “commonlabs” as the
`commontoolsinc` GitHub organization because that is the organization used by
the repositories' remotes.

An authenticated organization query found 24 active repositories. Recursive
Git trees supplied the tracked-file inventory for every repository. GitHub
reported `truncated: false` for every tree.

| Repository | Branch | Audited commit | Blobs |
| --- | --- | --- | ---: |
| `common-tools-website` | `main` | `63c14bae3e40c06aa3a97ccaecfd203c64809db1` | 18 |
| `labs` | `main` | `a09656c3342bf3e34b68c5f754c25473acb0afef` | 5,365 |
| `adjacency-map` | `main` | `903d136fa1172ffe49e440c18adb44396d5cdd8f` | 88 |
| `.github` | `main` | `dc13da8fcbef9050ccdbeffc9a1d15696b6ad232` | 3 |
| `infra` | `main` | `cfe4ac630b0b1e223d57bed12ae02fa6c53b9eb2` | 382 |
| `promptinjection-wtf` | `main` | `283783f4890f8b9e50f0d5d3ca9fc7492f5a9df6` | 11 |
| `resonant-computing-org` | `main` | `fd7ef02db2e84e149d15eea92f4fd5d04d2fe4d8` | 80 |
| `fabric-city-3000` | `main` | `84dc86a5fc310d84977087861b1301f8aaa24d9c` | 658 |
| `specs` | `main` | `57d00d343109b34e279a11efcb8517ff0e25e9c4` | 5,712 |
| `gvisor` | `cfc_v2` | `bb309e286c61e1a5a5f9893666443a9ea31c4f17` | 3,991 |
| `danfuzz-land` | `main` | `876e2b25e7bf410ccff72eca5b53375061afd451` | 323 |
| `common-cluster` | `main` | `50c7f1bb0b83dad6057b3bde73ce599f86624084` | 164 |
| `pattern-factory` | `main` | `50179e976b1a8826de0c65cf13061e22a167513f` | 123 |
| `run-orchestrator` | `main` | `d3d4d5f917cc7379f580e6987dde2150032946e8` | 36 |
| `loom` | `main` | `43a4afe18fbfc37ab8a11da8fe5011f0be81f6e7` | 3,014 |
| `bay` | `main` | `05045315be9a4bcc71b67eb2e52efe1c0f7cbc65` | 182 |
| `loom-scripts` | `main` | `fb0f2eb1031c548992b4e76bd79f79c30b7c548e` | 539 |
| `auth-broker` | `main` | `f11ec247c581f7975806d3d5b4e472c990ef8b35` | 31 |
| `obsidian-loom` | `main` | `5a0df821f6519eb3332df29dd8375c7d7b41d1cb` | 29 |
| `pond` | `main` | `409f916b03fdb6f04ef0a2f223d950e58c4de937` | 150 |
| `fabric-browser-extension` | `main` | `01e95b5e95788e4ce96e8b802fc8a0d10421ed55` | 18 |
| `fabric-mobile` | `main` | `94ae27c19a5accba06ccc84172a6e0f7bc16259c` | 42 |
| `legibility` | `main` | `d82321ba9e54b5bc59dcf64d6075d5944f86a5d5` | 174 |
| `raia` | `main` | `6b9cc95befe5f7cf0929eb569d9a1157e62d2374` | 291 |
| **Total** | | | **21,424** |

Generated files, fixtures, and vendored source remain in the tracked-file
counts because they can appear in diffs. Materialized untracked dependencies,
parallel Labs checkouts, Loom's vendored Labs copy, and binary contents were
not scanned.

## Reproduction and classification method

The active inventory came from this GitHub request for each table row:

```text
gh api \
  "repos/commontoolsinc/<repository>/git/trees/<audited-commit>?recursive=1"
```

Only entries whose type was `blob` were counted. The response was rejected if
`truncated` was true.

The raw inventory grouped paths as follows:

1. Take the basename.
2. If it has a conventional final suffix, lowercase that suffix.
3. If it has no suffix, record its lowercase basename with an `@` prefix.
4. Keep a single-dot control file such as `.gitignore` as its own token.
5. Inspect every exact filename, compound suffix, and ambiguous suffix before
   assigning a syntax family.

The final inspection is necessary. For example, `.cfg` means TLC
configuration, JSON, or INI in the surveyed repositories. A suffix such as
`.x86_64` belongs to a `Dockerfile.x86_64`, not an x86 source file.

Recent activity was measured in six locally fetched repositories. Each
non-empty path emitted by this command counted as one path-change event:

```text
git log \
  --since=2026-01-28T00:00:00-08:00 \
  --format= \
  --name-only \
  --find-renames=50% \
  -l0 \
  <audited-commit>
```

The measured commits were the Labs, Loom, Infra, Common Cluster, Specs, and
gVisor commits in the table. The command did not use `--follow` or `-m`.
Rename detection used the explicit 50 percent similarity threshold with no
candidate limit. Each non-empty path emitted by Git counted once. This is
review traffic, not a line count. It covered 74,623 path-change events.

## What `cf view` supported

| Language or container | Recognized input | Highlighting | Structure | Semantic lookup |
| --- | --- | --- | --- | --- |
| TypeScript and JavaScript | `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`; also every unclaimed input | Compiler-backed | Full syntax tree and Common Fabric nodes | Types and definitions |
| Markdown | `.md`, `.markdown`, `.mdown`, `.mkd`, `.mdx` | Markdown syntax | Heading tree | None |
| JSON and JSONC | `.json`, `.jsonc` | JSON values, keys, comments, and brackets | Object-key tree | None |
| YAML | `.yaml`, `.yml` | YAML-oriented scanner | None | None |
| Unified diff and Git commit output | Detected from content or forced with `--diff` | Diff metadata plus each named file's selected language | Hunks plus the named file's available structure | Delegated when a selected language provides semantics |

YAML reached `upstream/main` in commit `4b5760b6a` on the day of the survey.
The requested Labs 5 branch predated that commit. The support comparison
therefore used the fetched `upstream/main`, not the branch's older files.

A named unknown file was parsed as TypeScript. An unnamed pipe was TypeScript
unless it looked like a diff or standard Git commit output. Piping JSON or YAML
without a filename therefore did not select the JSON or YAML implementation.

MDX was recognized as Markdown. Embedded TypeScript and JSX were not delegated
to the TypeScript implementation, so MDX support was partial.

## Active-repository family counts

The table reconciles all 21,424 tracked blobs and all 74,623 measured
path-change events. Its final row contains 838 binary, media, archive, font,
and database blobs, plus 280 plain-text records, special-name structured
files, and low-count operational records. Those special cases appear in the
per-repository and cross-cutting inventories below.

Counts for Python and shell are lower bounds because extensionless programs
are not included. Dockerfile counts include inspected suffixed Dockerfiles.
TLA+ counts exclude the two `.cfg` files that contain JSON or INI.

| Syntax family | Active tracked files | Recent changes | Audit status |
| --- | ---: | ---: | --- |
| TypeScript and JavaScript | 5,345 | 33,138 | Supported |
| Markdown | 5,809 | 14,593 | Supported |
| JSON and JSONC | 699 | 1,179 | Supported |
| YAML | 214 | 671 | Supported |
| Python | at least 2,017 | at least 14,481 | TypeScript fallback |
| Go | 2,568 | 2,129 | TypeScript fallback |
| Shell | at least 269 | at least 1,929 | TypeScript fallback |
| HTML | 1,321 | 2,226 | TypeScript fallback |
| Lean | 310 | 1,280 | TypeScript fallback |
| CSS and SCSS | 61 | 990 | TypeScript fallback |
| Starlark and Bazel | 537 | 259 | TypeScript fallback |
| C, C++, headers, and CUDA | 465 | 112 | TypeScript fallback |
| OpenTofu and HCL | 96 | 105 | TypeScript fallback |
| Swift | 19 | 109 | TypeScript fallback |
| Ignore files and Git attributes | 77 | 98 | TypeScript fallback |
| Dockerfile syntax | 90 | 64 | TypeScript fallback |
| TLA+ and TLC configuration | 28 | 50 | TypeScript fallback |
| XML, SVG, property lists, and entitlements | 60 | 48 | TypeScript fallback |
| Makefile syntax | 14 | 49 | TypeScript fallback |
| Org mode | 2 | 42 | TypeScript fallback |
| TeX and BibTeX | 3 | 32 | TypeScript fallback |
| JSON Lines and NDJSON | 38 | 20 | TypeScript fallback |
| CSV, TSV, and numeric data tables | 31 | 16 | TypeScript fallback |
| Jinja, Terraform, ERB, Handlebars, and generic templates | 27 | 14 | TypeScript fallback |
| Ruby and Rack | 9 | 13 | TypeScript fallback |
| INI, Ansible, and codespell configuration | 8 | 11 | TypeScript fallback |
| TOML | 14 | 10 | TypeScript fallback |
| Protocol Buffers and protobuf text format | 22 | 6 | TypeScript fallback |
| SQL | 1 | 3 | TypeScript fallback |
| Assembly and linker scripts | 67 | 2 | TypeScript fallback |
| Rust | 11 | 0 | TypeScript fallback |
| Packetdrill | 8 | 0 | TypeScript fallback |
| Graphviz DOT | 1 | 0 | TypeScript fallback |
| Unified patch files | 65 | 0 | Supported through diff detection |
| Other special-name text, plain records, and binary assets | 1,118 | 944 | Text uses TypeScript fallback; binary input is not recognized |

The supported families accounted for 49,581 of the 74,623 measured events.
Adding the counted Python filename forms alone would raise that measured share
from 66.4 percent to 85.8 percent. Adding the counted Python, Go, and shell
forms would raise it to 91.3 percent. Those forms account for 74.0 percent of
all measured unsupported activity. Extensionless recognition can only
increase those gains.

The history sample covers six repositories rather than all 24. The priority
signal is therefore strong for those repositories and provisional for the
organization as a whole. File population, repository breadth, operational
risk, generated-file concentration, implementation reuse, and syntax
dependencies must also influence the live order.

The HTML count needs context. Specs contains 1,213 HTML files, mainly in
generated prompt-render and archive directories. The same caution applies to
one generated CSS artifact that accounts for much of Loom's CSS history.

## Syntax inventory by active repository

Plain licenses, CNAME files, checksums, PID files, and similar unstructured
records are summarized as plain text.

### Requested repositories

| Repository | Languages and syntaxes found |
| --- | --- |
| `labs` | TypeScript, TSX, JavaScript, JSX, MJS, Markdown, JSON, JSONC, YAML, shell, HTML, CSS, TLA+, TLC configuration, TOML, C, SVG and XML, Dockerfiles, dotenv, ignore files, web-manifest JSON, TLDraw JSON, Deno lock JSON, SQL in recent history, and plain text |
| `loom` | Python, TypeScript, TSX, JavaScript, MJS, shell, Markdown, HTML, CSS, JSON, JSON Lines, YAML, TOML, INI, Swift, Apple property-list XML, web-manifest JSON, TSV, dotenv examples, launchable `.command` shell, Git hooks, and plain text |
| `infra` | OpenTofu and HCL, Terraform variables, YAML, Ansible YAML, Jinja templates whose hosts include shell and systemd units, Terraform shell templates, shell, Makefiles, Dockerfiles, INI inventories, Ansible configuration, dotenv, JSON, TOML, JavaScript, Netdata configuration, systemd units, ignore files, and plain text |

### Other active repositories

| Repository | Languages and syntaxes found |
| --- | --- |
| `.github` | Markdown and plain text |
| `adjacency-map` | TypeScript, JavaScript, MJS, HTML, JSON, Markdown, and plain text |
| `auth-broker` | TypeScript, shell, JSON, Markdown, dotenv examples, and plain text |
| `bay` | Go, shell, YAML, Go module and checksum files, VS Code workspace JSONC, and plain text |
| `common-cluster` | Go, TLA+, TLC configuration, YAML, shell, Makefile, Dockerfile variants, Go module and checksum files, and plain text |
| `common-tools-website` | HTML, CSS, JavaScript, SVG and XML, and plain text |
| `danfuzz-land` | Python, TypeScript, shell, Markdown, JSON, ignore files, and plain text |
| `fabric-browser-extension` | JavaScript, MJS, HTML, JSON, Markdown, and plain text |
| `fabric-city-3000` | TypeScript, HTML, JSON, Markdown, and plain text |
| `fabric-mobile` | Swift, Rust, Python, TypeScript, JavaScript, HTML, CSS, JSON, NDJSON, TOML, Cargo lock format, Apple property-list XML, Markdown, and plain text |
| `gvisor` | Go; Starlark and Bazel; C, C++, headers, and CUDA; assembly and linker scripts; shell; Swift; Ruby, Rack, ERB, and Bundler lock format; Python; Dockerfile variants; HTML; SCSS; JavaScript; Rust; Protocol Buffers and protobuf text format; SQL; Handlebars; Graphviz DOT; Packetdrill; YAML; JSON; TOML; CSV; Org mode; XML entitlements and SVG; patch files; Makefiles; INI-like and application-specific configuration; Go, Swift, and Ruby lock or manifest formats; and plain text |
| `legibility` | Python, shell, Makefile, YAML, JSON Lines, TOML, systemd units, tmpfiles configuration, Markdown, and plain text |
| `loom-scripts` | Python, TypeScript, Go, shell, Swift, Makefile, JSON, YAML, dotenv-style examples, Markdown, and plain text |
| `obsidian-loom` | TypeScript, JavaScript, MJS, shell, JSON, Markdown, and plain text |
| `pattern-factory` | TSX, shell, JSON, Markdown, dotenv examples, and plain text |
| `pond` | TypeScript, HTML, CSS, JSON, Markdown, and plain text |
| `promptinjection-wtf` | HTML, Markdown, and plain text |
| `raia` | Go, Python, JSON, JSON Lines, unified patches, logs, Markdown, extensionless task records, and plain text |
| `resonant-computing-org` | Python, shell, HTML, CSV, Markdown, and plain text |
| `run-orchestrator` | Go, shell and extensionless Git hooks, JSON, JSON Lines, YAML, Go module and checksum files, Markdown, and plain text |
| `specs` | Markdown, HTML, Lean, JSON, JSON Lines, CSS, Python, TeX, BibTeX, shell, TOML, tabular `.dat` data, SVG and XML, and plain text |

## Cross-cutting filename and composite-syntax cases

Extension-only matching cannot cover the surveyed repositories:

- Extensionless programs use Python, Bash, POSIX shell, Ruby, Node, or Deno
  shebangs.
- `Makefile`, `Dockerfile`, `BUILD`, `Gemfile`, Git hooks, and executable
  command names carry their language in an exact filename or content.
- `Dockerfile.dashboard`, `Dockerfile.x86_64`, and similar names carry their
  language in a filename prefix rather than the final suffix.
- `.tfvars.example`, `config.json.example`, and similar sample files need
  compound-extension peeling.
- Jinja files have several host languages. The surveyed `.j2` files contain
  shell, systemd-unit, authorized-keys, and YAML syntax.
- Terraform `.tftpl` files contain shell plus Terraform interpolation.
- HTML contains embedded CSS and JavaScript. ERB and Handlebars also contain a
  host language.
- `.cfg` means TLC configuration in Labs and Common Cluster, JSON in gVisor,
  and INI in Infra.
- `.lock` means JSON for Deno, TOML for Cargo, Bundler's lock format for Ruby,
  and an application-specific lock record in Specs.
- `.webmanifest`, `.tldr`, the gVisor syzkaller `.cfg`, and Swift
  `Package.resolved` are JSON-shaped despite their suffixes.
- `.plist` and `.entitlements` are XML.
- `.service` is a systemd unit. Some `.conf` files contain YAML, while others
  use application-specific directive syntax.
- `go.mod`, `go.sum`, `.gitattributes`, `.gitmodules`, `.worktreeinclude`,
  `.bazelrc`, `.bazelversion`, and `lean-toolchain` each have stable
  special-name syntax.
- Jupyter notebooks appeared in recent Labs history. Their `.ipynb` container
  is JSON with embedded language cells even though none remained in the active
  tree at the audited commit.

## Binary and non-source assets

The repositories also contained PNG, JPEG, GIF, ICO, WebM, TTF, WOFF, WOFF2,
PDF, SQLite database and write-ahead-log files, gzip, tar, Zstandard, and JAR
artifacts. These are not syntax-highlighting targets. They still need honest
binary recognition so that `cf view` does not present them as TypeScript.

## Raw tracked-file token inventory

An `@` token denotes an exact suffixless basename. The repository column is
the number of active repositories containing the token. Compound names and
ambiguous suffixes still require the inspection described above.

| Raw token | Blobs | Repositories |
| --- | ---: | ---: |
| `.md` | 5,809 | 23 |
| `.ts` | 3,906 | 11 |
| `.go` | 2,568 | 6 |
| `.py` | 2,017 | 9 |
| `.html` | 1,321 | 12 |
| `.tsx` | 1,007 | 3 |
| `.png` | 748 | 12 |
| `.json` | 656 | 17 |
| `@build` | 502 | 1 |
| `.jsx` | 360 | 1 |
| `.cc` | 353 | 1 |
| `.lean` | 310 | 1 |
| `.sh` | 268 | 14 |
| `.yaml` | 121 | 8 |
| `.yml` | 93 | 8 |
| `.h` | 85 | 1 |
| `.tf` | 80 | 1 |
| `.gitignore` | 71 | 23 |
| `.patch` | 65 | 2 |
| `.s` | 65 | 1 |
| `.svg` | 56 | 5 |
| `@dockerfile` | 55 | 3 |
| `.css` | 54 | 6 |
| `.js` | 47 | 9 |
| `.jsonc` | 43 | 1 |
| `.jsonl` | 37 | 5 |
| `.example` | 35 | 5 |
| `.bzl` | 33 | 1 |
| `.txt` | 32 | 6 |
| `.gitkeep` | 31 | 5 |
| `@license` | 26 | 23 |
| `.cfg` | 25 | 4 |
| `.mjs` | 25 | 5 |
| `.woff` | 25 | 1 |
| `.woff2` | 25 | 1 |
| `.c` | 23 | 2 |
| `.j2` | 22 | 1 |
| `.x86_64` | 22 | 1 |
| `.proto` | 21 | 1 |
| `.csv` | 20 | 2 |
| `.swift` | 19 | 4 |
| `.tfvars` | 16 | 1 |
| `.toml` | 14 | 7 |
| `@makefile` | 12 | 5 |
| `.rs` | 11 | 2 |
| `.dat` | 10 | 1 |
| `.gif` | 9 | 1 |
| `.jpg` | 9 | 3 |
| `.conf` | 8 | 3 |
| `.gz` | 8 | 1 |
| `.pkt` | 8 | 1 |
| `.rb` | 7 | 1 |
| `.scss` | 7 | 1 |
| `.ini` | 6 | 2 |
| `.lock` | 6 | 6 |
| `.env` | 5 | 1 |
| `.log` | 5 | 2 |
| `.mod` | 5 | 5 |
| `.sum` | 5 | 5 |
| `.tla` | 5 | 2 |
| `@cname` | 5 | 4 |
| `.cu` | 4 | 1 |
| `.pdf` | 3 | 2 |
| `.plist` | 3 | 2 |
| `.service` | 3 | 1 |
| `.webmanifest` | 3 | 2 |
| `@post-merge` | 3 | 2 |
| `.aarch64` | 2 | 1 |
| `.dockerignore` | 2 | 2 |
| `.gitattributes` | 2 | 2 |
| `.ico` | 2 | 2 |
| `.key` | 2 | 2 |
| `.lds` | 2 | 1 |
| `.mk` | 2 | 1 |
| `.org` | 2 | 1 |
| `.tex` | 2 | 1 |
| `.tftpl` | 2 | 1 |
| `.ttf` | 2 | 1 |
| `.worktreeinclude` | 2 | 2 |
| `@agent-browser` | 2 | 1 |
| `@cf` | 2 | 1 |
| `@cf-review` | 2 | 1 |
| `@deno-memory-profiler` | 2 | 1 |
| `@figma-to-code` | 2 | 1 |
| `@fuse-agent` | 2 | 1 |
| `@fuse-workflow` | 2 | 1 |
| `@isolated-test-processes` | 2 | 1 |
| `@knowledge-base` | 2 | 1 |
| `@lean-toolchain` | 2 | 1 |
| `@lit-component` | 2 | 1 |
| `@loom` | 2 | 1 |
| `@loom-acceptance` | 2 | 1 |
| `@loom-fuse` | 2 | 1 |
| `@loom-install` | 2 | 1 |
| `@loom-review` | 2 | 1 |
| `@pattern-critic` | 2 | 1 |
| `@pattern-debug` | 2 | 1 |
| `@pattern-deploy` | 2 | 1 |
| `@pattern-dev` | 2 | 1 |
| `@pattern-implement` | 2 | 1 |
| `@pattern-schema` | 2 | 1 |
| `@pattern-test` | 2 | 1 |
| `@pattern-test-to-integration` | 2 | 1 |
| `@pattern-ui` | 2 | 1 |
| `@pre-commit` | 2 | 2 |
| `@sha256sums` | 2 | 1 |
| `@state-inspector` | 2 | 1 |
| `@task-management` | 2 | 1 |
| `@topics` | 2 | 1 |
| `._js` | 1 | 1 |
| `.activity` | 1 | 1 |
| `.bazel` | 1 | 1 |
| `.bazelignore` | 1 | 1 |
| `.bazelrc` | 1 | 1 |
| `.bazelversion` | 1 | 1 |
| `.bib` | 1 | 1 |
| `.build` | 1 | 1 |
| `.code-workspace` | 1 | 1 |
| `.codespellrc` | 1 | 1 |
| `.command` | 1 | 1 |
| `.dashboard` | 1 | 1 |
| `.db` | 1 | 1 |
| `.db-shm` | 1 | 1 |
| `.db-wal` | 1 | 1 |
| `.denoignore` | 1 | 1 |
| `.dot` | 1 | 1 |
| `.entitlements` | 1 | 1 |
| `.erb` | 1 | 1 |
| `.gitmodules` | 1 | 1 |
| `.hbs` | 1 | 1 |
| `.in` | 1 | 1 |
| `.jar` | 1 | 1 |
| `.k8s-sandbox-service` | 1 | 1 |
| `.kitchen-sink` | 1 | 1 |
| `.llama-2-7b-chat-hf` | 1 | 1 |
| `.ndjson` | 1 | 1 |
| `.nvmrc` | 1 | 1 |
| `.pid` | 1 | 1 |
| `.port` | 1 | 1 |
| `.resolved` | 1 | 1 |
| `.ru` | 1 | 1 |
| `.runtime` | 1 | 1 |
| `.sandbox-kitchensink` | 1 | 1 |
| `.sandbox-rootfs` | 1 | 1 |
| `.sandbox-service` | 1 | 1 |
| `.sql` | 1 | 1 |
| `.sse-fix-extproc` | 1 | 1 |
| `.tar` | 1 | 1 |
| `.test` | 1 | 1 |
| `.textproto` | 1 | 1 |
| `.tldr` | 1 | 1 |
| `.toolshed` | 1 | 1 |
| `.toolshed-router-extproc` | 1 | 1 |
| `.tsv` | 1 | 1 |
| `.webm` | 1 | 1 |
| `.zst` | 1 | 1 |
| `@accept_blob` | 1 | 1 |
| `@airtable` | 1 | 1 |
| `@attention` | 1 | 1 |
| `@authors` | 1 | 1 |
| `@bay_261_sticky_ids` | 1 | 1 |
| `@bay_322_antigravity` | 1 | 1 |
| `@bay_home_palette` | 1 | 1 |
| `@bazelversion` | 1 | 1 |
| `@cf-sandbox` | 1 | 1 |
| `@client-0001` | 1 | 1 |
| `@deno_version` | 1 | 1 |
| `@description` | 1 | 1 |
| `@fabric-local` | 1 | 1 |
| `@gemfile` | 1 | 1 |
| `@generate_image` | 1 | 1 |
| `@init` | 1 | 1 |
| `@istio_blob` | 1 | 1 |
| `@legacy-ops-cleanup` | 1 | 1 |
| `@libhook` | 1 | 1 |
| `@loom-diagnose` | 1 | 1 |
| `@loom-dispatcher` | 1 | 1 |
| `@loom-wish` | 1 | 1 |
| `@people-canonical` | 1 | 1 |
| `@places-geocode` | 1 | 1 |
| `@post-checkout` | 1 | 1 |
| `@post-command` | 1 | 1 |
| `@post-merge-dispatcher` | 1 | 1 |
| `@pre-command` | 1 | 1 |
| `@pre-push` | 1 | 1 |
| `@prepare-commit-msg` | 1 | 1 |
| `@setup_version` | 1 | 1 |
| `@version` | 1 | 1 |
