import { computed, pattern } from "commonfabric";

// Demonstrates the bug the unknown-capture diagnostic warns about: a value that
// is present at runtime but typed `unknown` is captured into a computed(), whose
// input schema becomes `{ type: "unknown" }`. The runner does not materialize a
// structured value across that boundary, so the body reads `undefined` even
// though a real object was supplied as the argument. The typed capture in the
// same body materializes normally — the drop is specific to `unknown`.

interface Named {
  name: string;
}

export default pattern<
  { payload: unknown; typed: Named },
  { unknownPresent: boolean; unknownName: string; typedName: string }
>(({ payload, typed }) => {
  return computed(() => {
    const p = payload as Named | undefined;
    return {
      unknownPresent: p !== undefined && p !== null,
      unknownName: p ? p.name : "MISSING",
      typedName: typed.name,
    };
  });
});
