# Lunch Poll

`main.tsx` is the canonical lunch-poll pattern used for deployment and product
behavior. The diagnostic tooling is intentionally separate from the pattern
files so repo-wide pattern checks do not compile it as a pattern:

- `../tools/lunch-poll-diagnose.ts` runs headless multi-runtime scaling probes.

By default, diagnostics run against `main.tsx` so runtime changes are measured
against the product lunch-poll graph instead of a comparison fixture.

Run a single lunch-poll scenario with `N` options, `M` voters, and `X` vote
cycles by setting one option count, one user count, and one round count. `M`
must be at least `1` because one user is the host that creates options and
drives refreshes:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --options=10 \
  --users=5 \
  --rounds=3 \
  --skip-refresh
```

Run an explicit matrix with `options x users` cases when comparing runtime
changes across multiple sizes:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --cases=1x2,3x5,10x5 \
  --rounds=3 \
  --skip-refresh
```

Use `--program=<file>` to point the same scenario runner at another local lunch
poll pattern variant when you intentionally want to compare a branch-local
experiment:

```bash
deno run -A packages/patterns/tools/lunch-poll-diagnose.ts \
  --program=main.tsx \
  --cases=1x2,3x5,10x5 \
  --rounds=3 \
  --skip-refresh
```
