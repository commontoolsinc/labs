# Lunch Poll

`main.tsx` is the canonical lunch-poll pattern used for deployment and product
behavior. The diagnostic tooling is intentionally separate from the pattern
files so repo-wide pattern checks do not compile it as a pattern:

- `../tools/lunch-poll-diagnose.ts` runs headless multi-runtime scaling probes.
- `deploy-safe.sh` runs the complete test set plus `setsrc --check`; it is
  preflight-only unless explicitly invoked with `--apply`.

Deployment and migration details, including why link-bearing JSON exports are
not restorable backups, live in [`DEPLOY-AND-SHARE.md`](./DEPLOY-AND-SHARE.md).

By default, diagnostics run against `main.tsx` so runtime changes are measured
against the product lunch-poll graph instead of a comparison fixture.

Each case opens one poll across as many runtimes as it has voters, gives every
voter an identity, joins them, has the host add the options, and then runs the
requested number of rounds of concurrent voting. Every phase is sampled for
scheduler graph size, settle cost, and action-run trace, and each case ends with
the commit-churn counters and a cross-session convergence check. The sampled
phases go to standard output as one JSON document; the per-phase summary lines
go to standard error.

Run a single lunch-poll scenario with `N` options, `M` voters, and `X` vote
cycles by setting one option count, one user count, and one round count. `M`
must be at least `1` because one user is the host that creates options and
drives refreshes:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --options=10 \
  --users=5 \
  --rounds=3
```

Run an explicit matrix with `options x users` cases when comparing runtime
changes across multiple sizes:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --cases=1x2,3x5,10x5 \
  --rounds=3
```

`--quick` is the smoke-sized default matrix — options `1,3` against `2` users
for one round — for checking that the probe itself still runs. It and
`--production` are mutually exclusive:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts --quick
```

`--production` reproduces the current deployed shape — `14` options, `1` viewer,
and `3` vote rounds — without having to remember those dimensions:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts --production
```

Record graph size, phase elapsed time, settle time, and commit churn together. A
fast handler measured without the rendered result graph does not represent a
browser vote. The probe runs the server-execution OFF arm unless
`EXPERIMENTAL_SERVER_EXECUTION` is set explicitly; headless, the ON posture
waits on a toolshed that is not running.

Use `--program=<file>` to point the same scenario runner at another local lunch
poll pattern variant when you intentionally want to compare a branch-local
experiment:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=main.tsx \
  --cases=1x2,3x5,10x5 \
  --rounds=3
```

Every step the probe drives is gated in the pattern: joining needs a resolved
profile, adding an option needs the host, and casting a vote needs a roster
entry and a resolved clock. A case whose setup a gate refuses fails with the
phase it stopped at and the poll state each session was left in, rather than
reporting the zeros that refusal produces.
`../integration/lunch-poll-diagnose.test.ts` runs the smallest case there is and
checks what it measured, so a change to one of those gates fails there rather
than the next time somebody reaches for the probe.
