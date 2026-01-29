# 12. Summary and Design Rationale

## 12.1 Core Achievements

This design allows:

- precise, policy-scoped use of authorization secrets,
- principled translation from authorization secrecy to resource secrecy,
- correct handling of query-dependent taint,
- prevention of confused deputies via integrity-guarded exchanges.

The Gmail OAuth case serves as a concrete illustration of the general mechanism.

## 12.2 Design Trade-offs

### 12.2.1 Expressiveness vs. Decidability

**Choice**: Use powerset lattices with declarative exchange rules rather than arbitrary code in declassifiers.

**Trade-off**:
- Gain: Deterministic policy evaluation, clear audit trails, compositional reasoning
- Cost: Complex policies may require multiple exchange rules or pre-computation steps

**Justification**: In reactive systems with untrusted patterns, arbitrary declassifier code creates attack surface. Declarative rules enable static analysis and formal verification.

### 12.2.2 Confidentiality vs. Integrity Asymmetry

**Choice**: Confidentiality propagates by default (monotone); integrity requires explicit endorsement.

**Trade-off**:
- Gain: Prevents accidental leaks, forces explicit trust decisions
- Cost: High-integrity paths require more ceremony (endorsement facts)

**Justification**: Confidentiality leaks are silent and irreversible. Integrity errors are often detectable. The asymmetry reflects real security priorities.

### 12.2.3 Space-Based vs. User-Set Confidentiality

**Choice**: Model collaborative access through spaces with role membership rather than explicit user sets in labels.

**Trade-off**:
- Gain: Dynamic membership without label rewriting, disjunctive authorization emerges naturally
- Cost: Data belongs to exactly one space; cross-space sharing requires links

**Justification**: The label-rewriting problem is fundamental in IFC systems. Spaces solve it cleanly while preserving role-based access patterns common in collaborative applications.

### 12.2.4 Authority-Only Classification

**Choice**: Distinguish secrets used for authorization from those representing data-bearing content.

**Trade-off**:
- Gain: Prevents confused deputy attacks, allows fetch tokens to not taint responses
- Cost: Requires explicit policy decisions about secret classification

**Justification**: OAuth tokens must authorize requests without making responses inherently secret. Authority-only classification captures this precisely.

### 12.2.5 UI Evidence vs. Code-Based Intent Recognition

**Choice**: Use snapshot digests and declarative conditions to bind intents to rendered UI state.

**Trade-off**:
- Gain: Prevents UI spoofing, provides audit trail, reduces trust in application code
- Cost: Requires canonical VDOM representation, limits dynamic UI patterns

**Justification**: User actions are the ultimate source of authorization in many flows. Binding them to concrete rendered state prevents attacks that manipulate control flow while showing different UI.

### 12.2.6 Single-Use Intents vs. Persistent Authorization

**Choice**: Event-scoped actions use consumable intents rather than persistent capabilities.

**Trade-off**:
- Gain: Prevents replay attacks, limits blast radius of compromised intents
- Cost: Requires intent refinement step, complicates async flows

**Justification**: In FRP systems, persistent authorization creates ambient authority. Single-use intents force explicit scoping and enable precise audit trails.

## 12.3 Comparison to Related Work

### 12.3.1 Jif (Java Information Flow)

**Similarities**:
- Lattice-based labels with confidentiality and integrity dimensions
- Declassification requires explicit justification
- Static and dynamic enforcement

**Differences**:
- **CFC**: Reactive dataflow system, UI-backed evidence, policy principals as atoms
- **Jif**: Imperative language, label inference, principal hierarchy
- **CFC**: Spaces for disjunctive authorization; **Jif**: DNF labels or authority delegation
- **CFC**: Authority-only secrets; **Jif**: Declassification via trusted methods

**Context**: Jif pioneered decentralized label models and robust declassification. CFC adapts these ideas to reactive systems where data flows through untrusted handlers and user actions drive authorization.

### 12.3.2 COWL (Confinement with Origin Web Labels)

**Similarities**:
- Web context, dynamic label enforcement
- Origin-based principals
- Prevents exfiltration from untrusted code

**Differences**:
- **CFC**: Contextual integrity, policy records, integrity-guarded exchange
- **COWL**: Browser-level confinement, label raising without policy
- **CFC**: UI evidence for declassification; **COWL**: Privilege objects
- **CFC**: FRP dataflow; **COWL**: Imperative JavaScript with IFC runtime

**Context**: COWL demonstrated practical browser-based IFC. CFC extends this with CI-aware policies and reactive computation. Where COWL isolates compartments, CFC enables controlled sharing through policy-mediated exchange.

### 12.3.3 Resin (Policy-Augmented JavaScript)

**Similarities**:
- Web application focus
- Policy objects attached to data
- Reactive taint tracking

**Differences**:
- **CFC**: Lattice-based labels, formal exchange rules, UI provenance
- **Resin**: Imperative policies in JavaScript, assertion-based
- **CFC**: Spaces and links for multi-party data; **Resin**: Per-object policies
- **CFC**: Intent refinement for side effects; **Resin**: Filter guards

**Context**: Resin showed policy-carrying data is practical in JavaScript. CFC formalizes this with IFC foundations and applies it to reactive systems where data flows through multiple untrusted transformations.

### 12.3.4 Novel Contributions

CFC's unique contributions:

1. **Policy principals as confidentiality atoms**: Policies propagate like data, interpreted only at trusted boundaries
2. **Contextual Integrity integration**: Transmission principles map to integrity-guarded exchange rules
3. **Authority-only classification**: Formal distinction between authorization secrets and data-bearing secrets
4. **UI-backed integrity**: Gesture provenance bound to rendered snapshots via declarative conditions
5. **Space-based disjunctive authorization**: Role membership solves label-rewriting problem
6. **Additive endorsement via links**: Cross-space references preserve and augment integrity

## 12.4 Future Work

### 12.4.1 Recombination Attack Mitigation

**Problem**: Overlapping declassifiers can leak more information when outputs are combined ([§10](./10-safety-invariants.md#10-safety-invariants)).

**Potential approaches**:
- Linkage tracking to prevent joining outputs from the same source
- Differential privacy budgets for declassification
- Semantic aliasing to mark sibling outputs as non-joinable

**Research needed**: Formal model for composition attacks, decidable prevention

### 12.4.2 Multi-Step Contamination Scoping

**Problem**: How to scope taint from intermediate steps that don't appear in final output.

**Example**: Search query taints results; results displayed to user; user selects one; selection action should not inherit full query secrecy.

**Potential approaches**:
- Event-bounded taint lifetimes
- User observation as implicit declassification
- Scoped contamination labels that expire at gesture boundaries

**Status**: Open research problem, no fully satisfactory solution

### 12.4.3 Formal Verification

**Goal**: Machine-checked proofs of safety invariants ([§10](./10-safety-invariants.md#10-safety-invariants)).

**Challenges**:
- Model reactive dataflow with dynamic policy evaluation
- Handle UI evidence and snapshot digests
- Prove noninterference with declassification

**Approach**: Formalize in Coq or Lean, prove safety for core calculus, extend to full system

### 12.4.4 Static Analysis for Patterns

**Goal**: Detect label violations before deployment ([§11](./11-developer-guide.md#11-developer-guide)).

**Challenges**:
- Infer labels through reactive operators (`map`, `filter`, `flatMap`)
- Detect authority-only leaks in handler code
- Verify exchange rule preconditions

**Approach**: Extend TypeScript type system with label types, integrate with tsc

### 12.4.5 Performance Optimization

**Goal**: Reduce runtime overhead of label propagation and policy evaluation.

**Opportunities**:
- Cache policy evaluation results for common patterns
- Optimize label join/meet operations
- Lazy label computation for cold paths

**Measurement needed**: Profile real workloads to identify bottlenecks

### 12.4.6 Developer Experience

**Goal**: Make CFC practical for pattern developers without security expertise.

**Needs**:
- Visual label debugger showing data flow and policy decisions
- Error messages that explain label mismatches in user terms
- Library of common policy patterns (OAuth, multi-party sharing, etc.)
- Migration tools for existing patterns

### 12.4.7 Cross-Runtime Interoperability

**Goal**: Exchange labeled data between CFC runtimes (client/server, different users).

**Challenges**:
- Serialize labels and evidence
- Verify policy compatibility across runtimes
- Handle clock skew for intent expiration

**Approach**: Define wire format for labeled values, remote policy evaluation protocol

## 12.5 Implementation Status

This is a specification (v0.2). Implementation is in progress in the Common Tools runtime.

Reference implementation includes:
- Label propagation for reactive operators
- Space and role-based confidentiality
- UI snapshot digests and gesture provenance
- Intent refinement and single-use semantics

Not yet implemented:
- Full policy evaluation (in progress)
- Authority-only classification enforcement
- Static analysis tooling
- Cross-runtime labeled data exchange

## 12.6 Acknowledgments

This design builds on decades of information flow control research, particularly:

- Decentralized label models (Myers and Liskov)
- Robust declassification (Zdancewic, Myers)
- Contextual Integrity (Nissenbaum)
- Browser-based IFC (COWL, Resin)
- Reactive programming with security (FlowPool, LWeb)

Special thanks to:
- [Acknowledgments to be added: reviewers, contributors, research advisors]
