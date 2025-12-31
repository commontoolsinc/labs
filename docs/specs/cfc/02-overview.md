# 2. Overview

**Contextual Flow Control (CFC)** integrates classical information-flow control with Helen Nissenbaum's theory of **Contextual Integrity (CI)**.

CFC preserves the formal rigor of IFC (labels, lattices, integrity, declassification) while making *contextual appropriateness*—rather than raw secrecy—the primary unit of reasoning.

In CFC:

- data carries **contextual labels** that encode which social or functional context it belongs to,
- policies are first-class **context principals** that define the norms of information flow in that context,
- **transmission principles** are implemented as integrity-guarded exchange rules,
- and UI-backed evidence provides concrete justification for norm-conforming flows.

The motivating examples include OAuth-protected Gmail access, trusted search backends, and user-mediated sharing actions, but the model is general and applies to arbitrary reactive dataflow systems.

---

## 2.1 Notation and Conventions

- **Atoms**: The spec uses functional notation like `User(Alice)`; concrete forms appear as JSON objects like `{ "type": "User", "subject": "did:key:alice" }` (Section 4.1).
- **Hashing**: `H(x)` denotes a fixed cryptographic hash over canonical bytes `c14n(x)` (canonicalization rules are type-specific).
- **References vs hashes**: `refer(ptr)` denotes an opaque runtime reference to a store cell/path, used for pass-through and `exactCopyOf` checks; it is compared by the trusted runtime, not by pattern code (Section 8).
- **Policy principal binding**: Policy/context principals are schema-time without a hash and label-time with a policy content `hash` (Sections 4.1.2 and 4.4.2).
- **Templates**: Template variables are written as `$name` (e.g., `$actingUser`) and substituted at runtime (Section 11).
