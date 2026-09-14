---
status: historical
created: 2026-09-10
archived: 2026-09-10
reason: "Investigation record: the commit conflicts a lunch-poll client raises when it only observes while one other client votes, measured headless and in two browsers, each refusal attributed to the derivation that wrote it and to the admission rule that refused it."
---

# The conflicts an observing lunch-poll client raises

Measured 2026-09-10 on the same machine as
[where the lunch poll spends its time](2026-09-lunch-poll-where-the-time-goes.md),
from `packages/patterns/lunch-poll/main.tsx` at commit `803fa74392` on
`robin/lunch-poll-perf-2026-09`. That branch carries the memory server's
identity-commit acceptance (`docs/specs/memory-v2/03-commit-model.md`
§3.6.1): a commit refused for a stale read is accepted, and elided, when every
operation leaves its document as stored. Every process was on the
`serverExecution` OFF arm, the arm the deployed poll runs. The question was
narrower than the earlier record's: with two clients, one voting and one only
watching, which conflicts does the watching client raise, and why.

Two instruments. Headless, `packages/patterns/tools/lunch-poll-diagnose.ts`
gained `--voters=N`, which has only the first `N` users cast while the rest
observe, and reports commit churn per session; the runs below are
`--cases=14x2 --rounds=3 --voters=1`. In the browser, a scratch copy of
`packages/patterns/integration/lunch-poll-vote.test.ts` drove two Chrome
pages against a source-run toolshed on port 8700: the host creates a profile,
joins, adds 14 options one at a time, and votes three rounds; the observer
creates a profile and joins and never votes; each page's worker reported its
`storage.v2` counters after every phase. In both instruments a temporary
probe on the engine's refusal path printed each staleness refusal with the
stale document at the reader's seq, the document as stored, and the commit's
operations, which is what attributes a refusal to a pattern variable.

## Headless: five refusals, all at startup

Both clients open the poll with an identity and no roster entry, the host
joins, the observer joins, the host adds 14 options, the host casts three
rounds. The voter raised no conflict in any run.

| Arrangement | Observer conflicts | Observer reverts |
| --- | --- | --- |
| Both clients act at once | 6 | 7 |
| Observer acts after the host settles | 1 | 2 |

The six are five stale-read refusals and their cascades, none of them in the
vote rounds:

- Four in the baseline-open phase, one each for the observer's name, its
  joined flag, its join-button label, and one link-valued derivation. Each is
  a viewer-dependent derivation's first run. The derivation writes the
  user-scoped redirect link into the space-scoped computed slot and creates
  the observer's user-scoped value document in the same commit. The host's
  first run of the same derivation had written the identical link at seq 113
  to 116; the observer's confirmed read of the slot was from seq 5, its
  baseline view. The patch half replays from that basis to exactly the stored
  document, so it is an identity on its own, but the user-scoped `set`
  creates a document that did not exist, and the rule requires every
  operation to be an identity.
- One in the join phase: the roster `.map()` creates the child pattern
  instance for the host's row on both clients, with the same deterministic
  id, and both splice its link into the children list. The observer's splice
  replays from its basis to the stored list and every other operation equals
  what is stored. It is refused by the idempotency half of the patch rule
  alone: replayed on the stored list the splice would append the element
  twice.

The stale read in every one of these is a read of the derivation's own output
slot, taken to decide whether the link is already there, not a read of one of
the derivation's inputs.

Staggering the observer removes the four slot races, because the host's first
run has settled before the observer derives. It cannot remove the roster-row
race, which the host's join triggers on both clients: the observer reacts to
the roster revision as soon as it arrives, before the host's children-list
revision lands a few seqs later. Only opening the piece after the host has
joined and settled removes that one too, and the harness opens every session
at creation, so the headless probe cannot make that arrangement.

## Browser: about eighteen refusals per option added

The same scenario in two browsers is a different shape. Counters are the
observer page's worker, cumulative.

| Phase (staggered open) | Host conflicts | Observer conflicts | Observer reverts |
| --- | --- | --- | --- |
| Host joined | 1 | not open | not open |
| Observer opened and joined | 3 | 0 | 0 |
| 14 options added | 4 | 257 | 763 |
| Three vote rounds | 4 | 269 | 818 |

Opening both browsers at once gave the same picture: 230 observer conflicts
and 772 reverts, 218 of them during the option additions. The stagger changes
nothing in the browser, and joining is not where the cost is. Neither is
voting: the three rounds added twelve conflicts.

The engine probe saw 857 staleness refusals server-side across the run, of
which 470 were accepted as identities and never reached a client counter.
Three sessions raised them: the observer's browser, the host's browser, and
the test's pieces controller, a Deno runtime that keeps the piece running with
a result sink and is a third replica with churn of its own that neither
browser counts.

| Session | Staleness refusals | Accepted as identity | Refused |
| --- | --- | --- | --- |
| Observer browser | 364 | 114 | 250 |
| Pieces controller | 485 | 351 | 134 |
| Host browser | 8 | 5 | 3 |

The observer's 250 refused commits, by what they wrote:

| Count | Stale document | What the commit wrote | The values |
| --- | --- | --- | --- |
| 136 | a computed slot | patch the space-scoped slot with the user-scoped redirect link; create the observer's user-scoped `of:` document | per-option vote-state strings: the empty string, "Love it", "Okay with it", "Veto"; the per-option vote button vnodes; links to per-option cells |
| 80 | a computed slot | the same, creating a user-scoped computed document | per-option booleans, almost all `false`; rank labels "#1" and "#2"; the top-choice badge |
| 14 | the option list's map output | a child pattern instance start: its argument and result documents, its schemas, and the splice into the children list | one per option |
| 20 | mixed | session-scoped equivalents of the first row, and a few whole-commit shapes | |

The median lag between the observer's read and the write that made it stale
was 26 seqs, against a median of 652 for the controller. These are tight
races, not a view stale since the page opened. Each option the host adds
spawns fifteen to twenty new viewer-dependent derived documents: the vote
label the viewer sees on that option, whether the viewer has voted each color
on it, the button vnodes. The host authored the option, so the host's runtime
derives them first and writes the slots. The observer's runtime derives the
same documents a few seqs later, reads each slot at its delivered revision,
which predates the host's write, patches in the same link, and creates its own
user-scoped value in the same commit. The server refuses the commit for the
slot read, the client re-derives and retries, and the dependents it had
already queued cascade as reverts, about three per refusal.

## What this says

- The identity rule does the work it was built for. In the browser run it
  absorbed 470 of 857 staleness refusals, most of them a derivation
  re-writing exactly what another replica had stored.
- What it leaves is one shape: a commit whose stale read is of its own output
  slot, whose patch on that slot is an identity, and which also creates a
  per-viewer document nobody else could have written. Relaxing the server rule
  per document would accept it, and is not sound in general: a stale read of
  one document can inform a real write to another, and the naive model of
  `packages/memory/test/naive-admission.ts` would reject what the engine
  accepted.
- The sound fix is on the client, in how the runtime writes a viewer-dependent
  derivation's slot. The slot read is a read of the derivation's own output,
  taken to avoid re-writing a link that is already there. Either it is not
  carried as a confirmed read of the commit that writes the user-scoped value,
  the way the mergeable-op incidental-read exclusion in
  `packages/runner/src/storage/v2.ts` already drops reads of a write's own
  target, or the slot patch goes in its own commit, where a lost race makes it
  a pure identity the server already accepts.
- The roster-row and per-option instance starts are refused by the
  idempotency half of the patch rule alone. Dropping that half needs the
  accept response to carry the elided operation indexes and the client to drop
  those operations instead of re-folding them over its confirmed base; the
  engine computes the indexes, the wire response does not carry them, and the
  runner never reads them.
- A pattern's cost to an observer scales with the derived documents each
  authored change spawns, not with the change. Fourteen options cost the
  observer 257 refused commits and 763 reverts while it did nothing.
