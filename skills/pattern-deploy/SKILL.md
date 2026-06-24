---
name: pattern-deploy
description: Deploy patterns and test with CLI
user-invocable: false
---

# Deploy Phase

Use the `cf` skill, or read `skills/cf/SKILL.md`, for comprehensive CLI
documentation. Use the command shapes from its Quick Command Reference rather
than guessing flags; this skill only covers the deploy workflow and exit
criteria.

## Read First

- `skills/cf/SKILL.md` — the Environment Setup section (`CF_API_URL`,
  `CF_IDENTITY`, identity key creation) is the prerequisite for every command
  below
- `docs/development/LOCAL_DEV_SERVERS.md` - Local dev setup
- `docs/common/workflows/development.md` - Workflow commands

## Find Identity Key

```bash
ls -la ./cf.key 2>/dev/null || ls -la *.key 2>/dev/null || find . -name "*.key" -maxdepth 2 2>/dev/null
```

If no key exists, create one per the cf skill
(`deno run -A packages/cli/mod.ts id new > cf.key` for a unique key — note the
cf skill's warning: never redirect `deno task cf` output into a key file, the
wrapper pollutes it with ANSI preamble). Never overwrite an existing key file —
identity-scoped data (PerUser state, favorites) becomes invisible under a new
identity. Do **not** use `id derive "implicit trust"` here: it is a shared,
publicly-derivable identity, so deploying with it to a shared server collides
you into one principal with every other developer who did the same (see the cf
skill and `docs/development/SHARED_IDENTITY.md`).

## Commands

With `CF_API_URL` and `CF_IDENTITY` exported (see the cf skill), you can drop
`--api-url`/`--identity`; `--space` is always required.

**Check syntax without deploying:**

```bash
deno task cf check pattern.tsx --no-run
```

**Deploy new pattern (first time only):**

```bash
deno task cf piece new packages/patterns/[name]/main.tsx --identity cf.key --api-url $CF_API_URL --space <space>
# Output: Created piece bafyreia... <- SAVE this piece ID
```

**Update deployed pattern (all subsequent iterations):**

```bash
deno task cf piece setsrc packages/patterns/[name]/main.tsx --piece <ID> --identity cf.key --api-url $CF_API_URL --space <space>
```

`--piece` is required for `setsrc` — never "update" by re-running `piece new`,
which creates a duplicate piece.

**Inspect piece state:**

```bash
deno task cf piece inspect --piece <ID> --identity cf.key --api-url $CF_API_URL --space <space>
```

**Test handler via CLI:**

```bash
deno task cf piece call handlerName --piece PIECE_ID
deno task cf piece step --piece PIECE_ID    # Required! Triggers recomputation
deno task cf piece inspect --piece PIECE_ID  # Now shows updated state
```

**Important:** Always run `piece step` after `piece call` or `piece set`.
Without it, computed values remain stale and `inspect`/`get` return old data.

## When Deploy Fails

- If `piece new` or `setsrc` errors, re-run `deno task cf check` locally first.
- Verify `CF_API_URL` is reachable (see the cf skill's troubleshooting table).
- If you accidentally ran `new` twice, remove the duplicate with
  `deno task cf piece rm --piece <ID> ...` before continuing.
- Never retry `new` to "fix" a failed `setsrc`.

## Get Help

```bash
deno task cf --help
deno task cf piece --help
```

## Done When

- Piece deploys without errors
- State inspects correctly
- Handlers respond to CLI calls
