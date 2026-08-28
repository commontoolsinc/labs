---
name: pattern-iframe
description: Build or generate a Common Fabric pattern whose primary UI is a self-contained `cf-iframe` guest. Use when an agent should turn an input-data shape and a small state/output contract into a working iframe-first pattern without learning the broader pattern framework, including React guests, PerSpace/PerUser/PerSession data, path-scoped Cell access, stable array-item handles, mergeable pushes, or bridged SQLite.
---

# Iframe-first patterns

Choose one self-contained authoring contract before writing code:

- For a React component tree, hooks, or an explicitly requested React guest,
  read `docs/common/ai/iframe-pattern-react-guide.md` in full.
- Otherwise read `docs/common/ai/iframe-pattern-guide.md` in full for a plain
  DOM guest.

Do not load both guides unless the task is a migration between those styles. Do
not load the general pattern-development guides unless the requested behavior
extends beyond the generated wrapper.

Keep the authored surface small:

- `contract.ts` names the input, durable state, and output data shapes and their
  defaults.
- `guest.ts` or `guest.tsx` owns the application. It may use plain DOM code or
  React and the guest bridge.
- `main.tsx` is generated glue. Do not hand-edit it.
- One joint initial `pull()` barrier owns readiness for every resource an action
  uses. Keep action controls disabled until it resolves; an individual
  synchronous `sink()` callback must never declare the guest ready.

Generate the wrapper with:

```bash
deno run -A tools/write-iframe-wrapper.ts \
  --contract packages/patterns/<name>/contract.ts \
  --guest packages/patterns/<name>/guest.ts \
  --out packages/patterns/<name>/main.tsx
```

Add `--react` when the authored guest is React TSX, as required by the React
guide.

Add `--html packages/patterns/<name>/guest.html` when the guest needs a custom
document shell, and `--force` only when regenerating the named output. The HTML
shell must contain `<!-- PATTERN_IFRAME_SCRIPT -->` exactly once.

Validate the generated pattern with:

```bash
deno fmt packages/patterns/<name>
deno check packages/patterns/<name>/<guest-file>
deno task cf check packages/patterns/<name>/main.tsx --no-run
```

Replace `<guest-file>` with the authored `guest.ts` or `guest.tsx` filename.

Run the pattern or add a focused test when behavior, rather than only its data
contract, changed. Preserve `contract.ts` and the guest source beside the
generated wrapper so the pattern remains reproducible.
