import Std

import Cfc.Policy
import Cfc.Exchange

namespace Cfc

/-!
Sink gate / sink-scoped exchange rules (spec 5.2.1 and 5.3.2).

The spec introduces a distinction between two kinds of exchange rules:

1. General rules (no `allowedSink`):
   - Applied label-wide during fixpoint evaluation at a trusted boundary.
   - Example: after a fetch, use `AuthorizedRequest` + `NetworkProvenance` to add
     `EmailMetadataSecret(Alice)` to the response label.

2. Sink-scoped rules (`allowedSink = "fetchData"`, etc):
   - Applied only when data flows to a specific sink.
   - Used for *structural authorization* such as "an authority-only token appears only at the
     Authorization header path".
   - When they fire, the sink gate strips the authority-only taint and emits
     `AuthorizedRequest{sinkName = ...}` as integrity evidence.

Why do we need a separate model?

The core `Label` type in this repo is intentionally tiny:

  confidentiality : CNF (List (List Atom))

It does NOT record *where in a structured value* an atom originated.

But sink-scoped rules are explicitly path-aware: they care whether some confidentiality taint
appeared at an allowed path (e.g. `options.headers.Authorization`) and did not appear anywhere
else (e.g. not in the request body).

So this file models exactly the additional bit of information the sink gate needs:

  `PathTaints := List (Path × List Atom)`

Interpretation:
- A `Path` is a list of segments (like a JSON pointer, but stored as segments).
- `PathTaints` records, for each path, which confidentiality atoms are present *at that path*.
- We only intend this to include the "authority-only" atoms that the sink gate may strip.

This is a minimal model, but it is enough to test and prove the key spec claim:

  "Token secrecy is stripped ONLY when the token appears at permitted locations."
-/

namespace SinkGate

open Cfc.Policy

/-!
## Paths and taints

We keep paths as `List String` for consistency with Chapter 8 (projection paths).
-/

abbrev Path := List String

/--
Path-scoped confidentiality taint atoms for a structured value.

We use a list of pairs instead of a map to keep dependencies minimal.
All operations are small (policies have few paths), so O(n^2) behavior is fine.
-/
abbrev PathTaints := List (Path × List Atom)

/--
Collect the taint atoms that appear at any of the `paths`.
-/
def atomsAtPaths (paths : List Path) (taints : PathTaints) : List Atom :=
  taints.foldl (fun acc t =>
    match t with
    | (p, as) =>
        if p ∈ paths then acc ++ as else acc
  ) []

/--
Collect the taint atoms that appear at paths *not* in `paths`.

This is the "disallowed locations" view used to detect token misplacement.
-/
def atomsOutsidePaths (paths : List Path) (taints : PathTaints) : List Atom :=
  taints.foldl (fun acc t =>
    match t with
    | (p, as) =>
        if p ∈ paths then acc else acc ++ as
  ) []

/-!
## Matching helpers

Sink-gate matching is about atoms (not CNF structure), so we reuse the `AtomPattern` matcher from
`Cfc.Policy`.
-/

def matchesAtomPattern (p : AtomPattern) (a : Atom) : Bool :=
  match matchAtomPattern p a [] with
  | some _ => true
  | none => false

def anyMatchesAtomPattern (p : AtomPattern) (atoms : List Atom) : Bool :=
  atoms.any (fun a => matchesAtomPattern p a)

/-!
## AuthorizedRequest integrity token

The spec's sink gate emits `AuthorizedRequest{ sinkName = ... }`.

We model that as an `integrityTok` whose payload string includes the sink name.
This is deliberately light-weight: in a fuller model we would add a dedicated atom constructor.
-/

def authorizedRequest (sinkName : String) : Atom :=
  Atom.integrityTok ("AuthorizedRequest(" ++ sinkName ++ ")")

/-!
## Applying a sink-scoped exchange rule

This file uses a conservative interpretation aligned with the Gmail example:

- The *target* confidentiality pattern is the first element of `rule.preConf`.
- We allow stripping only if:
    1) the target matches at some allowed path, and
    2) the target does NOT match at any disallowed path.

If those checks pass, we drop the singleton clause `[targetAtom]` from the overall label.

This is exactly the authority-only pattern: the token contributes a singleton secrecy clause
that should not taint the response once structurally authorized.
-/

def dropSingletonClauses (atoms : List Atom) (C : ConfLabel) : ConfLabel :=
  atoms.foldl (fun acc a => Exchange.confDropSingleton a acc) C

def applySinkScopedRule
    (sinkName : String)
    (taints : PathTaints)
    (boundaryIntegrity : IntegLabel)
    (rule : ExchangeRule)
    (ℓ : Label) : Label × Bool :=
  match rule.allowedSink with
  | none =>
      -- Not sink-scoped.
      (ℓ, false)
  | some s =>
      if s ≠ sinkName then
        (ℓ, false)
      else
        match rule.preConf with
        | [] =>
            -- No confidentiality target => nothing to do.
            (ℓ, false)
        | target :: _ =>
            let allowedAtoms := atomsAtPaths rule.allowedPaths taints
            let outsideAtoms := atomsOutsidePaths rule.allowedPaths taints

            -- Structural safety check:
            -- if the target appears anywhere outside the allowed paths, do NOT strip it.
            if anyMatchesAtomPattern target outsideAtoms then
              (ℓ, false)
            else
              -- Compute all valid variable bindings from the allowed-path taints,
              -- then apply any integrity guards against integrity in scope.
              let avail := Exchange.availIntegrity ℓ boundaryIntegrity
              let confBs := matchAllSomewhere rule.preConf allowedAtoms []
              let bsList := List.flatMap (fun bs => matchAllSomewhere rule.preInteg avail bs) confBs

              -- For each binding, instantiate the target atom and drop its singleton clause.
              let targets := bsList.filterMap (fun bs => instantiateAtomPattern target bs)
              let conf' := dropSingletonClauses targets ℓ.conf

              let changed : Bool := decide (conf' ≠ ℓ.conf)
              ({ ℓ with conf := conf' }, changed)

/-!
## Evaluating the sink gate

We evaluate all sink-scoped rules from all policies in scope, then:
- if any rule fired, we add `AuthorizedRequest(sinkName)` to integrity.

We do NOT run a fixpoint here. In the intended use cases:
- sink rules are "stripping" rules (they remove authority-only clauses),
- stripping reduces the set of policy principals in scope, rather than introducing new ones,
  so there is no natural source of new sink-rule applicability after a successful strip.

If we later add richer sink-rule shapes, we can revisit this and add a fuelled fixpoint just as
in `Cfc.Policy.evalFixpoint`.
-/

def evalSinkGateOnce
    (policies : List PolicyRecord)
    (sinkName : String)
    (taints : PathTaints)
    (boundaryIntegrity : IntegLabel)
    (ℓ : Label) : Label × Bool :=
  let pols := policiesInScope policies ℓ.conf
  pols.foldl (fun acc pol =>
    let cur := acc.1
    let firedAny := acc.2
    pol.exchangeRules.foldl (fun acc2 rule =>
      let cur2 := acc2.1
      let fired2 := acc2.2
      let (next, firedRule) := applySinkScopedRule sinkName taints boundaryIntegrity rule cur2
      (next, fired2 || firedRule)
    ) (cur, firedAny)
  ) (ℓ, false)

def evalSinkGate
    (policies : List PolicyRecord)
    (sinkName : String)
    (taints : PathTaints)
    (boundaryIntegrity : IntegLabel)
    (ℓ : Label) : Label :=
  let (out, fired) := evalSinkGateOnce policies sinkName taints boundaryIntegrity ℓ
  if fired then
    { out with integ := addUnique out.integ (authorizedRequest sinkName) }
  else
    out

end SinkGate

end Cfc

