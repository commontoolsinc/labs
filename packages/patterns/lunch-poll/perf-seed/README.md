# lunch-poll perf seed

Reusable seeding for the lunch-poll **performance investigation** — recreate the
exact rapids staging dataset against a local toolshed so the slow-load / socket /
flicker symptoms can be reproduced and measured in a controlled environment.

## Quick start

```bash
# servers up? (./scripts/start-local-dev.sh from the repo root if not)
packages/patterns/lunch-poll/perf-seed/seed.sh          # fresh seeded poll → prints URL
```

Open the printed URL, then **Register → Import CLI Key**, upload `cf.key`, and
you load as the joined host "Gideon" (matching the snapshot).

## Modes

| Command | Result |
|---|---|
| `seed.sh` | fresh deploy, full mirror (10 options w/ art, 35 votes, 4 users) |
| `seed.sh --piece <fid1:...>` | reseed an existing piece in place (fast, for A/B) |
| `seed.sh --no-art` | options with `imageUrl` stripped (63KB → ~1KB) |
| `seed.sh --empty` | zero options/votes/users (pure runtime/pattern-boot baseline) |

Flags: `--space`, `--api-url`, `--identity`, `--pattern`. Env: `CF_API_URL`,
`CF_IDENTITY`.

## Data provenance

`data/*.json` was pulled on 2026-06-23 from the rapids staging poll
(piece `fid1:bb9YQo5g-9B0o9Nx_cR9sR5qA8oxEkFA5AYUlC84EwE`, space
`lunch-2026-06-23`, build `040b201f0`) via the registered identity:

- **10 options** — each carries an inline `data:image/webp;base64` `imageUrl`
  (2–11 KB; ~63 KB total) from the host-generated dish-illustration feature.
- **35 votes** — `voteType` green/yellow/red = 18/10/7.
- **4 users** — Gideon, Danfuzz, Berni (remote), Alex.

## The one gotcha

Poll state is `PerSpace` **input**. Write it with `cf piece set --input`. Without
`--input`, the write targets the computed *result* proxy and whole-array writes
**silently no-op** (scalars stick, arrays do not). The script always uses
`--input`.
