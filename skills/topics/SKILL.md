---
name: topics
description: Interact with the Common Fabric team's Topics board on Estuary through
  the Labs cf CLI. Use when reading, creating, or updating Topics; posting Topic
  progress comments; attaching pull request links; or adding references between
  Topics.
---

# Topics on Estuary

Topics is the team's minimal issue tracker: a board piece holding Topic pieces
on Estuary, driven through `cf`. This file is the map. Each file under
`references/` carries the detail for one part of the work and is the thing to
read once you are doing that part. `skills/cf/SKILL.md` is the general CLI
surface; the pattern's canonical semantics are
`packages/patterns/topics/README.md`, and its verb contracts
`packages/patterns/topics/main.tsx` and `packages/patterns/topics/topic.tsx`.

## Where, and as whom

Run from inside the Labs checkout. Every command in this skill and its
references is spelled `deno task cf`, which runs that checkout's CLI from any
directory in it and needs nothing on PATH; `skills/cf/SKILL.md` covers the other
routes. Shell state rarely survives between an agent's tool calls, so set these
in the same invocation as the command that needs them:

```bash
export CF_API_URL='https://estuary.saga-castor.ts.net'
export CF_SPACE='topics-dev-476ea34f'
export TOPICS_BOARD='/of:fid1:jtdD-DSmuGrLGSt_6sJ3DS_7jmerrkKTEnW3fZV9e34'
export CF_IDENTITY="${CF_IDENTITY:-$HOME/.config/commonfabric/identity.key}"
```

The key is the team's per-user default at that path, the same one your human
user holds; an already-set `CF_IDENTITY` is the explicit override. When `cf`
reports the keyfile missing or unreadable, stop and ask the human to provision
that default or export the correct path: the check belongs to `cf`, so the shell
never touches the key. Do not search for keys, mint an agent key, use another
human's key, or use the publicly derivable `implicit trust` identity, and never
print or inspect key material; `deno task cf id did "$CF_IDENTITY"` gives the
public DID when one is needed.

Every authored-content mutation carries `agentName` in the same event: one
stable agent name, and no second signature in titles, labels, bodies, or
comments. Fabric retains the human principal behind the key; Topics stores the
agent name as content attribution. `mention` and `unmention` record only a
reference edge and take no `agentName`.

## What holds throughout

- The running piece is authoritative, and the deployment is routinely dozens of
  commits behind the checkout. Read the board's `piece verbs` listing before
  mutating, and the commit its `/api/meta` reports before recording one or
  reading a verb's behavior as a defect.
- Discovery is bounded: survey the projected `index`, expand one Topic at a
  time, and take an emitted `$link` unchanged.
- A call's envelope, or its absence, is an observation and not proof of durable
  state. One invocation session per run, one invocation id per logical mutation,
  a read-back after every write, and no retry on the strength of a timeout,
  which is how one Topic becomes two.
- The body is the living document, replaced whole; comments are append-only,
  point-in-time progress; every relevant pull request is an `addLink` with
  `kind: "pr"`; relationships between Topics are references, never pasted fids.
- Changing the board's or a Topic's pattern source is a production migration
  over team-critical data, held behind the rehearsal and authorization rules in
  `references/pattern-updates.md`.

## The detail, by task

| Read                               | When you are                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `references/verbs.md`              | orienting: the discovery commands and their costs, the deployment gap, the declared contract, retraction and by-reference verbs               |
| `references/reading.md`            | surveying the board or reading a Topic: the index, addresses and how to compare them, durable inputs against stepped results                  |
| `references/naming.md`             | citing or resolving a Topic by its number, `top/42`, and what the deployment carries                                                          |
| `references/mutating.md`           | creating a Topic and recovering its address, the observation asymmetry, the Topic verbs, references between Topics, the editorial conventions |
| `references/pattern-updates.md`    | changing pattern source: `setsrc` rehearsal, `--root`, team authorization                                                                     |
| `references/namespace-backfill.md` | naming the Topics filed before the namespace: the operator procedure and its traps                                                            |
