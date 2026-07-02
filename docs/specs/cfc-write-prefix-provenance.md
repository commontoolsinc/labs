# CFC per-write read-prefix provenance (Epic D4) — soundness review

_Epic D, stage D4, of
[`docs/plans/cfc-future-work-implementation.md`](../plans/cfc-future-work-implementation.md).
This doc is a **soundness review** of the plan's proposed prefix approximation,
grounded in the CFC spec (`commontoolsinc/specs` `cfc/08-09-runtime-label-propagation.md`
§8.9, §8.9.1). It found a real unsoundness in the plan text and fixes the
design before code lands. Written 2026-07-02 at owner request._

## 1. What D4 proposes and why

Today the `requiredIntegrity` gate (`verifyInputRequirements`) and the D3
write-side floor (`verifyWriteFloor`) quantify over the **transaction-global**
consumed-read set: *every* labeled read in the transaction must satisfy the
floor of *every* protected write. Two costs:

- **False rejects (audit S7).** An unrelated protected write is rejected because
  some *other* part of the transaction read low-integrity data. The current
  mitigation (`isProvenanceOnlyConsumedLabel`) is a blunt, transaction-global
  exemption.
- **Vacuous pass (audit #14).** A floor-declaring write whose consumed set is
  empty passes today (the gate only fires when `gatedReads.length > 0`). It
  should fail — no endorsed input means the floor is unmet.

D4's idea: gate each protected write on only the reads that **actually fed it**,
approximated by the reads that occur *before* the write in the transaction
journal (which orders reads and writes). The plan calls this the "prefix
approximation … strictly tighter than transaction-global; not value-level
dataflow, stated honestly."

## 2. What the spec actually requires

`08-09` §8.9.1 (*Normative definition, `computePcConfidentiality`*) defines the
consumed set `O` as **every read recorded in the attempt's transaction
journal** — transaction-global — plus trigger/gating reads. The default output
label `L_default` is "the conservative label from all observable inputs plus PC
taint." So the spec's baseline is exactly today's transaction-global gating.

§8.9.1 (*Decomposition before claims*) is the only sanctioned way to be **more
precise** than `L_default`, and it names exactly two mechanisms:

1. **Transaction decomposition** — running a sub-operation in its own
   transaction whose journal *does not contain* the other reads. Then pointwise
   precision is a **structural fact**; no trust gate is involved.
2. **Trusted flow-precision claims** — a precision claim (`L_claim` less
   restrictive than `L_default`) is only honored when the executing
   implementation identity is trusted for the concept `flow-taint-precision`;
   otherwise the runtime MUST fall back to `L_default` (or reject).

**The prefix heuristic is neither of these as written.** The journal *does*
contain all the reads (one transaction), so it is not decomposition; and the
plan proposes to apply it unconditionally, not behind the `flow-taint-precision`
trust gate. So the review question is: **is the prefix a sound structural fact
(like decomposition), or an untrusted claim (which the spec forbids applying by
default)?** The answer depends entirely on which bound is used.

## 3. The unsoundness in the plan's bound

The plan says: gate a write on "reads with `journalIndex <` the write's **first
attempt**." This is **unsound** under write re-attempts.

Counterexample (single transaction, one path `P`, floor declared on `P`):

| journal index | activity |
|---|---|
| 5 | write `P` = a (first attempt) |
| 7 | read `R` (low-integrity) |
| 9 | write `P` = f(R) (re-attempt — the committed value) |

`P`'s committed value at index 9 **depends on `R`** (index 7). But the
first-attempt bound is 5, so the gate quantifies over reads before index 5 —
**excluding `R`**. A low-integrity value flows into a floored write and the gate
misses it. This is a real taint escape, not a mere false-accept of noise.

Re-attempts are not exotic: a reactive recompute, a retry, or a
read-modify-write of the same path all produce write-then-read-then-write on one
path within a transaction.

## 4. The sound bound: the write's LAST attempt

Gate a write to path `P` on the reads with `journalIndex <` the **last** write
to `P` in the journal.

Soundness argument — this *is* a structural fact from the journal order, on par
with decomposition:

- `P`'s committed value is the value of its **last** write. Call its index `w`.
- Any read at index `> w` occurs after `P` was finalized. No later write touches
  `P` (by definition of "last"), so nothing recomputes `P` from that read.
  Therefore a read after `w` **cannot** have fed `P`'s committed value.
- `P`'s own value is a plain datum or a *reference*; if it is a link, the
  reference was fixed at `w`, and the link target's label is tracked separately
  by the link machinery (§8.11) — not by `P`'s prefix.
- Reads at index `< w` are exactly the observations that *could* have fed any of
  `P`'s writes up to and including the finalizing one. Keeping all of them is
  conservative within the dataflow-to-`P` question.

So the last-attempt prefix drops only reads that provably did not feed the
value — the same character of structural argument §8.9.1 makes for
decomposition ("the journal simply does not contain the other elements"). It is
**not** an untrusted `L_claim`, so it does **not** require the
`flow-taint-precision` trust gate. It is a permitted precision, and it is sound.

The first-attempt bound fails this argument (reads between the first and last
write to `P` are dropped though they can feed the re-write); the last-attempt
bound satisfies it. **Use last-attempt.**

### Trigger reads (§8.9.2 / H5)

Trigger reads have no journal index — they are the addresses whose invalidating
writes *scheduled the run*, i.e. they logically precede every write in the
attempt. They must be assigned index `−∞` (before all writes) so they gate
**every** protected write's prefix. Anything else would let the scheduling
channel escape the per-write gate. (H5 already folds trigger reads into the
transaction-global gate; D4 must keep them in every prefix.)

## 5. Consequences for the two payoffs

- **Vacuous-pass fix (#14).** Under the last-attempt prefix a floored write whose
  prefix has **no** gating reads had no endorsed input and MUST fail. This is
  now sound *because the prefix is a true dataflow bound* — the reason the
  in-code comment (`isProvenanceOnlyConsumedLabel`, prepare.ts) says the #14
  tightening "is unsound to apply without (a)": (a) is exactly this prefix, and
  it must be the *sound* (last-attempt) prefix.
- **S7 narrowing.** The provenance-only exemption can shrink: a provenance read
  that occurs *after* a protected write's last attempt no longer gates it (it
  couldn't have fed it), so the exemption is needed only for provenance reads
  *within* the prefix. Port the group-chat regression scenario as a test.

## 6. Digest binding is mandatory (not optional)

The decision now depends on **journal order** — specifically the last-write
index per path and the set of read indices below it. But
`canonicalizePreparedDigestInput` (`cfc/canonical.ts`) **sorts `consumedReads`
and `writes` by address**, discarding order. So the prepare→commit digest
recheck would NOT detect a post-prepare reordering that changes which reads fall
in a write's prefix — a verification bypass (audit S2 shape).

Therefore D4 MUST add an **ordered** write-attempt log to `PreparedDigestInput`
(`{ target: CfcAddress, journalIndex: number }` per path's last write, in
journal order) and canonicalize it **order-preserving** (or by `journalIndex`),
so any post-prepare activity that changes the ordering invalidates the
preparation. This is the same discipline `trustSnapshot`/`policySnapshot` follow
and is listed in the plan's cross-cutting register — the review confirms it is
**load-bearing for soundness**, not bookkeeping.

## 7. Verdict and implementation constraints

D4 is sound **iff** it is built as follows:

1. **Bound = last write to the path**, not first (§3–4). Trigger reads at `−∞`.
2. Framed and documented as a **structural precision fact** (§8.9.1
   decomposition-class), so it needs no `flow-taint-precision` trust gate — but
   the framing must be stated so a future reader does not mistake it for an
   untrusted `L_claim`.
3. **Ordered write-attempt log in the digest** (§6) — mandatory.
4. Applies to the `requiredIntegrity` gate and the D3 write floor; the
   confidentiality **egress ceiling** stays transaction-global (a sink request
   records no per-write provenance — §8.10 / `collectConsumedConfidentiality`
   comment — so the whole consumed set is the sound over-approximation there).
5. Red-first tests: the §3 re-attempt counterexample **rejects** under
   last-attempt (and would pass under the buggy first-attempt bound — a
   regression guard); empty-prefix floored write fails; a post-prepare reorder
   invalidates; the S7 group-chat scenario passes.

Stated honestly (as the plan asks): this is a **dataflow approximation**, but a
*sound* one — it never drops a read that could have fed the value. It is tighter
than the spec's `L_default` only in the decomposition-permitted direction.

## Provenance

Grounded in `commontoolsinc/specs` `cfc/08-09-runtime-label-propagation.md`
§8.9.1 (`computePcConfidentiality`, *Decomposition before claims*, the
`flow-taint-precision` normative profile) and §8.9 read-time-journaling
rationale; the runner seams are `verifyInputRequirements`/`verifyWriteFloor`
(`cfc/prepare.ts`), `isProvenanceOnlyConsumedLabel` (the #14/S7 comment),
`tx.journal.activity()` (the ordered read|write stream,
`storage/interface.ts`), and `canonicalizePreparedDigestInput`
(`cfc/canonical.ts`, the address-sort that motivates §6).
