---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Executed Lot Watch protected input compiler correction."
---

# Lot Watch protected input compiler correction

This work order records a review correction to the Lot Watch protected input
normalization. The numbered section is one commit. It follows the earlier
rollout and repair work orders without changing the two leading boundaries:
the first commit contains only switch changes, and the second contains only
tests that directly inspect those switches.

## 1. Use the pattern compiler-compatible input boundary

The first normalization cast satisfied TypeScript by naming the target
`Writable` cell types. The pattern compiler rejects casts to `Writable`
because they can hide invalid reactive code. Lot Watch therefore passed a
direct Deno check but failed the supported pattern compilation path.

Use the narrow boundary form already established for optional protected inputs
in Parking Coordinator. The surrounding variable annotations retain the
runtime cell types, direct Deno checking still verifies their uses, and the
pattern compiler no longer sees a forbidden cast to `Writable`. Record the
changed Lot Watch argument contract in the append-only pattern compatibility
baselines.
