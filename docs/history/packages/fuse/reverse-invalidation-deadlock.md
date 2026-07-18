---
status: historical
created: 2026-07-18
archived: 2026-07-18
reason: "Root-cause record for the FUSE daemon hang that flaked the CLI FUSE integration suite; the fix shipped in packages/fuse."
---

# FUSE daemon hang: reverse invalidation deadlocks the request thread

## Summary

The CLI FUSE integration suite (`packages/cli/integration/fuse-exec.sh`)
failed on roughly a quarter of CI runs, across many unrelated branches. On a
failing run the daemon mounted cleanly and then served zero filesystem
operations: every `test -e` probe timed out because the mount never answered a
single lookup. The daemon's worker process sat in uninterruptible kernel sleep
(process state `D`) before it handled its first request.

The daemon deadlocked itself. It issued a kernel cache reverse invalidation
(`fuse_lowlevel_notify_inval_entry`) synchronously, on the same thread that
answers filesystem requests. On Linux that call enters the kernel and takes the
target directory's inode lock for writing. A lookup that is already in flight
under that directory holds the same lock for reading until the daemon answers
it. The daemon answers on the thread now blocked inside the invalidation, so the
lookup can never be answered, the read lock is never released, and the write
wait never completes. The mount is dead.

The fix runs the two reverse-invalidation calls off the request thread, so the
request thread stays free to answer the lookup that the invalidation is waiting
behind.

## Why it looked like a random CI flake

The bug is a timing race, so it surfaced as load-dependent flakiness rather than
a deterministic failure. It needs a reverse invalidation to run while a lookup
under the same directory is in flight in the kernel but has not yet been
answered by the daemon. Under light load a probe's lookup is answered before the
next invalidation fires, and nothing collides. Under CI contention the gap
between "a piece rebuild finished and scheduled an invalidation" and "the
scheduled invalidation actually ran" widens, and a probe's lookup is far more
likely to be sitting in that gap. That is why the failures clustered by runner
load and hit branches whose code had nothing to do with FUSE.

The daemon's last log line on a hung run was the piece-list sync finishing a
rebuild (`Updated <Piece>/result`). That rebuild is exactly what schedules the
reverse invalidations that then deadlock, which is why the log stops there.

## Why it never reproduced on macOS

FUSE-T, the macOS provider, returns success from `notify_inval_entry` and
`notify_inval_inode` without doing anything (see the note in
`packages/fuse/mount-options.ts`). The call never enters the kernel lock path,
so it never blocks, so the deadlock cannot form. The bug is specific to Linux
libfuse3, where the invalidation does real work.

## The two threads, and why they wait on each other

The daemon is single-threaded for request handling. `fuse_session_loop` runs on
one Deno FFI blocking-pool thread for the mount's lifetime. Every operation
callback and, before this fix, every reverse-invalidation call runs on the one
V8 isolate thread. When the session-loop thread reads a request from
`/dev/fuse`, it hands the work to the isolate thread and waits; the isolate
thread runs the callback and calls the reply function. So a reply can only be
produced by the isolate thread.

Reverse invalidation was issued on that same isolate thread. On Linux the call
path is `writev` on `/dev/fuse` into the kernel, then
`fuse_reverse_inval_entry`, which takes the parent directory's inode read/write
semaphore for writing. A concurrent lookup holds that same semaphore for
reading across its whole request: the kernel takes it in `__lookup_slow` before
sending the lookup to the daemon and releases it only after the daemon replies.

The wait graph is a cycle:

- The isolate thread is inside the invalidation, waiting to take the parent
  inode semaphore for writing.
- The write wait is queued behind a lookup that holds the same semaphore for
  reading.
- That lookup is waiting for the daemon to reply.
- The daemon replies on the isolate thread, which is stuck in the invalidation.

Nothing breaks the cycle, so the isolate thread stays in uninterruptible sleep
and the mount serves nothing.

The existing mitigation did not cover this. The daemon already defers
invalidations onto a timer and skips the flush while `pendingFuseReplies > 0`.
But `pendingFuseReplies` only counts requests whose callback has begun running
on the isolate thread and deferred its reply. The lookup in the deadlock has
been accepted by the kernel — which is already holding the read lock — but its
callback has not started on the isolate thread yet, so the counter is still
zero and the flush proceeds.

## Reproduction

The repro is a self-contained libfuse3 daemon (about 250 lines) that mirrors the
real daemon's threading: `fuse_session_loop` as a nonblocking FFI symbol,
op callbacks and reverse invalidations on the isolate thread. It mounts a
trivial tree (a root directory containing `dir`, which contains `file`) and
runs on Linux libfuse3. It reproduces on aarch64 and x86_64 alike; the deadlock
is in the kernel's inode-lock handling and is architecture-independent.

It was run under Colima (an aarch64 Linux VM), in a container started with
`--cap-add SYS_ADMIN --device /dev/fuse`. Two triggers were exercised:

1. A deterministic trigger, where the lookup handler issues the invalidation for
   `dir` inline, before replying. This guarantees the invalidation runs while
   this very lookup holds the parent read lock, so the deadlock forms every
   time. It is a stand-in that pins the exact lock topology.
2. The realistic trigger, matching the daemon's actual shape: a timer-driven
   flush that issues invalidations for `dir` while forty-eight parallel
   processes hammer `stat` on `dir` and `dir/file`. This reproduces the same
   deadlock probabilistically under contention, which is what CI hits.

Both triggers produced the identical kernel stack on the wedged isolate thread:

```
state=D  wchan=fuse_reverse_inval_entry
[<0>] fuse_reverse_inval_entry+0x4c/0x210
[<0>] fuse_notify_inval_entry
[<0>] fuse_notify
[<0>] fuse_dev_do_write
[<0>] fuse_dev_write
[<0>] ... vfs_writev ... __arm64_sys_writev
```

The counterpart probe was blocked waiting for the reply, holding the parent
read lock:

```
state=D  wchan=request_wait_answer
[<0>] request_wait_answer
[<0>] fuse_simple_request
[<0>] fuse_lookup_name
[<0>] fuse_lookup
[<0>] __lookup_slow          <- holds inode_lock_shared(parent) here
[<0>] ... path_lookupat ... __arm64_sys_statx
```

Once wedged, the daemon could not be killed (uninterruptible sleep ignores
`SIGKILL`) and the mount could not be unmounted. The only recovery was aborting
the FUSE connection through `/sys/fs/fuse/connections/<id>/abort`, which is the
documented last resort for a wedged mount. This matches the CI behavior, where
the job ran to its step timeout and was cancelled.

## The fix

The two reverse-invalidation FFI symbols, `fuse_lowlevel_notify_inval_entry` and
`fuse_lowlevel_notify_inval_inode`, are declared nonblocking in
`packages/fuse/platform.ts`. A nonblocking FFI call runs on an FFI thread rather
than the isolate thread and returns a promise. The daemon's flush in
`packages/fuse/mod.ts` awaits each call.

Now the invalidation blocks on the parent inode semaphore on an FFI thread. The
isolate thread stays free, answers the in-flight lookup, and the lookup releases
its read lock. The invalidation's write wait then completes on the FFI thread.
The cycle is broken.

The reply functions stay synchronous. They are called from inside the op
callbacks on the isolate thread, they hand an answer to an outstanding request
rather than waiting on a lock, and the reply-once contract depends on them
running inline. Only the reverse-invalidation calls, which take a lock that a
request can hold, needed to move off the isolate thread.

One lifetime detail: because an invalidation can now still be running on an FFI
thread when the daemon shuts down, `main()` awaits the last flush before it
destroys the session, so a notify call cannot dereference freed session memory.
By shutdown the session has been unmounted, which releases any blocked notify,
so the wait resolves promptly.

`packages/fuse/platform.test.ts` guards the invariant: the reverse-invalidation
symbols must be nonblocking and the reply functions must not be, so a later edit
cannot quietly move the invalidation back onto the request thread.

### Verification

Under the same forty-eight-worker `stat` storm that deadlocks the current
daemon at once, the fixed daemon kept serving: it handled thousands of lookups
and getattrs over twenty seconds while issuing invalidations continuously, and
its isolate thread stayed in the normal event-loop wait (`ep_poll`) throughout.
The deterministic inline trigger, which deadlocks every time before the fix,
also completed the lookup and returned correct metadata after it.
