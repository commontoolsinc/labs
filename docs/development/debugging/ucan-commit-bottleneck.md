# UCAN Commit Bottleneck Investigation

## Reproduce

```bash
# Times out at default 5s — this is the bug:
deno task ct test packages/patterns/notes/notebook.test.tsx --verbose

# Passes with 30s timeout — timing data printed to stderr:
deno task ct test packages/patterns/notes/notebook.test.tsx --verbose --timeout 30000
```

Look for `[COMMIT-TIMING]`, `[CONSUMER-TIMING]`, `[SCHEDULER-COMMIT-CB]`,
`[SCHEDULER-IDLE]`, and `[TEST-RUNNER]` lines in stderr output.

## What the instrumentation shows

The `createNotes` action (multi-push: 2 notes pushed into an array) triggers
~27 reactive settle iterations. Each iteration fires `tx.commit()` without
awaiting it. The scheduler declares idle immediately, but the commit promise
callbacks don't resolve for 6-8 seconds.

**Where the time goes (per commit):**

| Phase | Time | Location |
|-------|------|----------|
| diff + nursery + subscription.next | ~0.3ms | `cache.ts` commit() sync path |
| `remote.transact()` → UCAN auth | **50-130ms** | `consumer.ts` execute() → `Access.authorize()` |
| Ed25519 sign | bulk of auth | `crypto.subtle.sign("ed25519", ...)` |
| sendQueue serialization | 0ms wait | commits arrive one-at-a-time (settle loop is sync) |

**Total: ~80 commits x ~80ms average = ~6,400ms** — matching the observed timeout.

## Root cause

`scheduler.ts` `run()` line 716 fires `tx.commit()` without awaiting. The
`.then()` callback (line 718) only does `retries.delete()` (~0ms), but it
can't fire until the commit promise resolves. Each commit goes through the
full UCAN authorization pipeline (`Access.authorize()` → Ed25519 sign via
`crypto.subtle`), even in emulated/in-memory mode.

The scheduler declares idle as soon as it has no pending/dirty effects, but
the stale commit promises are still draining in the background. The test
runner's `runtime.idle()` resolves before the commits finish, so the next
action fires while the previous action's commits are still in-flight. This
compounds until the backlog exceeds the test timeout.

## Key finding

**`resubscribe()` is NOT the bottleneck** (0-69ms, usually 0ms). The cost is
entirely in the UCAN authorization pipeline — specifically Ed25519 signing at
50-130ms per commit.

## Instrumented files

- `packages/runner/src/storage/cache.ts` — `[COMMIT-TIMING]` per-commit sync vs transact split
- `packages/memory/consumer.ts` — `[CONSUMER-TIMING]` auth, queue wait, exec per transaction
- `packages/runner/src/scheduler.ts` — `[SCHEDULER-COMMIT-CB]` callback delay, `[SCHEDULER-IDLE]` idle resolution
- `packages/cli/lib/test-runner.ts` — `[TEST-RUNNER]` action send/idle timing
