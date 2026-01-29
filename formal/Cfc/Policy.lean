import Std

import Cfc.Access
import Cfc.Exchange

namespace Cfc

/-!
Policy evaluation at trusted boundaries (spec Chapter 4 / 5).

This file models the part of the spec where *policies are evaluated at a trusted boundary*
(display / network egress / store write):

  - A label may contain **policy principals** (Context/Policy atoms) in its confidentiality CNF.
  - A policy principal points to a **policy record** containing **exchange rules**.
  - At the boundary, the runtime:
      1) collects the policy principals in scope from the label,
      2) evaluates their exchange rules against the label + boundary-minted integrity,
      3) repeats until reaching a fixpoint (no more changes).

This is the spec's core "declassification happens via integrity-guarded exchange rules" story.

Important note about scope:

The full spec supports a rich pattern language with variables and constraints.
To keep this Lean development small (Std-only, proof-friendly), we implement a *usable subset*:

  - variables inside string / nat / list-of-string fields,
  - matching a rule means "there exists some atom in the label/integrity that matches each pattern".

This is already enough to express and test the most important examples in the repo
(spaces, Gmail OAuth authority-only drop, etc.).
-/

namespace Policy

/-!
## Bindings

Rule matching produces a binding environment (variables -> values).
Variables can range over different "shapes" of values (strings, naturals, lists, even whole atoms).

We represent this as a small tagged union `BindingVal`, plus a list-based map `Bindings`.
Lists are fine here because policies and patterns are small; we also avoid extra dependencies.
-/

inductive BindingVal where
  | str (s : String)
  | nat (n : Nat)
  | strs (xs : List String)
  | atom (a : Atom)
  deriving Repr, DecidableEq

abbrev Bindings := List (String × BindingVal)

def lookup (x : String) : Bindings → Option BindingVal
  | [] => none
  | (y, v) :: rest => if x = y then some v else lookup x rest

def bind (x : String) (v : BindingVal) : Bindings → Option Bindings
  | [] => some [(x, v)]
  | (y, v') :: rest =>
      if x = y then
        if v = v' then some ((y, v') :: rest) else none
      else
        match bind x v rest with
        | some rest' => some ((y, v') :: rest')
        | none => none

/-!
To avoid repeating "convert to/from BindingVal" plumbing, we use a small typeclass.

This is purely a convenience for the matching/instantiation code below.
-/

class BindingType (α : Type) where
  toVal : α → BindingVal
  ofVal : BindingVal → Option α

instance : BindingType String where
  toVal := BindingVal.str
  ofVal
    | .str s => some s
    | _ => none

instance : BindingType Nat where
  toVal := BindingVal.nat
  ofVal
    | .nat n => some n
    | _ => none

instance : BindingType (List String) where
  toVal := BindingVal.strs
  ofVal
    | .strs xs => some xs
    | _ => none

instance : BindingType Atom where
  toVal := BindingVal.atom
  ofVal
    | .atom a => some a
    | _ => none

/-!
## Generic field patterns

We use the same tiny pattern shape for each kind of field:

  - `lit v` matches only exactly `v`
  - `var "X"` matches any value and binds it to the variable `X`

This is a standard unification-style setup.
-/

inductive Pat (α : Type) where
  | lit (v : α)
  | var (x : String)
  deriving Repr

def matchPat {α : Type} [DecidableEq α] [BindingType α] (p : Pat α) (v : α) (bs : Bindings) : Option Bindings :=
  match p with
  | .lit w =>
      if w = v then some bs else none
  | .var x =>
      bind x (BindingType.toVal v) bs

def instantiatePat {α : Type} [BindingType α] (p : Pat α) (bs : Bindings) : Option α :=
  match p with
  | .lit v => some v
  | .var x =>
      match lookup x bs with
      | some bv => BindingType.ofVal bv
      | none => none

/-!
## Atom patterns (subset)

We provide patterns for the atom constructors that appear in the spec examples and the Lean repo.
For everything else, rules can still match using `eq a` (exact-atom match).
-/

inductive AtomPattern where
  | user (did : Pat String)
  | space (id : Pat String)
  | policy (name : Pat String) (subject : Pat String) (hash : Pat String)
  | hasRole (principal : Pat String) (space : Pat String) (role : Pat String)
  | integrityTok (name : Pat String)
  | expires (t : Pat Nat)
  | other (name : Pat String)
  /-- Match exactly a specific atom (no variables). -/
  | eq (a : Atom)
  deriving Repr

def matchAtomPattern (p : AtomPattern) (a : Atom) (bs : Bindings) : Option Bindings :=
  match p, a with
  | .user didP, .user did =>
      matchPat didP did bs
  | .space idP, .space sid =>
      matchPat idP sid bs
  | .policy nameP subjP hashP, .policy name subj hash =>
      matchPat nameP name bs >>= fun bs1 =>
      matchPat subjP subj bs1 >>= fun bs2 =>
      matchPat hashP hash bs2
  | .hasRole pP sP rP, .hasRole p s r =>
      matchPat pP p bs >>= fun bs1 =>
      matchPat sP s bs1 >>= fun bs2 =>
      matchPat rP r bs2
  | .integrityTok nP, .integrityTok n =>
      matchPat nP n bs
  | .expires tP, .expires t =>
      matchPat tP t bs
  | .other nP, .other n =>
      matchPat nP n bs
  | .eq a', _ =>
      if a' = a then some bs else none
  | _, _ =>
      none

def instantiateAtomPattern (p : AtomPattern) (bs : Bindings) : Option Atom :=
  match p with
  | .user didP =>
      Atom.user <$> instantiatePat didP bs
  | .space idP =>
      Atom.space <$> instantiatePat idP bs
  | .policy nameP subjP hashP =>
      let mk (n s h : String) := Atom.policy n s h
      mk <$> instantiatePat nameP bs <*> instantiatePat subjP bs <*> instantiatePat hashP bs
  | .hasRole pP sP rP =>
      let mk (p s r : String) := Atom.hasRole p s r
      mk <$> instantiatePat pP bs <*> instantiatePat sP bs <*> instantiatePat rP bs
  | .integrityTok nP =>
      Atom.integrityTok <$> instantiatePat nP bs
  | .expires tP =>
      Atom.expires <$> instantiatePat tP bs
  | .other nP =>
      Atom.other <$> instantiatePat nP bs
  | .eq a =>
      some a

def instantiateAll (ps : List AtomPattern) (bs : Bindings) : Option (List Atom) :=
  ps.mapM (fun p => instantiateAtomPattern p bs)

/-!
## Exchange rules and policy records

We encode the spec's `ExchangeRule` shape directly:
- a list of confidentiality patterns (the first is the target),
- a list of integrity patterns (the guard),
- a postcondition (conf atoms to add; empty means drop the matched alternative),
- a list of integrity atoms to add.

For policy records, we keep only what we need for evaluation: the principal and the exchange rules.
-/

structure ExchangeRule where
  name : String
  preConf : List AtomPattern
  preInteg : List AtomPattern
  postConf : List AtomPattern
  postInteg : List AtomPattern
  deriving Repr

structure PolicyRecord where
  /-- The policy principal (a confidentiality atom) that selects this record. -/
  principal : Atom
  exchangeRules : List ExchangeRule
  deriving Repr

/-!
## Collecting policies in scope

We treat `Atom.policy name subject hash` as the repo's "policy principal" constructor.
This corresponds to the spec's label-time `Policy(...)` and `Context(...)` atoms.
-/

def isPolicyPrincipal : Atom → Bool
  | .policy _ _ _ => true
  | _ => false

/-!
`Std` in this repo's Lean toolchain does not provide some common list utilities
(`List.join`, `List.get?`, `List.enum`, `List.bind`).

So we define the tiny helpers we need locally, in a way that stays executable and easy to reason
about.
-/

def flatten (xss : List (List α)) : List α :=
  xss.foldl (fun acc xs => acc ++ xs) []

def get? : Nat → List α → Option α
  | _, [] => none
  | 0, x :: _ => some x
  | n + 1, _ :: xs => get? n xs

def dedup [DecidableEq α] (xs : List α) : List α :=
  let rec go (seen : List α) : List α → List α
    | [] => []
    | x :: rest =>
        if x ∈ seen then
          go seen rest
        else
          x :: go (x :: seen) rest
  go [] xs

def collectPolicyPrincipals (C : ConfLabel) : List Atom :=
  let atoms : List Atom := flatten C
  dedup ((atoms.filter isPolicyPrincipal))

def lookupPolicy (policies : List PolicyRecord) (a : Atom) : Option PolicyRecord :=
  policies.find? (fun p => p.principal = a)

def policiesInScope (policies : List PolicyRecord) (C : ConfLabel) : List PolicyRecord :=
  (collectPolicyPrincipals C).filterMap (lookupPolicy policies)

/-!
## Rule matching

Matching produces *all* matches, because multiple rules can apply at different places.
This mirrors the spec's `matchRuleWithTargetClause` returning all possible bindings.
-/

structure RuleMatch where
  clauseIndex : Nat
  altIndex : Nat
  bindings : Bindings
  deriving Repr

def confPositions (C : ConfLabel) : List (Nat × Nat × Atom) :=
  let rec goClause (i : Nat) : ConfLabel → List (Nat × Nat × Atom)
    | [] => []
    | c :: rest =>
        let rec goAlt (j : Nat) : Clause → List (Nat × Nat × Atom)
          | [] => []
          | a :: more => (i, j, a) :: goAlt (j + 1) more
        goAlt 0 c ++ goClause (i + 1) rest
  goClause 0 C

def matchAny (p : AtomPattern) (atoms : List Atom) (bs : Bindings) : List Bindings :=
  atoms.foldl (fun acc a =>
    match matchAtomPattern p a bs with
    | some bs' => bs' :: acc
    | none => acc
  ) []

def matchAllSomewhere (ps : List AtomPattern) (atoms : List Atom) (bs : Bindings) : List Bindings :=
  match ps with
  | [] => [bs]
  | p :: rest =>
      List.flatMap (fun bs' => matchAllSomewhere rest atoms bs') (matchAny p atoms bs)

def matchRule (rule : ExchangeRule) (ℓ : Label) (availIntegrity : IntegLabel) : List RuleMatch :=
  match rule.preConf with
  | [] => []
  | target :: others =>
      let confAtoms : List Atom := flatten ℓ.conf
      let integAtoms : List Atom := availIntegrity
      List.flatMap (fun (i, j, a) =>
        match matchAtomPattern target a [] with
        | none => []
        | some bs0 =>
            let confBs := matchAllSomewhere others confAtoms bs0
            let allBs := List.flatMap (fun bs1 => matchAllSomewhere rule.preInteg integAtoms bs1) confBs
            allBs.map (fun bs => { clauseIndex := i, altIndex := j, bindings := bs })
      ) (confPositions ℓ.conf)

/-!
## Applying a rule (local rewrite)

The spec applies a rule to a *specific* target clause and alternative.
We do the same.
-/

def removeAt {α : Type} : Nat → List α → List α
  | _, [] => []
  | 0, _ :: xs => xs
  | n + 1, x :: xs => x :: removeAt n xs

def updateAt {α : Type} : Nat → (α → α) → List α → List α
  | _, _, [] => []
  | 0, f, x :: xs => f x :: xs
  | n + 1, f, x :: xs => x :: updateAt n f xs

def addUnique (xs : List Atom) (a : Atom) : List Atom :=
  if a ∈ xs then xs else xs ++ [a]

def addUniqueAll (xs : List Atom) (as : List Atom) : List Atom :=
  as.foldl addUnique xs

def applyRule (ℓ : Label) (m : RuleMatch) (rule : ExchangeRule) : Option Label := do
  let postConfAtoms <- instantiateAll rule.postConf m.bindings
  let postIntegAtoms <- instantiateAll rule.postInteg m.bindings
  let addedInteg := postIntegAtoms.filter (fun a => decide (a ∉ ℓ.integ))
  match get? m.clauseIndex ℓ.conf with
  | none => some ℓ
  | some clause =>
      if postConfAtoms = [] then
        -- Empty postcondition confidentiality means: drop the matched alternative.
        let clause' := removeAt m.altIndex clause
        let conf' :=
          if clause' = [] then
            removeAt m.clauseIndex ℓ.conf
          else
            updateAt m.clauseIndex (fun _ => clause') ℓ.conf
        some { conf := conf', integ := addUniqueAll ℓ.integ addedInteg }
      else
        -- Nonempty postcondition confidentiality means: add those atoms as alternatives in the target clause.
        let clause' := postConfAtoms.foldl (fun c a => Exchange.clauseInsert a c) clause
        let conf' := updateAt m.clauseIndex (fun _ => clause') ℓ.conf
        some { conf := conf', integ := addUniqueAll ℓ.integ addedInteg }

/-!
## Evaluating to a fixpoint (fuelled)

The spec recommends evaluating to a fixpoint:

  keep applying any rule that can fire until no further changes occur.

In Lean, the most convenient executable way to model this is to use an explicit `fuel : Nat`.
This guarantees termination of the evaluator as a program.

We also provide the key semantic property:

  If one whole "pass" makes no change, then we are at a fixpoint for that pass function.

Later files can add stronger theorems that the chosen fuel bound is sufficient for a given policy set.
-/

def evalOnce (policies : List PolicyRecord) (boundaryIntegrity : IntegLabel) (ℓ : Label) : Label :=
  let pols := policiesInScope policies ℓ.conf
  -- Apply all rules, and within a rule apply all matches, sequentially.
  pols.foldl (fun acc pol =>
    pol.exchangeRules.foldl (fun acc2 rule =>
      let avail := Exchange.availIntegrity acc2 boundaryIntegrity;
      let ms := matchRule rule acc2 avail;
      ms.foldl (fun acc3 m =>
        match applyRule acc3 m rule with
        | some next => next
        | none => acc3) acc2
    ) acc
  ) ℓ

/--
Fuelled fixpoint loop.

We keep this as a separate definition (instead of a local `let rec`) so that:
- it is easier to test with `simp` in small regressions, and
- we can later prove lemmas about it by induction on `fuel`.
-/
def evalFixpointLoop (policies : List PolicyRecord) (boundaryIntegrity : IntegLabel) : Nat → Label → Label
  | 0, cur => cur
  | n + 1, cur =>
      let next := evalOnce policies boundaryIntegrity cur
      if next = cur then
        cur
      else
        evalFixpointLoop policies boundaryIntegrity n next

def evalFixpoint (fuel : Nat) (policies : List PolicyRecord) (boundaryIntegrity : IntegLabel) (ℓ : Label) : Label :=
  evalFixpointLoop policies boundaryIntegrity fuel ℓ

end Policy

end Cfc
