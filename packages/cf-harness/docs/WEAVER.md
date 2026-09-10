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

The instance records everything the console needs to share its fabric, and the
launcher in step 2 reads those records itself. Two of them decide whether a run
works at all, so they are worth knowing by name:

- **The store**, which `loom toolshed-store-dir <instance>` prints. Loom keys it
  by the labs commit it vendors, so the value changes under an operator on every
  `loom update`. A console pointed at a superseded store starts cleanly and
  reads the space as empty. It is printed as a `file://` URL, which is what the
  toolshed reads `MEMORY_DIR` as; the console reads that variable as a directory
  to walk, so it is given the plain path. A `file://` URL there walks nothing
  and the console reads another store's cells as this space's.
- **The `runsc-cfc` sidecar directories**, which are not loom's at all: the
  Docker runtime registration names them in `--cfc-result-dir` and
  `--cfc-invocation-context-dir`, and `docker info` reports what the running
  daemon actually loaded. The harness asks only that they are named, so a
  console pointed anywhere else starts cleanly and denies every observation of
  the run. Fix a wrong one where the runtime is registered, then restart Docker
  so the daemon reloads it — an edited `daemon.json` it has not read is not what
  `docker info` reports, and the registration in force is the one that counts.

The rest — the identity key at `defaults.identity`, the space at
`defaults.local_space`, and the toolshed URL at `defaults.server_urls.toolshed`
— live in the instance's `pieces.json`
(`~/.local/share/loom/instances/<instance>/pieces.json`). Loom's daemon listens
on its base port plus the instance's port offset, and answers `/config` on
whichever port that is:

```sh
curl -s http://127.0.0.1:<loom-port>/config | jq '{serverUrls, identityDid}'
```

## 2. The console, on loom's fabric

One command starts a console on a loom instance's fabric. From a labs checkout:

```sh
deno task --cwd packages/cf-harness console:loom \
  --instance <instance> \
  --pattern-index-url <index URL> \
  --skills-registry-url <registry URL>
```

It resolves the identity, the space and the toolshed URL from the instance's
`pieces.json`, the store from `loom toolshed-store-dir`, and the two sidecar
directories from the `runsc-cfc` registration `docker info` reports. It prints
every value beside the record that decided it, and serves on 8135 — the port
Weaver's harness console setting and loom's proxy both address. Read the
printout before opening Weaver: a value that is wrong names where to fix it, and
the three sources are three different places.

Everything the launcher cannot derive is a flag, and its absence is an error
naming it rather than a default nobody chose. A pattern index and a skills
registry belong to a deployment rather than to loom, so name each one or waive
it with `--no-pattern-index` or `--no-skills-registry`. `--port` moves the
console, `--console-dir` moves its state, and `--fabric-cfc-posture`,
`--fabric-cfc-flow-labels` and `--fabric-cfc-enforcement-mode` move it off the
enforcing posture the launcher otherwise runs under. Arguments after `--` reach
the console untouched, so every other flag it takes —
[`../console/README.md`](../console/README.md) has them — is reachable through
this one path:

```sh
deno task --cwd packages/cf-harness console:loom --instance <instance> \
  --pattern-index-url <index URL> --skills-registry-url <registry URL> \
  -- --host-mount name=corpus,source=/absolute/corpus,target=/corpus
```

**One console per state directory.** The launcher names a directory per instance
and port, so two consoles started this way keep separate runs, sessions and
workspaces on their own. A `--console-dir` naming a directory another console is
already using interleaves both consoles' run records.

Launch the process so it outlives the shell that started it; macOS has no
`setsid`, so a double fork with `nohup` is the usual form.

To let `/cf-harness` collect existing assets into durable Looms, the console
also needs an explicit host authoring configuration. The shared Fabric identity
above is not a grant to the separate Common Fabric Service command host. Save a
private host file (outside the model workspace) with absolute paths:

```json
{
  "cliPath": "/absolute/loom/src/bin/loom",
  "transport": {
    "kind": "direct",
    "instanceDir": "/absolute/loom/instances/your-instance",
    "runId": "weaver-console",
    "actor": "agent:cf-harness"
  }
}
```

Set `CF_HARNESS_LOOM_AUTHORING_CONFIG` to that file's absolute path in the
console's launch environment, then restart the console with its existing Fabric
and provider settings. Use the CLI and instance corresponding to this console's
Fabric; do not reuse a different bench's file. The CLI must support the direct
transport flag and three authoring commands described in
[Durable Loom authoring](LOOM_AUTHORING.md). Each interactive session derives a
separate stable receipt namespace from this configured base run identity.
Without the file the console still builds Patterns, but it offers no Loom tools.
Start a new session after changing the policy; existing sessions keep their
recorded tool grants.

Verify the console before opening Weaver, on the host it runs on:

- `GET /api/health` reports `fabricApiUrl` as loom's toolshed.
- `GET /api/status` names the run directory the launcher printed.
- `GET /live/x` answers 200: the live pane the pill embeds is served.

A wire check without Weaver: fetch `/` for the token cookie, `POST /api/task`
with `{"text": "a hello card"}`, and when the turn ends open
`http://127.0.0.1:<loom-port>/pattern-pane/<space>/<slug>`.

## 3. The stack over a tailnet

The Weaver runs on the operator's own Mac and the whole of the rest of the stack
runs on the loom host, so a Weaver that is not on that host reaches everything
through Tailscale. Three routes carry it, and each is a Tailscale serve entry on
the loom host:

| What the Weaver opens                    | Route                           | Serves                                           |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------ |
| The loom app, the pill, the pattern pane | `<loom base>/`                  | the daemon on 9900                               |
| The harness console                      | `<loom base>/harness-console/*` | the daemon, which proxies to the console on 8135 |
| A pattern's runtime                      | `https://<host>.ts.net:8000/`   | the toolshed                                     |

`<loom base>` is whichever front reaches the daemon. Loom's matching-port
topology fronts it on its own port, so the base is `https://<host>.ts.net:9900`;
a bench that has also configured the page-link root route reaches it at
`https://<host>.ts.net` as well. Either is a base to give Weaver, and the
console's route hangs off whichever one it was given — there is no separate
console front to configure.

**Those two port numbers belong to an instance at no port offset. An instance at
an offset serves its own.** Its daemon and toolshed sit at the base port plus
the offset, and the ports in the serve entries, in the preflight below, and in
every URL here are that instance's — `defaults.server_urls` in its `pieces.json`
is what says which. An instance at offset 1 runs its daemon on 9901 and its
toolshed on 8001, and a route left on 9900 and 8000 fronts nothing it owns. Read
the ports off `pieces.json` before serving anything, never from this table.

The console needs no serve entry of its own: loom's daemon reverse-proxies
`/harness-console/*` to the loopback address the console binds, rewriting the
`Host` header the console's own gate insists on. Weaver derives that URL from
the loom base it resolved, so its harness console setting is left blank for a
remote loom and holds `http://127.0.0.1:8135` for a local one.

The console's port is the one place the offset does not reach: the daemon
proxies to 8135 whatever the instance's offset, because that is the port Weaver
pairs with. Three things decide it, in order — `defaults.harness_console_port`
in `pieces.json`, then a `CF_HARNESS_CONSOLE_PORT` the daemon itself inherited,
then 8135. The middle one is the one to check when the route reaches nothing: a
daemon started from a shell that exported the console's own variable proxies
wherever that shell said, which is not what `pieces.json` records. Move the
console with `--port` and record the new port in `pieces.json`, so the daemon
and the launcher agree from one place.

**The toolshed's own port is required, and its absence is silent.** Loom rebases
the loopback URLs in `/config` onto the host the request arrived at and keeps
the port, so a tailnet client is handed `https://<host>.ts.net:8000` for the
fabric API. With nothing serving that port a pattern's runtime cannot boot and
hands out no port, while the static render keeps working because it rides the
front that already reaches the daemon — the pane looks healthy and is dead. The
loom repository's `docs/operations/tailnet.md` gives the matching-port serve
topology, one entry per service with the external port matching the internal
one, and `loom doctor` reports an instance that fronts its daemon without
fronting its toolshed.

## 4. Pre-demo preflight

Run all four from the operator's Mac, against the loom host's tailnet name, in
this order. Each one fails in a way the next cannot diagnose.

```sh
FRONT=https://<host>.ts.net

# 1. The serve topology carries the daemon's front and the toolshed's own port.
tailscale serve status

# 2. The URLs a pattern's runtime is handed resolve from this device.
curl -s "$FRONT/config" | jq '.serverUrls'
curl -s -o /dev/null -w '%{http_code}\n' "$(
  curl -s "$FRONT/config" | jq -r '.serverUrls.toolshed'
)"

# 3. The console answers behind the daemon's prefix.
curl -s -o /dev/null -w '%{http_code}\n' "$FRONT/harness-console/api/health"

# 4. The live pane the pill embeds is served behind that prefix.
curl -s -o /dev/null -w '%{http_code}\n' "$FRONT/harness-console/live/x"
```

Both `/api/health` and `/live/x` answer 200, and the toolshed URL `/config`
hands out answers rather than refusing to connect. A `serverUrls` entry that
resolves from the loom host and not from this device is the half-fronted tailnet
in section 3.

## 5. Weaver, built and configured

Build and install Weaver from its repository's deploy script, signed for its
team; the repository's new-machine setup notes cover signing and registering the
Mac. Then, in Weaver's settings under Services:

- **Common Fabric**: the daemon's base URL — the tailnet front for a remote
  loom, or the daemon port when a local instance does not run at the default.
- **Harness console**: left blank for a remote loom, where Weaver derives
  `/harness-console/` from the loom base; `http://127.0.0.1:8135` for a console
  on this Mac. Test reports the console healthy and names its fabric API URL.

## 6. Drive it

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
