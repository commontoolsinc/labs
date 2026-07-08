# Documentation

This tree holds the project's documentation. It is split into two kinds, and the
split is deliberate.

## Live vs. historical

- **Live** documentation describes what the repository currently contains or
  intends to contain: specs of current and proposed behaviour, concept guides,
  conventions, tutorials, reference material, and plans for work not yet done.
  **Live docs are kept up to date.** Everything under `docs/` *except*
  `docs/history/` is live.

- **Historical** documentation is a point-in-time record: an executed plan, a
  completed migration, an audit or investigation, a decision record, or the
  design of a removed feature. **Historical docs are frozen and must not be
  edited to reflect new reality.** They live under
  [`docs/history/`](history/README.md), which explains the rule in full.

The test for which is which: **if the system changed, would someone edit this
document, or write a new one?** Edit it → live. Write a new one and leave this
alone → historical.

If you are an agent working in this repository, the maintenance policy — keep
live docs current, never edit historical docs, add the header banner when you
create a historical artifact, and move a live doc into `docs/history/` when its
status changes — is stated in [`AGENTS.md`](../AGENTS.md).

## Live documentation map

- [`common/README.md`](common/README.md) — building **patterns**: concepts,
  authoring recipes, components, conventions, capabilities, and workflows. Start
  here for pattern development.
- [`development/DEVELOPMENT.md`](development/DEVELOPMENT.md) — runtime
  development: coding style, design principles, testing, local dev servers, and
  debugging. See also [`development/debugging/README.md`](development/debugging/README.md).
- [`specs/`](specs/) — design and reference specs for the runtime, storage,
  scheduler, sandboxing, transformers, and related systems. Each spec carries a
  `Status:` line indicating whether it is a draft, a proposal, or as-built.
- [`tutorial/`](tutorial/README.md) — a guided tour of the platform from the big
  picture down to runtime internals.
- [`features/`](features/) and [`future-tasks/`](future-tasks/) — forward-looking
  designs and work not yet carried out.
- [`FAQ.md`](FAQ.md) — a lightweight index of frequently asked questions.

## Historical documentation

- [`history/`](history/README.md) — the frozen archive, with its own index.
