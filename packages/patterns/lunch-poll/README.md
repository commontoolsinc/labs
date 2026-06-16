# Lunch Poll

`main.tsx` is the canonical lunch-poll pattern used for deployment and product
behavior. The diagnostic files in this directory are intentionally separate:

- `diagnose.ts` runs headless multi-runtime scaling probes.
- `main-indexed.tsx` is a simplified indexed-state comparison target for those
  probes.
- `main-v1.tsx` is the same diagnostic comparison target backed by the local
  `keyed-collection-v1.ts` helper seam.
- `main-full-v1.tsx` is a full-product-parity helper-backed variant. It keeps
  the canonical UI, profile join path, homepage/image enrichment, history, and
  handler surface, but stores options and votes through the local
  `keyed-collection-v1.ts` helper seam.

Do not treat `main-indexed.tsx` or `main-v1.tsx` as replacements for the product
pattern; they omit or stub non-diagnostic UI/enrichment/history behavior so they
can isolate reactive graph and aggregate-shape costs.

`main-full-v1.tsx` is intentionally separate from `main.tsx`: use it for honest
full-parity comparison while keeping the deployed/product baseline untouched.
Because it imports the sibling keyed-collections helper, run its tests with a
common pattern root, for example:

```bash
deno task cf test packages/patterns/lunch-poll/main-full-v1.test.tsx --root packages/patterns --verbose
deno task cf test packages/patterns/lunch-poll/multi-user-full-v1.test.tsx --root packages/patterns --verbose
```
