---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Post-mortem: every load-bearing claim about the verbs arc that failed when measured, and what the failures had in common."
---

# Claims that failed measurement on the verbs arc

Over 2026-08-15/16, closing out the verbs implementation arc, twelve
load-bearing claims turned out to be false. Each was found the same way — by
running one command against the artifact the claim named — and each had
survived because the previous reader had taken it on trust.

They are recorded together because the individual corrections are already in
the issues and pull requests, and the pattern across them is not.

## What they had in common

**Every one was a restatement.** Not a fresh reading: a plan's wording, a
comment's summary, a review's paraphrase, or an earlier message of my own.
The code was right far more often than the sentences beside it.

**None was caught by a mechanism.** No test failed, no gate went red, no
reviewer objected on the merits. Twelve were found by measuring and none by
the system noticing.

**Several were mine, written the same day.** A doc comment that described a
rule its own diff inverted. A "correction" to a public issue that was itself
wrong. A status board whose headline number disagreed with the table beneath
it. Proximity in time was no protection; if anything it hurt, because I read
what I meant rather than what I wrote.

## The claims

### About the plan

`docs/plans/verbs-implementation.md`, item 11, was wrong in four separate
ways, each discovered by measurement:

1. **"Blocked by #5746."** The plan never said this. It said "gated on one
   measurement" and, separately, that a same-file rule *queued* the two. I
   compressed those into "blocked", wrote it into a status board, an issue
   comment and several conversations, and added a causal sentence — "that is
   why it has not been started" — that no source supported. The hunks did not
   even overlap: #5746 touched `schema-injection.ts` at three places around
   lines 53, 2971 and 3023; the work in question was at line 287 of the same
   4,364-line file.

2. **Part 2 "sufficient on its own."** Measured against a *declared* field
   rather than the `any`-typed field the original probe used, it was not. The
   refusal fired before the option it added was ever consulted.

3. **Part 1 "stands on its own."** Refusing a structural copy requires
   identifying a reference position, and no schema the CLI can read
   distinguishes one from an ordinary nested object of the same type.

4. **Part 4 attributed to `applyCapabilitySummaryToArgument`.** That function
   is real and does shrink, but the CLI never reads its output, so editing it
   would not have changed what the gate sees.

The plan's *reasoning* held up throughout. Its **sizing** failed every time it
was checked.

### About the code

5. **`fieldEditDistance` and `keyEditDistance` "do not exist."** They did.
   The greps ran in a worktree 31 commits behind `main`, from before the two
   pull requests that added them. I published this as a correction to an
   accurate issue, complete with a paragraph about how work orders naming
   nonexistent code get picked up as fully specified.

6. **"`isCellLink` needs exporting."** Already exported, as `isLink`. I
   searched for the wrong name and reported the absence.

7. **"The declared schema keeps the `asCell` marker."** The *transformer
   output* keeps it. The *stored pattern* does not. I measured one artifact and
   asserted it of another, which invalidated an entire approach after it was
   built and tested.

8. **A doc comment stating the rule its own diff inverted.** The JSDoc on
   `eventSchemaJudgesRootFields` said a schema carrying `additionalProperties`
   welcomes undeclared fields. The same pull request made that false for
   `false`. Written hours earlier, by me, in the same session.

9. **A silent flag alias.** Fixing a reviewer's finding, I made the gate ask
   "would the payload door accept this NAME" when the right question was "does
   this SCHEMA judge its fields". A field declared `fooBar` then accepted
   `--fooBar` as an undocumented alias of `--foo-bar`, untyped.

10. **A disjunction treated as a veto.** `declaredEventFields` copied a root
    `anyOf` check from a function answering a different question — "does this
    judge?" rather than "what does this declare?" — and took away flags that
    already worked.

11. **A conjunction over a scalar routed to object parsing.** Admitting any
    schema carrying `allOf` sent `allOf: [{type: "string"}]` down the flag
    path with a vocabulary of none.

12. **A status board whose headline disagreed with its own table.** It read
    "15 on main" over a table showing fourteen. The table was right.

## The instruments, which failed differently

Three measurement *tools* produced transcripts indistinguishable from success.
These are worse than a wrong claim, because the evidence looks like evidence.

- **`deno test --filter` against a BDD file.** Only the top-level `describe`
  is a registered test, so a filter written against an `it()` matches nothing
  and prints `ok | 0 passed | 0 failed | 1 filtered out`, exiting 0. I used
  this to "confirm" a reproduction and got a green that meant the opposite.
  **Read the passed count, never the `ok`.**

- **`git checkout <branch> -- <file>` from a branch that never had the
  commit.** Restoring a file from a branch pointing at `main` silently reverted
  an uncommitted change. `deno check` passed because the file was still valid.
  The delete output said `(was 87f350e64)` — main's SHA — and I read past it.

- **`git push` after a failed commit.** The commit failed on a stale
  `index.lock`; the push on the next line ran anyway and reported success,
  having pushed the *previous* head. **Compare local, remote and PR SHAs after
  pushing.**

## What actually worked

**Running one command against the real artifact.** Not reading the code that
implements it — running it. The gate measurement that redirected an entire
item took two minutes; the reasoning it replaced had been wrong for weeks.

**Testing live, after the unit tests passed.** The marker recovery had seven
green tests and did nothing, because the tests called the overlay directly
while the dispatch path read a different schema. Only the live call showed it.

**Asking whether two things agree, rather than whether one is right.** The
most durable tests written during this work assert that two surfaces answer
identically — `read-options-four-ways.test.ts`, and the parity table pinning
four schema shapes across both doors. A drift names itself instead of hiding
behind two green tests.

**Naming the mutation.** For any claim of the form "the repo already checks
X", the question that settles it is: what change would make this claim false,
and does anything fail when I make it? A claim with no such mutation is
decoration.

## What would have caught them mechanically

Little of it, honestly, which is why the habit matters more than the tooling.
Two exceptions worth building:

- A gate reading every `(#NNNN)` in a plan against its pull request state,
  the way `check-docs-history-index` reads the index. Four rows naming merged
  pull requests as "in review" survived for days across two documents that
  disagreed with each other.
- `deno task check-skill-facts` already fails when a path cited by a skill or
  an `AGENTS.md` stops resolving. Nothing does this for an issue body, and
  claim 5 above was exactly that failure, published as a correction.
