---
status: historical
created: 2026-07-17
archived: 2026-07-17
reason: "Point-in-time record of the on-hardware FUSE-T verification of stable inodes and the moving mtime, including the measurement that the same-size staleness is bounded rather than unbounded"
---

# Verification: stable FUSE inodes and moving mtime on FUSE-T

This records the on-hardware verification of the stable-inode rebuild work
(`fuse-stable-inodes` branch) against FUSE-T 1.2.7 on macOS 26, arm64, run
against a local toolshed. It captures what was confirmed and one measurement
that corrects the framing the change was built with.

## Setup

A local toolshed on a copy-specific port offset served one deployed piece (the
`fuse-exec` integration fixture, whose result exposes a `messageCount` counter
and a `lastMessage` string). Two FUSE-T mounts of the same space ran side by
side: one from the branch head (stable inodes plus a per-node mtime) and one
from the commit just before the mtime work (stable inodes, no mtime, stat
carries no modification time). Driving the `recordMessage` handler stepped the
counter through single-digit values, each step a same-byte-length content
change (`1`→`2`→`3`…), which is the case the mtime was added to keep fresh.

## Confirmed

- **Inode stability holds.** The `result/messageCount` value file kept the same
  inode number (`26`) across every rebuild on both mounts. This is the branch's
  core deliverable, and it reproduces on real FUSE-T.
- **The mtime moves.** On the branch-head mount the file's stat `mtime` advanced
  with each content change; on the pre-mtime mount it stayed `0`. `ls -l`
  reported `Jul 17 16:52` on the branch-head mount and `Dec 31 1969` (the epoch)
  on the pre-mtime mount — a user-visible correctness difference independent of
  freshness.
- **Same-size changes read fresh through the mount.** Stepping the counter
  through same-length values and reading the value file back through the NFS
  mount reflected each new value on both mounts.

## The correcting measurement

The mtime work was motivated by a review finding that predicted a same-size
content change on a stable inode would "read stale indefinitely" on the macOS
NFS backend, because FUSE-T ignores the inode-invalidation notifications and
stat carried no modification time. On FUSE-T 1.2.7 that unbounded staleness
does not occur.

Polling both mounts every 0.2 s immediately after a same-size change, with the
default one-second attribute-cache timeout:

| | with moving mtime | no mtime |
| --- | --- | --- |
| same-size change read fresh after | ~0.4 s | ~0.8–1.2 s |

The no-mtime mount refreshed within roughly the attribute-cache timeout rather
than staying stale — the one-second `attrcache-timeout` default (established in
the earlier [FUSE-T cache-tuning
evaluation](./noattrcache-mount-option-evaluation.md)) forces a revalidation
that refetches the content regardless of whether the mtime moved. A repeat with
an untuned mount (`--attrcache-timeout 0`) also refreshed both mounts within a
couple of seconds; FUSE-T's NFS backend does not appear to cache positive file
content long enough for a same-size change to go stale for the tens of seconds
the earlier evaluation measured for negative-name and directory-listing
staleness.

So the moving mtime **tightens the freshness window** for a same-size change
(here roughly halving it) and **restores correct file timestamps**, but it does
not rescue an otherwise-broken read on this backend, because the staleness it
guards against is bounded by the attribute-cache timeout, not unbounded. It
remains worth keeping: correct mtimes are expected by ordinary tools, the
tighter window is a real improvement, and the signal is load-bearing for any
client that caches file data by mtime-and-size for longer than FUSE-T does.

## Cleanup

All four mounts were unmounted, the pre-mtime git worktree removed, and the
local dev servers stopped; the working tree was left clean on the branch.
