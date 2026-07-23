---
status: historical
created: 2026-07-22
archived: 2026-07-22
reason: "Audit snapshot of how every cf command handles --json."
---

# `cf --json` behavior audit

This report describes the command tree at commit `93f97e568`. It covers every
visible command and every hidden command registered by the `cf` entry point.

`cf` has no root-level `--json` option. Most commands reject the option. The
accepted uses fall into three categories:

- `cf inspect` and four `cf piece` read commands use it as a machine-readable
  output switch.
- `cf exec` and `cf piece call` use it mainly to select JSON input for a
  callable or to request JSON schema help. Their output format does not change.
- Some paths accept the option but ignore it or let another output option take
  precedence. These paths are called out below.

Unsupported means that Cliffy prints the command help, reports `Unknown option
"--json"`, and exits with status 2. Successful JSON output is indented with two
spaces. Thrown validation and runtime errors remain plain text on stderr even
when a command accepts `--json`. A command can still serialize a successful
result object that contains an `error` field.

## Top-level command inventory

| Command | Behavior when passed `--json` |
| --- | --- |
| `cf` | Rejects it. There is no global JSON mode. |
| `cf help` | Rejects it. This also applies to help beneath a command group, such as `cf inspect help --json`. |
| `cf acl` | Rejects it. The `ls`, `set`, and `remove` subcommands also reject it. |
| `cf piece` | The group rejects it. Individual subcommands are described below. |
| `cf check` | Rejects it. `--pattern-json` is the separate option that prints the evaluated pattern export. |
| `cf deps` | Rejects it. Its `update` subcommand also rejects it. |
| `cf inspect` | Accepts it as a global option inherited by the inspection subcommands. Passing it to the group without a subcommand still prints ordinary help. |
| `cf view` | Rejects it. |
| `cf exec` | Passes arguments after the mounted callable path to the callable parser. That parser treats `--json` as input or schema-help syntax, as described below. |
| `cf fuse` | Rejects it. The `mount`, `unmount`, and `status` subcommands also reject it. |
| `cf id` | Rejects it. The `new`, `did`, `derive`, and `from-mnemonic` subcommands also reject it. |
| `cf init` | Rejects it. |
| `cf test` | Rejects it. |
| `cf wish` | Rejects it, but successful results are always serialized as JSON. |

## `cf inspect`

`inspect` declares `--json` as a global option. Every data subcommand listed
below accepts it before or after the subcommand name. The generated `help`
subcommand still rejects it. Most data subcommands pass their successful result
to `JSON.stringify(value, null, 2)` instead of running their human renderer.

| Command | Successful output with `--json` |
| --- | --- |
| `cf inspect spaces` | For local stores, an array of `{ did, path, sizeBytes, commits, entities, lastActivity }` rows. For `--remote`, an object containing `remote` and `spaces`. |
| `cf inspect pull` | An object containing `remote`, `cacheDir`, and the `pulled` array. |
| `cf inspect group` | The complete grouping result from `groupDiscoveredSpaces`, including groups and ungrouped spaces. |
| `cf inspect identity` | The complete identity description from `describeIdentity`. |
| `cf inspect summary` | The complete space summary from `summarizeSpace`. |
| `cf inspect scopes` | The scope array from `listScopes`. |
| `cf inspect users` | The participant array from `spaceParticipants`. |
| `cf inspect commits` | The commit array from `listCommits`. |
| `cf inspect hot` | The ranked entity array from `hotEntities`. |
| `cf inspect conflicts` | With an entity, the conflict report from `entityConflicts`. Without an entity, the contested-entity array from `contendedEntities`. |
| `cf inspect entities` | The entity-model array from `listEntityModels`, after applying `--kind` when supplied. |
| `cf inspect piece` | The complete piece description from `describePiece`. `--code` controls whether full pattern source is included. An inspection failure represented as an `{ error: ... }` result is also serialized. |
| `cf inspect graph` | The complete `SpaceGraph` object after `--root` filtering. If `--dot` is also present, DOT text is printed instead and `--json` has no effect. |
| `cf inspect html` | No JSON behavior. The flag is accepted but ignored. The command prints HTML or writes HTML to `--out`. |
| `cf inspect history` | The entity-history array from `entityHistory`. |
| `cf inspect value-at` | With `--as`, the complete result from `valueAsIdentity`. Otherwise, an object with `exists` and an annotated `value`. `--doc` selects the whole document before annotation. |
| `cf inspect overlay` | The complete scope overlay from `scopeOverlay`. |
| `cf inspect diff` | The complete entity diff from `diffEntity`. |
| `cf inspect timeline` | With an entity, the entity-timeline array. Without one, the space-timeline array. |
| `cf inspect converge` | The complete convergence result from `convergence`. |
| `cf inspect converge-scan` | The complete scan result from `convergenceScan`. |

Two accepted combinations do not produce JSON:

- `cf inspect html ... --json` produces HTML.
- `cf inspect graph ... --dot --json` produces Graphviz DOT.

## `cf piece`

The `piece` group does not define a global JSON option. A supported `--json`
must appear after the subcommand that defines it.

| Command | Behavior when passed `--json` |
| --- | --- |
| `cf piece ls` | Emits an array of objects containing `id`, `name`, and `patternRef`. Missing names and pattern references become `null`. The human-only error presentation is not included. An empty space emits `[]` instead of emitting nothing. |
| `cf piece new` | Rejects it. The normal output is a plain piece identifier. |
| `cf piece set-slug` | Rejects it. |
| `cf piece step` | Rejects it. |
| `cf piece apply` | Rejects it. The command already reads its input as JSON from stdin. |
| `cf piece getsrc` | Rejects it. |
| `cf piece setsrc` | Rejects it. |
| `cf piece inspect` | Emits the complete result from `inspectPiece`. With `--summary`, `source` and `result` are first reduced to scalar summaries. |
| `cf piece view` | Emits the raw view value. A missing view emits JSON `null` instead of the human text `<no view data>`. |
| `cf piece render` | Emits `{ "html": ... }`. With `--watch`, each update emits `{ "html": ..., "renderCount": ... }`, but ordinary status and separator lines are mixed into stdout. The watch stream is therefore not a clean JSON stream. A piece with no UI emits the human text `<piece has no UI>` even in JSON mode. |
| `cf piece link` | Rejects it. |
| `cf piece get` | Rejects it, but the successful value is always serialized as JSON. |
| `cf piece set` | Rejects it. The command already reads the new value as JSON from stdin. |
| `cf piece map` | Rejects it. |
| `cf piece call` | Accepts it, but its meaning depends on where it appears. See the next section. |
| `cf piece rm` and `cf piece remove` | Reject it. |
| `cf piece recreate-root` | Rejects it. |
| `cf piece set-home` | Rejects it. |

The four output switches in this table use `safeStringify`. It replaces circular
references with a marker. It replaces values beyond the default maximum depth
of eight with a depth marker. `cf piece get` uses the same serializer even
though it has no output flag.

### `cf piece call`

`piece call` stops normal option parsing at the callable name. The same token
therefore has different meanings on opposite sides of that name.

| Invocation form | Behavior |
| --- | --- |
| `cf piece call --json <callable>` | Cliffy parses the option before the callable. The action does not read the parsed value, so it has no effect. |
| `cf piece call <callable> --json` | Converts the request to `--help --json`. It prints the callable kind, input schema, and optional output schema as JSON. It does not invoke the callable. |
| `cf piece call <callable> --help --json` | Prints the same machine-readable schema help. |
| `cf piece call <callable> '<json>'` | Converts the one inline argument to callable-level `--json '<json>'` and invokes the callable with the parsed value. This is the supported inline form. |
| `cf piece call <callable> -- --json` | Invokes the callable and reads JSON from stdin. |
| `cf piece call <callable> --json '<json>'` | Forwards only `--json`. The inline token is discarded, so the callable reads stdin instead. This differs from the supported inline form above. |

The flag does not control output. Handlers print the ordinary `Called handler
...` confirmation from `piece call`. Tools print their result as JSON whether
or not the flag was present.

## `cf exec`

`exec` passes every token after the mounted callable path to the callable
parser. The meaningful forms are:

| Invocation form | Behavior |
| --- | --- |
| `cf exec <mounted-file> --json '<json>'` | Parses the inline JSON and uses it as the complete callable input. |
| `cf exec <mounted-file> --json` | Reads the complete callable input as JSON from stdin. |
| `cf exec <mounted-file> --help --json` | Prints a JSON object containing `callableKind`, `inputSchema`, and `outputSchema` when the callable has an output schema. |
| `cf exec --json <mounted-file>` | Treats `--json` as the mounted file path. The option must come after the path. |

Callable-level JSON input cannot be combined with schema-derived input flags.
The CLI parses the JSON but does not check whether the value matches the
callable's input schema. The runtime performs that check.

The flag does not control output. A mounted handler has no stdout on success. A
mounted tool prints its result as JSON on success regardless of its input mode.

## Commands with JSON behavior but no `--json` option

- `cf wish` always removes runtime cell and stream handles from the result, then
  emits the remaining value through the safe JSON serializer.
- `cf piece get` always emits the requested value through the safe JSON
  serializer.
- `cf check` and the hidden `cf dev` command use `--pattern-json` instead. That
  option prints the selected evaluated export unless `--show-transformed` is
  also present.
- `cf piece apply` and `cf piece set` always parse stdin as JSON input.

## Hidden commands

| Command | Behavior when passed `--json` |
| --- | --- |
| `cf dev` | Rejects it. It has the separate `--pattern-json` option. |
| `cf fuse-daemon` | Forwards raw arguments to the FUSE parser. That parser accepts unknown flags, records a `json` boolean, and never reads it. The flag is silently ignored. |
| `cf fuse-supervisor` | Rejects it. |
| `cf deploy` | Rejects it. |

## Verification

The inventory came from the command registrations in
`packages/cli/commands/main.ts` and each file under
`packages/cli/commands/`. The output paths were traced through
`packages/cli/lib/render.ts`, `packages/cli/lib/callable-command.ts`, and
`packages/cli/lib/exec-schema.ts`.

Representative commands were also run through the real entry point. The probes
confirmed the status-2 rejection behavior, inherited `inspect` option parsing,
and the plain-help behavior of `cf inspect --json`. Small Cliffy parser probes
confirmed that `piece call` stops option parsing at the callable name and that
`exec` treats a leading `--json` as its mounted file argument.
