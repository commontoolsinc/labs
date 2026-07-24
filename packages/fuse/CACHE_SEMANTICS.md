# FUSE cache semantics and our flag choices

Why reads through a CF FUSE mount can briefly return stale results on macOS,
what the relevant mount flags actually do (they are misleadingly named and their
meaning has already changed across FUSE-T versions), and the reasoning behind
how `cf exec` checks for a mounted callable. If you are reaching for a
cache-related mount flag or debugging a "file exists but the mount can't see it
yet" report, start here.

The measurements below were taken with a small synthetic FUSE-T filesystem that
makes a file begin to exist daemon-side with no client syscall, while logging
every kernel request — so a stat/readdir served from the client cache is
distinguishable from one that reached the daemon. Re-measure that way (and read
`nfsstat -m`) before trusting flag behavior on a new FUSE-T version.

## The short version

- On **Linux** none of this applies: kernel FUSE honors the per-reply
  `entry_timeout`/`attr_timeout` we set to `0`, so every lookup reaches our
  bridge. The staleness below is **macOS-only**.
- On **macOS**, CF mounts are NFS translations (FUSE-T → the kernel NFS client).
  FUSE-T **ignores the cache timeouts a filesystem returns** (documented
  limitation), so caching is entirely the macOS NFS client's, governed by its
  own mount parameters — not by anything our bridge sends.
- Two client caches cause stale reads: the **negative name cache** (a "not
  found" is remembered) and the **attribute/directory cache**
  (`acregmin=5,
  acregmax=60, acdirmin=5, acdirmax=60` — a stat or `ls` result
  is trusted for 5–60 s, age-dependent).
- `-o noattrcache` **does not mean what its name says on current FUSE-T.** On
  1.2.x it maps to `nonegnamecache` _only_ — it disables the negative name cache
  and leaves the attribute/directory cache fully on. Confirm with `nfsstat -m`,
  never from the flag name.

## Layers

| Layer                       | Platform | Role in caching                                                                                                                                                                                                      |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CF bridge (`packages/fuse`) | both     | Serves lookups/reads; sets reply timeouts to `0` for dynamic piece content. Effective on Linux, ignored on macOS.                                                                                                    |
| Kernel FUSE (libfuse)       | Linux    | Honors the `0` timeouts; error-style `ENOENT` is not negatively cached; readdir is not cached; `notify_inval_*` works. No staleness.                                                                                 |
| FUSE-T translation          | macOS    | Userspace NFS server. Ignores the filesystem's reply timeouts ("caching attributes returned by the filesystem implementation are ignored"); no `notify_inval_*` on the NFS backend. Exposes only coarse mount flags. |
| macOS NFS client (xnu)      | macOS    | Owns the actual caching: negative name cache + age-based attribute cache (`acreg*/acdir*`). This is where the staleness lives.                                                                                       |

## What the flags actually do (verify with `nfsstat -m`)

Default CF mount, from `nfsstat -m`:

```
... negnamecache, ..., rdirplus, ..., acregmin=5,acregmax=60,acdirmin=5,acdirmax=60, ...
```

`-o noattrcache` changes exactly one thing on FUSE-T 1.2.x:

```
... nonegnamecache, ...      # acregmin/acdirmin etc. UNCHANGED
```

So on 1.2.x `noattrcache` disables only negative-name caching. **This changed
between versions** — on FUSE-T 1.0.x the same flag also zeroed the attribute
cache. Do not assume its effect; read `nfsstat -m` on the version you ship.

## The two staleness behaviors (measured)

Measured on macOS 15 / arm64, FUSE-T **1.0.49** and **1.2.7**:

| Behavior                                                                          | Cause                               | Default                                                         | With `-o noattrcache`                                                             |
| --------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Repeated `stat` of a known path keeps returning "not found" after the file exists | negative name cache                 | **~50 s** window (both versions), zero daemon traffic during it | **~0.2 s** (both versions) — `nonegnamecache` makes the stat authoritative        |
| An `ls` / readdir returns stale directory contents                                | attribute/directory cache (`acdir`) | stale up to `acdirmax` = 60 s                                   | **1.0.x: fixed** (attr cache zeroed); **1.2.x: NOT fixed** (attr cache untouched) |

Takeaways:

- The ~50 s negative-name window is why a stat-only retry loop cannot recover: a
  1 s budget against a cache that answers for tens of seconds, asking the same
  question that returned the stale answer. Escaping it requires a call the
  client can't serve from that cache (a readdir that reaches the daemon), or
  `nonegnamecache`.
- On 1.2.x, `noattrcache` fixes negative-name staleness (known-path stats) but
  **not** directory-listing staleness. Pick the flag by which one you have.

## Why `cf exec` resolves a mounted callable the way it does

`cf exec` must confirm a callable file exists before invoking it. A `stat` alone
can hit the negative name cache and wrongly report "not found" for up to the
window above. The existence check therefore falls back to listing the parent
directory, because a readdir that reaches the daemon refreshes the entry.

**Known latent edge:** if that fallback readdir is itself served from a stale
_directory_ cache (within `acdir` validity), it can miss a just-created callable
and return a false "not found" with no retry. Reproduced ~1 in 14 runs on 1.2.7;
it is timing-narrow but real, and independent of `noattrcache`. The robust,
version-independent fix is a **single bounded retry on the readdir-miss path**
(sleep past the `acdir` validity window, readdir once more, then fail) — latency
lands only on the miss path, and a genuinely absent file still errors after one
retry. `-o noattrcache` also masks this (via `nonegnamecache`, the stat becomes
authoritative so the fallback is never reached), but relying on it is brittle:
its meaning already shifted once between versions and it does nothing for
directory-listing staleness.

## If you are choosing a cache flag

- **Don't trust the flag name — read `nfsstat -m`** on the FUSE-T version you
  ship. `noattrcache` = `nonegnamecache` only, today.
- **Known-path existence/read coherence:** `nonegnamecache` (via `noattrcache`)
  or a bounded retry is enough.
- **Directory-listing freshness:** neither `noattrcache` (on 1.2.x) nor bumping
  directory mtimes helps within the validity window — the client serves the
  cached listing without revalidating. Only shrinking `acdir` (not exposed by
  FUSE-T) or tolerating up to 60 s would.
- **Linux:** unaffected; no flag needed.

## Sources

- FUSE-T wiki (mount options, unsupported features, caveats):
  <https://github.com/macos-fuse-t/fuse-t/wiki>. Relevant upstream history on
  the caching behavior:
  [fuse-t#61](https://github.com/macos-fuse-t/fuse-t/issues/61) (disabling the
  attr cache livelocked the NFS client), and
  [fuse-t#71](https://github.com/macos-fuse-t/fuse-t/issues/71) (attr caching
  re-enabled / lookup caching bug fixed).
- Apple `mount_nfs(8)` — `acreg*/acdir*` defaults, `nonegnamecache`.
- xnu `bsd/nfs/nfs_vnops.c` — `nfs_vnop_lookup` (negative cache),
  `nfs_vnop_readdir`.
- In-repo: `mod.ts` (`replyEntry` timeouts, mount args, `notify_inval_*` ENOSYS
  handling), `stat.ts` (no timestamps emitted), `packages/cli/lib/exec.ts`
  (`assertMountedCallableFileExists`).
