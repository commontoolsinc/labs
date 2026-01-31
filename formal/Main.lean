import Cfc

/-
`Main` exists just so `lake build` can produce an executable as well as a library.
The executable doesn't do anything interesting; it prints a banner.

All the "real work" is in the library modules under `Cfc/`.
-/
def main : IO Unit :=
  IO.println "cfc formalization (Lean)"
