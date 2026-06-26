import { computed, pattern } from "commonfabric";

// FIXTURE: pattern-optional-destructured-capture
// Verifies: an optional pattern input (`opt?`) destructured and captured in a
//   closure is emitted optional in the derived lift's input schema (so it does
//   not gate the lift), while `ud: T | undefined` (no `?`) stays required, and a
//   renamed binding (`ren: renamed`) tracks its source property's optionality.
export default pattern<{
  req: string;
  opt?: string;
  ud: string | undefined;
  ren?: string;
}>(({ req, opt, ud, ren: renamed }) => {
  const body = computed(() => ({
    req,
    ...(opt !== undefined && { opt }),
    ...(ud !== undefined && { ud }),
    ...(renamed !== undefined && { renamed }),
  }));
  return <div>{body}</div>;
});
