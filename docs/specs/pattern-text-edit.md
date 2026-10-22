# Editing live collaborative text from pattern code: `Writable<string>.edit`

**Status:** proposed · **Builds on:**
[Collaborative Operations, Views, and Anchors](memory-v2/07-op-views-and-annotations.md)
and its [implementation plan](../plans/memory-apply-op.md)

## Why

A collaborative text field is a Memory v2 operation field. Edits to it
are CodeMirror change sets, which the server codec rebases over
concurrent edits (`packages/memory/v2/operation-codec.ts`). Today the
only way to submit one is the main-thread
`runtime-client.applyOperation`, and its one caller is
`cf-code-editor`. Pattern code has only `.set()`. While the field is
active, the engine refuses an ordinary write that changes it
(`OpFieldWriteConflictError`, `packages/memory/v2/engine.ts`), and the
refusal rolls back the whole transaction.

So **no handler, agent or pattern can put a single character into a
note that anyone has open.** Only a person typing in the editor can.
That rules out:

- an agent appending action items to shared meeting notes;
- a suggestion that adds an item to a list in the note;
- a summary inserted under a heading;
- resetting a shared note from a handler.

Collaborative documents are effectively read-only to all code except
the editor. That is a strange gap for a system where agents are meant
to be collaborators.

This proposes one primitive, shaped like the one agent harnesses
settled on for editing files.

## Prior art

How agent harnesses edit files:

- **Anthropic text editor tool, and the SWE-bench agent.** String
  replacement was the most reliable format. An edit lands only on
  exactly one match; zero or several matches return an error, and the
  model retries with more context
  ([SWE-bench write-up](https://www.anthropic.com/research/swe-bench-sonnet),
  [text editor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)).
- **Claude Code's Edit tool.** The same rule, plus `replace_all`. The
  file must have been read first, which is a staleness check.
- **Aider.** Line numbers in hunks fail; models handle them poorly
  ([unified diffs](https://aider.chat/docs/unified-diffs.html),
  [edit formats](https://aider.chat/docs/more/edit-formats.html)).
- **OpenAI `apply_patch`.** Context lines and scope markers, no line
  numbers
  ([GPT-4.1 prompting guide](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide)).
- **Cursor.** Search/replace hunks, because models are "bad at counting
  line numbers" ([Instant Apply](https://cursor.com/blog/instant-apply)).
- **SWE-agent.** Line-range edits needed a linter to revert bad edits
  ([paper](https://arxiv.org/html/2405.15793v3)). Its default
  configuration now uses `str_replace`.

**The consensus:**

- anchor by content, never by line number;
- require an exact, unique match;
- return failure as feedback, so the caller re-reads and anchors more
  precisely;
- treat whitespace as significant.

Fuzzy fallbacks only exist to forgive a model's sloppy copy of a file
nobody else is writing. A live document is the opposite case.

## Semantics

```ts
type TextEdit =
  | { old: string; new: string; replaceAll?: boolean } // replace by content
  | { append: string }                                 // on its own line, at the end
  | { prepend: string };                               // on its own line, at the start

type EditResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; kind: "no-match" | "ambiguous"; edit: number; count: number }
  | { ok: false; kind: "conflict"; reason: string }; // could not write at all

interface Writable<string> {
  edit(e: TextEdit | readonly TextEdit[], opts: { dedupeId: string }): EditResult;
}
```

### Where `old` is matched: on the server, when the edit lands

`old` is matched against the field's value at integrate time, not
against the value the handler read.

Matching against the handler's read and shipping a change set for the
codec to rebase would be wrong. Rebasing preserves positions, not
meaning. If someone types inside the span being replaced, the rebase
strands their words next to `new`, corrupting both edits with no
signal to either party.

Matching at integrate time means the edit applies only where the exact
text exists at the moment it lands. The engine serializes integration,
so there is no gap between the check and the write. Typing elsewhere in
the field never blocks the edit.

The handler still gets a synchronous result. `edit` evaluates the same
predicate against the handler's snapshot as a *prediction*, without
recording a read dependency; otherwise every keystroke would invalidate
the commit. The server evaluates it again. If the two verdicts
disagree, the transaction rolls back and the scheduler re-runs the
handler through its existing stale-basis path. On the re-run the
snapshot is fresh, so the prediction agrees with the server, and the
caller sees the real verdict. `edit` never retries.

### Matching rules

- Compare exact code units, with no normalization.
- `old` must be non-empty. The one exception: `old: ""` matches once
  when the whole value is empty.
- Count occurrences including overlaps (`"aa"` occurs twice in
  `"aaa"`).
- Without `replaceAll`, exactly one occurrence is required: zero is
  `no-match`, two or more is `ambiguous`.
- With `replaceAll`, at least one occurrence is required, and
  replacement runs left to right over non-overlapping occurrences.

### Append and prepend are line-oriented

The field's start and end always exist and are always unique, so
`append` and `prepend` never fail with `no-match` or `ambiguous`. They
are for the empty field and for logging at the bottom of a document.
Anchoring an append on "the current last line" would fail every time
someone typed at the bottom.

They mean "add this as its own line", so there is no newline for a
caller to forget. The server resolves the separator when the edit
lands, against the value as it is then:

- `append` inserts `"\n"` first, unless the value is empty or already
  ends with `"\n"`.
- `prepend` inserts `"\n"` after the text, unless the value is empty or
  the text already ends with `"\n"`.

Nothing else is normalized. A blank line asked for explicitly (a
leading `"\n"`) is kept. Only the server can make this decision,
because only it knows whether someone has just typed or deleted the
trailing newline.

Other cases are replacements:

- Inserting after a known passage replaces it with itself plus the new
  text, so the edit fails, correctly, if that passage changed.
- Continuing the last line inline replaces that line.

Two concurrent appends land in the order they are integrated.

### Several edits

Every edit in a list matches against the same starting value. This is
unlike a sequence of edits, where one edit can create or destroy
another's anchor. Matched spans must not overlap, and an overlap is a
contract violation that throws. `append` and `prepend` count as
zero-width spans at the boundary. The edits apply all or nothing, and a
failure names the index of the first edit that failed.

### Result kinds

Each failure leads to a different next step, so each is its own value:

| Result | Meaning | Caller's next step |
| --- | --- | --- |
| `no-match` | `old` is not in the text | The text moved: re-read |
| `ambiguous` (with count) | `old` occurs more than once | Make `old` longer |
| `conflict` | The write was refused (authority, history gone, codec mismatch) | Nothing is known about the text |

### Idempotence

`dedupeId` is required. Derive it deterministically from the cause, for
example `${eventId}:${purpose}`.

A handler may run more than once, and in a shared space every
participant's runtime may run it. The first submission applies, and
later ones resolve to `{ok: true, duplicate: true}`. The dedupe check
must run **before** matching. Otherwise a second runtime's `old` no
longer matches, because the first runtime's edit already changed the
text, and it reports a false `no-match`.

### Proposals taken later

A proposed edit (a suggestion offered now and accepted later) stores
`{target, edits, dedupeId}`. Its state is derived reactively from the
pure `matchEdits(currentValue, edits)`, so it can dim or withdraw as
soon as `old` stops matching uniquely, without polling. On acceptance,
the handler calls `edit`. A `no-match` or `ambiguous` result marks the
proposal stale in the same transaction, and the proposer re-reads and
proposes again.

### Inactive fields

On a field with no active epoch, `edit` activates it through the
existing baseline-hash path. There is one write path, and once a field
is active every writer uses `edit`.

## What it must not do

- **No fuzzy matching.** No whitespace trimming, no Unicode folding, no
  first match wins. In a live document, a near match is usually text a
  person just changed on purpose. A failure costs one re-read; landing
  in the wrong place overwrites someone's words.
- **No line numbers or offsets** in the API. Start and end are the only
  positional anchors, because they are the only positions that mean the
  same thing after anyone's edit.
- **No partial application, no `.set()` fallback, and no retry inside
  `edit`.**

## CFC

- `edit` is a write. It needs the same write authority on the field as
  `.set()`, checked at integrate time for the submitting principal. An
  accepted proposal runs with the accepting user's authority, not the
  proposer's.
- The result discloses content: whether `old` matched, and how many
  times. So the result carries the field's confidentiality label, as a
  read would.
- `new` flows into the field and is checked against the field's label,
  like any write.

## What labs would add

1. **A `replace` payload variant in the CodeMirror codec**,
   `{clientId, replace: TextEdit[], dedupeId}`, accepted in place of
   `changes`. `integrate` resolves it against the value after the
   intervening operations into an ordinary change set, and that is what
   the log stores. So `cf-code-editor` sees ordinary operations and does
   not change. A server that predates the variant rejects the unknown
   key, so the failure is loud.
2. **Structured refusals** (`no-match` / `ambiguous`, with index and
   count) in place of a generic codec error, so the runner can turn
   them into a re-run or a value.
3. **Dedupe by `dedupeId` across the whole epoch, checked before
   matching.** Today the codec sees only the intervening window and
   deduplicates after rebasing.
4. **`Writable<string>.edit` in the runner.** It predicts against the
   snapshot without recording a read, and enqueues an `apply-op` in the
   handler's commit, which already accepts apply-ops atomically.
5. **One exported pure `matchEdits(value, edits)`**, shared by the
   runner, the codec and proposal UIs. Two implementations would let
   predictions diverge from the server.
6. **The same `EditResult` returned through any command or agent tool
   surface**, unchanged.

## Open questions

1. An anchor can be unique at the handler's base cursor and become
   ambiguous only because someone pasted a copy elsewhere. Should the
   server then resolve it by mapping the base position through the
   intervening operations? This proposal says no, until evidence says
   otherwise.
2. Should range-oriented CFC, which §7's plan defers, change the label
   on the result from the whole field to the matched range?
