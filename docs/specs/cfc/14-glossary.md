# 14. Glossary

Short definitions of recurring CFC terms (informative). For the normative model, see [§3](./03-core-concepts.md#3-core-concepts)–[§8](./08-label-transitions.md#8-label-transition-rules).

## 14.1 Labels

- **Atom**: A structured label element with a `type` and parameters ([§4.1](./04-label-representation.md#41-parameterized-atoms)). Atoms appear in confidentiality clauses and integrity sets.
- **Clause**: One confidentiality requirement. A clause is either a single atom or a list of alternative atoms (OR) ([§3.1.1](./03-core-concepts.md#311-confidentiality-cnf-structure)).
- **CNF confidentiality**: Confidentiality is an AND of clauses (CNF). Exchange rules add alternatives inside clauses; data combination concatenates clauses ([§3.1.1](./03-core-concepts.md#311-confidentiality-cnf-structure)–[§3.1.3](./03-core-concepts.md#313-exchange-rules-add-alternatives)).
- **Integrity label**: A conjunction (set) of integrity atoms/facts that justify beliefs about a value or a decision ([§3.1.6](./03-core-concepts.md#316-integrity-simple-conjunction)).

## 14.2 Policies

- **Policy record**: Content-addressed definition of exchange rules and classifications for a policy/context principal ([§4.4](./04-label-representation.md#44-policy-lookup-and-evaluation) and [§5](./05-policy-architecture.md#5-policy-architecture)).
- **Policy principal / context principal**: A confidentiality atom whose meaning is given by a policy record. In schemas/templates it is unbound (no hash); in runtime labels it is bound to a specific policy hash ([§4.1.2](./04-label-representation.md#412-atom-representation-concrete) and [§4.4.2](./04-label-representation.md#442-policy-references-in-labels)).
- **Exchange rule**: An integrity-guarded rewrite that adds (or sometimes removes) confidentiality alternatives and may mint integrity facts ([§3.1.3](./03-core-concepts.md#313-exchange-rules-add-alternatives) and [§4.4.5](./04-label-representation.md#445-exchange-rule-evaluation)).
- **Trusted boundary**: A runtime point where policy evaluation and verification occurs (e.g., display, network egress, store writes). Exchange rules, `refer(...)` checks, and attestation/provenance facts are enforced here, not by untrusted pattern code ([§6](./06-events-and-intents.md#6-events-intents-and-single-use-semantics), [§8](./08-label-transitions.md#8-label-transition-rules), [§11](./11-developer-guide.md#11-developer-guide)).

## 14.3 Intents and Side Effects

- **IntentEvent**: High-integrity event minted from UI interaction by trusted UI/runtime components ([§3.8](./03-core-concepts.md#38-ui-backed-integrity-and-gesture-provenance)).
- **IntentOnce**: Single-use, consumable intent capability used to authorize a specific side effect; it is consumed only on commit ([§6](./06-events-and-intents.md#6-events-intents-and-single-use-semantics) and [§7](./07-write-actions.md#7-write-actions)).
- **Attempt vs commit**: An attempt sends an external request; commit means policy-defined success criteria are met and the intent is consumed ([§7.5](./07-write-actions.md#75-commit-points)).
- **Commit point**: A sink that performs side effects (e.g., `fetch`) and is responsible for coupling consumption to commit conditions ([§7.5](./07-write-actions.md#75-commit-points)).

## 14.4 Control-Flow Effects

- **PC (flow-path) integrity**: Integrity required to justify control-flow decisions that enable declassification (robust declassification) ([§3.4](./03-core-concepts.md#34-control-pc-integrity) and [§3.8.6](./03-core-concepts.md#386-integrity-requirements-for-intent-parameters-robust-declassification)).
- **PC (flow-path) confidentiality**: Confidentiality introduced by control decisions influenced by secret inputs; it must be joined into downstream outputs when routing/selection depends on secrets ([§8.11](./08-label-transitions.md#811-content-labels-vs-flow-labels)).

## 14.5 Data Handling Primitives

- **Pass-through (`passThrough`)**: Output is a reference to an input; the runtime verifies reference preservation ([§8.2](./08-label-transitions.md#82-pass-through-via-references)).
- **Projection (`projection`)**: Output is a subfield of an input object; labels propagate according to projection semantics ([§8.3](./08-label-transitions.md#83-projection-semantics)).
- **Exact copy (`exactCopyOf`)**: Output must be bitwise-equal to an input at runtime; mismatches are fatal ([§8.4](./08-label-transitions.md#84-exact-copy-verification)).
- **Opaque input**: Handler may receive a reference but cannot read the content; used to pass secrets safely through untrusted code ([§8.13](./08-label-transitions.md#813-opaque-inputs-blind-data-passing)).
- **Write authority (`writeAuthorizedBy`)**: Field-level capability set controlling who may modify stored state; separate from value integrity ([§8.15](./08-label-transitions.md#815-modification-authorization-write-authority)).

