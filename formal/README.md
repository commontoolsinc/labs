# cfc (Lean4)

Tiny, self-contained Lean4 formalization of a *core* slice of the CFC spec in `docs/specs/cfc/`.

Build:

```sh
cd formal
lake build
```

What is modeled:

- CNF confidentiality labels as lists of clauses, integrity as a list of atoms
- Access check (`canAccess`) and label join (conf concatenation, integrity intersection)
- A tiny expression language with PC/flow-path taint
- An integrity-guarded declassification operator (minimal stand-in for guarded exchange)
- Proofs are added incrementally in `formal/Cfc/Proofs/`.

Proofs:

- Termination-insensitive noninterference (with implicit-flow/PC taint): `formal/Cfc/Proofs/Noninterference.lean`
- Guarded declassification only rewrites confidentiality when the guard token is present: `formal/Cfc/Proofs/RobustDeclassification.lean`
- Integrity-guarded confidentiality exchange + scenario checks (spaces/links, multi-party, authority-only): `formal/Cfc/Proofs/Scenarios.lean`
