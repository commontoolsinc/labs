# Type-checking doc code blocks

`docs/check.sh` (which runs `docs/check.ts`) type-checks the TypeScript and TSX
code blocks embedded in the Markdown under `docs/`. It runs in CI as the
"Type-check docs code blocks" step of the `check` job. Run it locally with:

```text
deno task check-docs            # all of docs/
deno task check-docs tutorial   # just docs/tutorial/
```

## How a block is checked

Most snippets are fragments — the body of a pattern, a piece of JSX, a few
interface members — that lean on identifiers the surrounding (elided) code would
provide. A block opts into a context by starting with one of these comments, and
the checker splices the block into the matching scaffold before running
`deno check`:

```text
// Shown at module scope.                 top level of a module
// Shown inside a pattern body.           inside a function body
// Shown as JSX element children.         inside a JSX fragment
// Shown as interface or class members.   inside an interface / class body
// Shown as alternative snippets.         "wrong then right" variants, each in
//                                        its own scope so a name can recur
// Shown for illustration only.           not type-checked (pseudocode)
```

A block with no marker is checked as a standalone module (the previous
behaviour). The scaffold supplies the `commonfabric` surface and ambient
declarations for the example identifiers listed in `check.vocabulary.json`.

## When the check fails on a block you added

Pick whichever applies:

- The snippet is a fragment that needs a surrounding context — add the matching
  marker as its first line.
- The snippet references an example variable defined in elided code — add the
  identifier to `others` in `check.vocabulary.json`.
- The snippet is illustrative pseudocode (placeholders, `...`, a wrong-then-right
  pair) — mark it `// Shown for illustration only.`

## TODO: drive the skipped count to zero

Every `// Shown for illustration only.` block is a snippet the check does not
verify, so it can rot silently. The goal is to have none. As the contexts and
vocabulary grow and snippets are tidied up, each illustrative block should either
become checkable in a real context or be rewritten so it compiles. Treat the
skipped count as a number to drive down to zero over time.
