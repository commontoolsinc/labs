# 2. Overview

**Contextual Flow Control (CFC)** integrates classical information-flow control with Helen Nissenbaum's theory of **Contextual Integrity (CI)**.

CFC preserves the formal rigor of IFC (labels, lattices, integrity, declassification) while making *contextual appropriateness*—rather than raw secrecy—the primary unit of reasoning.

In CFC:

- data carries **contextual labels** that encode which social or functional context it belongs to,
- policies are first-class **context principals** that define the norms of information flow in that context,
- **transmission principles** are implemented as integrity-guarded exchange rules,
- and UI-backed evidence provides concrete justification for norm-conforming flows.

The motivating examples include OAuth-protected Gmail access, trusted search backends, and user-mediated sharing actions, but the model is general and applies to arbitrary reactive dataflow systems.
