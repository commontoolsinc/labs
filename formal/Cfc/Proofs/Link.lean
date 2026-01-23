import Std

import Cfc.Access
import Cfc.Link

namespace Cfc

namespace Proofs
namespace Link

open Cfc

theorem canAccess_deref_iff (p : Principal) (link target : Label) :
    canAccess p (Cfc.Link.deref link target) ↔ canAccess p link ∧ canAccess p target := by
  simp [Cfc.Link.deref, Label.endorseIntegrity, canAccess, canAccessConf_append_iff]

theorem mem_deref_integ (a : Atom) (link target : Label) :
    a ∈ (Cfc.Link.deref link target).integ ↔ a ∈ target.integ ∨ a ∈ link.integ := by
  simp [Cfc.Link.deref, Label.endorseIntegrity]

end Link
end Proofs

end Cfc
