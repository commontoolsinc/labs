# Topics interaction performance: improvement plan

Target: interacting with a space over a real link — reading a board, listing
verbs, pulling a field — should cost a few seconds at most, and a read-shaped
interaction should not durably grow the space. The evidence base, including
the measured cost ladder and transfer-volume composition this plan's numbers
come from, is frozen in
[`../history/topics-performance-testbed-2026-08-06.md`](../history/topics-performance-testbed-2026-08-06.md).

The cost of a cold interaction decomposes into four terms, and the plan
attacks them in leverage order:

| Term | Today (WAN testbed) | Lever |
| --- | --- | --- |
| Bytes moved | 28 MB per cold start; ~47 s at ~5 Mbps | Stages 1–3 |
| Round-trip waves | ~20 dependent waves; ~4.5 s at 190 ms RTT | Stage 4 |
| Compute floor | ~12 s at zero latency | shrinks with stages 1–3; re-profile at stage 5 |
| Storage growth | ~9 MB durably appended per session | Stages 1, 3, 6 |

Each stage is a separately reviewable change with its own Linear issue. The
testbed (`scripts/delay-proxy.ts` over a rehearsal clone, per the procedure in
[`../development/space-clone-rehearsal.md`](../development/space-clone-rehearsal.md))
is the acceptance instrument: every stage re-runs the cost ladder and records
the deltas.

## Stages

1. **Slim commit read-sets to per-entity claims** —
   [CT-1955](https://linear.app/common-tools/issue/CT-1955). Replace verbatim
   per-path read records with per-entity claims while preserving server-side
   read-validity checking; resolve the reject-and-full-retry so envelopes are
   not shipped twice. Measured ceiling for this stage alone: 64 s → 30 s on
   the capped link, and the startup commit shrinks from ~8.8 MB to tens of
   KB. The slim form is also what gets durably stored.
2. **Watch selectors by schema reference** —
   [CT-1956](https://linear.app/common-tools/issue/CT-1956). Send schema
   hashes (the `cid:` scheme the download side already uses) instead of
   inline JSON Schemas; removes ~2.7 MB of upload per cold start.
3. **Ack-and-drop equal-value materializations** —
   [CT-1957](https://linear.app/common-tools/issue/CT-1957). A session-scope
   `set` whose canonical hash equals the stored value is acknowledged without
   persisting; read-shaped interactions stop growing the space.
4. **Wave-count reduction** —
   [CT-1959](https://linear.app/common-tools/issue/CT-1959). Schema-rooted
   pre-sync (one recursive-schema query per root, the compilation-cache
   shape) in place of client-side link walking, plus CLI session reuse to
   remove the fixed ~2.5 s session-establishment floor for narrow reads.
   Decide `experimentalConcurrentWatchRefresh`'s future here: measurement
   shows no effect on this workload, which supports its
   remove-if-superseded exit path.
5. **Discovery projection** —
   [CT-1958](https://linear.app/common-tools/issue/CT-1958). Registry
   enumeration reads a compact identity/name/mentionable/callable projection
   instead of starting full board results; attacks the 8.1 MB download and
   the per-startup server traverse together. Needs a human decision on which
   registry fields must remain live and durable.
6. **Storage diet and retention** —
   [CT-1960](https://linear.app/common-tools/issue/CT-1960). Hash-not-store
   for the operations duplicated between `commit.original` and `revision`,
   slim stored read-sets, and an explicit retention/compaction policy so
   history stops being append-only-forever.
7. **Wish unloaded-vs-empty** —
   [CT-1961](https://linear.app/common-tools/issue/CT-1961). Correctness
   companion: hold durable wish state until cross-space dependencies confirm
   (the `resume-republish` precedent) so cold starts stop publishing
   transient error states and reversing them.

[CT-1954](https://linear.app/common-tools/issue/CT-1954) anchors the research
package and testbed tooling.

## Expected end state

After stages 1–5: ~1–2 MB moved per cold interaction, ~5 waves, and a compute
floor that shrinks with the bytes it no longer canonicalizes and hashes — a
few seconds on Rapids-class links, sub-second narrow reads on a held session.
Stage 6 makes existing spaces compact to roughly a quarter of their current
size and caps growth. Stages are sequenced by leverage, but 2–7 are
independent of each other; only the stored-read-set half of stage 6 depends
on stage 1's claim format.
