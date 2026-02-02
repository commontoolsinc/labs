# Contextual Flow Control (CFC) System Specification

## Policy-Carrying Secrets and Authorized Fetch

This specification describes a complete **Contextual Flow Control (CFC)** system—an information-flow control model that integrates classical IFC with Helen Nissenbaum's theory of **Contextual Integrity (CI)**.

## How to Read This Spec

- **Impatient?** Start with [Section 1 (Gmail Example)](./01-gmail-example.md) for a concrete walkthrough
- **Want the big picture?** Read Parts I-II (Sections 1-4)
- **Building patterns?** Sections 4, 6, 7, 8, 11
- **Building runtime?** Sections 4, 6, 7, 8
- **Security review?** Sections 9, 10
- **Researching IFC?** Sections 5, 9, 10 (CI Mapping, Threat Model, Safety Invariants)

## Specification Sections

### Part I: Motivation (Concrete First)

1. [Gmail OAuth Example](./01-gmail-example.md) - Concrete walkthrough of read/search/forward flows
2. [Overview](./02-overview.md) - Introduction, key concepts, and design goals

### Part II: Core Model

3. [Core Concepts](./03-core-concepts.md) - Labels, integrity, spaces, links, and UI evidence
4. [Label Representation](./04-label-representation.md) - Parameterized atoms, policy records, trust delegation

### Part III: Policies

5. [Policy Architecture](./05-policy-architecture.md) - CI mapping, request authorization, confidentiality exchange

### Part IV: Intents & Actions

6. [Events and Intents](./06-events-and-intents.md) - Single-use semantics, causal ID derivation
7. [Write Actions](./07-write-actions.md) - Intent refinement, canonicalization, idempotency, commit points

### Part V: Runtime

8. [Label Transitions](./08-label-transitions.md) - Runtime propagation, pass-through, projections, opaque inputs

### Part VI: Safety

9. [Threat Model](./09-threat-model.md) - Attacker capabilities, trust boundaries, scope of protection
10. [Safety Invariants](./10-safety-invariants.md) - Security guarantees, attack examples, open problems

### Part VII: Developer Experience

11. [Developer Guide](./11-developer-guide.md) - TypeScript integration, static analysis, pattern compilation

### Part VIII: Synthesis

12. [Summary and Design Rationale](./12-summary.md) - Design benefits, trade-offs, future work

### Appendix

13. [Atom Registry](./13-atom-registry.md) - Common atom types, fields, and conventions
14. [Glossary](./14-glossary.md) - Quick definitions of recurring terms

## Companion Documents

- [CFC Essay](./cfc-essay.md) - Accessible narrative explanation (stashed)
- [Essay Outline](./cfc-essay-outline.md) - Structure for the essay

## Key Ideas

In CFC:

- Data carries **contextual labels** encoding which social/functional context it belongs to
- Policies are first-class **context principals** defining information flow norms
- **Transmission principles** are implemented as integrity-guarded exchange rules
- UI-backed evidence provides concrete justification for norm-conforming flows
- **Spaces** with role-based membership handle disjunctive authorization
- **Links** across spaces create conjunctive confidentiality with additive endorsement integrity

## Status

This is a draft specification (v0.2).

## Changelog

- 2025-12-22: Renumbered sections for consistency; language pass for Pinker-style clarity
- 2025-12-22: Added threat model (Section 9), expanded summary with trade-offs and related work (Section 12)
- 2024-12-22: Major restructure - concrete examples first, consolidated chapters
