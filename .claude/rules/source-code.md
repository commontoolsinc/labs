---
paths:
  - "**/*.ts"
  - "**/*.tsx"
---

# Writing code

The map is the `writing-code` skill at `skills/writing-code/SKILL.md`: which
document governs what you are about to touch, and what to run before pushing.
The two it says to read first are `docs/development/DEVELOPMENT.md` and
`docs/development/code-comment-style.md`.

What follows is only the part that survives every gate, so that a green run
tells you nothing about it.

## A green run is not evidence about style

`deno fmt` settles line width, indent, semicolons, and quotes. `deno lint` and
`deno task check` settle types and import mechanics. Nothing settles the shape
of a class, the grouping of imports, the wording of a comment, or the words
themselves — and a reviewer will raise all four.

The class rules are the ones most often missed, because the wrong form compiles
and passes: `#privateName` rather than TypeScript's `private`, no enumerable
properties on a class, and the member order in
`docs/development/DEVELOPMENT.md`, § Classes. A `private` field is an own
enumerable property once the modifier is erased, so `private` is not a quieter
spelling of `#`. A member kept `private` so that a test can cast its way to it
is the same defect; the same section says how an `accessForTestingOnly` getter
hands a test what it needs instead.

## The document is part of the change

Changing behavior a live document describes means editing that document in the
same change, not filing a follow-up. `docs/README.md` has the rules, including
which tree a new document belongs in.
