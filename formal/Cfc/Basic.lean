/- 
`Cfc.Basic` is the "everything important" import for this repo.

Lean builds proofs by compiling modules. By importing all core definitions and proof modules here,
we ensure that:
- `import Cfc` (see `formal/Cfc.lean`) pulls in the whole development, and
- `lake build` typechecks the full suite of proofs.

If you are new to Lean, you can think of this file as the project "index" that determines what
gets compiled as part of the library.
-/

import Cfc.Atom
import Cfc.Label
import Cfc.Store
import Cfc.Opaque
import Cfc.LabelTransitions
import Cfc.Access
import Cfc.Link
import Cfc.Intent
import Cfc.CommitPoint
import Cfc.Language
import Cfc.Language.Declassify
import Cfc.Exchange
import Cfc.Collection
import Cfc.Proofs.Noninterference
import Cfc.Proofs.RobustDeclassification
import Cfc.Proofs.TransparentEndorsement
import Cfc.Proofs.PcIntegrity
import Cfc.Proofs.FlowPathConfidentiality
import Cfc.Proofs.ExchangeDeclassification
import Cfc.Proofs.SafetyInvariants
import Cfc.Proofs.Exchange
import Cfc.Proofs.Link
import Cfc.Proofs.Intent
import Cfc.Proofs.CommitPoint
import Cfc.Proofs.Scenarios
import Cfc.Proofs.GmailExample
import Cfc.Proofs.LabelTransitions
import Cfc.Proofs.Store
import Cfc.Proofs.Opaque
import Cfc.Proofs.Collection
import Cfc.Proofs.LabelTransitionExamples
