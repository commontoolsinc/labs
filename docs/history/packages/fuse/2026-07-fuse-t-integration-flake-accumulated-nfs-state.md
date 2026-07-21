---
status: historical
created: 2026-07-18
archived: 2026-07-18
reason: "Root-cause record for a FUSE-T integration-suite failure that looked like a #4811 daemon regression but was accumulated macOS NFS state; no daemon fix was warranted."
---

# FUSE-T integration failure: accumulated stale NFS mounts, not a daemon regression

## Summary

On macOS with FUSE-T, `packages/cli/integration/fuse-exec.sh` failed on its
very first `wait_for_path` for the mounted pieces directory
(`$MOUNTPOINT/$SPACE/pieces`). The daemon reported the mount, but the kernel
never made the pieces directory visible to a `stat`, so the shell's poll loop
ran out its twenty-second timeout. This looked like a regression from the recent
FUSE daemon changes — most suspiciously #4811, which moved the reverse-cache
invalidation FFI calls off the request thread — because the daemon log carried
`notify_inval_entry(...) => -57` (ENOTCONN) lines that had not been seen before.

It is not a daemon regression. The failure is accumulated macOS kernel NFS
state: stale `fuse-t:` mounts and orphaned `go-nfsv4` helper processes left
behind by `SIGKILL`-ing FUSE daemons without a clean unmount. Enough stale
mounts degrade the kernel's NFS client so that a *new* FUSE-T mount cannot serve,
and the daemon's directory-entry-visibility mechanism — which does not depend on
`notify_inval_entry` on FUSE-T — never gets a chance to run.

## What actually makes directory entries visible on FUSE-T

FUSE-T translates FUSE operations into NFS and serves them through a per-mount
`go-nfsv4` process. On that path, two things a normal libfuse daemon relies on do
nothing:

- The entry and attribute timeouts a reply carries are ignored.
- `notify_inval_entry` and `notify_inval_inode` are not acted on (see
  `packages/fuse/mount-options.ts` and the #4811 record,
  `reverse-invalidation-deadlock.md`).

The daemon makes new entries visible on FUSE-T through the two mechanisms that
the NFS client does honor, both already present before this investigation:

- The parent directory's mtime is advanced whenever its entry set changes.
  `FsTree.touch` (added in #4810) is called when a piece appears under a space
  (`CellBridge.addPieceToSpace`), when a piece is removed, and when a piece
  directory gains or loses a top-level entry. The macOS NFS client revalidates a
  directory's cached entries — including negative-name entries — against the
  directory's mtime, so advancing it is the signal that drops a stale "not
  found".
- The `attrcache-timeout=1` mount option (default for FUSE-T since #4722) bounds
  how long the NFS client serves a stale attribute, negative-name entry, or
  directory listing to one second.

This is the same principle #4789 applied to the generated `.status` file: on
macOS, freshness is carried by the node mtime plus the attribute-cache bound, not
by the kernel-invalidation calls. Directory entries were already covered by it.

## Reproduction

On a freshly restarted set of local dev servers with no stale FUSE state, the
suite passes reliably. Across more than a dozen runs — sequential and four-way
concurrent — every run passed in roughly twenty seconds, and the daemon logged
no `notify_inval_entry` failure (the daemon only logs that call when its return
code is non-zero, and here it returned zero).

The failure reproduces by recreating the accumulated state directly. Mounting a
space and immediately `kill -9`-ing the daemon, thirty times, leaves the
daemon's kernel NFS mount and its `go-nfsv4` helper behind each time, because
`SIGKILL` cannot be caught and so no clean unmount runs. After that churn:

- `mount | grep -c fuse-t:` showed twelve stale mounts and there were eighteen
  orphaned `go-nfsv4` processes.
- The next real suite run failed on the first `wait_for_path`. Its daemon log
  ended with:

  ```
  Mounted at /var/folders/.../tmp.XXXX
  Press Ctrl+C to unmount
  [<space>] syncPieceListOnce: live=1 tracked=1
  FUSE loop exited (code -1)
  Cleaned up.
  ```

  `fuse_session_loop` returned `-1` almost immediately after the mount was
  announced, so the daemon served zero lookups. The daemon detected the exit and
  cleaned up correctly; the mount simply could not run because the kernel NFS
  transport was saturated by the stale mounts.

The degradation is cumulative. A lighter churn that left five stale mounts still
passed; twelve did not. The exact threshold is not fixed — it is whatever tips
the kernel NFS client over — but the direction is clear: more stale mounts,
closer to failure.

The `-57` seen in the original report is a milder point on the same spectrum:
there the session loop did start and the daemon stayed alive, but the NFS
reverse channel was not ready when a reverse invalidation fired, so
`notify_inval_entry` returned ENOTCONN. On FUSE-T that call is a no-op whether it
returns success or ENOTCONN, so the return code changes nothing; it is a symptom
of the degraded NFS layer, not a cause of the invisible directory.

## Confirmation that it is environmental

Unmounting the twelve stale mounts (`umount -f` on each `fuse-t:` mount) and
killing the orphaned `go-nfsv4` processes returned the machine to zero stale
mounts and zero helpers. The suite then passed again with no other change. Clean
state passes, accumulated state fails, cleanup restores passing.

A clean shutdown does not accumulate anything. A single mount followed by
`cf fuse unmount` tears down both the kernel mount and the `go-nfsv4` helper,
leaving zero of each. Only `SIGKILL` leaks, and `SIGKILL` cannot be caught, so
the daemon cannot clean up after it. The accumulation in the original report came
from the heavy mount/unmount/kill churn of a long debugging session, not from
normal test runs, each of which unmounts cleanly.

## Why #4811 was the wrong suspect

#4811 moved the reverse-invalidation FFI calls off the isolate thread to break a
Linux inode-lock deadlock; that deadlock and its fix are Linux-specific. On
FUSE-T the calls do nothing regardless of which thread issues them, so the change
cannot affect what a FUSE-T mount makes visible. The `-57` lines it surfaced are
new only in that the previous FUSE-T runs happened to issue their invalidations
after the reverse channel was up (return code zero, not logged); they are not a
new failure.

## Recovery

When the FUSE-T integration suite starts failing on the first `wait_for_path`
after a session with much mount/unmount/kill churn, the state to clear is the
kernel's, not the repository's:

```sh
mount | grep 'fuse-t:' | awk '{print $3}' | while read -r mp; do umount -f "$mp"; done
pkill -9 -f go-nfsv4
```

Then restart the local dev servers and rerun the suite. No daemon change is
needed; the directory-visibility mechanism is correct and, on non-degraded
state, works.
