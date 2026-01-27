/- 
This is the root module of the `Cfc` library.

In Lean, a "library" is just a collection of modules. By convention, the root module
re-exports whatever should be considered the public surface area.

Here we simply re-export `Cfc.Basic`, which in turn imports all core definitions and proof
modules. That means:
- `import Cfc` pulls in the whole development, and
- `lake build` typechecks the entire proof suite.
-/
import Cfc.Basic
