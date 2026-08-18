---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Executed review correction for overlap notification coalescing."
---

# CFC overlap coalescing review correction

This work order records the change required by the final adversarial review of
conflict notification coalescing. The numbered section is one commit. It
follows the earlier rollout and repair work orders without changing the two
leading boundaries: the first commit contains only switch changes, and the
second contains only tests that directly inspect those switches.

## 1. Preserve per-rejection recovery notifications

Waiting for every overlapping repair claim to disappear can withhold the
subscriber invalidation that lets reactive conflict recovery advance. A
continuing recovery chain can replace a released claim before the count reaches
zero. The document then has no guaranteed point at which a notification can be
published.

The coalescing implementation also rebuilt the final change set from one
repair's earlier snapshot. It could omit a path introduced by an optimistic
layer after that snapshot.

Restore one notification for each completed semantic rejection. A rerun that
observes another rejected optimistic layer is stopped by the existing dead
pending-layer guard before it reaches the server. This keeps recovery live and
bounds the intermediate work without publishing or accumulating an incomplete
change set.
