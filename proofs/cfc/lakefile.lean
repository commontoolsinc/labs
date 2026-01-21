import Lake
open Lake DSL

package «cfc» where
  -- add package configuration options here

lean_lib «CFC» where
  -- add library configuration options here

@[default_target]
lean_exe «cfc» where
  root := `Main
