import Std

import Cfc.Access
import Cfc.Link

namespace Cfc

namespace Proofs
namespace Link

open Cfc

/-
Proofs about link dereferencing (`Cfc.Link.deref`).

Spec connection:
- 3.7.1: link confidentiality is conjunctive (must see both link and target)
- 3.7.2: link integrity is additive endorsement (traversing a link adds facts)

These lemmas are simple consequences of how `Link.deref` is defined in `Cfc.Link`.
-/

/-
Access characterization:

Because `Link.deref` concatenates confidentiality (`link.conf ++ target.conf`),
`canAccess` to the dereferenced label is equivalent to having access to both input labels.

We prove this by unfolding and using `canAccessConf_append_iff`.
-/
theorem canAccess_deref_iff (p : Principal) (link target : Label) :
    canAccess p (Cfc.Link.deref link target) ↔ canAccess p link ∧ canAccess p target := by
  simp [Cfc.Link.deref, Label.endorseIntegrity, canAccess, canAccessConf_append_iff]

/-
Integrity membership characterization:

`Link.deref` sets integrity to `target.integ ++ link.integ`.
So membership is exactly "in target OR in link".
-/
theorem mem_deref_integ (a : Atom) (link target : Label) :
    a ∈ (Cfc.Link.deref link target).integ ↔ a ∈ target.integ ∨ a ∈ link.integ := by
  simp [Cfc.Link.deref, Label.endorseIntegrity]

end Link
end Proofs

end Cfc
