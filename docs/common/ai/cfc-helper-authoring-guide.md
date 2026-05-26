# CFC Helper Authoring Guide

Use this guide when creating or promoting shared CFC helpers under
`packages/patterns/cfc/`.

## When to Create a Shared Helper

Create a shared helper only when the code is policy-generic and has clear reuse
value. Good candidates include:

- CFC contract type aliases that encode a recurring trusted UI pattern
- reusable trusted surfaces with domain-neutral inputs and copy
- generic admin registry or credential helpers
- prompt-injection helper utilities that are not tied to one hostile fixture

Keep code local when it contains app-specific label atoms, integrity names,
resource subjects, value digests, demo data, route names, model choices, or UI
copy that only makes sense in one pattern.

## Authoring Rules

- Put shared helpers in `packages/patterns/cfc/`.
- Use one file per reusable trusted surface under
  `packages/patterns/cfc/trusted-surfaces/`.
- Export trusted surfaces through `trusted-surfaces/mod.ts`.
- Keep shared helper names generic. The local pattern should supply concrete
  policy vocabulary such as `"parking-admin"` or a resource DID.
- Prefer small helper functions over framework-like abstractions. A caller
  should still make its policy decision explicitly.
- Do not hide CFC labels or event-integrity requirements behind local defaults
  that a caller cannot inspect.

## Required Updates

When adding a shared helper:

1. Migrate at least one existing caller to prove the shared shape.
2. Add or move focused pattern tests, or run `cf check --no-run` when a test is
   not practical.
3. Update `packages/patterns/cfc/README.md` with the helper category and import
   example.
4. Keep `docs/common/ai/pattern-development-guide.md` focused on reuse; put
   helper-authoring details in this guide.

## Verification

Use the narrowest meaningful checks:

```sh
deno task cf test packages/patterns/<pattern>/main.test.tsx --root packages/patterns
deno task cf check packages/patterns/<pattern>/main.tsx --no-run
deno fmt --check <touched files>
```

Broaden only when the helper affects multiple CFC demos or shared contract
types.
