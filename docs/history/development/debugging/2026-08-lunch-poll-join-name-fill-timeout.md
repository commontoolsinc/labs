---
status: historical
created: 2026-08-03
archived: 2026-08-03
reason: "Investigation finding: the lunch-poll join-name fill timeout is not a fill-helper problem."
---

# The lunch poll's join-name fill timeout is not in the fill helper

`packages/patterns/integration/lunch-poll-vote.test.ts` intermittently fails
with `Timed out filling cf input "#lp-join-name"`, on either the host's fill or
the guest's. The obvious reading is that `fillCfInput` gives up too early, or
watches the DOM when it should be driving the page. That reading is wrong, and
this record exists so the next person does not spend the effort a second time
rebuilding the fill helper.

## What the failure probe says

The helper's own failure probe is decisive. From a CI run on `main`:

```text
"fill": { "attempts": 605, "phase": "no-element" },
"pendingIpc": [],
```

605 evaluations across the five-minute safety net, every one of them finding no
element at all, with nothing in flight to the worker. The predicate was never
starved of re-evaluations: 605 over 300 seconds is exactly the cadence of the
timer backstop in `packages/integration/utils.ts`.

## Driving the page does not help

The natural fix is to make the fill ask the view to settle before it reads the
DOM, because asking the worker whether it is idle is what queues runnable pull
work, and an integration test holds no UI subscription that would otherwise
start it. That reasoning is sound in general, and the text waits in
`packages/patterns/integration/cfc-browser-helpers.ts` rely on it.

It does not fix this failure. With the settle in place the same test still fails
the same way:

```text
"fill": { "attempts": 60, "phase": "no-element" },
"pendingIpc": [],
```

Sixty attempts, each of which drove a full settle, and the field was absent for
every one. The control genuinely never renders, so no amount of driving the page
will surface it.

## Where the fault actually is

`#lp-join-name` renders only under the `showManualEntry` branch of
`packages/patterns/lunch-poll/participant-identity-card.tsx`, and that branch is
gated on one per-session cell:

```text
const useCustomName = Writable.perSession.of<boolean>(false);
const showManualEntry = computed(() => useCustomName.get());
```

The only thing that sets it is the `#lp-guest-button` handler,
`onClick={() => useCustomName.set(true)}`. So the failure means that clicking
"Continue as guest" did not produce the manual-entry branch.

The click did reach the worker: the failing probe records one completed
`ipc/cell:send`, which is the handler dispatch. The worker then reported itself
idle — `pendingIpc` empty, and sixty subsequent idle round-trips all resolving —
while the rendered view never showed the branch that cell drives. The gap is
between the handler's write and the rendered view, not in how the test waits for
it.

Two leads worth pulling, in order:

- The failing probe records `ipc/vdom:mount` twice and `ipc/vdom:unmount` once.
  Confirm the piece's vdom is still mounted at the point of failure; the probe
  also reports an empty `hostTagName`, which is consistent with the card not
  being in the document at all.
- The card's own comment notes that `hasProfile` is a cross-space computed value
  with a transient empty-name window, and that `showProfileSetup` (which renders
  the guest button) and `showProfileJoin` swap as it resolves. Establish whether
  the handler's write lands while that swap is in flight, and whether the write
  is observed by the recomputation that produces the branch.

## Reproducing it

It reproduced once locally, on the first run of this test in a fresh working
copy, and not since. Start the local dev servers for the copy with its port
offset, then point the test at them:

```text
API_URL=http://localhost:<toolshed-port> FRONTEND_URL=http://localhost:<shell-port> \
  LOG_LEVEL=warn deno test --trace-leaks -A ./integration/lunch-poll-vote.test.ts
```

A failing run takes the full five-minute bound and a passing one finishes in
under ten seconds, so the two are easy to tell apart while iterating.

There is no reliable reproduction yet. These attempts did not produce one, and
each rules something out:

- The click and the field it should reveal, driven on one browser for ten
  consecutive navigations: ten passes. The step is not fragile on its own.
- The same, on two browsers booted against the piece concurrently, for eight
  navigations and sixteen clicks: sixteen passes. Concurrency between the two
  browsers is not sufficient either, and the field appeared immediately every
  time rather than late.
- The whole test against freshly restarted shell and toolshed processes: passes.
  The compile cache is keyed per space and every run takes a fresh space UUID,
  so restarting the servers does not make the run colder.
- The whole test under enough busy loops to saturate every core: passes. Plain
  CPU starvation is not the trigger.

What the one failure had that none of these did was a first-ever boot in the
copy, so the shell's own dev-server transform cache was cold and the browser's
boot was much slower. That points at a slow-boot window rather than at load as
such, and it matches this test's `beforeAll` comment about cold compiles wedging
the worker event loop. Confirming it means catching a failure with the worker
instrumented to say whether the handler's write to the per-session cell actually
landed, which needs the failure to be summonable first.

## What was changed on the strength of this

Nothing in the pattern or the runtime. The fill helpers were changed for two
reasons that stand on their own and are not this flake: they now drive the page
rather than only watching it, matching the text waits beside them, and they now
re-resolve the control after asking the host to commit, because a commit that
re-renders the host leaves the typed value on a detached input and an empty live
field could report a successful fill.
