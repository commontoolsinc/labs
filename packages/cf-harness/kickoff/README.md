# cf-harness kickoff

Type a task, watch the harness work, open what it built. One Deno HTTP server
holding one in-process interactive chat service, one static page reading its
events over Server-Sent Events, no build step and no framework.

The server binds `127.0.0.1` and has no authentication. Reaching it means
already running code on this machine; do not put it behind a public address.

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
  the index.

## Running it

```sh
export CF_HARNESS_FABRIC_API_URL=http://localhost:8000
export CF_HARNESS_FABRIC_IDENTITY="$HOME/.cf/my-key.pkcs8"
export CF_HARNESS_FABRIC_SPACE=my-space
export CF_HARNESS_PATTERN_INDEX_URL=https://index.example/   # optional

deno task --cwd packages/cf-harness kickoff
open http://127.0.0.1:8100
```

Every environment variable has a flag, and the flag wins:

| Flag                  | Environment                          | Default                               |
| --------------------- | ------------------------------------ | ------------------------------------- |
| `--port`              | `CF_HARNESS_KICKOFF_PORT`            | `8100`                                |
| `--fabric-api-url`    | `CF_HARNESS_FABRIC_API_URL`          | `http://localhost:8000`               |
| `--fabric-identity`   | `CF_HARNESS_FABRIC_IDENTITY`         | required                              |
| `--fabric-space`      | `CF_HARNESS_FABRIC_SPACE`            | required, a name                      |
| `--pattern-index-url` | `CF_HARNESS_PATTERN_INDEX_URL`       | unset                                 |
| `--model`             | `CF_HARNESS_MODEL`                   | the CLI's default model               |
| `--workspace`         | `CF_HARNESS_KICKOFF_WORKSPACE`       | `.cf-harness-kickoff/workspace`       |
| `--artifact-root`     | `CF_HARNESS_ARTIFACT_ROOT`           | `.cf-harness-kickoff/runs`            |
| `--session-db`        | `CF_HARNESS_KICKOFF_SESSION_DB`      | `.cf-harness-kickoff/sessions.sqlite` |
| `--max-model-turns`   | `CF_HARNESS_KICKOFF_MAX_MODEL_TURNS` | the prompt loop's default             |

Everything the server writes lives under `.cf-harness-kickoff/` in the working
directory — the sandbox workspace, run artifacts, the session database, and the
sandbox's two CFC sidecar transport directories. The harness refuses to start an
enforcing run without those transports wired, so this surface sites them itself;
`CF_HARNESS_RUNSC_CFC_RESULT_DIR` and
`CF_HARNESS_RUNSC_CFC_INVOCATION_CONTEXT_DIR` move them somewhere else.
`CF_HARNESS_KICKOFF_DIR` moves the whole tree.

`--session-db none` keeps sessions in memory for the life of the process, which
is what a throwaway run wants. Otherwise sessions, turns, and events are
durable: restarting the server and reopening the page replays the log.

## What you'll see

Type a task — "build me a page that tracks the books I'm reading" — and press
Start. The feed then shows, in the order the harness produces them:

- **`calling <tool>`** as each tool call begins, with its input summary.
- **`<tool> completed` / `failed`** with the result the model read, truncated.
- **assistant text** between tool calls.
- **the final text** of the turn, in a boxed entry, when it completes.

When the run names a piece, the `assign_slug` result carries a `slug` and a
`url`, and the page raises an **Open your piece** link above the feed. That link
is the point of the surface: everything above it is the work, and the link is
what the work produced. The same result is durable under
`<artifact-root>/<run-id>/tool-outputs/`, which is where to look when a run ends
without the link appearing.

Cancel stops the running turn. The session survives a cancel and a page reload
both — the stream resumes from the last event the page rendered rather than
replaying the feed.

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
