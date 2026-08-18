---
status: historical
created: 2026-08-19
archived: 2026-08-19
reason: "Decision record for the topics reference-graph contract break shipped in #5921 — the first accepted break in the pattern-update registries. Backfilled from the shipping change's own prose when the registries gained their record linkage."
---

# Topics reference-graph contract break (#5921)

The first contract break the repository decided to ship, and the change that
introduced the accepted-break registries it is recorded in
(`tasks/pattern-compat-accepted-breaks.ts`,
`tasks/pattern-vintage-accepted-drops.ts`). This record is a backfill: the
deliberation below is taken from the shipping change's own prose
([#5921](https://github.com/commontoolsinc/labs/pull/5921), merged
2026-08-18), recorded when the registries gained their required `record`
linkage.

## The decision

A topic's references became cell references rather than ids. The board derives
the whole reference graph once, in one pivot, and every topic reads its own row
out of the result by identity; rows are addressed by `Writable.for(topic)`, so
a row keeps its address wherever the board reorders it. An index row IS the
topic it describes, so the row's own address is the topic's address, and the
copied `fid` field goes with the copy.

## What broke, on purpose

- The old prose reference-graph row (`crossrefs` and its per-topic and
  per-mentionable copies) is gone wholesale; the pivot row that replaced it
  carries a topic and who mentions it. Nothing of the old row survives to be
  compared field by field.
- `mention`'s payload stopped being `unknown` and now names `title` — a real
  tightening of what the verb accepts, so it can tell a reference from a
  non-reference in one read and reject an entry that resolves to no piece.
- Stored topics' defaults moved (`title`, `body`, `createdByName` gained one)
  so the board's card list can be declared over the topic itself rather than
  over a card-shaped copy.

## Disposition of deployed pieces

Pieces holding the old shape are accepted casualties of the removed surface:
the runtime updater refuses contract-changing swaps on ordinary pieces and
`cf piece setsrc` refuses unprovable updates, so old pieces keep running their
old source rather than breaking in place. Vintages captured before the rebuild
(`capturedThrough: 2026-08-06T23-04-13.189Z`) are forgiven exactly the removed
paths and nothing else; vintages captured after hold pivot rows and are
compared with no exemption.
