---
status: historical
created: 2026-09-06
archived: 2026-09-06
reason: "Audit snapshot of the `//` blocks that sat above class member declarations and read as doc comments, at labs `e9b4dd53e`, with the conversion series that resolved them and the residue it left."
---

# `//` notes above class members that were doc comments in disguise

**The finding, stated first.** At `e9b4dd53e`, 508 class members across 109
files outside `packages/patterns` carried a `//` block directly above the
declaration that described the member: what it holds, what it does, what a
caller may rely on. That is the content
[`code-comment-style.md`](../../development/code-comment-style.md) § Doc
comments gives JSDoc form, and in `//` form it renders nowhere and binds to
nothing. The series of pull requests listed below converted 472 of them,
turned one group note into a section marker (and a second, a blank line above
its members, into another), and left 35 `//` notes in place on purpose, each
for a reason this document records.

The census, the tooling, and the rules of judgment are described so a later
run of the same exercise can be diffed against this one.

## What was counted, and how

A TypeScript-AST census walked every tracked `.ts` and `.tsx` file except
`packages/patterns` (the standing carve-out for cosmetic sweeps), the
vendored DOM declarations, and the generated declaration bundles: 4849 files.
For every member of every class declaration or expression it collected the
`//` blocks in the member's leading trivia (adjacent `//` lines form one
block) and classified each: a tool directive (`deno-lint-ignore`,
`deno-fmt-ignore`, `deno-coverage-ignore`, `@ts-`), a section-marker frame
(a block opening and closing with a bare `//`), a `TODO`, or a doc
candidate. For each it also recorded whether a blank line separated the block
from the declaration, whether a `/**` comment was also present, and the
member's first and last lines.

A control fixture of nine planted sites and four decoys (a comment inside a
method body, a class-shaped template literal, an object-literal member, and a
`static {}` block) reported exactly the nine. Over the tree:

| Kind | Sites |
| --- | ---: |
| Doc candidate, directly above the member | 508 |
| Doc candidate, a blank line above the member | 12 |
| Section-marker frame | 142 |
| `TODO` block | 5 |
| Tool directive | 5 |

The 508 fell across packages as follows: `runner` 212, `ui` 128, `shell` 31,
`integration` 28, `memory` 19, `runtime-client` 18, `identity` 17,
`dashboard` 14, `deno-web-test` 11, `html` 7, and 25 across `js-compiler`,
`piece`, `cf-harness`, `background-piece-service`, `schema-generator`,
`ts-transformers`, `data-model`, `iframe-sandbox`, `lib-shell`,
`test-support`, `utils`, and `tasks/`.

## What "reads as a doc comment" meant in practice

The census cannot tell a description of one member from a label over several,
so every site was read. Three shapes came out of that reading, and the series
treated each differently.

**A description of the member it sits on.** The common case. It became the
member's doc comment, with the edits JSDoc form calls for and nothing else:
a method's opens with a third-person verb phrase and a field's with a noun
phrase; where the note opened with rationale and never said what the member
is, a sentence saying so now opens it; identifiers, callables, and properties
take backticks and their parentheses; emphasis by capitals became
underscores; labels the guide keeps out of a comment (tracker identifiers,
rollout stages, review-thread pointers, comparisons to the code's own past)
went, with the sentence each sat in saying the same thing without it. Spec
pointers stayed. Every converted member took the blank line above its doc
comment and the blank line below the member that the guide asks for; most of
the converted fields had sat in unbroken runs, which are now spaced.

**A description of two members, bound to the first.** A note such as
"Liveness: whether this seal is registered, and the last sheen alpha written"
sat above two fields. Converted as written, the new blank line below the
first field bounds the doc comment to it and leaves the second undocumented.
Each such note was split into one doc comment per member. Reviewers found
several of these that the first pass had missed; the shape is worth checking
for on any conversion of this kind.

**A label over a run of members.** `Public properties`, `Internal state`,
`Element references`, `Cell factory methods`. A doc comment is the wrong form
for a label, and a section marker was considered for each, per § Section
markers. Two became markers: `Traversals` in `BoundedKeyMap` and
`Unreached stubs` in a `data-model` test fixture, each titling a region that
runs to the end of its class. The rest stayed `//`: a marker opens a region
that runs to the next marker or the end of the class, and a label over a run
of fields in the middle of a class would open a region swallowing the
constructor and every method, with nothing in
[`DEVELOPMENT.md`](../../development/DEVELOPMENT.md) § Classes' marker
vocabulary to close it.

Two method notes were long enough to hold both a contract and its mechanics.
Per § "Where one goes", the contract and the bound on what the method
establishes became the doc comment, and the paragraphs on how the read is
issued open the body as `//`.

## The series

| Pull request | Scope | Converted |
| --- | --- | ---: |
| #7022 | thirteen small packages and `tasks/` | 28, plus 2 markers |
| #7023 | `memory`, `identity`, `integration`, `runtime-client` | 82 |
| #7024 | `shell` | 25 |
| #7025 | `dashboard`, `deno-web-test` | 25 |
| #7026 | `ui`, `cf-autocomplete` through `cf-input` | 52 |
| #7027 | `ui`, `cf-keybind` through `core` | 57 |
| #7029 | `runner/src/storage/` | 81 |
| #7031 | `runner`: pattern manager, runner, runtime, scheduler | 80 |
| #7032 | `runner`: the remaining source and tests | 40 |

Each pull request carried the same proofs: every changed file transpiles to
byte-identical JavaScript with comments stripped before and after; the census
re-run over the changed files reports nothing but the labels deliberately
left; the blank-line-below detector reports nothing it does not also report
on `main`; every added line is 80 characters or fewer with no backtick span
broken across lines; `deno fmt --check`, `deno lint`, and `deno task check`
repo-wide; and the package suites. Each also had a report-only `cf-review`
pass, whose findings are recorded in the pull request's `Review` section.
The reviews earned their keep: across the series they caught eight sentences
the conversion had written as contracts the code does not satisfy, every one
fixed before merge.

## What the series left, and why

**Labels over runs of members, 35 sites.** Listed here so a later reader
knows they were seen and not missed. `shell/src/lib/debugger-controller.ts`
(six field groups), `ui` components (`cf-autocomplete` eight,
`cf-image-input` two, `cf-location` two, `cf-map` three, `cf-keybind`,
`cf-file-download`, `cf-prompt-input`, `cf-tools-chip`,
`core/mention-controller`),
`runner/src/runtime.ts` (`Cell factory methods` twice and `Convenience methods
that delegate to the runner`, each over an overload set or a run of methods),
`runner/src/scheduler/facade.ts` (two field groups), `runner/src/cell.ts`
(`Stream-specific fields`), and `runner/src/traverse.ts` (three counter
groups). If the marker vocabulary grows a way to close a mid-class region,
these are the sites it would reach.

**One declaration-mechanics note.** `utils/src/cache.ts`'s
`LRUCache.#weigh` carries a `//` on how its type is written, which § "Where
one goes" keeps as `//` beside a declaration with no body.

**Twelve notes a blank line above the member.** Not doc comments by the
census's own rule, and read as region notes or absence notes ("No
`sqliteExecute` handler"); left for a later pass with its own judgment.
`runner/src/traverse.ts`'s note above `traverseWithSchema()` was the
exception, a doc sentence and a `TODO` that #7032 folded into the
existing doc comment and the body.

**Five `TODO` blocks above a member.** A `TODO` about a method goes in its
body per § "Where one goes"; these sit above fields and methods across five
packages and were out of scope.

**What the census does not see.** It walked class members only. The same
shape exists on interface members, object-literal members, and module-level
declarations (`dashboard/ci-job-cache.ts`'s `drawable`, `cf-input.ts`'s
option-literal labels, among others the reviews noted in passing), and a
later census would extend the walk to them.

## The tooling

Everything ran from a scratch directory and none of it is checked in. The
census is a Deno script over `npm:typescript`; the converter rewrites a
census site in place and inserts the two blank lines; a second tool rewrites
the doc comment above a named declaration from prose, wrapping at 80 columns
and keeping each backtick span on one line; the emit-identity proof
transpiles both versions of each changed file with `removeComments`. The
converter's one defect worth recording: the census reports a member's end
line, and for an overload set that is the first signature, so the blank line
below landed inside two overload sets in `runtime.ts` before the label
restore caught it. A scan of every branch's diff for a blank line between
two same-named signatures found no other.
