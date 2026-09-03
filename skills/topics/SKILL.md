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
cf piece verbs --cell "$TOPICS_BOARD" --json
```

That listing includes the deployed pattern reference, callable prose, and input
and output schemas. `cf piece describe --cell "$TOPICS_BOARD" --json` returns a
superset of it (the same verb rows plus name, purpose, state, and inputs) for
the same bounded discovery load. Neither command starts the piece; the reason to
default to `verbs` is payload, not time: the listing is the smaller document to
hold in context, and it is complete for calling. Use `describe` when you need
the piece-wide purpose, state, or input documentation. Use
`cf piece call --cell "$TOPICS_BOARD" <verb> --help --json` only after choosing
a verb and when its generated flags or standalone help are useful; help is
served through the dispatch path, which also starts the space root, so it is the
most expensive of the three. Each command is an independent cold CLI process, so
do not run all three by default.

The deployment can be well behind the checkout the CLI runs from, and that gap
explains board behavior that would otherwise read as a defect. Ask it which
commit it serves before recording one:

```bash
curl -fsS "$CF_API_URL/api/meta" | jq -r .gitSha
```

Resolve that in the repository — `git log --oneline -1 <sha>`, and
`git rev-list --count <sha>..upstream/main` for the distance — before concluding
anything from a verb that behaves unlike the source in front of you. A gap of
dozens of commits is ordinary, so which source is running is the first question,
not the last.

Run `piece verbs --json` again after selecting a Topic, and use `describe` or
per-verb help on demand. `piece verbs` lists contract verbs by default; `--all`
additionally shows UI wrappers and deprecated verbs. The board's published Topic
rows deliberately contain no verbs: take a row's address and call that Topic
directly.

The current declared contract is:

| Piece | Verb            | Input                                           | Declared result       |
| ----- | --------------- | ----------------------------------------------- | --------------------- |
| Board | `addTopic`      | `title`, optional `body`, `agentName`           | created `topic`       |
| Topic | `addComment`    | `body`, `agentName`                             | appended `comment`    |
| Topic | `addLink`       | `url`, optional `kind` and `label`, `agentName` | appended `link`       |
| Topic | `setBody`       | complete `body`, `agentName`                    | body and attribution  |
| Topic | `setTitle`      | `title`, `agentName`                            | title and attribution |
| Topic | `mention`       | Topic reference                                 | none                  |
| Topic | `unmention`     | Topic reference                                 | none                  |
| Topic | `editComment`   | comment reference, `body`, `agentName`          | body and `editedAt`   |
| Topic | `removeComment` | comment reference, `agentName`                  | the retraction stamp  |
| Topic | `removeLink`    | link reference **or** `url`, `agentName`        | url and stamp         |

A retraction stamps the record rather than deleting it: the comment or link
stays, carrying what it always said, while readers stop showing it and
`commentCount` stops counting it. A retracted link also stops resolving into
`mentions`. Retracting is not a way to make something unsaid — the evidence is
retained deliberately.

`editComment` and `removeComment` name their target by REFERENCE, and a comment
is not a piece: it has no fid to write into an inline JSON event, so these are
reachable from a reader that holds the row, not from a bare `cf piece call`.
`removeLink` is the exception and takes `url` for exactly that reason,
retracting the most recently added link still present with that URL — so
retracting twice retracts two rather than re-stamping one.

## Discover and read

Survey through the compact `index`. Its rows are Topics, and `@` asks for each
row's canonical address without expanding its body, thread, or verbs:

```bash
cf cell get "$TOPICS_BOARD" index --step \
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

That rule is about writing an address. Reading one has a counterpart: a Topic
answers to more than one address, so two that differ as strings can name the
same Topic. The `$link` a `mention` edge carries is not the string the board
index hands out for the Topic it points at. Resolve each address and compare
what comes back rather than comparing the addresses, and compare on something a
separate document would not share — `createdAt`, or the comment thread — since a
title alone can be duplicated. An address you do not recognise on an edge is not
evidence the edge is wrong.

Read one Topic's durable input before changing it:

```bash
cf cell get --cell "$TOPIC" title --input
cf cell get --cell "$TOPIC" body --input
cf cell get --cell "$TOPIC" comments --input \
  --select sentAt,author.kind,author.name,body
cf cell get --cell "$TOPIC" links --input \
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
CREATE="$(cf piece call --cell "$TOPICS_BOARD" \
  --invocation '<unique-topic-create-id>' \
  addTopic \
  '{"title":"<title>","body":"<initial living document>","agentName":"Sol"}' \
  -- --schema '{"properties":{"topic":{"$link":true}}}')"
TOPIC="$(printf '%s\n' "$CREATE" | jq -r '.result.topic["$link"] // empty')"
```

When the result is present, carry `TOPIC` into the next command. Use JSON
encoding or schema-derived flags for multiline Markdown; do not interpolate
unescaped content into JSON.

Current Estuary calls have a known observation asymmetry. `addTopic` has
reported an error after committing and has reported success without committing.
A call can also answer nothing at all: `addTopic` and `addLink` have each hung
past a ten-minute client timeout and committed, and an `addTopic` has hung the
same way and not committed. A timeout therefore settles nothing in either
direction, and none of this is particular to `addTopic` — take it as the
behavior of every authored-content verb.

So treat every call envelope, and every absence of one, as an observation rather
than proof of durable state, and read back after every mutation. For `addTopic`,
use a distinctive title and compare the narrow board index before and after the
call; if the result is uncertain, recover its `$link` there rather than blindly
creating another Topic. Retrying on the strength of a timeout is how one Topic
becomes two.

```bash
cf cell get "$TOPICS_BOARD" index --step --select @,title
cf cell get --cell "$TOPIC" title --input
```

Use one invocation session per agent run and an explicit invocation id per
logical mutation. Retry an uncertain mutation only with that same session/id
pair. The full retry and receipt model is in `skills/cf/SKILL.md` and
`docs/common/verbs/over-the-cli.md`.

## Update through Topic verbs

```bash
cf piece call --cell "$TOPIC" --invocation '<unique-set-title-id>' setTitle \
  '{"title":"<complete new title>","agentName":"Sol"}'
cf piece call --cell "$TOPIC" --invocation '<unique-set-body-id>' setBody \
  '{"body":"<complete revised body>","agentName":"Sol"}'
cf piece call --cell "$TOPIC" --invocation '<unique-add-comment-id>' addComment \
  '{"body":"<point-in-time update>","agentName":"Sol"}'
cf piece call --cell "$TOPIC" --invocation '<unique-add-link-id>' addLink \
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
cf piece call --cell "$TOPIC" --invocation '<unique-mention-id>' mention \
  "{\"topic\":\"$OTHER_TOPIC\"}"
cf piece call --cell "$TOPIC" --invocation '<unique-unmention-id>' unmention \
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
