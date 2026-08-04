---
paths:
  - "docs/**/*.md"
---

# Editing documentation

The full rules are in `docs/README.md`. These are the ones that are easiest to
break without noticing.

## `docs/history/` is a record, not a description

Never edit the content of a document under `docs/history/`. Its value is as a
record of what was true at a moment, so a correction destroys the thing it is
for. Two mechanical edits are permitted and no others: repointing a link whose
target moved, and fixing the metadata header.

A report, an audit, a post-mortem, or any account of completed work is created
in `docs/history/` from the start, with the metadata header defined in
`docs/history/README.md`. It is not written as a live document and archived
afterwards.

## Where a new live document goes

The map in `docs/README.md` says which directory holds what; read it rather
than guessing from the directory names. The part that is easy to skip is what
comes after: every directory has a `README.md` indexing it, and a document
missing from its index is a document nobody will find.

`deno task docs-links --orphan` names those. Run it after moving or renaming
more than one document; it is not a CI gate, so nothing else will tell you.

## Code blocks here are compiled

`deno task check-docs` type-checks the TypeScript and TSX blocks under `docs/`,
`docs/history/` excepted. Most blocks are fragments, so a block picks the
scaffold it compiles inside by opening with a context comment. That vocabulary
is defined in `docs/check.md` and cannot be worked out from the source. Run
`deno task check-docs` after touching a code block.
