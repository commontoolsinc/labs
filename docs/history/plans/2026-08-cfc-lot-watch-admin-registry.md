---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Executed Lot Watch strict CFC schema compatibility change."
---

# Lot Watch strict CFC schema compatibility

This work order records the Lot Watch change required after strict CFC
enforcement became the default. The numbered section is one commit. It follows
the earlier rollout and repair work orders without changing the two leading
boundaries: the first commit contains only switch changes, and the second
contains only tests that directly inspect those switches.

## 1. Give the admin registry one object schema

Lot Watch represented its admin registry as a union between the stored object
shape and a default empty object shape. Those branches diverge at the same
flow path, so strict CFC schema preparation rejects the registry before the
pattern can initialize.

Express the default as the stored registry shape itself. The `admins` property
is already optional, so an empty object remains a valid initial value without
introducing a second schema branch. This matches the parking coordinator's
registry and preserves the existing stored data shape.
