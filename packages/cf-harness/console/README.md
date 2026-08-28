# cf-harness console

Type a task, watch the harness work, open what it built — and read what the run
left behind when the feed's elided summaries are not enough. One Deno HTTP
server holding one in-process interactive chat service, and one Lit page reading
its events over Server-Sent Events.

The server binds `127.0.0.1`, and it treats loopback as an address rather than
as an authorization: a page anywhere on the web can drive requests at the
socket, so every request must name this server's own host and every `/api` route
must carry the per-process token the page is handed as a `SameSite=Strict`
cookie when it loads. Do not put it behind a public address.

## Prerequisites

- **Toolshed and shell running locally.** `./scripts/start-local-dev.sh` from
  the repository root, which serves the API on `http://localhost:8000`. See
  [`docs/development/LOCAL_DEV_SERVERS.md`](../../../docs/development/LOCAL_DEV_SERVERS.md).
- **Docker.** Every tool the model runs executes in the harness sandbox, which
  is a container. A stopped Docker daemon is a run that fails on its first
  `bash` call.
- **An identity keyfile.** A PKCS#8 key on this host, the same one the `cf` CLI
  uses. The fabric session loads it to sign with, and the pattern index signs
  its requests with the same identity.
- **A space named by name.** `assign_slug` composes the URL a person opens from
  the API URL and the space's name, and offers no URL at all for a space named
  by `did:key`. The server refuses a `did:` space at startup rather than
  finishing a run with no link to show.
- **A connected model provider.** The provider preference lives in
  `$CF_HARNESS_HOME/config.json` and its credentials in
  `$CF_HARNESS_HOME/auth.json`, both written by `cf-harness config set` and
  `cf-harness auth`. `CF_HARNESS_HOME` defaults to `$HOME/.cf-harness`. For
  `openai-compatible-gateway`, the key comes from `CF_HARNESS_API_KEY` or
  `OPENAI_API_KEY` instead; for `openai-codex`, the server preflights the stored
  credential and refuses to start when it is not connected.
- **A model credential.** For `openai-compatible-gateway`, `CF_HARNESS_API_KEY`
  or `OPENAI_API_KEY`; a turn started without one fails on its first model call
  rather than at startup, because the key is read per request.
- **A pattern index URL**, optionally. With one set, the session also offers
  `search_patterns` and `record_feedback`, so a run can find an existing pattern
  rather than write one from scratch, and publishes what it worked out back to
  the index. It is also what the Index view reads; without one that view says so
  and the server answers its route with a 404.

## Running it

```sh
export CF_HARNESS_FABRIC_API_URL=http://localhost:8000
export CF_HARNESS_FABRIC_IDENTITY="$HOME/.cf/my-key.pkcs8"
export CF_HARNESS_FABRIC_SPACE=my-space
export CF_HARNESS_PATTERN_INDEX_URL=https://index.example/   # optional

deno task --cwd packages/cf-harness console
open http://127.0.0.1:8100
```

`console` builds the page and then serves it. The page is a [felt](../../felt/)
build: its source is `src/`, its static files are `public/`, and both are
emitted to `dist/`, which the server serves and git ignores. A server started
without that build answers `/` by naming the command that produces it. While
changing the page, `deno task --cwd packages/cf-harness
console:watch` rebuilds
`src/` on save — it serves on felt's own port, which holds no API, so keep the
console server running and reload against it after a rebuild. `console:build` is
the one-shot build on its own.

Every environment variable has a flag, and the flag wins:

| Flag                  | Environment                          | Default                               |
| --------------------- | ------------------------------------ | ------------------------------------- |
| `--port`              | `CF_HARNESS_CONSOLE_PORT`            | `8100`                                |
| `--fabric-api-url`    | `CF_HARNESS_FABRIC_API_URL`          | `http://localhost:8000`               |
| `--fabric-identity`   | `CF_HARNESS_FABRIC_IDENTITY`         | required                              |
| `--fabric-space`      | `CF_HARNESS_FABRIC_SPACE`            | required, a name                      |
| `--pattern-index-url` | `CF_HARNESS_PATTERN_INDEX_URL`       | unset                                 |
| `--model`             | `CF_HARNESS_MODEL`                   | the CLI's default model               |
| `--workspace`         | `CF_HARNESS_CONSOLE_WORKSPACE`       | `.cf-harness-console/workspace`       |
| `--artifact-root`     | `CF_HARNESS_ARTIFACT_ROOT`           | `.cf-harness-console/runs`            |
| `--session-db`        | `CF_HARNESS_CONSOLE_SESSION_DB`      | `.cf-harness-console/sessions.sqlite` |
| `--max-model-turns`   | `CF_HARNESS_CONSOLE_MAX_MODEL_TURNS` | the prompt loop's default             |

Everything the server writes lives under `.cf-harness-console/` in the working
directory — the sandbox workspace, run artifacts, the session database, and the
sandbox's two CFC sidecar transport directories. The harness refuses to start an
enforcing run without those transports wired, so this surface sites them itself;
`CF_HARNESS_RUNSC_CFC_RESULT_DIR` and
`CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR` move them somewhere else.
`CF_HARNESS_CONSOLE_DIR` moves the whole tree.

`--session-db none` keeps sessions in memory for the life of the process, which
is what a throwaway run wants. Otherwise sessions, turns, and events are
durable: restarting the server and reopening the page replays the log.

## What you'll see

Type a task — "build me a page that tracks the books I'm reading" — and press
Start. The feed then shows, in the order the harness produces them:

- **`calling <tool>`** as each tool call begins, with its input summary.
- **`<tool> completed` / `failed`** with the result the model read, truncated.
- **assistant text** between tool calls.
- **a nested subagent block** under each `delegate_task` entry, headed by the
  child's profile and the goal it was given, holding the child's own tool and
  assistant lines as they happen and closing with the child's status.
- **the final text** of the turn, in a boxed entry, when it completes.

When the run names a piece, the `assign_slug` result carries a `slug` and a
`url`, and the page raises an **Open your piece** link above the feed. That link
is the point of the surface: everything above it is the work, and the link is
what the work produced. The same result is durable under
`<artifact-root>/<run-id>/tool-outputs/`; when a run ends without the link
appearing, the Runs view below reads it back.

Cancel stops the running turn. The session survives a cancel and a page reload
both — the stream resumes from the last event the page rendered rather than
replaying the feed.

## Sessions

The session a page is showing is named in its address, as `?sessionId=<id>`. A
started task puts it there, so the address bar always holds a link back to the
run: open it later, or on another tab, and the page replays that session's whole
event log from the start and draws the same feed the live run drew, nested
subagent blocks and piece link included.

With no session named, the page lists the sessions this server knows — the most
recently touched first, each named by the task it was given — and following one
opens it.

An open session takes another turn: the box sends a follow-up into the session
being shown rather than starting a new one, and the feed continues rather than
clearing. **New session** goes back to an empty page and the list. A session
that cannot take another turn — closed, or left with a transcript that did not
survive a restart — says so in the feed when the follow-up is refused.

## CFC

This surface exists partly to show CFC working, so the fabric session's runtime
runs under the `max-enforcement` posture by default rather than opting into it.
That bundle — `MAX_ENFORCEMENT_CFC_OPTIONS` in the runner's presets — sets flow
labels to `persist`, puts the write floor, policy evaluation, declared
monotonicity and label-metadata protection at `enforce`, turns trigger-read
gating on, installs the standard prompt-caveat policy, and gives the
network-fetch sinks public-only confidentiality ceilings. The server prints the
posture it resolved at startup, so what a run ran under is never a guess.

The bundle leaves the enforcement pin at `enforce-explicit`; `enforce-strict`
stays a deliberate per-session raise. Each dial has a flag, and the flag wins:

| Flag                            | Environment                              | Default                            |
| ------------------------------- | ---------------------------------------- | ---------------------------------- |
| `--fabric-cfc-posture`          | `CF_HARNESS_FABRIC_CFC_POSTURE`          | `max-enforcement` (`none` to drop) |
| `--fabric-cfc-flow-labels`      | `CF_HARNESS_FABRIC_CFC_FLOW_LABELS`      | the posture's `persist`            |
| `--fabric-cfc-enforcement-mode` | `CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE` | `enforce-explicit`                 |

These govern the runtime `run_pattern` deploys patterns into. The harness's own
`cfcEnforcementMode`, which governs tool policy and the sandbox, is a separate
dial and reaches every run's `policy-snapshot.json` either way.

## Reading a run

Three columns, each scrolling on its own: the runs there are, the run being
read, and the map of how it went. A turn produces a run, and the run's artifacts
are the record of it, so the same view serves a run that finished an hour ago
and one still going. The live event stream drives the status line and the
re-reads; it is not a second feed. A run writes its artifacts as it goes, so
every completed tool call re-reads the list, the open run and its map. The step
the scrubber sits on survives the re-read.

### The runs

The left column lists every run the server has made, each named by the task it
was given, with a `delegate_task` child nested under the run that delegated to
it.

### The map

The right column is the conversation, read top to bottom. A turn opens where a
person spoke; under it are the calls the agent made, each carrying how it turned
out and what CFC decided, with a delegated child's own calls nested beneath the
call that delegated. Clicking a node moves the middle column to that step —
which is how you move around a run — and clicking a node of a child opens that
child's own run.

Cells appear wherever a run touches one:

- **makes** — the call minted it, and its result addressed it.
- **reads** — the call was wired to it, labelled with the argument name that
  carried it.
- **in scope** — it arrived without this call making it: a handle handed to the
  session, or one a child's result carried back.

The map heads with the CFC regime the run ran under and with the blunt counts:
how many calls failed, how many CFC refused, and how many patterns read no cell.
That last one matters — a run whose patterns read nothing built its work from
literals rather than composing it over references, which is the opposite of what
the handle model is for.

A map spans the run **and the `delegate_task` children beneath it**, because
that is where the routing lives: a parent commonly names a cell its child
produced. Cells are keyed by the address they stand for, so a parent's token and
a child's token for one cell are one cell.

### A cell

A cell is drawn one way wherever it appears — in an argument, in a map node, in
the handles a step holds — because two sightings of one cell have to be
recognisable as one cell. The chip carries the name it goes by: the slug a
person gave it, else the handle the model held, else its address. Hovering it
gives the rest — handle, address, the shape the pattern that made it declared,
the confidentiality atoms riding on it, and the step whose result minted it.

A cell showing no atoms under a run whose flow labels are `off` is saying what
that run recorded, not hiding something. The regime at the top of the map is
what makes the difference readable.

### The run's own panes

- **Timeline** — the run step by step, scrubbed with arrow keys or the slider. A
  tool call and the result answering it are one step. A coloured dot on each
  step in the rail says how it turned out: green for a result the tool called
  `ok`, red for one it called an error, amber for a call CFC denied.

  A step leads with what it was given and what it holds, and the payloads come
  after:

  - **handles in scope** — every cell live by that point, the ones the step
    introduced marked.
  - **arguments** — each one read as what it is. A reference is a cell chip and
    leads back to the step that produced it; both spellings resolve alike, since
    `run_pattern` takes a `cfh:a:` token or a whole link and they name one cell.
    A plain value says it is a value.
  - **cfc** — the decision recorded for that call: allowed or denied, its effect
    class, and the reason codes behind it. A policy event appears beside it,
    which is how a call CFC _allowed_ but whose _observation_ it refused reads
    as the two separate facts it is. The flow labels the runtime computed for
    each input position appear here too.
  - **disclosure** — how many bytes the result let across as a plain value, how
    many positions it sealed behind a reference, and the longest run of numbers
    it carried. A long numeric run is called out, in the rail as well: the
    harness seals a string the schema does not pin to an enum or a const, but it
    never seals a number, so an array of them carries whatever its author chose
    to encode.

  Then the call's input and output as formatted JSON, untruncated, with long
  lines scrolling inside their block rather than widening the page.

  A `delegate_task` step names the child it started; opening that child in the
  rail reads its own timeline.
- **Patterns** — the pattern-shaped work. Every `run_pattern` attempt in order
  with the source it submitted and, for one the compiler refused, the diagnostic
  — so the compile-error and fix rounds are legible rather than lost. Alongside
  them: what `search_patterns` matched and with what score, what
  `record_feedback` reported, and every address `assign_slug` named.
- **Tool outputs** — each tool result as the model read it, untruncated.
- **Artifacts** — the run's own records: `run-state.json`, `transcript.json`,
  `run-report.json`, the policy snapshot and trace, the capability snapshot, and
  the skill registry and activations, whichever the run wrote.

Handle scope is reconstructed rather than recorded. A run keeps one handle
table, its last, so the timeline takes a handle to be in scope from the step its
token first appears in — the order the model met them in, which is the order
that matters for reading a run back.

## The Index view

The header switches between **Runs** — everything above — and **Index**, which
reads the pattern index the server was configured with. The view is named in the
address as `?view=index`, so it is a page to reload into and to link someone at.
It needs `--pattern-index-url`; without one, the route it reads through answers
404 saying the server was started without an index, and the view shows that.

The page holds no key and addresses no host but this server. It posts a function
name to `/api/index/call`, and the server signs the request with the fabric
identity and sends it — so the index sees the operator's own identity, the same
principal a run writes with. Four functions are reachable, all of them reads:
`listPatterns`, `listEvents`, `getPattern` and `searchPatterns`. Anything else —
a publication, a recorded event — is refused by name before the index is
touched, and the request the server sends is composed field by field rather than
forwarded, so nothing extra survives the crossing. `getPattern` is called
without `includeSource`: this surface shows metadata, schemas, dependencies and
events, and a pattern's source is read through the CLI.

The route sits under `/api/`, so the `Host`, `Origin` and token gates that cover
every other route cover it too.

Three panes:

- **Patterns** — everything the index holds, by score. A row carries the pattern
  id, its description and hashtags, a badge per event type counted against it,
  the weighted score those counts produce, and when it was created; the weights
  themselves are printed beside the heading. Opening a row reads that pattern's
  argument and result schemas, its dependencies, and the events you recorded
  against it. Every identifier is a button that copies the whole of itself.
- **Your events** — your own event stream, newest first, with a box that filters
  on any field. The index answers each signer with their own events and nobody
  else's; the shared reading of what everyone did is the score in the table
  above.
- **Search** — the query the runtime's `search_patterns` would make, run by
  hand. Tags, free text and a limit compose a request, and the request is shown
  beside the results, because what the pane is for is how the index answers
  rather than what it answered once. Each hit reads `matched/asked` on its text
  terms: matching is disjunctive and ranked, so the ratio is what says how close
  a hit is.

## How the configuration reaches the run

`CreateHarnessPromptLoopOptions` extends the engine's options, which extend the
config resolver's, and the interactive chat service spreads its
`basePromptLoopOptions` into every turn. So `fabricSession` and `patternIndex`
set once at startup hold for the whole session, and the engine builds each
lazily-cached client factory from them.

Configuration alone is not enough: the default chat policy's tool surface does
not include `run_pattern`, `assign_slug`, `search_patterns`, or
`record_feedback`. The server names them in the policy it starts each session
with, and the prompt loop withholds each again if its backing is absent — so a
missing index means the two index tools are simply not offered, rather than
offered and failing.
