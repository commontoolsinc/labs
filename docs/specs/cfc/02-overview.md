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

- **Atoms**: The spec uses functional notation like `User(Alice)`; concrete forms appear as JSON objects like `{ "type": "User", "subject": "did:key:alice" }` ([§4.1](./04-label-representation.md#41-parameterized-atoms)).
- **Canonicalization + hashing**: `H(x)` denotes a fixed cryptographic hash over canonical bytes `c14n(x)`. For JSON objects, `c14n` SHOULD follow a standard canonical JSON scheme (e.g., RFC 8785 / JCS). Type-specific canonicalization (e.g., sorting set-like arrays, NFC normalization for user text) is required for stable digests (see [§7.3](./07-write-actions.md#73-canonicalization-and-binding)).
- **References vs hashes**: `refer(ptr)` denotes an opaque runtime reference to a store cell/path, used for pass-through and `exactCopyOf` checks; it is compared by the trusted runtime, not by pattern code ([§8](./08-label-transitions.md#8-label-transition-rules)).
- **Policy principal binding**: Policy/context principals are schema-time without a hash and label-time with a policy content `hash` ([§4.1.2](./04-label-representation.md#412-atom-type-structure) and [§4.4.2](./04-label-representation.md#442-policy-references-in-labels)).
- **Templates**: Template variables are written as `$name` (e.g., `$actingUser`) and substituted at runtime ([§11](./11-developer-guide.md#11-developer-guide)).
