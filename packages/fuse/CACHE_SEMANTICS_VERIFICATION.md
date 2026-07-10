# FUSE cache semantics: verifying the claims in PR #4642

Status: live working document. Findings below are source-verified; the
experiments section is pending execution on a local macOS machine with FUSE-T.
When the experiments are done and PR #4642 is resolved, fill in the results and
archive this file to `docs/history/packages/fuse/` per `docs/README.md`.

## Context

[PR #4642](https://github.com/commontoolsinc/labs/pull/4642) replaces the
20×50ms `Deno.stat` poll in `cf exec`'s mounted-callable existence check
(`packages/cli/lib/exec.ts`) with a single stat plus a parent-directory-listing
fallback. Its justification makes several claims about "FUSE semantics". Those
claims mix behavior from four distinct layers, and only some layers exist on
each platform. This document attributes each claim to its layer, records what
is already verified against primary sources, and specifies the experiments
needed to confirm the rest.

## Layer map

CF FUSE runs on both Linux and macOS, but the cache stack differs completely:

| Layer | Platform | What it caches / controls | Can CF control it? |
| --- | --- | --- | --- |
| **CF fuse bridge** (`packages/fuse`) | both | In-memory `FsTree`; clears + re-hydrates piece-prop subtrees on cell changes; hydrates on both lookup (`cell-bridge.ts` `prepareLookup`) and readdir (`prepareDirectory`); maps *any* hydration failure to ENOENT (`mod.ts:1000-1002`) | yes — it's ours |
| **Kernel FUSE via libfuse** | Linux only | Honors `entry_timeout`/`attr_timeout` per reply (CF sends 0 for dynamic inodes, `mod.ts:920`); does **not** cache negative lookups when the fs replies `fuse_reply_err(ENOENT)` (negative dentry caching requires replying an entry with `ino=0` and a timeout); does not cache readdir by default; supports `notify_inval_entry`/`notify_inval_inode` | yes — via reply timeouts and notify |
| **FUSE-T translation** | macOS only | Userspace NFS server bridging libfuse to the macOS NFS client. Wiki, verbatim: "Caching of attributes is done by the client. Currently the caching attributes returned by the filesystem implementation are ignored" and "Notifications: Works for SMB backend, unsupported for NFS and FSKit". Closed-source binary; offers a `-noattrcache` mount option | only via mount options |
| **macOS NFS client** (xnu) | macOS only | Attribute cache 5s min / 60s max by default (`acregmin`/`acdirmin`, `mount_nfs(8)`); **negative name cache on by default** (`nonegnamecache` exists to disable); lookup trusts a negative entry behind a *cached* directory GETATTR (`nfs_vnop_lookup`, `NGA_CACHED`); a readdir starting at offset 0 forces an *uncached* directory GETATTR (`nfs_vnop_readdir`, `NGA_UNCACHED`) and purges caches only if the directory's attributes changed | no — kernel policy; only mount options |

Consequences of the layer map:

- CF's zero entry/attr timeouts (`mod.ts:910-920`) are fully effective on
  Linux and a **documented no-op on macOS** — FUSE-T ignores them.
- The entire "stale NotFound" phenomenon PR #4642 addresses **cannot occur on
  Linux** from kernel caching: with timeout 0 and error-style ENOENT replies,
  every `stat` reaches the bridge. On Linux, a stale NotFound can only be a
  bridge answer (see the hydration-failure catch below).
- The PR's fallback readdir is, on Linux, simply a second trip to the bridge
  (readdir is never kernel-cached by default) — redundant but harmless, and it
  effectively grants one bridge-side retry via `prepareDirectory`.

## Claim-by-claim status

Layer key: **B** = CF bridge, **K** = Linux kernel FUSE, **T** = FUSE-T,
**N** = macOS NFS client.

### 1. "FUSE-T cannot push kernel cache invalidations" — CONFIRMED (T; macOS only)

FUSE-T wiki lists notifications as unsupported for the NFS backend (CF uses
NFS; `mod.ts:3195` passes only `allow_other`/`default_permissions`). Matches
the ENOSYS handling at `mod.ts:3273`/`3307`. On Linux this claim is false —
`notify_inval_*` works — but there it is also unnecessary given timeout 0.

### 2. "A stale FUSE-T kernel cache reports transient NotFound" — MECHANISM IDENTIFIED, SEED UNCONFIRMED (N seeded by B; macOS only)

The sustaining mechanism is the macOS NFS client's **negative name cache**:
once a lookup has been answered ENOENT, xnu's `nfs_vnop_lookup` keeps
returning ENOENT from cache, with no network round-trip, until a *directory
change* is detected — potentially far longer than the old 1s poll budget
(which explains "an invalidation window that outlasted the budget").

But a negative entry must be **seeded** by one genuine ENOENT crossing the
wire. The bridge hydrates before answering lookups, so the prime suspect is
`mod.ts:1000-1002`: any transient `prepareLookup` failure is swallowed into
`fuse_reply_err(ENOENT)`. One transient hydration error → one ENOENT → the
kernel repeats it for the whole window. Unconfirmed; Experiment E1.

Platform note: on Linux the same hydration-failure ENOENT is *not* cached, so
the next stat retries the bridge — which is why the old poll "worked" and why
the phenomenon is macOS-only in practice.

### 3. "A readdir goes back to the bridge, so the listing names every callable file that exists" — PARTLY CONFIRMED (N; macOS only; trivially true on Linux)

Verified in xnu: a readdir from offset 0 (every `Deno.readDir`) always sends
an **uncached** GETATTR for the directory to the server — the exact asymmetry
vs. lookup that makes the PR's fallback work. Not guaranteed: the *entries*
are re-fetched only if that GETATTR shows the directory changed. CF's
`buildNodeStat` (`stat.ts:59`) sends **no timestamps**, so change detection
may never fire, and a previously kernel-cached listing may be served without
reaching the bridge.

Why the fallback still works for the PR's target race: any cached listing
either predates the subtree clear (file existed → named) or was answered by
the bridge post-hydration (→ named). Residual false-negative: a **just-created**
callable whose parent listing was kernel-cached before it existed now fails
with zero retries. Experiments E4/E5.

### 4. "Listing type flags come from the same cached attribute channel; name match counts unless the entry is a directory" — PLAUSIBLE, UNVERIFIED (N; macOS only; low stakes)

Consistent with NFS READDIRPLUS semantics. The directionally safe guard in
the PR is reasonable. Not worth an experiment unless E4 shows anomalies.

### 5. "A Deno.watchFs-based wait would never fire" — CONFIRMED ON BOTH PLATFORMS, for different reasons

macOS: FSEvents cannot observe daemon-side changes on an NFS volume, and
FUSE-T notifications are unsupported on NFS. Linux: inotify on FUSE only
reports changes that pass through the kernel; bridge-side rehydration does
not. (See libfuse wiki "Fsnotify and FUSE".) The PR's secondary argument — an
event-driven wait cannot terminate for a genuinely absent file without a
deadline — holds regardless of platform.

## What we still do not understand

1. What actually seeds the negative entry (claim 2) — bridge hydration-failure
   ENOENT, a bridge-side clear/hydrate race, or FUSE-T's own translation
   layer.
2. Whether FUSE-T synthesizes a changing NFSv4 change attribute even though
   the bridge reports no timestamps. The fuse README's observation that new
   pieces appear "within 1-2 seconds" suggests *something* revalidates;
   FUSE-T is closed-source, so only observation can tell.
3. How long the stale window really lasts, and whether an `ls` (readdir)
   actually clears it — i.e., empirical confirmation that the PR's fallback
   defeats the negative cache.
4. Whether the residual false negative (just-created file + cached parent
   listing) occurs at realistic timings.
5. The cost/benefit of mounting with FUSE-T's `-noattrcache`.

## Experiments for a local agent (macOS with FUSE-T)

Prerequisites: macOS machine with FUSE-T installed (`brew install fuse-t`),
this repo, and a running backend (see `docs/development/LOCAL_DEV_SERVERS.md`
and the `cf`/`fuse-workflow` skills). Mount with op logging:

```bash
deno task cf fuse mount --debug /tmp/cf   # or CF_FUSE_DEBUG=1
```

Deploy a test piece with at least one callable (see `skills/cf`), e.g. a
pattern exposing `result/search.tool`. **All daemon-side mutations below must
go through the cf CLI / API, never through the mount** — writes through the
mount pass through the kernel and update its caches coherently, which would
mask the effects under test.

General instrumentation: `nfsstat -c` before/after each step (deltas in
lookup/readdir/getattr RPC counts show what went over the wire); the bridge
`--debug` log shows which ops reached the bridge. FUSE-T logs land in
`~/Library/Logs/fuse-t` when its debug is enabled.

### E1 — What seeds the ENOENT? (claim 2's missing link)

1. Add a temporary log line inside the `prepareLookup(...).catch` at
   `packages/fuse/mod.ts:1000-1002` (it currently converts any hydration
   failure to ENOENT silently) and in the equivalent readdir path.
2. Reproduce the original race: in a loop, write to the piece's input cell via
   the cf CLI (each write triggers a result-subtree clear + rehydrate) while
   concurrently running `stat /tmp/cf/<space>/pieces/<piece>/result/search.tool`
   in a tight shell loop. Run for several minutes.
3. Record: every interval where stat returns ENOENT; whether the bridge log
   shows (a) a lookup answered ENOENT — and if so whether via the hydration
   catch — or (b) **no bridge traffic at all** during the window.
4. Interpretation: (a) confirms the bridge seeds it (and the catch is a fixable
   bug affecting both platforms); (b) with a *preceding* single bridge ENOENT
   confirms seed-then-cache; (b) with *no* prior bridge ENOENT points at
   FUSE-T's own layer.

### E2 — Negative-cache persistence and whether readdir clears it (claims 2+3)

1. `stat` a name that does not exist yet in a prop dir (e.g.
   `result/new.tool`) a few times — this seeds a negative entry.
2. Change the pattern/input via CLI so that file comes into existence
   daemon-side.
3. Arm A: loop `stat` once per second; record seconds until success.
4. Remount (or use a different fresh name) and repeat, Arm B: after creating
   the file, run `ls` on the parent dir once, then `stat`. Record whether stat
   succeeds immediately after the `ls`.
5. Interpretation: Arm A measures the raw stale window (expect within
   5–60s attr-cache bounds if the negative-cache theory is right). Arm B ≪
   Arm A confirms readdir purges/bypasses the negative entry — the PR's core
   bet. Also record `nfsstat -c` deltas: Arm A stats producing *no* lookup
   RPCs is the direct signature of the negative name cache.

### E3 — Does the fallback listing reach the bridge during the window? (claim 3)

During an E2 Arm A stale window, run `ls` on the parent and check the bridge
`--debug` log for a readdir/lookup op at that moment, and whether the listing
printed the file. Bridge op observed + file listed = claim 3 confirmed for
this scenario. File listed with *no* bridge op = kernel served a cached
listing that happened to contain it (claim 3 as stated is false, but the fix
still works); file *missing* = the PR's fallback is unsound.

### E4 — The residual false negative (just-created file + cached listing)

1. `ls` the parent dir (seeds the kernel's directory-listing cache).
2. Create a new callable in it daemon-side via CLI.
3. After a delay of 0.5s / 1s / 2s / 5s (separate trials, ~10 each), run the
   PR's exact sequence via a small Deno script: `Deno.stat(file)`; on
   NotFound, `Deno.readDir(parent)` and check for the name.
4. Record the rate at which the readdir fallback misses the file per delay.
5. Interpretation: a nonzero miss rate at realistic delays means PR #4642
   should add a single delayed retry (or the bridge should bump directory
   mtimes — see below) before merging; zero misses closes the concern.

### E5 — Does FUSE-T synthesize a change attribute? (unknown 2)

While creating/deleting children daemon-side, watch the parent directory's
`stat -f "%m %c" /tmp/cf/<...>/result` from the shell. The bridge sends no
timestamps; if mtime/change still moves, FUSE-T synthesizes one (good — the
kernel's change detection works, and E4 should show zero misses). If it never
moves, negative entries and cached listings are only bounded by attr-cache
expiry (5–60s), and bumping directory mtimes in `buildNodeStat` on rehydration
becomes the recommended bridge-side fix for all consumers, not just `cf exec`.

### E6 — `-noattrcache` cost/benefit (optional)

Add `fuseArgs.push("-o", "noattrcache")` at `mod.ts:3195`, remount, re-run E2
and E4 (expect the staleness to vanish), and measure the cost: `time ls -R`
over a large space, before vs. after. Decides whether mount options beat
code-level workarounds.

### E7 — Linux control (optional, any Linux box with fuse3)

Run E1's race repro on Linux. Expected: no stale windows at all (`--debug`
shows every stat reaching the bridge; `notify_inval_entry` returns 0). Any
observed ENOENT must coincide with a bridge-logged ENOENT (e.g. the hydration
catch) — which would confirm that piece of the story platform-independently.

## Follow-ups independent of the experiments

- `packages/fuse/README.md:316-318` claims kernel-cache invalidation via
  `notify_inval_entry`; the `cell-bridge.ts:1495` comment says FUSE-T lacks
  `notify_inval_entry` but implies `notify_inval_inode` works. Both contradict
  the source-confirmed reality (neither works on FUSE-T/NFS). Reconcile.
- The `replyEntry` comment at `mod.ts:910-914` ("keep cache timeouts short" as
  the FUSE-T mitigation) should note that FUSE-T ignores those timeouts
  entirely; the timeouts only govern Linux.
- Consider surfacing real (or monotonically bumped) directory mtimes from
  `buildNodeStat` — on macOS a changing directory attribute is what purges
  negative name-cache entries and cached listings.

## Primary sources

- [FUSE-T wiki — options, unsupported features, caveats](https://github.com/macos-fuse-t/fuse-t/wiki)
- [Apple `mount_nfs(8)` source (aosm/NFS)](https://github.com/aosm/NFS/blob/master/mount_nfs/mount_nfs.8) — `acregmin`/`acdirmin` defaults, `nonegnamecache`
- [xnu `bsd/nfs/nfs_vnops.c`](https://github.com/apple/darwin-xnu/blob/main/bsd/nfs/nfs_vnops.c) — `nfs_vnop_lookup` (negative cache behind `NGA_CACHED`), `nfs_vnop_readdir` (`NGA_UNCACHED` at offset 0)
- [libfuse wiki — Fsnotify and FUSE](https://github.com/libfuse/libfuse/wiki/Fsnotify-and-FUSE)
- This repo: `packages/fuse/mod.ts` (`replyEntry`, lookup callback, notify
  fallbacks, mount args), `packages/fuse/cell-bridge.ts` (`prepareLookup`/
  `prepareDirectory`, prop-subtree clear), `packages/fuse/stat.ts`
  (no timestamps), `packages/cli/lib/exec.ts` (the code PR #4642 changes)
