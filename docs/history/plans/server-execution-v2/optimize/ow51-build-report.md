---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "OW51 build: the RULED option (a) — the serving runtime matches the client's unresolved-input lift semantics exactly, and the ruled lift-throw semantic (a specific tx-abort error handled like an unresolved input: output undefined, re-trigger on any so-far read change) lands on both sides; the default-app surface greens ON and its skip lifts."
---

# OW51 build — the ruled unresolved-input lift semantics

## 0. The ruling (2026-08-21)

The owner, ruling the OW51 fix fork
([ow51-undefined-read-report.md](ow51-undefined-read-report.md) §4)
option (a):

> (a), server-side should match the current client behavior exactly.
> also note that with the lazy proxy based evaluation a lift can throw
> a specific error and mark a tx aborted with that reason and that
> should also be handled just like an unresolved input, i.e. being
> retriggered when any of the reads so far change (just like a regular
> call), and the output being `undefined`.

— owner (Berni), 2026-08-21. RULED. Three build obligations follow:

1. **(i) the reference behavior, verified then matched**: what the
   CLIENT does today with an unresolved lift input is the contract;
   the SERVING runtime must match it exactly.
2. **(ii) the ruled lift-throw semantic**: a lift that throws the
   specific tx-abort error is handled exactly like an unresolved
   input — the run re-triggers when any of its so-far reads change,
   its output is `undefined` in the interim.
3. **(iii) spec**: the serving-half sentence + the lift-throw
   semantics land in speculation.md (§2 neighborhood) as RULED text;
   the client half, already stated there, gets a verification pin.

Then the default-app surface (the OW51 crash) is re-verified ON 10+,
its skip entry lifts, and the register row closes with the ruling.

## 1. The client's current behavior (the reference), verified

Mapped on main:

- `experimental.lazyMaterialization` defaults TRUE
  (`runtime.ts` `??= true`), so lift bodies read through the LAZY
  SCHEMA VIEW (`schema-view.ts`): each path materializes as touched.
- A view read that cannot proceed (missing/mismatched data) calls
  `mismatch()`: it FIRST registers the failed read
  (`tx.readValueOrThrow(link)` — the dependency that re-triggers the
  reader when the data arrives), then throws `SchemaMismatchError`
  and notes it on the tx (`noteSchemaRefusal`).
- The action-run boundary (`runner.ts`) disposes a
  `SchemaMismatchError` — thrown synchronously OR arriving as an
  async rejection — as `postRun(undefined)`: "the run could not
  proceed on the data available, which is a non-event rather than a
  fault." Output `undefined`, no error surface, re-run on any
  registered read change.

This is exactly the ruled semantics, already built for the paths the
view covers. The OW51 crash is the hole beside it: a read whose LINK
CHAIN dies at a missing intermediate doc yields `undefined` into the
callback WITHOUT the register-and-refuse step (and without the leaf
default), on both the client and the serving runtime.

(section in progress — the precise hole path, the fix, and the pins
land below as the build proceeds)

## 2. The hole (the exact path)

(pending — chain-walk in progress)

## 3. The build

(pending)

## 4. Spec landing

(pending)

## 5. Default-app verification + skip lift

(pending)
