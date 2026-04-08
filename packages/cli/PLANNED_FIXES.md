# Planned Fixes

## First Batch

### CT-1399

- Fix `cf piece call` and `cf exec` handler invocation so handler failures
  propagate as non-zero exits instead of reporting success.
- Route handler execution through stream `send(..., onCommit)` and inspect the
  committed transaction status after scheduler retries are exhausted.
- Capture runtime error messages for the active CLI runtime and prefer those in
  stderr when a handler action throws.

### CT-1436

- Treat schema-less / `Stream<void>` handlers as zero-input handlers.
- Allow bare invocation with no args instead of requiring `--value null`.
- Update help and FUSE `.handlers` output to say these handlers can be invoked
  with no args.

## Second Batch

### CT-1438

- Fix FUSE writes that currently rely on stale inode re-resolution during
  asynchronous flush/release handling.
- Store a stable write target on open file handles so heredoc / shell redirect
  writes survive subtree rebuilds.
- Separate truncate-only state from final buffered content so shell redirection
  does not commit an empty intermediate write.

## Third Batch

### CT-1434

- Mitigate mount stalls under agent load by coalescing repeated subtree rebuilds
  and invalidations per piece/property.
- Add lightweight instrumentation around rebuild backlogs and timings so we can
  distinguish our own churn from FUSE-T / NFS bridge stalls.
- Keep this as a mitigation-oriented pass unless deeper evidence points to a
  specific runtime bug we can fix directly.
