# Code comment style

How a comment in this repository is written: what earns one, what belongs
inside it, how it is marked up, and the shapes that quietly turn a comment into
a liability. This covers both kinds — the `//` comment that explains local
mechanics, and the JSDoc doc comment that states a contract.

Neighboring guidance: [`../README.md`](../README.md) governs the documentation
tree, including which spelling of English everything written here uses, and
[`DEVELOPMENT.md`](DEVELOPMENT.md) carries the rest of the coding standards,
the 80-column line width among them. The `describe()` and `it()` description
strings of a test have their own guide,
[`unit-test-coding-style.md`](unit-test-coding-style.md), which governs how
they are worded. What they take from here is the markup below, and the rule
that they describe the system as it stands.

Not every comment in the tree follows this guide, so a neighboring file is not
evidence of what to write. New code follows it closely. An edit to existing code
conforms the area around the edit; converting a whole file is its own change,
made deliberately rather than as a side effect.

## What earns a comment

The code already says what it does. A comment earns its keep by carrying what
the code cannot say on its own: an invariant that is not visible locally, the
reason a constraint exists, a trade-off deliberately taken, a pointer to the
part of a specification that decides the behavior.

Two things beat a comment whenever they apply.

A well-named helper or a better identifier says the same thing in the code
itself, where it cannot drift out of agreement with what it describes. When a
chunk of logic needs an inline comment to be readable, first ask whether naming
it would do the job instead.

And when the reasoning outgrows what a comment can hold, it belongs in a
document under [`../features/`](../features/README.md), with the comment naming
that document. Several invariants here are held that way. The pairing is what
keeps a subtle constraint from being edited away by someone who never saw the
argument for it.

A stale comment is worse than no comment, because it is believed. Changing code
means changing the comments that describe it.

## Describe the system as it is

A comment describes the system as it stands, for a reader who has the code in
front of them and no other context — not the conversation that produced the
code, and not the one that produced the comment. That one rule generates most
of what follows, and the sections below are the shapes it rules out, each of
which feels helpful while being written.

### Not the code's own past

Do not compare the code to a previous version of itself. "Preserving prior
behavior", "this used to collapse to `{}`", "no longer coerced", "now
simplified" — all of it is history. History is valuable, and its home is the
commit message and the pull request body, which is where a reader goes when the
question is how the code got this way.

State the present-tense fact and stop:

```ts
// Shown as alternative snippets.

// Wrong: half of this describes code that is not here.

/**
 * Freezes `donut` if it is not already frozen. Previously this returned
 * `undefined` for an already-frozen donut; it now returns the donut itself,
 * preserving the old caller's expectations.
 */
function freezeDonut(donut: object): object {
  return Object.isFrozen(donut) ? donut : Object.freeze(donut);
}
```

```ts
// Shown as alternative snippets.

// Right: what a caller needs, and nothing about how it came to be.

/**
 * Freezes `donut` if it is not already frozen, and returns it either way.
 */
function freezeDonut(donut: object): object {
  return Object.isFrozen(donut) ? donut : Object.freeze(donut);
}
```

This reaches test files, and the description strings in them as much as the
comments. A test added in response to a bug reads like every other test: it
states the behavior being pinned. "Regression test for the case where …"
explains why the test was written, which is again pull request material.

### Not the road not taken

State the requirement. The argument for it against some alternative that was
considered and rejected is a record of a decision, and belongs where decisions
are recorded.

"Being total is also what keeps it honest, since the alternative is collapsing
an unknown flavor into a catch-all" is a sentence about a discussion. "Every
flavor maps to a distinct key; a collision here would silently merge two
orders" is a sentence about the code.

### Not the neighbors

A comment is about the code it sits next to. Whatever is true of another module
is that module's business, and a criticism of it planted here is a claim nobody
maintaining either file will think to revisit. "`glazeOf()` tolerates some of
these today, but that tolerance is a bug rather than a contract" is a comment in
the wrong file, and possibly a bug report that was never filed.

Noting a genuine present-tense inconsistency _within_ the current system is
fine, because that is the system as it is: "the opposite of the
`undefined ≈ true` convention used elsewhere in this file" tells a reader
something true and useful.

### Not a survey of the rest of the system

Claims about the wider codebase rot silently, because nothing about editing the
far end of the claim brings anyone back here. "As all current callers do", "the
only caller", "there are three such sites" — each is one refactor away from
being false, and the refactor will not fail any check.

If a property matters, assert it locally: guard it, type it, or state it as the
contract the code enforces. Code search answers the cross-reference questions.

A doc comment may mention callers only when they are local to its own file —
that is, when the thing is not exported and the file bounds the claim.

### Not a rollout plan

Terms like "Stage 3", "the expand-acceptor step", or "parallel-change" name a
plan for getting somewhere. They have no referent for someone reading the code
later, at which point the plan is either finished or abandoned. The same goes
for issue numbers, tracker identifiers, and pull request numbers: the commit
message and the branch name carry that trail, and they stay accurate when the
tracker is replaced.

What survives the plan is why the code has the shape it has. Write that, and
give the eventual cleanup a `TODO` phrased as a condition on the world:

```ts
// Shown at module scope.

// The legacy branch exists so that orders naming a glaze by number still
// resolve.
// TODO(DonutFry99): Remove once every deployed fryer names glazes by string.
export const acceptNumberedGlazes = true;
```

Note the shape of that `TODO`: it names the fix and names the blocker. Removing
process residue is subtraction, and subtraction alone can leave a comment worse
than it found it — a vague `TODO(DonutFry99): Fix the problem.` is what
remains when a tracker identifier is deleted and nothing takes its place. Say
the thing, rather than only striking the part that cannot stay.

Note the tag, too. Every `TODO` names whoever is on the hook for it, and a bare
`TODO:` fails `deno lint`, which runs the `ban-untagged-todo` rule across the
repository. That rule also accepts an issue reference in the tag position,
which does not make one a good idea here: an issue number is exactly what this
section says to leave out of a comment. Tag a person.

### The check that finds these

Self-review does not reliably catch any of the above, because each shape reads
as helpful in the moment it is written. Grep the added comment lines of the diff
instead:

```text
before|used to|previously|no longer|formerly|the alternative|rather than the old
```

That list is a starting point, not a specification of the rule. It leans toward
the past-tense shapes, and has nothing in it that would catch a rollout stage, a
count of callers, or a complaint about a neighbor; the sections above are the
rule. Nor is every hit wrong — "before" has honest uses. Each one is a place to
ask which system the sentence describes: the one in the file, or one that is
gone.

The list is meant to grow. When a comment of one of these shapes gets past it,
add the wording that would have caught it.

## Removing code removes its comments

When a conditional or a block goes away, the comments that annotate it go with
it. Comments that annotate surviving context nearby stay. The discriminator is
whether the comment describes the thing being removed or something else that is
still there.

- A `// frozen means terminal` premise on an `if (Object.isFrozen(donut))`
  short-circuit goes when the short-circuit goes.
- A `// TODO(DonutFry99): This copy should not be necessary.` on a
  `copyIfNecessary(...)` call goes when the call goes.
- A comment describing the unbox-fill-rebox cycle around them stays, because
  it describes behavior that remains.

A premise left behind after its conditional is deleted is the most misleading
comment there is: it is well written, it is in the right place, and it is about
nothing.

## Markup

Comments are marked up as Markdown, and so are error messages and log messages
(see below).

**Backticks around code and code-like things.** This covers identifiers, literal
values (`914`, `NaN`, `undefined`, `true`), keywords and operators (`export`,
`===`), and snippets (`flavor != "chocolate"`, `fryTime: 200`). Backtick a
keyword or a constant whenever it can reasonably be read as naming the language
construct rather than as plain English; on a close call, backtick it.

A literal string is written without its quotes, so `frosted` rather than
`"frosted"`, unless dropping them would be confusing in context.

Avoid two backticked spans in a row. They are hard to read and often ambiguous,
and there is nearly always a single-span phrasing that says the same thing:
write ``when `name === null` `` rather than ``with a `null` `name` ``.

**Underscores for emphasis.**

```ts
// Shown at module scope.

// Three donuts is not enough, but _four_ should be sufficient.
export const donutCount = 4;
```

**Callables get trailing parentheses, properties get a leading dot.** Write
`eat()` for a function or method. Write `.name` for a getter or non-method
property being named without a salient receiver in context.

**The royal "we" for process.** The reader and the code are on a journey
together: "we count the `donuts` here, because one might have gone missing while
we were not looking."

## Section markers

Mark a section of a file or a class with a `//` comment block that opens and
closes with a line holding nothing but `//`. It carries a noun-phrase title, and
optionally a fully grammatical description after a blank line:

```ts
// Shown at module scope.

//
// Exported donut handlers
//
// These cover all currently-known types of donuts, including crullers and
// fritters.
//

export function fry(): void {}
```

Section markers separate major portions of a file or class. They are not
headers for individual functions and their helpers — doc comments already
carry that structure, and a reader navigating by rendered documentation never
sees the marker at all.

**No horizontal rules.** Do not put long runs of dashes, equals signs, or other
repeated characters into a comment, whether or not as part of a section marker.
The exception is a table, where they are part of the layout.

## Doc comments

### Format

This project uses JSDoc-style comments: open them with `/**`, and close them
with `*/`.

If a doc comment would fit in the 80-column line width limit including
indentation and comment markers, then it can be written on a single line, e.g.:

```ts
    /** Desired fryer temperature, in Kelvin. */
```

For any other doc comment, the opener and closer go on their own lines, with
a `*` on continuation lines aligned with the _first_ opener `*`, e.g.:

```ts
// Indented as if it were a doc comment on an inner declaration.

    /**
     * A `FryerCat` is twelve cats in a trenchcoat, who operate donut fryers.
     */
```

Note that if the comment above were formatted as a single line, that line would
exceed the line width limit. This is why it is rendered as a multiline comment.

As a _counterexample_, do not make multiline doc comments where either the
open or close marker is _not_ on its own line, e.g. don't do this:

```ts
// Shown as alternative snippets.

// Wrong: Multiline comment whose delimiters are on lines with text.

/** Full list of all known donut styles, whether or not the system is capable of
 *  constructing them. */
```

```ts
// Shown as alternative snippets.

// Right: Multiline comment whose delimiters are each on their own line.

/**
 * Full list of all known donut styles, whether or not the system is capable of
 * constructing them.
 */
```

### What gets one

- Every exported symbol: variable, function, class, type.
- Every class and every public member of one, including the constructor,
  whether or not the class is exported.
- Every non-trivial internal function.

Anything else may have one, and the bar is low. Err toward writing one for all
but the most trivial definitions.

### What goes in one

A doc comment that restates the name and the type signature has added nothing.
Reach for three things:

- **What** it does or represents, adding the context the name alone does not
  carry.
- **Why** it exists, or a pointer to the part of a specification that decides
  its behavior, or both.
- **The bound on any guarantee it claims.** When a comment says a check catches
  something, say what it does not catch. A reader takes "catches drift" to mean
  "catches drift", and the unstated half is exactly where a check that works
  gets trusted past its range. A `satisfies` pin, for instance, catches a
  missing or mistyped member and is blind to an extra one, because
  assignability permits extras.

A doc comment states the contract, and states it accurately. Accuracy here
means not overclaiming: a function that is safe to call on a frozen input but
that does freeze what it is given says so, rather than claiming it never
mutates.

```ts
// Shown at module scope.

/**
 * Canonicalizes `order`, returning an instance equivalent to it which is safe
 * to share. Safe on a frozen or a mutable argument, and never requires a
 * mutable one, though it may freeze the argument in place.
 */
export function canonicalizeOrder<T extends object>(order: T): T {
  return Object.freeze(order);
}
```

Keep it tight. A sentence or two usually does it. The goal is for a reader —
human or agent — to understand the intent without reading the implementation.

Contracts go in the doc comment, not in inline exhortations. An inline comment
explains local mechanics; the doc comment says what a caller can rely on.

### When one is also data

A doc comment on a type that reaches the schema generator does not stay
documentation. It attaches to the generated schema as its `description`, and
any `#hashtag` in that text is mirrored into a `tags` array, lowercased and
deduped. Where two declarations of the same thing carry conflicting docs, the
first wins and the conflict is recorded in `$comment`.

On such a type, then, a doc comment is program output, and a `#hashtag` written
as an aside becomes a tag whether or not one was meant. Which comment attaches
where is settled by section 12 of
[the type mapping spec](../specs/schema-generator/ts_to_json_schema_mapping.md).

### How one starts

**Functions and methods** start with a subjectless third-person singular verb
phrase: `Writes the donut preferences to stable storage.` Special cases:

- **An internal helper** starts `Helper for <the thing being helped>, which
  <verb phrase as above>.`
- **A variation on a theme** may be stated against its baseline:
  `Like <baseline>, except <difference>.`
- **A constructor** starts with the words `Constructs an instance`, with any
  salient detail in that same sentence: `Constructs an instance which keeps
  track of donut staleness.` A constructor that genuinely needs no further
  detail gets exactly `Constructs an instance.`, which shows the documentation
  was not left out by oversight.
- **An override or interface implementation** needing no further detail gets
  exactly `/** @inheritDoc */`, which likewise shows the absence of detail is
  deliberate.

**Variables and properties** start with a noun phrase, usually without an
article: `Special designation category of the donut.` Use "the" for something
singleton-ish: `The cache of all known donut manufacturers.`

## Error and log messages

The text of a thrown error or a log message follows the same markup rules as a
comment: backticks around code and code-like things, and the same conventions
for naming functions, methods, and properties.

```ts
// Shown at module scope.

export function checkFlavor(flavor: string): void {
  if (flavor !== "chocolate") {
    throw new Error(`Unsupported flavor: \`${flavor}\``);
  }
}
```
