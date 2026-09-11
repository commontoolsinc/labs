# Discover and read

Part of `skills/topics/SKILL.md`, which is the map. This is the detail on
surveying the board and reading one Topic.

Survey through the compact `index`. Its rows are Topics, and `@` asks for each
row's canonical address without expanding its body, thread, or verbs:

```bash
deno task cf cell get "$TOPICS_BOARD" index --step \
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
deno task cf cell get --cell "$TOPIC" title --input
deno task cf cell get --cell "$TOPIC" body --input
deno task cf cell get --cell "$TOPIC" comments --input \
  --select sentAt,author.kind,author.name,body
deno task cf cell get --cell "$TOPIC" links --input \
  --select kind,url,label,addedAt,addedBy.kind,addedBy.name
```

Use exact-field or range `--filter` predicates to narrow arrays, then project
with `--select`. Do not combine an address marker with `--filter`: filtering
changes positions, so a surviving row cannot carry its original address.

Input reads are the durable source of truth. Use `--step` for computed results
such as the board's `index` and a Topic's `commentCount`, `lastActivityAt`,
`mentions`, or `referencedBy`.

Do not substitute `piece ls` for the board index: handler-created Topics need
not appear in the registry.
