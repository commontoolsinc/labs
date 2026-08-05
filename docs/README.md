# Documentation

How this repository writes things down: comments in code, and documents.

Every document in this repository is in one of two categories, and the
category determines whether the document may be edited. This applies to
`docs/`, to package-level documents under `packages/`, and to tool documents
under `tools/`.

The test for which is which: if the system changed, would someone edit this
document, or write a new one and leave this one alone? Edit it — it is live.
Write a new one — it is historical.

## Comments in code

A comment carries what the code cannot say on its own. The code speaks for
itself, so a comment describes rather than defends it.

- Say what the behavior is. Do not argue for this approach over one that was
  not taken.
- Do not describe what the code would otherwise do, or what it used to do. A
  reader has the code in front of them and the history a command away.
- Leave issue and ticket numbers out. The commit message and the branch name
  carry that trail, and they stay accurate when the tracker changes.
- Leave asides out. A comment is read by people who were not present for the
  conversation that produced it.
- When the reasoning is longer than a comment can hold, write it down under
  `docs/features/` and have the comment name that document. Several invariants
  in this repository are held that way, and the pairing is what keeps a subtle
  constraint from being edited away by someone who never saw the argument for
  it.

Public interfaces additionally carry descriptive JSDoc; see the style section
of [`development/DEVELOPMENT.md`](development/DEVELOPMENT.md).

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

Steps 3 and 4 are the ones that go wrong quietly, and `deno task docs-links`
checks both: `--orphan` names every document nothing links to, which is what a
missed index entry looks like from the outside. It is worth running whenever
you move or rename more than one document at a time — see
[`development/README.md`](development/README.md#tools) for its other modes.

## Creating a new historical document

Reports, audits, post-mortems, and records of completed work should be
created directly in `docs/history/`, with the metadata header, rather than
created as live documents and archived later. A plan you intend to execute
starts in `docs/plans/` (a pending plan is live) and is archived when it is
done.

## Spelling

Prose written here — comments, documents, error and log messages, test
descriptions — uses American spellings: `behavior`, `color`, `center`,
`serialize`, `analyze`, `gray`.

This is standardization rather than a claim about which English is better: one
spelling per word means a search for a word finds all of it, and this is the
variety already in overwhelming use in these files.

Two carve-outs. Material quoted from outside — a dependency's name, a message
relayed from another system, a specification's wording, a data file's contents
— keeps whatever spelling it arrived with. And an identifier vocabulary
already established in the codebase, `cancelled` among them, is a rename
rather than a spelling fix: match the surrounding code, and treat a change to
it as the code change it is.

## Map of this tree

- [`why.md`](why.md) — the short statement of what Common Fabric is for and
  which parts already run
- [`FAQ.md`](FAQ.md) — frequently asked questions with pointers to the
  authoritative answers
- [`common/`](common/README.md) — pattern-author documentation: concepts,
  components, conventions, workflows
- [`development/`](development/README.md) — how to work in this repository:
  style, dependencies, running things locally, testing, debugging, and the
  policies that govern continuous integration
- [`features/`](features/README.md) — one document per feature, or per aspect
  of the runtime: how it behaves and what to know before changing it
- [`specs/`](specs/README.md) — technical specifications of current and
  intended behavior
- [`plans/`](plans/README.md) — pending implementation plans
- [`tutorial/`](tutorial/README.md) — the two-part system tutorial
- [`history/`](history/README.md) — archived point-in-time records (see
  above)
- [`check.md`](check.md) — how the TypeScript code blocks embedded in these
  documents are type-checked in CI (`deno task check-docs`); `history/` is
  exempt
