---
name: topics
description: Interact with the Common Fabric team's Topics board on Estuary through
  the Labs cf CLI. Use when reading, creating, or updating Topics; posting Topic
  progress comments; attaching pull request links; or adding references between
  Topics.
---

# Topics on Estuary

Topics is the team's minimal issue tracker. This skill names the Estuary
deployment, the deployed verb contract, and the team's authorship and editorial
conventions. Use `skills/cf/SKILL.md` for the general CLI surface. The pattern's
canonical semantics live in `packages/patterns/topics/README.md`; its verb
contracts live in `packages/patterns/topics/main.tsx` and
`packages/patterns/topics/topic.tsx`.

## Deployment and identity

Run from the Labs repository root so `cf` uses that checkout:

```bash
export CF_API_URL='https://estuary.saga-castor.ts.net'
export CF_SPACE='topics-dev-476ea34f'
export TOPICS_BOARD='/of:fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34'
export CF_IDENTITY="${CF_IDENTITY:-$HOME/.config/commonfabric/identity.key}"
test -r "$CF_IDENTITY" || {
  printf 'Topics identity key is not readable: %s\n' "$CF_IDENTITY" >&2
  exit 1
}
```

An already-set `CF_IDENTITY` is the explicit override. Otherwise use the team's
stable per-user default at `~/.config/commonfabric/identity.key`; the path is
common while its contents belong to that teammate. Use the same Estuary identity
key as your human user. If the readability check fails, stop and ask the human
to provision that default or export the correct path. Do not search for keys,
mint an agent key, use another human's key, or use the publicly derivable
`implicit trust` identity. Never print or inspect key material; use
`cf id did "$CF_IDENTITY"` when the public DID is needed for verification.

Every authored-content mutation carries `agentName` in the same event. Use one
stable agent name, without decorating titles, labels, bodies, or comments with a
second signature. Fabric retains the human principal authenticated by the key;
Topics stores the agent name as structured content attribution.

`mention` and `unmention` are the intentional exception: they record only a
reference edge, take no `agentName`, and return no value.

## Start from the deployed verbs

The running piece is authoritative. Orient before mutating it:

```bash
cf piece describe --piece "$TOPICS_BOARD"
cf piece verbs --piece "$TOPICS_BOARD" --json
cf call --piece "$TOPICS_BOARD" addTopic --help --json
```

Repeat `describe`, `verbs`, and `call <verb> --help --json` after selecting a
Topic. `piece verbs` lists contract verbs by default; `--all` additionally shows
UI wrappers and deprecated verbs. The board's published Topic rows deliberately
contain no verbs: take a row's address and call that Topic directly.

The current declared contract is:

| Piece | Verb         | Input                                           | Declared result       |
| ----- | ------------ | ----------------------------------------------- | --------------------- |
| Board | `addTopic`   | `title`, optional `body`, `agentName`           | created `topic`       |
| Topic | `addComment` | `body`, `agentName`                             | appended `comment`    |
| Topic | `addLink`    | `url`, optional `kind` and `label`, `agentName` | appended `link`       |
| Topic | `setBody`    | complete `body`, `agentName`                    | body and attribution  |
| Topic | `setTitle`   | `title`, `agentName`                            | title and attribution |
| Topic | `mention`    | Topic reference                                 | none                  |
| Topic | `unmention`  | Topic reference                                 | none                  |

## Discover and read

Survey through the compact `index`. Its rows are Topics, and `@` asks for each
row's canonical address without expanding its body, thread, or verbs:

```bash
cf get "$TOPICS_BOARD" index --step \
  --select @,title,createdAt,lastActivityAt,commentCount,createdBy.kind,createdBy.name
```

Keep discovery bounded. An unprojected board or durable `topics` read can follow
every Topic into its body, thread, and verbs, transfer the whole graph, and
append a read-set commit proportional to what it observed. Survey the projected
`index`, then expand one Topic at a time.

Take the selected row's `$link` value unchanged as `TOPIC`; canonical references
compose directly into later commands. The space prefix appears only when the
reference's space differs from the command's target space, so never reconstruct
or edit the emitted address.

Read one Topic's durable input before changing it:

```bash
cf get --piece "$TOPIC" title --input
cf get --piece "$TOPIC" body --input
cf get --piece "$TOPIC" comments --input \
  --select sentAt,author.kind,author.name,body
cf get --piece "$TOPIC" links --input \
  --select kind,url,label,addedAt,addedBy.kind,addedBy.name
```

Use exact-field or range `--filter` predicates to narrow arrays, then project
with `--select`. Do not combine an address marker with `--filter`: filtering
changes positions, so a surviving row cannot carry its original address.

Input reads are the durable source of truth. Use `--step` for computed results
such as the board's `index` and a Topic's `commentCount`, `lastActivityAt`,
`mentions`, or `referencedBy`.

## Create and recover the address

Mint one invocation session for the agent run. Replace every angle-bracketed
invocation placeholder below with an id unique to that logical mutation, and
reuse that id only to retry the same mutation. Create through the board and
project the returned Topic to its address:

```bash
export CF_INVOCATION_SESSION="$(cf invocation-session new)"
CREATE="$(cf call --piece "$TOPICS_BOARD" \
  --invocation '<unique-topic-create-id>' \
  --schema '{"properties":{"topic":{"$link":true}}}' \
  addTopic \
  '{"title":"<title>","body":"<initial living document>","agentName":"Sol"}')"
TOPIC="$(printf '%s\n' "$CREATE" | jq -r '.result.topic["$link"] // empty')"
```

When the result is present, carry `TOPIC` into the next command. Use JSON
encoding or schema-derived flags for multiline Markdown; do not interpolate
unescaped content into JSON.

Current Estuary calls have a known observation asymmetry: `addTopic` has both
reported an error after committing and reported success without committing.
Treat every call envelope as an observation, not proof of durable state. Read
back after every mutation. For `addTopic`, use a distinctive title and compare
the narrow board index before and after the call; if the result is uncertain,
recover its `$link` there rather than blindly creating another Topic.

```bash
cf get "$TOPICS_BOARD" index --step --select @,title
cf get --piece "$TOPIC" title --input
```

Use one invocation session per agent run and an explicit invocation id per
logical mutation. Retry an uncertain mutation only with that same session/id
pair. The full retry and receipt model is in `skills/cf/SKILL.md` and
`docs/common/verbs/over-the-cli.md`.

## Update through Topic verbs

```bash
cf call --piece "$TOPIC" --invocation '<unique-set-title-id>' setTitle \
  '{"title":"<complete new title>","agentName":"Sol"}'
cf call --piece "$TOPIC" --invocation '<unique-set-body-id>' setBody \
  '{"body":"<complete revised body>","agentName":"Sol"}'
cf call --piece "$TOPIC" --invocation '<unique-add-comment-id>' addComment \
  '{"body":"<point-in-time update>","agentName":"Sol"}'
cf call --piece "$TOPIC" --invocation '<unique-add-link-id>' addLink \
  '{"url":"<PR URL>","kind":"pr","label":"<label>","agentName":"Sol"}'
```

`kind` defaults to `web`; a blank or omitted `label` defaults to the URL.
Current authored-content verbs reject blank required content or attribution
instead of reporting apparent success.

Verify the relevant durable input after each call (`title`, `body`, `comments`,
or `links`). Use `--step` as a second check when the expected change is
computed, such as a count or board-index row.

A cross-Topic connection is a reference, not an address pasted into prose. Pass
the canonical reference in the declared reference position; the CLI turns it
into the live piece link the verb expects. Set `OTHER_TOPIC` to the `$link` from
the index row for the Topic being referenced:

```bash
export OTHER_TOPIC='<canonical /of:... address from another index row>'
cf call --piece "$TOPIC" --invocation '<unique-mention-id>' mention \
  "{\"topic\":\"$OTHER_TOPIC\"}"
cf call --piece "$TOPIC" --invocation '<unique-unmention-id>' unmention \
  "{\"topic\":\"$OTHER_TOPIC\"}"
```

Use inline JSON for these reference events. The schema-derived `--topic` flag
parses its declared object before reference resolution and therefore rejects a
bare canonical address.

`unmention` removes every `mention`-made edge to that Topic. References created
inside the body are removed by editing the body. An `addLink` URL that resolves
to a piece also contributes to the reference graph.

## Editorial conventions

- Treat the body as the living big-picture document. Replace it whole with the
  current state while preserving meaningful context and decisions. Fabric owns
  revision history; do not duplicate it as an activity log.
- Treat comments as append-only, point-in-time progress records. Record what
  changed, what was learned or decided, and what comes next.
- Add every relevant pull request explicitly with `addLink` and `kind: "pr"`;
  mentioning a PR only in prose is not enough.
- Use references for relationships between Topics. Do not rely on pasted fids or
  prose scanning.

## Production pattern updates

Changing content through verbs is normal. Changing the board or Topic pattern
source is a production migration over team-critical data. Before any `setsrc`,
read `docs/development/space-clone-rehearsal.md` and the latest Topics migration
record in `docs/history/topics-board-migration-2026-08-28.md`. Do not use
`--dangerously-allow-incompatible-schema` without explicit team authorization.

Do not substitute `piece ls` for the board index: handler-created Topics need
not appear in the registry. If a deployed field or verb differs from this map,
trust `piece describe`, `piece verbs`, and verb help, then update this skill in
the same change that updates the deployment contract.
