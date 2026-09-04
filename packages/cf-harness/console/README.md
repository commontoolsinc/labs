# cf-harness console

Type a task, watch the harness work, open what it built — and read what the run
left behind when the feed's elided summaries are not enough. One Deno HTTP
server holding one in-process interactive chat service, and two Lit pages
reading its events over Server-Sent Events: the console itself, and the live
pane a host embeds to show one session working.

The server binds `127.0.0.1`, and it treats loopback as an address rather than
as an authorization: a page anywhere on the web can drive requests at the
socket, so every request must name this server's own host and every `/api` route
except health must carry the per-process token the page is handed as a
`SameSite=Strict` cookie when it loads. Do not put it behind a public address.

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
  and the server answers its route with a 404. Driving a list of tasks through
  this server unattended and counting what they did with the index is
  [the measurement protocol](../docs/pattern-index-measurement.md), whose runner
  reaches this server over the same routes the page does.
- **A public skill registry URL**, optionally. With one set, the parent session
  offers metadata-only `search_skills`; without one, the tool is absent. Its
  registry-reported install counts are unauthenticated and unverifiable, not a
  trust signal, and the tool cannot fetch, read, or load skill content.

## Running it

```sh
export CF_HARNESS_FABRIC_API_URL=http://localhost:8000
export CF_HARNESS_FABRIC_IDENTITY="$HOME/.cf/my-key.pkcs8"
export CF_HARNESS_FABRIC_SPACE=my-space
export CF_HARNESS_PATTERN_INDEX_URL=https://index.example/   # optional
export CF_HARNESS_SKILLS_REGISTRY_URL=https://www.skills.sh/  # optional

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

| Flag                    | Environment                          | Default                               |
| ----------------------- | ------------------------------------ | ------------------------------------- |
| `--port`                | `CF_HARNESS_CONSOLE_PORT`            | `8100`                                |
| `--fabric-api-url`      | `CF_HARNESS_FABRIC_API_URL`          | `http://localhost:8000`               |
| `--fabric-identity`     | `CF_HARNESS_FABRIC_IDENTITY`         | required                              |
| `--fabric-space`        | `CF_HARNESS_FABRIC_SPACE`            | required, a name                      |
| `--pattern-index-url`   | `CF_HARNESS_PATTERN_INDEX_URL`       | unset                                 |
| `--skills-registry-url` | `CF_HARNESS_SKILLS_REGISTRY_URL`     | unset                                 |
| `--model`               | `CF_HARNESS_MODEL`                   | the CLI's default model               |
| `--workspace`           | `CF_HARNESS_CONSOLE_WORKSPACE`       | `.cf-harness-console/workspace`       |
| `--artifact-root`       | `CF_HARNESS_ARTIFACT_ROOT`           | `.cf-harness-console/runs`            |
| `--session-db`          | `CF_HARNESS_CONSOLE_SESSION_DB`      | `.cf-harness-console/sessions.sqlite` |
| `--space-db`            | `CF_HARNESS_SPACE_DB`                | the space's own database, discovered  |
| `--max-model-turns`     | `CF_HARNESS_CONSOLE_MAX_MODEL_TURNS` | the prompt loop's default             |
| `--skills-root`         | `CF_HARNESS_CONSOLE_SKILLS_ROOT`     | the repository's `skills/` tree       |
| `--host-mount`          | —                                    | none; repeatable                      |

Publishing to the index is configured the way the CLI configures it, by the same
names:

| Flag                                   | Environment                                       | Default               |
| -------------------------------------- | ------------------------------------------------- | --------------------- |
| `--no-pattern-index-publish`           | `CF_HARNESS_PATTERN_INDEX_PUBLISH=0`              | publishing is on      |
| `--pattern-index-publish-discoverable` | `CF_HARNESS_PATTERN_INDEX_PUBLISH_DISCOVERABLE=1` | recorded, not offered |

A pattern a session authors and runs is recorded against the index unless
publishing is turned off, and is offered to search only when discoverability is
asked for — which is for deliberate corpus seeding, since discoverability is
otherwise earned from later evidence.

`--host-mount name=<name>,source=<host path>,target=<sandbox path>[,mode=readonly|writable]`
takes the same spec the CLI takes, and is repeatable. It is how a reference tree
— a corpus to work from, a checkout to read — reaches the sandbox a task runs
in.

Every turn scans the skills root and records the registry on its run before the
first model call, so `read_skill_resource` can answer and a delegated
`pattern-author` child inherits its profile's preloaded skills — the authoring,
schema, and UI guides. A turn whose run carries no registry authors patterns
without them. Tools read the tree on the host, so it needs no sandbox mount; the
registry names host paths, and the run's `skill-registry.json` artifact records
what the scan found.

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

## HTTP routes

Every route retains the console's loopback `Host` and `Origin` checks. The token
column refers to the per-process cookie, which is handed to whichever of the two
pages is loaded — `/` or `/live/<sessionId>` — and to the assets they pull.

| Method | Route                        | Token | Result                                                                                                                         |
| ------ | ---------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/api/health`                | No    | Console health, configured Fabric API URL, and honestly limited Fabric-session liveness                                        |
| `POST` | `/api/task`                  | Yes   | Starts a session or a follow-up turn                                                                                           |
| `POST` | `/api/cancel`                | Yes   | Cancels the active turn                                                                                                        |
| `GET`  | `/api/sessions`              | Yes   | Durable session summaries                                                                                                      |
| `GET`  | `/api/status`                | Yes   | Session status and artifact roots                                                                                              |
| `GET`  | `/api/policy`                | Yes   | What a new session here would run under                                                                                        |
| `GET`  | `/api/turns/<turnId>/result` | Yes   | Durable structured result for a completed turn                                                                                 |
| `GET`  | `/api/events`                | Yes   | Live and replayed chat events over SSE                                                                                         |
| `GET`  | `/api/runs`                  | Yes   | Run summaries                                                                                                                  |
| `GET`  | `/api/runs/<runId>/...`      | Yes   | Run detail, flow, graph, artifacts, and tool outputs                                                                           |
| `POST` | `/api/index/call`            | Yes   | One allowlisted pattern-index read                                                                                             |
| `GET`  | `/live/<sessionId>`          | No    | The live pane for one session, which is handed the token the way `/` is; takes `?turn=<turnId>` and `?piecesBase=<url-prefix>` |

Health returns `ok`, `fabricApiUrl`, and `fabricSession`. The last field is
`unverified`: the console has no inspectable Fabric-session connection state,
and HTTP reachability, configuration, or factory existence says nothing about
whether a retained session can complete an operation. The field does not spend a
provider turn or make a Fabric round trip. A caller needing proven substrate
liveness must perform a separate probe.

A task body carries the text, optionally the session to continue, and optionally
the cells the task is to be computed over:

```json
{
  "text": "summarize this trip",
  "sessionId": "…",
  "inputCells": [
    { "name": "itinerary", "ref": "/of:fid1:…/days" }
  ]
}
```

An input cell is named per task rather than per session, because a turn is its
own run with its own handle table: the tokens the model is given are the ones
that turn's run minted. What the model receives is a token and the caller's own
name for it — never the reference, and never what the cell holds. The reference
grammar is `--input-cell`'s, so a spelling the CLI refuses is refused here with
a 400 before any turn starts: a `ref` has to be a link naming an entity
(`/of:fid1:…/path`, or `computed:`), not a bare hash. A cell that passes the
grammar and still cannot be minted — one in another space, say — fails the turn
rather than starting it without what the caller attached, and that turn is
terminal like any other failed one.

The completed-turn result is:

```json
{
  "pieces": [
    {
      "slug": "reading-list",
      "url": "http://localhost:8000/my-space/reading-list"
    }
  ],
  "spaceName": "my-space",
  "finalText": "Your reading list is ready."
}
```

`pieces` is always present, including as `[]` when the run assigned no slug.
Each entry copies only `slug` and `url` from the model-facing `assign_slug`
output recorded in the run transcript; the console neither reconstructs the URL
nor derives pattern metadata. `spaceName` identifies the space this console is
configured against.

The route never holds a request open; it answers with where the turn stands, and
the status code says whether asking again can change the answer:

| Turn                    | Status | Body                                            |
| ----------------------- | ------ | ----------------------------------------------- |
| running, or canceling   | 409    | `{ code: "turn_not_completed" }` — ask again    |
| completed               | 200    | the result above                                |
| completed, no artifacts | 404    | `{ code: "turn_result_unavailable" }`           |
| failed                  | 410    | `{ code: "turn_failed", detail: <chat error> }` |
| canceled                | 410    | `{ code: "turn_canceled", detail: <reason> }`   |
| unknown                 | 404    | `{ code: "turn_not_found" }`                    |

Every body carries an `error` string beside `code`. A poller's whole rule is:
409 keep polling, 200 read the result, anything else stop. 410 is what a turn
that died before its first model turn answers too — a turn is terminal after
every way it can fail, not only after the model has been asked.

The same holds for the run behind the turn. Its `run-state.json` under the
artifact root reads `status: "running"` from the moment the turn takes it,
through every tool call, until the turn ends; `completed` or `failed`, with
`endedAt` and `terminalReason`, appear once and only when it is over. A `failed`
run carries the failure under `failureRecords` and `primaryFailure`, and
`terminalReason: "setup_error"` names the run that never reached a model turn.

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

The `turn_completed` event also carries the same structured object under
`result`. Live streams and replayed durable events have the same shape, so a
caller can open `result.pieces[0].url` without parsing assistant prose. Pollers
read the same object from `GET /api/turns/<turnId>/result`.

When the run names a piece, the `assign_slug` result carries a `slug` and a
`url`, and the page raises an **Open your piece** link above the feed. That link
is the point of the surface: everything above it is the work, and the link is
what the work produced. The same result is durable under
`<artifact-root>/<run-id>/tool-outputs/`; when a run ends without the link
appearing, the Runs view below reads it back.

Cancel stops the running turn. The session survives a cancel and a page reload
both — the stream resumes from the last event the page rendered rather than
replaying the feed.

## The live pane

`GET /live/<sessionId>` is the same work in a column, for a host that can show a
task running beside the thing that asked for it and can only open a plain web
address. It is served from the same build as the console page and handed the
same token cookie, so its own script reaches `/api` on this origin and nothing
else does: the `Host` gate covers it, and the content security policy that keeps
the console page out of a frame keeps this one out too. It is opened at the top
level of a view, never framed.

`?turn=<turnId>` narrows the pane to one turn. Without it the pane shows the
session's activity in order, however many turns it has taken.

`?piecesBase=<url-prefix>` says where the host renders a piece. A piece's own
address is the one `assign_slug` recorded, which is the Fabric API's; a host
that shows pieces somewhere else — a pane of its own, say, where the API's
address answers with a login gate instead of the piece — names its prefix here,
and every piece link on the page is composed as `<piecesBase>/<space>/<slug>`
from the space and slug the turn's result carries, each escaped. With no prefix
named, the recorded URL is used as it stands rather than rebuilt. The prefix has
to be an absolute `http` or `https` URL: it arrives from whatever opened the
page and ends up in an `href`, so anything else — a `javascript:` URL, a
relative path — is refused, the page says so, and the links stay on the recorded
address. The console composes against a prefix it is given and knows nothing
about the host that gave it.

The pane reads the same event stream the console page reads, from sequence zero
— so a pane opened halfway through a turn shows the steps that already happened
rather than only the ones that follow, and a reconnect resumes from the last
event it rendered. What the stream carries is the order and the outcome; what a
call was given, what CFC decided about it, and what it withheld from the model
come from the turn's own run, which the pane re-reads when one of its tool calls
completes. The run id of a console turn is the turn id, so no route composes
that address and no lookup stands between the two.

Each step is one line — the tool, how it ended, and what it was about: the
numbered `run_pattern` attempt and the compiler's word on it, the slug
`assign_slug` registered, the query a search was given, the question
`query_docs` asked. Under a line whose run recorded a CFC decision sits the same
CFC line the console's timeline draws, and a result that held anything back from
the model carries the same omission block, openable in place. A completed turn
ends the pane with the piece link the turn produced, which is what the pane is
watched for.

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

### Status route

`GET /api/status` returns the console's absolute `artifactRoot` and a `sessions`
array. Each session status carries its lifecycle, timestamps, model, workspace,
capabilities, policy, and, once a run has started, its own `artifactRoot`. A
`sessionId` query narrows that array to the matching live session. Clients that
need a run's artifacts use the session's root when it is present and the
top-level root as the console-wide fallback.

Status requires the per-process token cookie obtained by loading the console
page. The top-level fields are present even before the console has any sessions,
so an unattended client can check the route contract before starting a model
turn.

### Policy route

`GET /api/policy` returns what a session started here **would** run under, which
is the same question the status route answers only for sessions that already
exist:

| field                     | value                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `systemPromptSha256`      | SHA-256 of the seeded system prompt, or `null` when none is seeded    |
| `allowedToolIds`          | the tools a new session's policy asks for                             |
| `allowedSubagentProfiles` | the subagent profiles it authorizes                                   |
| `artifactRoot`            | where runs are filed                                                  |
| `fabricSpace`             | the space name runs build in                                          |
| `sessionDbPath`           | the durable session store, or `null` when sessions are held in memory |

The prompt crosses as a digest and never as text, so a client can check that
this console holds the prompt it was told to run without the prompt leaving the
process. `allowedToolIds` is what the policy asks for; the prompt loop withholds
a tool again when its backing is absent, so this says a session may reach a tool
rather than that a turn will hold it.

The route carries the token, as the status route carrying the same policy on a
live session does — and the space name and the two host paths, which nothing
outside this server's own page has business reading. The health route's
exemption is for a client that has no token yet and wants liveness; a client
acting on this answer has loaded the page and holds one.

An unattended client is the caller this route is for: the measurement batch
runner refuses a whole batch when the console it found is not the cell its
`--cell-spec` names, before the first task spends anything. That file's shape is
in
[the measurement protocol](../docs/pattern-index-measurement.md#the-cell-spec).

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

A run ends by reading the space it wrote into for the labels it holds on the
cells the run touched, and records them as the run's `cell-labels.json` in the
same write as its outcome, so `run-state.json` carries them too. That is what a
cell chip draws its `space` row from, and what the head of the map states the
regime of — a space that could not be read is a run whose cells are
unasked-about rather than unlabelled, and a snapshot that could not be written
at all is a failure record on the run, which tells it from a run that held no
cell to ask about. The turn's run and the `delegate_task` children beneath it
each record their own as each of them ends, and the head states what every cell
on the map can be taken to mean, so a family whose runs did not all read the
space is stated as read for none of them: one member's reading cannot speak for
another member's cells. `--space-db` reaches the children as it reaches the
parent.

The read is one hop wide. A pattern's results are their own cells, linked from
the piece that names them, and the derived label sits on the cell — so the
labels of the cells a run's own cells link to are read too, at the path the link
sits at. The walk descends through the objects and arrays of a value to find
those links and stops at each: a linked cell's own links belong to that cell,
not to this one.

It descends a bounded way, and what it does not reach it records rather than
passes over. The bounds sit far above the shape of any document a pattern writes
— sixty-four levels deep, a hundred thousand values wide — and a path below that
depth is recorded unread at the path itself, so the cells beneath it read as
nothing known. A value large enough to exhaust the node budget is a walk that
stopped before enumerating what was left, so it can name no path: it marks the
whole cell's labels partial and warns as it does, because a value that size is a
cycle far more often than it is a document. Either way, a cell the reader did
not finish never reads as a cell with no label.

It reaches one space. A reference or a link naming a space the opened file
cannot be shown to be — another space, or any space at all where the file's own
name proves no DID — is recorded as unread rather than resolved, because the id
it names may also exist here and would answer with the wrong cell's labels. A
reference is recorded unread as a whole cell; a link is recorded unread at the
path it sits at, so the cells beneath it read as nothing known rather than as
cells the space holds no label for. The database is opened read-only, and it is
found by the space the fabric session names; `--space-db` points at the file
instead, for a host whose store is not where the search looks — and a file named
for anything but its space proves no DID, so every spaced reference and link
goes unread against one. A cell the opened file holds no document for is
recorded as unread too, not as unlabeled: the run held a reference to it, so a
store with nothing at it is a store the run did not write into. A file holding
none of a run's cells is said out loud as the wrong store, with the fix beside
it.

## Reading a run

Three columns, each scrolling on its own: the runs there are, the run being
read, and the map of how it went. A turn produces a run, and the run's artifacts
are the record of it, so the same view serves a run that finished an hour ago
and one still going. The live event stream drives the status line and the
re-reads; it is not a second feed. A run records its labels in the write that
ends it, and the event that closes a turn follows that write, so the re-read the
event drives reads the snapshot rather than racing it. A run writes its
artifacts as it goes, so every completed tool call re-reads the list, the open
run and its map. The step the scrubber sits on survives the re-read.

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
the labels below, and the step whose result minted it.

A chip holds two label facts, and the card names them apart because they answer
different questions:

- **cfc** — the atoms the sandbox's invocation context recorded on the arguments
  of the call this sighting belongs to. What one call saw crossing into it. The
  count on the chip is this one.
- **space** — the confidentiality and integrity atoms the space stores for the
  cell itself, read from the space the run wrote into, with the labelled paths
  read path by path and the origin of each beside it.

An atom is not a claim that the value was computed from something confidential.
A value's label can be the join of the fields of the object it was reached
through, so a plain input reached through a labelled object carries an atom
having been derived from nothing. What separates the two is the space's own
account of where the value came from, and the chip wears it as a second state: a
**derived** cell — one the space says was computed from what a function read —
is colored apart from a merely labelled one, and its card names the
implementation that produced it under `transformed by`.

A cell whose card says the space holds no label for it is saying what the space
holds, and only a cell read whole says it. A cell whose card says no label was
read for it is saying nothing was read there, which is a different thing: either
the run's labels name the cell nowhere, or the reading covered part of it. Where
it covered part of it, a **reading** row says which part it missed and what a
path with no entry means under it — `read but for` the paths it declined to
follow, each named, with every other path read; or `did not finish`, which names
no path at all, because what it missed it never reached. The chip cannot tell on
its own whether a cell went unnamed because the space was never read. The head
of the map carries that: `cell labels read` with how many of the cells it read
carry one, `cell labels unavailable` with why, or `cell labels not read`. Where
a cell of the run was read only in part it heads `cell labels read in part`
instead, and says how many, because the count beside it is then a floor rather
than a total. Read an empty chip against that head — under a run whose flow
labels are `off`, or one whose space could not be read, an empty chip is a
record of what the run recorded rather than a cell with nothing to hide.

### The run's own panes

- **Timeline** — the run step by step, scrubbed with arrow keys or the slider. A
  tool call and the result answering it are one step. A coloured dot on each
  step in the rail says how it turned out: green for a result the tool called
  `ok`, red for one it called an error, amber for a call CFC denied. A call
  whose result CFC withheld the values of is green: it ran and answered.

  A step leads with what it was given and what it holds, and the payloads come
  after:

  - **handles in scope** — every cell live by that point, the ones the step
    introduced marked.
  - **arguments** — each one read as what it is. A reference is a cell chip and
    leads back to the step that produced it; both spellings resolve alike, since
    `run_pattern` takes a `cfh:a:` token or a whole link and they name one cell.
    A plain value says it is a value.
  - **cfc** — the decision recorded for that call: allowed, denied, or withheld,
    its effect class, and the reason codes behind it. A withheld decision is a
    confidentiality boundary holding back the values of a result the call did
    return, so the count of the positions it held back sits beside it and the
    step itself stays the success its answer states; the dot goes amber only for
    a call that did not run. Which of the three it is comes from the `release`
    record's own reason code wherever a boundary decided, not from the outcome
    word the run persisted beside it — the same field AUD-16 counts — so a run
    recorded before that word existed reads here as what its boundary actually
    decided. A policy event appears beside the decision, which is how a call CFC
    _allowed_ but whose _observation_ it refused reads as the two separate facts
    it is. The flow labels the runtime computed for each input position appear
    here too.
  - **disclosure** — how many bytes the result let across as a plain value, how
    many positions it sealed behind a reference, and the longest run of numbers
    it carried. A long numeric run is called out, in the rail as well: the
    harness seals a string the schema does not pin to an enum or a const, but it
    never seals a number, so an array of them carries whatever its author chose
    to encode.

  Then the call's input and model-facing output as formatted JSON, with long
  lines scrolling inside their block rather than widening the page. Beside the
  output, **withheld from the model** expands to the full artifact positions
  named by `transcript-omissions.json`, each labeled by its omission rule. CFC
  denials render a redaction marker. Scrubbed Fabric identifiers are shown with
  `[fabric-id]` in place of their values when the artifact position is
  available; that fixed marker stands in alone when it is not. A legacy result
  with no omission record says so instead of inferring omissions from the full
  result.

  Superseded `run_pattern` source is an assistant argument rather than a tool
  result, so it is outside the omission record. Where its marker appears, the
  Timeline says **source replaced by a later attempt** and directs the reader to
  the run-pattern-source sidecar named by that marker.

  A `delegate_task` step names the child it started; opening that child in the
  rail reads its own timeline.
- **Patterns** — the pattern-shaped work. Every `run_pattern` attempt in order
  with the source it submitted and, for one the compiler refused, the diagnostic
  — so the compile-error and fix rounds are legible rather than lost. Alongside
  them: what `search_patterns` matched and with what score, what
  `record_feedback` reported, and every address `assign_slug` named.
- **Tool outputs** — the full persisted tool-result artifacts, including fields
  the model-facing rendering omitted.
- **Artifacts** — the run's own records: `run-state.json`, `transcript.json`,
  `transcript-omissions.json`, `run-report.json`, the policy snapshot and trace,
  the capability snapshot, the cell labels read back from the space, and the
  skill registry and activations, whichever the run wrote.

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

The route sits under `/api/`, so it carries the protected routes' `Host`,
`Origin`, and token gates.

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

This server resolves its flags and environment into a `HarnessSessionConfig` —
the same description the batch CLI resolves argv into — and
`src/session-assembly.ts` turns that into the run. So a capability the CLI can
configure is configurable here under the same name, and the two surfaces cannot
drift apart over what a session is.

The tools a session offers are derived from what it can back rather than listed
here: the default surface plus `run_pattern` and `assign_slug` for a fabric
session, `search_patterns` and `record_feedback` for an index, `search_skills`
for a registry, and `acquire_skill` for a run holding both. A tool whose backing
is absent is not offered, rather than offered and failing.

Each turn is its own run, so what that run holds is established per turn and
announced in the messages it opens with: the skills registry scanned from the
skills root, the well-known grants of the session's space — which is what lets a
task explore what the space holds — and the input cells the request attached.
