import Cfc.Label

namespace Cfc

/-!
Links and dereferencing.

Spec pointers:
- Link confidentiality is conjunctive (3.7.1): you must be able to view both the link and target.
- Link integrity is additive endorsement (3.7.2): traversing a link adds endorsement facts.

In the spec, a "link" is a trusted pointer to some target value. Reading the target via a link
reveals two things:

1) Information in the *target* itself.
2) Information in the *existence of the link / relationship* (e.g. "Alice linked to this").

So confidentiality should be conjunctive: the viewer must be allowed to see both pieces.
In our CNF list model, "conjunctive" means concatenating the confidentiality lists.

Integrity is different: dereferencing a link provides additional provenance facts about *how*
we reached the target (who linked it, under what authority). This is "endorsement-style"
integrity addition, which we model as list append on the integrity field.

This is intentionally *not* the same as integrity join (`Label.joinIntegrity`), which would
intersect integrity atoms and often drop useful provenance.
-/

namespace Link

/-
Dereferencing a link: conjunctive confidentiality, additive integrity.

Concretely:
- `conf := link.conf ++ target.conf`
    CNF conjunction: to access the dereferenced value you must satisfy both CNFs.

- `integ := endorseIntegrity target.integ link.integ`
    "Endorsement integrity": keep the target integrity and add the link integrity facts.

The asymmetry is deliberate: a link *adds* integrity; it does not "meet" it with the target.
-/
def deref (link target : Label) : Label :=
  { conf := link.conf ++ target.conf
    integ := Label.endorseIntegrity target.integ link.integ }

end Link

end Cfc
