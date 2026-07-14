# Documentation

Every document in this repository is in one of two categories, and the
category determines whether the document may be edited. This applies to
`docs/`, to package-level documents under `packages/`, and to tool documents
under `tools/`.

The test for which is which: if the system changed, would someone edit this
document, or write a new one and leave this one alone? Edit it — it is live.
Write a new one — it is historical.

## Live documentation

Live documentation describes the repository as it is now, or work that is
still intended. Orientation documents and READMEs, concept guides and
tutorials, reference documentation, debugging guides, skills, specs that
govern current or planned behavior, and plans that have not yet been executed
are all live. Everything outside `docs/history/` is live.

Live documentation carries an obligation: **if you change behavior that a
live document describes, update that document in the same change.** A live
document that no longer matches the code is a bug. This applies to human and
AI contributors alike.

## Historical documentation

[`docs/history/`](history/README.md) holds point-in-time records: audit
reports, migration notes, investigation findings, profiling reports, executed
or abandoned plans, and superseded designs. Their value is as a record of
what happened or what was known at a moment, so their content is **never
updated**. Each one carries a metadata header giving at least its creation
date. The rules and the header format are in
[`history/README.md`](history/README.md).

## Moving a document from live to historical

A live document becomes historical when its status changes. Typical triggers:
a plan lands its last phase or is abandoned; a design ships and the document
now describes the change rather than the system; a report's measurements
describe code that no longer exists. When you notice this — most often
because your own change is what completed the plan — archive the document:

1. `git mv` it to `docs/history/<original path>`, dropping a leading `docs/`
   from the original path (so `docs/specs/foo.md` becomes
   `docs/history/specs/foo.md`, and `packages/cli/BAR.md` becomes
   `docs/history/packages/cli/BAR.md`).
2. Prepend the metadata header described in
   [`history/README.md`](history/README.md).
3. Fix references: repoint links elsewhere in the repo to the new path, and
   fix relative links inside the moved document so they still resolve. After
   that, an archived document receives only the edits
   [`history/README.md`](history/README.md) permits: mechanical link fixes
   and metadata-header corrections.
4. Add a one-line entry for it to the index in
   [`history/README.md`](history/README.md).

## Creating a new historical document

Reports, audits, post-mortems, and records of completed work should be
created directly in `docs/history/`, with the metadata header, rather than
created as live documents and archived later. A plan you intend to execute
starts in `docs/plans/` (a pending plan is live) and is archived when it is
done.

## Map of this tree

- [`common/`](common/README.md) — pattern-author documentation: concepts,
  components, conventions, workflows
- [`development/`](development/DEVELOPMENT.md) — runtime-developer
  documentation: style, testing, debugging, subsystem internals
- [`specs/`](specs/README.md) — technical specifications of current and
  intended behavior
- [`plans/`](plans/README.md) — pending implementation plans
- [`tutorial/`](tutorial/README.md) — the two-part system tutorial
- `future-tasks/` — parked ideas and future work
- `features/` — feature design documents
- [`history/`](history/README.md) — archived point-in-time records (see
  above)
- [`check.md`](check.md) — how the TypeScript code blocks embedded in these
  documents are type-checked in CI (`deno task check-docs`); `history/` is
  exempt
