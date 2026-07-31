# @commonfabric/cli

## View pager

`cf view [file]` is an interactive pager for transformed TypeScript, source
files, and unified diffs. Named Markdown, JSON, JSONC, YAML, and Python files
use their own syntax highlighting. Transformed compiler output piped without a
filename keeps TypeScript highlighting when its module header identifies it.
Python interpreter shebangs select Python for otherwise unrecognized names.
Node, Deno, and Bun shebangs select the TypeScript and JavaScript language
family. Other filename-free source and named files with unrecognized syntax are
shown as plain text. For piped source, `--filename` selects syntax as though the
input had that name. `--language` selects a language by its stable identifier or
alias. Both options keep the pipe read-only and suppress unified-diff
auto-detection. An explicit language takes priority when both options are
present. Use `--diff` instead when the pipe is a unified diff.

Automatic container detection is limited to structurally identified raw unified
diffs and standard Git commit output. A raw diff starts at the first nonblank
line. Recognized shebangs and transformed compiler headers remain explicit
selectors. JSON-, YAML-, Markdown-, Python-, and other language-shaped source is
not guessed from its syntax.

Markdown files can switch between the source and a rendered terminal view with
`V`. The rendered view formats headings, emphasis, links, quotes, lists, task
markers, tables, rules, and code. The same view is available for Markdown files
inside a unified diff; diff markers, addition and deletion tints, line
positions, and hunk expansion remain in place.

Press `\` in the interactive pager to cycle through unwrapped lines, hard
wrapping, and word wrapping. Hard wrapping fills every screen row before it
continues. Word wrapping breaks at whitespace and repeats the line's leading
punctuation and whitespace on each continuation row.

Redirected output keeps the source text verbatim by default and adds ANSI color
only when the selected color mode permits it. Pass `--rendered` to start in, or
print, the rendered representation when one is available. Editing from a
rendered view returns to source first.

```bash
cf check pattern.tsx --show-transformed --no-run | cf view
cf view .github/workflows/deno.yml
cf view scripts/analyse.py
git diff upstream/main | cf view
cf view --rendered README.md
generate-source | cf view --filename generated.py
generate-markdown | cf view --language markdown --rendered
```

## Piece discovery

`cf piece ls` lists the pieces in the selected space's piece registry. It reads
the default pattern and starts each registered piece to obtain its name and
pattern metadata. It does not enumerate every stored piece root.

`cf piece search` also starts from the registry. It searches readable input and
result data, but returns registered pieces only. `cf piece map` likewise shows
connections among registered pieces rather than walking the complete stored
graph.

A piece outside the registry can be found only through a searchable collection
that deliberately publishes it, by following links from a known piece, or by
using an exact piece address, including its scope, that is already known. A
piece with none of those paths is an orphan and cannot be discovered through the
piece commands. See
[Finding Pieces](../../docs/common/concepts/piece-discovery.md) for the complete
boundary.

## Piece data search

`cf piece search <query>` reads every registered piece in the selected space and
returns the pieces whose input or result data contains the query. Matching uses
full Unicode case folding and canonical normalization over nested object keys
and scalar values. Canonically equivalent text matches, and a match cannot stop
partway through one character's multi-letter fold. Readable nested cell values
are included when they belong to the piece being searched. A cell owned by
another piece is searched only with that owner, not with every piece that links
to it. Data owned by a piece absent from the piece registry is not attributed to
its referrers. A cell with no piece ownership metadata remains searchable
through each piece that links to it. Opaque, write-only, comparable, stream, and
SQLite cell handles are not read. Piece IDs, names, and pattern metadata are
returned for context, but they do not count as searchable data.

```bash
cf piece search --space team-space "invoice 1042"
cf piece search --space team-space --json invoice
```

The command accepts the same identity, API URL, space, and combined URL options
as `cf piece ls`. Human-readable output uses the same columns as `piece ls`.
`--json` returns an array for scripts, including an empty array when no piece
matches. If part of a piece cannot be read, the command reports a warning on
standard error and continues searching that piece and the rest of the space.

## Output Conventions

- stdout carries command output only; hints and diagnostics go to stderr.
  `piece get` prints JSON and represents an absent value as `null`.
- ANSI colors are emitted only when stdout is a TTY. `--no-color` or
  `NO_COLOR=1` disables them everywhere (including Cliffy help/usage output);
  `FORCE_COLOR=1`/`CLICOLOR_FORCE=1` forces them when piped. The policy is
  applied in `lib/color-mode.ts` and guarded by `test/color-mode.test.ts`. The
  [Cliffy dependency guidance](../../docs/development/DEPENDENCIES.md#cliffy)
  owns the import-map constraint that keeps this behavior working.
- `-q/--quiet` (on `piece`/`wish` subcommands) suppresses the stderr hint and
  next-step blocks. It deliberately does NOT change the log floor: consumers
  parse `--quiet` runs' stderr for runtime warnings (Loom's stale-root heal
  greps for `load-pattern-by-identity-source-miss`). Use `--log-level error` to
  drop warnings; the two compose.
- `piece call` accepts its payload as an inline JSON argument, `-` for stdin, an
  implicit pipe (no payload argument), or schema-derived flags after `--`.
- A `piece get` path that doesn't resolve prints a one-line error on stderr and
  exits 1 — it is a data error, not a usage error. A `piece link` that fails
  validation (a source/target piece or path that doesn't exist) reports the same
  way.
- The launcher spawns the child CLI with `deno run --quiet` so Deno's own
  warnings (npm "Ignored build scripts" banner) never reach users.

### Transforming `piece get` output

`piece get` can filter an array before it reaches stdout and project the result
to a smaller shape:

```bash
cf piece get --piece ID items --filter '.status == "open"'
cf piece get --piece ID items \
  --filter '.status == "open" and .score >= 10' \
  --schema id,title,author.name
```

`--filter` is jq-inspired rather than a full jq interpreter. It applies only to
arrays and accepts value paths (`.status`, `.author.name`, `.["display-name"]`,
`.tags[-1]`), JSON literals, `==`, `!=`, `<`, `<=`, `>`, `>=`, `and`, `or`,
`not`, and parentheses. Like jq, only `false` and `null` are falsey, so a
missing path simply does not match. A stored `undefined` is treated like a
missing value and is also falsey. Filtering happens before schema projection.

`--schema` accepts one of three forms:

- a comma-separated field projection such as `id,title,author.name`;
- an inline JSON Schema object;
- `@path/to/schema.json`.

For an array result, the concise form describes each item. An inline/file JSON
Schema describes the complete returned value, so a schema combined with
`--filter` must have an array root. Object `properties` are a whitelist by
default; use `"additionalProperties": true` to retain unspecified properties.
Projection schemas support structural `properties`, `items`, and scalar leaf
schemas. In an array-item projection, a scalar leaf whose declared type does not
match the stored value is omitted by the runtime rather than reported as an
error; prefer `true` leaves unless that type filtering is intentional. Schema
combinators and references are rejected.

Both transforms run as a short-lived computed pattern in the caller's session.
The runtime's list filter/map builtins therefore handle CFC exactly as authored
pattern expressions do: predicate observations label array membership,
projection reads propagate labels, and filtered elements retain their source
links. The source cell's schema remains authoritative for Common Fabric
metadata. A caller cannot introduce or override `ifc`, `asCell`, `scope`, or
`default` through `--schema`.

## Built Binary

`deno task build-binaries cf` compiles the CLI to `dist/cf` — fully
cwd-independent, with no Deno startup noise and roughly half the per-invocation
cost. (`--cli-only` is a legacy alias for the same thing.)

It exists for CI, which downloads it in `cli-integration-test` (on
`$GITHUB_PATH`) and `pattern-unit-test` (as `CF_BINARY`). A CI run never edits
the source the binary was built from, so it cannot go stale mid-run.

That does not hold for a working tree you are editing, and there is no
invalidation story to catch it — see "Why not `dist/cf`" under Installing `cf`
on PATH. Use `bin/cf` or `deno task cf` locally. If you do build it, rebuild
after every `git pull`: a stale binary rejects newer flags and can hit
wire-protocol skew against an updated server.

## Launcher Contract

`packages/cli/launcher.ts` is the stable Deno launcher for consumers that need
to run the Common Fabric CLI from another repo or from a sandbox. It keeps the
selected Labs checkout as the source of truth while making the child CLI process
use an explicit Deno config/import map.

The launcher itself intentionally uses only Deno built-ins so callers can invoke
it before the Labs import map is active.

Launcher options are parsed before the first non-launcher argument or `--`. Use
`--` when a `cf` argument has the same name as a launcher option:

```bash
deno task cf -- --config piece-config.json
```

Launcher `--config` is the child Deno config/import map used to start the CLI.
It is not a `cf` command or pattern config.

The child CLI working directory defaults to `INIT_CWD` when present, otherwise
the launcher's current directory. This preserves `deno task cf` behavior from a
caller directory. Direct sandbox or wrapper callers should pass `--cwd` when
they need to ignore a stale inherited `INIT_CWD`.

The child CLI process inherits the parent environment. The launcher only adds
`CF_CLI_NAME=cf`, so caller-provided `CF_API_URL`, `CF_IDENTITY`, experimental
flags, and CFC/sandbox-related environment variables continue to flow through.

From the Labs checkout:

```bash
deno task cf --help
deno task cf check packages/cli/fixtures/pattern.tsx --no-run
```

From a sibling consumer such as Pattern Factory:

```bash
deno run --allow-run --allow-env --allow-read ../labs/packages/cli/launcher.ts \
  -- check workspace/<run-id>/pattern/main.tsx --no-run
```

From a vendored consumer such as Loom:

```bash
deno run --allow-run --allow-env --allow-read vendor/labs/packages/cli/launcher.ts \
  --labs-root vendor/labs \
  --config deno.jsonc \
  -- check .ops/patterns/example.tsx --no-run
```

Use `--launcher-help` for launcher-specific help. Normal CLI flags such as
`--help` are passed through to `cf`.

## JSON command contract

An invocation that contains `--json` reserves stdout for JSON. Status text and
errors go to stderr. If a command does not support `--json`, it rejects the
option without printing command help to stdout. Static `--help` and `--json`
cannot be combined. Callable schema help is the exception because it is JSON:
use `cf exec <mounted-file> --help --json` or
`cf piece call ... <callable> --help --json`.

The supported output switches are:

- `cf space ... --json` serializes the clone manifest, verify result, or
  fingerprint. `cf space verify` and `cf space reset` exit nonzero when the
  clone does not match its baseline, so a rehearsal script can gate on them; the
  printed report, not usage help, is the output in that case. The procedure
  these commands serve is `docs/development/space-clone-rehearsal.md`.
- `cf inspect ... --json` serializes an inspector result. `inspect html` does
  not have a JSON representation, so `html` and `--json` are mutually exclusive.
  `inspect graph --dot` and `--json` are also mutually exclusive.
- `cf piece ls`, `piece search`, `piece inspect`, `piece view`, and
  `piece render` use `--json` as an output switch. `piece render --watch --json`
  writes only JSON render records to stdout; watch status goes to stderr.
  Rendering a piece without a UI fails instead of returning an empty successful
  JSON stream.
- `cf piece get` and `cf wish` always return JSON. Their `--json` options are
  accepted, documented no-ops for callers that select JSON explicitly.
- `cf check --json` compiles without evaluating and prints one object with a
  `files` array. Each entry has the input `path` and the compiled module bodies
  in `output`.

`cf check --json`, `--show-transformed`, and `--pattern-json` are three mutually
exclusive stdout modes. The command buffers all three modes until every input
succeeds. A failure therefore leaves stdout empty instead of mixing successful
output with later errors.

For `cf exec`, `--json` belongs after the mounted callable path. For
`cf piece call`, it belongs after the callable name. In both commands, it
selects complete JSON input:

```bash
cf exec /tmp/cf/home/pieces/notes/result/search.tool --json '{"query":"milk"}'
printf '%s' '{"query":"milk"}' |
  cf exec /tmp/cf/home/pieces/notes/result/search.tool --json

cf piece call ... search --json '{"query":"milk"}'
printf '%s' '{"query":"milk"}' | cf piece call ... search --json
```

Bare `--json` reads stdin. An inline value immediately after it is parsed as the
complete input. `piece call` also accepts a single positional JSON value. Put
schema-derived piece-call flags after `--`, for example
`cf piece call ... search -- --query milk`. Use `-- --json-file <path>` for a
piece-call JSON file. These rules keep the options before the callable name for
`piece call` itself and the arguments after the name for the invoked callable.

## Command visibility

Every registered top-level command appears in `cf --help`. The direct
`fuse-daemon` and `fuse-supervisor` entry points are visible because packaged
launchers use them. Shell completion is the exception: it drops commands whose
description opens with `Internal:`, because those are spawned by `cf fuse` and
never typed at a prompt.

## Installing `cf` on PATH

Interactively, the CLI has always been invoked as `deno task cf`. Shell
completion is the first thing that needs a `cf` on PATH on a developer machine:
the function it installs calls `cf completion complete` by name on every Tab, so
**completion does nothing at all without one** — including for
`deno task cf <TAB>`, which the same function services. Because a failing
completion is swallowed by design (it must never paste text into the command
line), a missing `cf` shows up as "completion doesn't work", not as an error.
`cf completion bash|zsh` therefore warns on stderr when it cannot find itself on
PATH.

(CI does resolve `cf` by name — `integration/integration.sh` runs `command cf`
against a binary the workflow puts on `$GITHUB_PATH` — but it builds that PATH
itself, and local runs of those same scripts set `CF_CLI_INTEGRATION_USE_LOCAL`
to force the source CLI.)

`bin/cf` is the install. It runs from source, so it never goes stale against the
checkout:

```bash
# mise users: nothing to do. mise.toml puts this checkout's bin/ on PATH.
mise trust    # only if this checkout has not been trusted yet

# everyone else (mise is recommended in README.md but not required):
deno task install-cf              # --dry-run to see what it would do
```

`install-cf` copies `bin/cf` to a directory already on your PATH — refusing to
guess if there isn't one, since installing somewhere unreachable would reproduce
the silent failure this exists to prevent. A copy rather than a link, because
the lookup below travels with the script: no particular checkout has to survive
for the install to keep working. Re-run it to upgrade. It never edits your shell
rc; it prints the completion line for you to add.

It copies **this** checkout's `bin/cf` — the one whose task you invoked, which
may carry changes not yet on `main` — while baking the **primary** checkout in
as the outside-a-checkout default, so removing the worktree you installed from
does not strand it.

### Which checkout runs

Several checkouts coexisting is normal — worktrees, and a vendored labs inside
another repo (a supported, tested layout: see `test/launcher.test.ts`). So the
symlink above does **not** pin `cf` to the checkout you installed it from. It
selects, in order:

1. **`$CF_LABS_ROOT`**, when set — the explicit override for when your cwd
   cannot say what you mean, such as working on a pattern under `/tmp`. A value
   that is not a checkout is an error, not a quiet fall-through. It chooses
   which CLI runs; it does not change your working directory.
2. **The nearest checkout walking up from `$PWD`.** A directory is tested as a
   checkout before it is tested as a host vendoring one at `vendor/labs`, so
   standing inside `<host>/vendor/labs` selects that labs rather than
   re-deriving it from the host.
3. **A default fixed at install time**, then **the checkout the script itself
   lives in** — for when you are not standing in one at all. An installed copy
   carries the default (`install-cf` points it at the primary checkout, since
   worktrees are removed routinely); the in-repo file and any symlink to it fall
   through to their own checkout. Both are ignored unless they are still real
   checkouts, so a stale default cannot silently send you somewhere that no
   longer exists. With none of them usable, `cf` says so and exits 2 rather than
   guessing.

`cf which` answers "which one would run?" — it prints the CLI path on stdout and
the reason on stderr, and is handled by the wrapper rather than forwarded, since
asking the CLI which CLI would run begs the question:

```bash
$ cf which
/path/to/checkout                                  # stdout
cf: entry /path/to/checkout/packages/cli/mod.ts    # stderr
cf: selected by nearest checkout above the current directory

$ cf which 2>/dev/null    # just the checkout, for scripts
```

stdout is the checkout because that is the part that varies; the entry inside it
is always `packages/cli/mod.ts`, which _is_ the CLI (it ends in
`if (import.meta.main)` and nothing outside `packages/cli/` imports it as a
library).

Rule 2 is what mise already does for its route (`_.path` resolves relative to
the `mise.toml` declaring it), so both install routes agree on which checkout
you get. The consequence worth knowing: `cf` inside checkout B runs B's code
even though you installed the link from A. That is the point, but it means a
stack trace is the quickest way to confirm which checkout answered.

### Why not `dist/cf`

The compiled binary is roughly twice as fast per invocation (~0.33s versus
~0.6s), which is tempting when every Tab press is a full CLI invocation. **Do
not put `dist` on your PATH anyway.** There is no invalidation story for it:
`tasks/build-binaries.ts` has no up-to-date check, nothing compares the binary
against its sources, and the whole mechanism is the "rebuild after every
`git pull`" instruction in the Built Binary section above. A stale `dist/cf`
rejects newer flags and can hit wire-protocol skew against an updated server —
see "FUSE mount wrapper mismatch" in `skills/cf/SKILL.md` for an instance of
this actually biting.

Nor is mtime a usable substitute: `revertWorkspace` restores `deno.jsonc` and
the compile-cache version module _after_ the binary is written, so `dist/cf` is
older than its own inputs the moment the build finishes.

CI is a different case and legitimately uses the binary — a workflow run never
mutates the source it was built from. `cli-integration-test` puts it on
`$GITHUB_PATH` and `pattern-unit-test` passes it as `CF_BINARY`. That reasoning
does not transfer to a working tree you are actively editing.

## Shell completion

`cf completion <shell>` prints a completion script for bash or zsh. It requires
`cf` on PATH — see "Installing `cf` on PATH" above.

```bash
# zsh — eager form, in ~/.zshrc after compinit. Required for the `deno` binding
# described below; the fpath form does not activate it until `cf` completes once.
source <(cf completion zsh)

# zsh — fpath form. Completes `cf` itself; add the two lines under
# "deno task cf" below if you also want `deno task cf` to complete.
cf completion zsh > "${fpath[1]}/_cf"
autoload -U compinit && compinit

# bash
cf completion bash > /usr/local/etc/bash_completion.d/cf
# or, for the current shell only:
source <(cf completion bash)
```

Completion covers the command tree — subcommands, flags, and enumerated values
such as `--log-level` — plus live values read from the fabric:

| Slot                            | Completes to                                |
| ------------------------------- | ------------------------------------------- |
| `--piece`                       | piece ids, annotated with each piece's name |
| `piece call <callable>`         | the piece's callables, as `cf piece verbs`  |
| `piece get`/`set <path>`        | cell keys, one path segment at a time       |
| `piece link <source>/<target>`  | `pieceId/path/to/field` endpoints           |
| `--space`                       | space DIDs of local memory-v2 stores        |
| `--identity`, pattern arguments | `*.key` / `*.tsx` files, via the shell      |

Live values need an identity and an api-url. Both are read from the line being
typed (`-i`, `-a`, `-u`) before falling back to `CF_IDENTITY`/`CF_API_URL`, so
`cf piece call -s other-space --piece <TAB>` lists that space's pieces rather
than the environment's. When neither is resolvable, or the server is
unreachable, completion yields nothing — it never prints an error into the
command line. Each request costs one CLI invocation plus one round trip, so
value completion is as fast as the fabric it queries.

### `deno task cf` and other invocations

The scripts bind `deno` as well as `cf`, so `deno task cf piece <TAB>` completes
the same way the binary does; `deno run … packages/cli/mod.ts` and the
`launcher.ts` form (including arguments after `--`) are recognized too. The
binding is cooperative: a `deno` line that is not a CLI invocation is handed
back to whatever completed `deno` beforehand, so `deno test` and
`deno task build-binaries` keep their own completions. Pass `--no-deno-task` to
bind only `cf`.

The binding is installed by the script body, so it needs the script to be
_evaluated_, not merely autoloadable. bash's `bash_completion.d` and zsh's
`source <(…)` both do that. zsh's fpath form does not: `_cf` is autoloaded on
the first `cf` completion, so until then `deno task cf <TAB>` does nothing. To
keep the fpath install and still bind `deno`, add this after `compinit`:

```zsh
_cf_deno_previous="${_comps[deno]:-}"   # preserve deno's own completion
compdef _cf deno
```

Capturing eagerly matters: `_cf` records the previous completer when it loads,
and by then `_comps[deno]` is already `_cf`. It refuses to chain to itself
(which would recurse and hang the terminal) and keeps any value recorded
earlier, so the line above survives.

### Implementation

Cliffy ships a `CompletionsCommand`, but its dynamic hook passes the callback
only `(command, parent)` — no cursor word and no access to the options already
typed — so it cannot answer "the callables of the piece named by the `--piece`
on this line". `lib/completion/` therefore emits its own scripts, which are
deliberately thin: they forward the raw command line and let
`cf completion complete` decide everything. A sourced completion function lives
in a user's shell profile and is not updated when the CLI is rebuilt, so it must
not encode a command tree that can go stale.

Resolution walks Cliffy's live `Command` tree rather than a hand-maintained
table, so a newly registered subcommand or flag completes as soon as it exists.
Two facts cannot be read off that tree and are carried explicitly in
`lib/completion/`: the pre-parse globals `--log-level` and `--no-color` (both
stripped from `argv` before Cliffy parses, in `lib/log-level.ts` and
`lib/color-mode.ts`), and the provider table binding slots to live data.
