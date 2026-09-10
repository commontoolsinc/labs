---
status: historical
created: 2026-09-09
archived: 2026-09-09
reason: "Decision record for the pattern-result `ifc` contract break: why a builder-synthesized covering clause on a pattern's result schema had to go, and what happens to pieces deployed under it."
---

# Pattern result `ifc` contract break (#7220)

`factoryFromPattern` joined the least upper bound of every
`ifc.confidentiality` atom appearing anywhere in a pattern's argument schema
onto the ROOT of its result schema. Storing a result document under that schema
mints an `origin: "declared"` label entry at path `[]`, which is a covering
label: it inherits down to every field, `$UI` among them, so the display
ceiling denies the pattern's whole rendered sub-view rather than the fields
that carry the label. Dropping the join changes the `ifc` on the result, and
the compatibility proof compares `ifc` for exact equality, so the correction
reads as a contract break against every baseline recorded for a pattern with a
confidential argument. This record is the deliberation behind the entries in
`tasks/pattern-compat-accepted-breaks.ts`.

## The decision

CFC §8.12.8 gives a persisted path three label components. The `declared`
component's provenance is "Schema `ifc` declarations and explicit store-label
operations" and its discipline is monotone; the `derived` component holds a
transaction's measured dependency under replace-on-overwrite, and the section
states that a runtime must not apply the monotone constraint to it, because a
ratchet over a measurement is label creep.

The join measured no transaction. It was computed from the shape of an
argument schema, before anything was read, and written into the declared
component — so a measurement acquired the monotone discipline reserved for
store policy. §8.9.2 takes the conservative join over "the set of observations
consumed by the handler in this attempt", and §4.6.3 says the label of a
structured read is "the join of the observations actually consumed". A pattern
body is handed reactive references and throws on a value read, so its build
consumes no observation of an argument. §8.9.1 calls that class of exclusion a
structural fact of the journal rather than a claim, needing no
`flow-taint-precision` trust.

What carries an argument's label into a pattern's result is per field, and
those carriers are untouched: an alias holds the argument cell's own label
through the link machinery, a lift or handler output holds the join its module
makes onto its own result, and the flow-labels dial writes the per-transaction
join as the derived component.

## What broke, on purpose

- `result`: the covering `ifc.confidentiality` clause the builder synthesized
  at the result schema's root is gone. Every `ifc` an author wrote stays where
  they wrote it.

Three patterns declare a confidential argument and so record a baseline
carrying that clause:

- `budget-tracker/confidential.tsx` — baseline root `ifc` was
  `{confidentiality: ["expense-note"]}`, while the author's declaration sits on
  `$defs.ConfidentialExpense.properties.description` and stays.
- `cfc-input-cell-demo/briefing.tsx` and `cfc-input-cell-demo/seed.tsx` — the
  same shape, over `demo-secret`.

That is the whole break. It was verified by restoring the join alone, with
every other change in place, and confirming the compatibility proof then
reported nothing for these patterns — so no second break is hiding behind the
one accepted here.

## Why these three patterns wanted the narrowing

Each was written to demonstrate a per-field label, and the synthesized clause
contradicted the demonstration in its own source.

`budget-tracker/confidential.tsx` says a space seeded through it "persists a
declared label on every record's `description` while `amount`, `category`, and
`date` stay inert". Under a covering root clause those three fields were not
inert: a read of any of them consumed the clause.

`cfc-input-cell-demo/briefing.tsx` says of its two results that "a reader that
colored a cell by the label its containing object carries would call both
confidential; the difference lives in each cell's own derived label". The root
clause put the label on the containing object, which is the reading that
pattern exists to rule out.

## Disposition of deployed pieces

A piece deployed under one of these contracts keeps its stored labels. Store
confidentiality is grow-only, so the declared entry already written at the
document root stays there: nothing a reader could not see before becomes
visible, and no write that fitted stops fitting. What such a piece loses is the
ability to be updated in place onto the narrowed contract — `cf piece setsrc`
refuses an update it cannot prove, and the automatic updater refuses a
contract-changing swap.

Nothing is stranded that was working. A piece holding one of these contracts
renders nothing under the display ceiling, because the covering clause denies
its whole view; that is the defect being corrected. Re-instantiating the
pattern is what reaches the narrowed contract, and because dropping the root
`ifc` changes the pattern's serialized form, a fresh instantiation addresses a
new result document rather than inheriting the old one's declared entry.
