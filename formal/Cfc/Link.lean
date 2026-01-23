import Cfc.Label

namespace Cfc

/-!
Links and dereferencing.

Spec pointers:
- Link confidentiality is conjunctive (3.7.1): you must be able to view both the link and target.
- Link integrity is additive endorsement (3.7.2): traversing a link adds endorsement facts.
-/

namespace Link

/-- Dereferencing a link: conjunctive confidentiality, additive integrity. -/
def deref (link target : Label) : Label :=
  { conf := link.conf ++ target.conf
    integ := Label.endorseIntegrity target.integ link.integ }

end Link

end Cfc

