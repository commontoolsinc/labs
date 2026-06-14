# Engineering Priorities

Everything we build affects users along a few key dimensions: is it secure, is
it correct, is it fast, can it do what they need, and is it easy to work with.
This document names those dimensions and gives us a shared language for
debating where to focus.

These are not a constraint on what work happens — they are a framework for
asking the right questions:

- Which of these is the current bottleneck for adoption?
- Which is causing users to leave?
- Which would unlock the most growth if we got it right?
- Where are we strong enough that we can afford to coast?

Users don't think in these terms, but their satisfaction — or frustration —
maps to them. Eventually each dimension should have an in-depth program
document (like `PERFORMANCE_PROGRAM.md` for speed) that captures our
principles, strategy, and current state.

Product owns the prioritization across these dimensions — they collect user
feedback, assess the most urgent needs, and decide where we focus. Engineering
program docs feed concrete projects into the overall task list; product decides
the relative priority.

## The Dimensions

### Security

Users trust the fabric layer with their data and programs. They don't have to
trust individual patterns or their authors — the platform's guarantees hold
regardless. When security is working, users don't think about it. When it
fails, nothing else matters.

*Owned by the Runtime team. By design, enforced at a layer where code above it
cannot compromise it.*

### Correctness

The system does what it says it does. Patterns behave predictably, data is
persisted faithfully, reactive updates are consistent. Includes reliability —
a crash is a correctness failure. Users experience correctness failures as
"it's broken" moments that erode confidence.

*Shared across Runtime and DevX.*

### Speed

Users feel every millisecond of overhead. Speed spans the full experience:
compilation, reactive propagation, rendering, storage, network. Includes
observability — you can't protect what you can't measure. Users experience
speed as "does this feel like a real tool or a toy?"

*Shared across Runtime and DevX. Runtime drives most of the work
(see `PERFORMANCE_PROGRAM.md`), but DevX choices directly affect what users
experience.*

### Capabilities

What the platform can do. New pattern APIs, integrations, data sources, ways
of building. Users experience capabilities as "can I build the thing I want
to build?" Gaps here mean users hit walls.

*Shared across Runtime and DevX.*

### Developer Experience

The friction of building on the platform. Documentation, tooling, error
messages, API ergonomics, onboarding. Users experience DX as "how hard is it
to figure this out?" and "how long until I'm productive?"

*Owned by the DevX team.*

### Scalability

Handling growth in users, data volume, and pattern complexity. Users experience
scalability as "it worked fine until..." — it's invisible when adequate and
catastrophic when not.

*Deferred for both teams. Not yet a constraint.*

## Using This Framework

These categories are a lens, not a scorecard. At any given moment, one or two
of them are the binding constraint on the product's success. The questions to
keep asking:

**What's keeping new users from trying it?** This is likely a capabilities or
DX problem — either they can't see how to build what they want, or the
onboarding friction is too high.

**What's the main reason they stop using it?** This could be correctness
(things break in confusing ways), speed (it doesn't feel responsive enough
to be a real tool), or capabilities (they hit a wall they can't work around).

**What's keeping them from sharing it or being more successful?** This might
be speed (they're embarrassed by how slow it is), correctness (they can't
rely on it for real work), or security (they don't trust it with real data).

The answers change over time. The framework stays the same. Product revisits
these questions regularly based on user feedback and adjusts priorities
accordingly.

## Status

| Category | Program Doc | State |
|----------|-------------|-------|
| Security | — | Active work, no program doc yet |
| Correctness | — | Active work, no program doc yet |
| Speed | `PERFORMANCE_PROGRAM.md` | Program doc in progress |
| Capabilities | — | Active work, no program doc yet |
| Developer Experience | — | Active work, no program doc yet |
| Scalability | — | Deferred |
