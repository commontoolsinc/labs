---
status: historical
created: 2026-08-25
archived: 2026-08-25
reason: "Record of the deliberate contract break taken when the Topics board narrowed what it demands of a stored topic."
---

# Topics: the board's demand narrows to what it uses

The Topics board stored each topic under `TopicPiece` — the topic's whole
published surface, sixteen required members with three verb streams among
them. That declaration is the board's *demand*: the shape it requires of a
stored topic, written into its durable argument schema.

A deployed holder's required demands are write-once. A stream can never carry
a default, so a verb named in the demand cannot be added to later and cannot be
dropped, and every future verb on a topic is priced as a deliberate break of
the board. The board calls no topic verb, so it was paying that price for
nothing.

The demand is now the eight members the board actually uses: `title`, `body`,
`commentCount`, `createdBy`, `lastActivityAt`, `createdAt`, `mentions`, and
`[NAME]`. No verbs. The topic's own demand on its siblings narrows the same
way, because the board hands one array to every child as its mention universe
and the two cannot move independently.

## Why this could not be done compatibly

An argument may not stop requiring a field it already requires, so narrowing a
demand is a break by construction. There is no shape of the board that both
keeps the old demand and stops paying for it.

The break reaches the published side as well, and that is not a separate
decision. A pattern cannot serve a wider view of a stored piece than the one it
requires, so narrowing the demand narrows what the board publishes with it —
`result.mentionable[]` loses the verbs, the comment thread, and the links.
Topics' author accepted that on 2026-08-24: the board is a directory, and a
caller that means to read a topic's detail or call its verbs addresses the
topic by its own address, where the topic's own schema governs.

## What a piece holding the old contract loses

Nothing of its own. A stored topic keeps every field and every verb it has;
what changes is only what the board requires of it and what the board will
serve about it. A caller reaching a topic through the board's projection sees
the eight members above. A caller addressing the topic directly sees
everything, exactly as before.

Every member of the new demand carries a default, so a topic written before a
member existed materializes that default rather than making the whole array
unreadable.

## The paths this break blames

- `argument.topics[]` and `argument.mentionable[]` — the demand itself, on the
  board and on the topic.
- `result.mentionable[].addComment` — the published side, reported through one
  verb because the compatibility proof reports at most one issue per role.

## Accepted alongside

Three baselines carried an accepted-break entry for the earlier crossref
identity change. Under this contract they fail on a path that entry does not
name, so that grant no longer forgives a finding and they move to this break's
entry instead.
