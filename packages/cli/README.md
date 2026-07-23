# @commonfabric/cli

## Piece data search

`cf piece search <query>` reads every piece in the selected space and returns
the pieces whose input or result data contains the query. Matching uses full
Unicode case folding and canonical normalization over nested object keys and
scalar values. Canonically equivalent text matches, and a match cannot stop
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
  `piece get` prints plain JSON, except an absent value prints the literal
  `undefined` — which is not valid JSON, so test for it before parsing. It is
  `undefined` rather than `null` on purpose: loom's fresh-space readback gate
  tolerates `undefined` as a transient, and `null` would hard-fail its deploy
  gate (see the `-q` note below and the PR compatibility rationale).
- ANSI colors are emitted only when stdout is a TTY. `--no-color` or
  `NO_COLOR=1` disables them everywhere (including Cliffy help/usage output);
  `FORCE_COLOR=1`/`CLICOLOR_FORCE=1` forces them when piped. The policy is
  applied in `lib/color-mode.ts`; the `@std/fmt/colors` import-map pin in
  `deno.jsonc` must track Cliffy's own `@std/fmt` dependency range (guarded by
  `test/color-mode.test.ts`).
- `-q/--quiet` (on `piece`/`wish` subcommands) suppresses the stderr hint and
  next-step blocks. It deliberately does NOT change the log floor: consumers
  parse `--quiet` runs' stderr for runtime warnings (Loom's stale-root heal
  greps for `load-pattern-by-identity-source-miss`). Use `--log-level error` to
  drop warnings; the two compose.
- `piece call` accepts its payload as an inline JSON argument, `-` for stdin, an
  implicit pipe (no payload argument), or schema-derived flags after `--`.
- A `piece get` path that doesn't resolve prints a one-line error on stderr and
  exits 1 — it is a data error, not a usage error.
- The launcher spawns the child CLI with `deno run --quiet` so Deno's own
  warnings (npm "Ignored build scripts" banner) never reach users.

## Built Binary

`deno task build-binaries --cli-only` compiles the CLI to `dist/cf` — fully
cwd-independent with no Deno startup noise, the recommended entry point for
agents and scripts. Rebuild after every `git pull`: a stale binary rejects newer
flags and can hit wire-protocol skew against an updated server.

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
