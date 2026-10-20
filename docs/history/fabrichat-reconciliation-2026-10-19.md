---
status: historical
created: 2026-10-19
archived: 2026-10-19
reason: "Decisions for PR 8235's adoption of the upstream pushed-message contract."
---

# FabriChat reconciliation with main, October 19

Dan requested that PR 8235 merge current `main`, accept settled specification
decisions, retain meaningful independent behavior, and minimize support code
outside FabriChat. The branch started at `0974871d23`; the merge target was
`9a02b1d519`.

## Contract decision

The reconciliation adopted upstream's pushed messages and reactions, in-place
edits, handler-recorded timestamps, and error-based message-act refusals. It
removed message windows, earlier versions, activity, request memory, and time
reservations. The once-per-event guarantee is the runtime contract stated by
upstream; the room no longer maintains its own delivery ledger. Upstream's
manager, public schemas, placement, adapter, and message-view derivation remain
the basis of the implementation.

The removal follows the existing
[pushed-message break decision](fabrichat-pushed-messages-break.md). It also
breaks the independent branch's October 13 and October 15 snapshots of `room`
and its standalone `main` starter. The compatibility registry names those four
pairs and only the reported message-storage and removed-output paths. The
older independent adapter and placement entries name the removed activity
output in place of the previous `createdAt` finding. All baseline evidence
remains, and no exemption covers the new snapshots. No automatic migration
between the retired keyed layouts and the pushed layout was added.

## Retained distinctions

Handlers compare the authenticated actor with the record's `authored-by`
attestation. Changing profiles does not give another principal editing,
deletion, or reaction-removal authority, and does not take the original
principal's authority away. The spec's resolved-profile requirement for editing,
deletion, and reactions was adopted. Obliteration still works without a readable
profile when the actor's rights allow it.

Message text remains exact, and a refused send keeps its composer draft. A
successful send clears only a draft still equal to the submitted text. Reply
handlers retain checks against deleted targets and main-conversation quotes of
thread-only messages. Those checks strengthen upstream's client-validation
responsibility and also cover a target deleted between composing and sending.
The roster retains its query-backed array, so readers with different profile
access do not compete to copy it into shared state.

Display rights still rely on the selected profile's attestation because the
runtime exposes authenticated principal identity only in handlers. Reaction
addition and tallying still identify reactors by profile, while removal checks
authenticated authorship. Profile changes can therefore affect deduplication
and which removal control is shown. This existing limitation was not resolved
by the reconciliation.

## Support-code reduction

Upstream `cf-render` starts the piece it embeds, so the independent
runtime-client producer-activation path and its runner export were removed.
The runner's synchronous builtin identity restoration, cold access-list
withdrawal, and withdrawal-lineage bookkeeping were removed for validation
against the merged FabriChat. Their earlier source and focused regressions
remain in `0974871d23` for separate investigation; their removal is not a claim
that every runtime defect those regressions demonstrate has been fixed.

Controlled `cf-submit-input` text and its JSX declarations remain to support
refused-draft retention. The integration tests retain the independent
participant-convergence and invited-member-send assertions, adapted to the
upstream event contract.
