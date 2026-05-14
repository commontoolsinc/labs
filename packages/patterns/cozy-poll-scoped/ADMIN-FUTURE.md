# Admin: future direction (CFC integrity)

Current implementation: the first user to join the poll is captured into
`adminName: PerSpace<string>`. Admin actions (add/remove option, reset votes)
short-circuit when `myName !== adminName`. This is enforced at the pattern level
— a determined caller can invoke a handler with arbitrary inputs and the runtime
will not stop them.

Per Berni: the right way to model authority is via CFC integrity labels rather
than runtime equality checks.

Sketch of the target shape:

- Each `User` entity in the directory carries an `admin` integrity label,
  applied once at claim time.
- The `options` (and possibly `votes`) cells declare a write-side IFC
  constraint, e.g. `ifc: { requiredIntegrity: ["admin"] }`.
- Handlers that mutate `options` run only when the invocation credentials carry
  the `admin` label — non-admin writes are rejected at the kernel layer.
- Pattern-level conditionals (e.g. hiding admin UI when `!isAdmin`) remain as
  UX, but are no longer the security boundary.

This deferral is intentional. The CFC wiring (label propagation through
handlers, integrity-aware schema fields, CFC tooling around scoped reads/writes)
needs more end-to-end coverage before patterns start depending on it for
authority decisions. Once it lands, the pattern-level `adminName` check can be
removed and the `isAdmin` derive becomes a UX-only signal.
