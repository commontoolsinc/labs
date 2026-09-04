# Driving the console from Weaver

Weaver's command pill offers two verbs backed by the cf-harness console:
`/patterns <query>` searches the pattern index, and `/cf-harness <task>` runs a
harness session. A task places a panel in the current loom that streams the
session live, and when the turn ends the panel is replaced by the finished
piece, rendered in the person's own loom space under their own identity.
`more
<text>` continues the last session; a task that names a pattern id from
`/patterns` has the session use that pattern.

The arrangement rests on one fact: **the console and loom share one fabric.**
The console runs against loom's toolshed, signs with loom's identity key, and
writes into loom's space, so a piece the harness builds is where Weaver and loom
already look. Weaver renders it through loom's pattern pane, which bootstraps
the identity on its own origin; the toolshed and shell URLs stop at a login gate
in a browsing context that holds no identity, so they are not what the pill
opens.

This document is the operator procedure for that arrangement. The console's own
prerequisites, flags and routes are in
[`../console/README.md`](../console/README.md); the verbs' behavior inside the
pill is documented in the Weaver repository (`apple/docs/PILL.md`); loom's own
installation is documented in the loom repository.

## 1. Loom, running and current

Install and start loom as its README describes, then keep it current with
`loom update`. Loom keys its toolshed store by the labs commit it vendors and
carries the previous store forward on a vendor bump, so an update does not empty
the space.

Read the values the console needs off the running instance:

```sh
curl -s http://127.0.0.1:<loom-port>/config | jq '{serverUrls, identityDid}'
```

- **Toolshed URL**: `serverUrls.toolshed`.
- **Space name**: `defaults.local_space` in the instance's `pieces.json`
  (`~/.local/share/loom/instances/<instance>/pieces.json`).
- **Identity key path**: `defaults.identity` in the same file.
- **Store path**: the toolshed process's `MEMORY_DIR`, a `file://` URL; the
  console reads it as a plain path.

Loom's daemon listens on its base port plus the instance's port offset; the
`/config` route answers on whichever port that is.

## 2. The console, on loom's fabric

From a labs checkout, in `packages/cf-harness`, with the values from step 1:

```sh
export CF_HARNESS_FABRIC_API_URL=<toolshed URL>
export CF_HARNESS_FABRIC_IDENTITY=<identity key path>
export CF_HARNESS_FABRIC_SPACE=<space name>
export MEMORY_DIR=<store path>
export CF_HARNESS_CONSOLE_PORT=8135
export CF_HARNESS_CONSOLE_DIR=<directory for console state>
deno task console
```

Add the pattern index and skills registry URLs your deployment uses, the CFC
posture flags, and the `runsc-cfc` result and invocation-context directories as
the console README describes; an enforcing posture refuses to start without the
sandbox directories. Launch the process so it outlives the shell that started
it; macOS has no `setsid`, so a double fork with `nohup` is the usual form.

Verify before opening Weaver:

- `GET /api/health` reports `fabricApiUrl` as loom's toolshed.
- `GET /live/x` answers 200: the live pane the pill embeds is served.
- The startup block prints the space, the fabric API URL, and the index and
  skills registry URLs. The skills root and docs corpus the run resolved are
  recorded in each run's state and printed in the operator summary, not at
  startup.

A wire check without Weaver: fetch `/` for the token cookie, `POST /api/task`
with `{"text": "a hello card"}`, and when the turn ends open
`http://127.0.0.1:<loom-port>/pattern-pane/<space>/<slug>`.

## 3. Weaver, built and configured

Build and install Weaver from its repository's deploy script, signed for its
team; the repository's new-machine setup notes cover signing and registering the
Mac. Then, in Weaver's settings under Services:

- **Common Fabric**: the daemon port, when the instance does not run at the
  default.
- **Harness console**: the console base URL, `http://127.0.0.1:8135` by default.
  Test reports the console healthy and names its fabric API URL.

## 4. Drive it

- `/patterns <query>` lists index hits with their ids.
- `/cf-harness <task>` starts a fresh session and places the live panel in the
  current loom. A turn runs for minutes; the panel streams throughout, and the
  piece replaces it when the turn ends.
- `more <text>` continues the last session.
- The console at its base URL holds every run: transcript, policy trace, the CFC
  withheld markers, and `deno task cfc-audit <run dir>` audits a family.

## Limits

- A harness-built piece is slugged in the space and not registered in loom's own
  piece registry, so it renders by slug but does not appear where loom lists
  registered pieces.
- Weaver's pattern-pane family can blank a hibernated pane, and a loom sync can
  prune components that are not on the stage; both belong to Weaver.
