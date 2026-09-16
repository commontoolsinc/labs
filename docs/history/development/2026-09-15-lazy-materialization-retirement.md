---
status: historical
created: 2026-09-15
archived: 2026-09-15
reason: "Decision to retire the lift materialization switch and retain lazy semantics."
---

# Lift materialization switch retirement

Mike approved retirement in this session: “retirement is fine.” The additional
Berni approval gate in the fast-follow plan was an agent interpretation of flag
ownership, not a separate requirement from the user. This decision supersedes
that gate. No additional approval is required to implement retirement; normal
antagonistic review, Cubic review, and CI still govern merging.

## Decision and consequences

Retire the runtime option and environment switch. Lift argument and body reads
use lazy materialization unconditionally. Preserve the transaction mark and its
reset before result serialization, along with eager materialization for
handlers and other unmarked callers. The handler-context deferral remains.

The supported rollback for the retirement change is a reviewed code revert and
redeploy. Reverting switch removal restores the option with its default still
on; it does not repair eager mode or establish that disabling lazy behavior is
safe. Disabling that behavior would require separately qualifying a build or
repairing eager semantics. No live poll or piece update is authorized here.

The [reload diagnosis](performance/2026-09-15-lazy-reload-diagnosis.md) and
[navigation-policy follow-up](performance/2026-09-15-notebook-reload-navigation-policy.md)
record why eager mode is not an equivalent fallback: it can supply undefined
for a promised nullable value and fail where a lazy read refuses. The corrected
served notebook test renders all seven notes in both modes, but eager still
fails on browser errors. Default-on acceptance does not certify that fallback.

## Alternatives

- Repair and qualify eager rollback first. This keeps two lift modes and
  requires a defined eager unresolved-input contract plus browser control and
  matched acceptance evidence. It was not chosen as a prerequisite to retiring
  a switch whose enabled behavior is the supported path.
- Keep the switch indefinitely with lazy mode on. This preserves the option
  without making its eager mode a qualified rollback, and leaves the rollout
  surface and cleanup unfinished.

The [fast-follow plan](../../plans/lazy-materialization-fast-follow.md) owns
remaining validation, measurements, and archival. This decision is not a claim
that those steps have already completed.
