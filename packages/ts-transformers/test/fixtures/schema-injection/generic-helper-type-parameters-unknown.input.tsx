import { Cell, generateObject, wish } from "commonfabric";

// FIXTURE: generic-helper-type-parameters-unknown
// Verifies: generic definition-site helper wrappers degrade injected schemas to unknown
//   wish<T>({ query }) → wish<T>({ query }, { type: "unknown" })
//   generateObject<T>({ ... }) → generateObject<T>({ ..., schema: { type: "unknown" } })
//   new Cell<T>() → new Cell<T>(undefined, { type: "unknown" })
// Cell initials are schema defaults and must be compile-time static
// (CT-1880); a generic helper's runtime value arrives via `.set(...)`.
export function buildWishExplicit<T>(path: string) {
  return wish<T>({ query: path });
}

export function buildObjectExplicit<T>(prompt: string) {
  return generateObject<T>({
    model: "gpt-4o-mini",
    prompt,
  });
}

export function buildCellExplicit<T>(value: T) {
  const result = new Cell<T>();
  result.set(value);
  return result;
}
