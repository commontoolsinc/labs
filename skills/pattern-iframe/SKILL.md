---
name: pattern-iframe
description: Build or generate a Common Fabric pattern whose primary UI is a self-contained `cf-iframe` guest. Use when an agent should turn an input-data shape and a small state/output contract into a working iframe-first pattern without learning the broader pattern framework, including React guests, path-scoped Cell access, stable array-item handles, mergeable pushes, or bridged SQLite.
---

# Iframe-first patterns

Read `docs/common/ai/iframe-pattern-guide.md` in full. It is the self-contained
authoring contract for this task; do not load the general pattern-development
guides unless the requested behavior extends beyond its wrapper.

Keep the authored surface small:

- `contract.ts` names the input, durable state, and output data shapes and their
  defaults.
- `guest.ts` or `guest.tsx` owns the application. It may use plain DOM code or
  React and the guest bridge.
- `main.tsx` is generated glue. Do not hand-edit it.

Generate the wrapper with:

```bash
deno run -A skills/pattern-iframe/scripts/write-wrapper.ts \
  --contract packages/patterns/<name>/contract.ts \
  --guest packages/patterns/<name>/guest.ts \
  --out packages/patterns/<name>/main.tsx
```

Add `--html packages/patterns/<name>/guest.html` when the guest needs a custom
document shell, and `--force` only when regenerating the named output. The HTML
shell must contain `<!-- PATTERN_IFRAME_SCRIPT -->` exactly once.

Validate the generated pattern with:

```bash
deno fmt packages/patterns/<name>
deno task cf check packages/patterns/<name>/main.tsx --no-run
```

Run the pattern or add a focused test when behavior, rather than only its data
contract, changed. Preserve `contract.ts` and the guest source beside the
generated wrapper so the pattern remains reproducible.
