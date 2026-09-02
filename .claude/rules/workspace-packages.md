---
paths:
  - "deno.jsonc"
  - "packages/*/deno.jsonc"
---

# Workspace package configuration

## Every package needs its own test task

A package's `deno.jsonc` must contain a `"tasks"` object with a `"test"` entry.
Use `"deno test"` when the package has tests, or `"echo 'No tests defined.'"`
when it does not have them yet.

This is not a tidiness rule. The root test runner (`tasks/test.ts`) walks every
workspace member and runs `deno task test` in each. A member with no `test`
task falls through to the root workspace's task, which is the whole suite —
so the suite would re-enter itself once per such package, spawning processes
exponentially. The runner reads every member's manifest before it spawns
anything and refuses to start when one has no `test` entry, naming it, so the
symptom is that message rather than a hung job.

A `test` task defined by its `"dependencies"` alone satisfies the rule, since
the name still resolves in the package's own directory. The check therefore
asks whether the manifest declares the task at all, which is a different
question from the one `memberTestTask()` in `tasks/workspace-tests.ts` answers
— what command line the task runs, which a dependencies-only task does not
have.

`packages/utils/deno.jsonc` is a correct minimal example.

## A new package is two edits

Adding the directory is not enough. The package path also goes into the
`"workspace"` array in the root `deno.jsonc`, or nothing in the repository
knows it exists.

## Declare dependencies at the narrowest scope

A dependency belongs in the `deno.jsonc` of the package that imports it, not at
the root. `docs/development/DEPENDENCIES.md` has the version-pin rules and the
reasoning. Three gates enforce parts of it, and all three are cheap to run
before you push:

- `deno task check-single-copy-deps` — one version of a dependency across the
  workspace.
- `deno task check-unused-deps` — nothing declared that nothing imports.
- `deno task check-deno-pins` — the accepted Deno range in `tasks/check.sh`
  still contains the pin in `mise.toml`.

## Two packages may not import each other

`deno task check-package-cycles` fails when a package's production source can
reach back to itself through another package. It counts an import by package
name and a relative path that climbs into another package alike, and it ignores
test code, which reaches wherever it needs to. It is the mechanical floor under
"Dependencies run downward" in `AGENTS.md`, and only the floor: a cycle is
caught, an import that merely runs up the stack is not. That paragraph's worked
example is where to put a module each side seems to want.

The cycles that predate the gate are listed in `ALLOWLIST` in
`tasks/check-package-cycles.ts`, each with what the two sides take from each
other. That list may only shrink: break one of those cycles and the gate fails
until its entry is deleted.
