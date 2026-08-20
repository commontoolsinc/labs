# Stale Source Closure: Reserved Helper Symbol on Load

**Error:** `Source cannot contain reserved helper symbol '__cfHelpers'.` while
loading an already-deployed piece — most often a space's default pattern, with
an accompanying `Could not initialize default pattern` warning. Related faces
of the same condition: `source closure recompiled to <X>, expected <Y>`, or a
source-closure verification failure.

**Cause:** The piece's stored source closure holds transformer-processed
source rather than the authored TypeScript. The runtime's invariant is that
the content-addressed source set holds pristine authored source — a timeless
fixed point that any compiler generation can recompile. A closure that
captured compiler-derived bytes instead violates that invariant, and the
violation surfaces only when the compiled cache misses: the compile-cache tag
is a fingerprint of compiler inputs, so any compiler iteration rotates it, and
the cold-load path recompiles the stored source. The transformer's
anti-double-injection guard (`checkCFHelperVar` in
`packages/ts-transformers/src/core/cf-helpers.ts`) then rejects the already-
injected source.

Content-hash verification does not catch this: it proves *integrity* (the
stored bytes match their key), not *pristineness* (the bytes are valid
transformer input). A poisoned closure is self-consistent and verifies clean.

Default patterns are disproportionately affected because they are seeded once
(`cf piece set-home`) and rarely redeployed, while dev patterns mint fresh
closures on every deploy.

**Fix:** `cf piece recreate-root` — the CLI's own error output suggests it
(`packages/cli/lib/piece.ts`). Recreation mints a fresh closure from current
authored source. There is no in-place repair: even without the guard, a
recompile of the poisoned source would hash to a different identity than the
piece expects.

**The general lesson:** any compiler- or runtime-derived bytes stored in the
content-addressed source set will surface, possibly weeks later, as an
unloadable piece — the fingerprint mechanism makes every compiler iteration a
cache rotation that forces a recompile from stored source.

## See Also

- [cli-debugging](../cli-debugging.md) — deploying and the setsrc loop
