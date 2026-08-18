---
status: historical
created: 2026-08-18
archived: 2026-08-18
reason: "Executed the state-vintage interval-clock correction found by the strict CFC rollout."
---

# State-vintage interval clock correction

This work order records one necessary correction found while replaying stored
Lunch Poll state under the strict CFC rollout. The numbered section is one
commit. It follows the rollout work orders without changing the two leading
boundaries: the first commit contains only switch changes, and the second
contains only tests that directly inspect those switches.

## 1. Replay a vintage under its captured interval clock

The pinned Lunch Poll fixture contains a vote from its capture day and the
derived `todaysVotes` and `todayVoteCount` values that exposed it. Replaying the
fixture refreshed its shared `#now/300` cell to the day CI ran. The raw vote
remained readable, but both current-day projections correctly became empty.
The state gate classified those environmental changes as state stranded by the
source update.

Give runtimes an explicit interval-clock mode. The default live mode retains
the existing behavior: refresh a stale stored clock and schedule aligned
ticks. The frozen mode keeps a restored value and schedules no ticks. Use
frozen mode only when the state-continuity harness opens an existing snapshot;
new captures continue to use live time. Add a runtime regression that seeds an
old interval value and proves a frozen wish returns it. Record the replay rule
in the live pattern-update testing specification.
