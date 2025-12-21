/**
 * Pure type inference utilities - extracted to avoid circular dependencies
 *
 * This module has ZERO dependencies on registry or modules.
 * It's a pure function library that both template-registry and modules can import.
 *
 * Dependency chain solved:
 *   members.tsx ─┐
 *                ├─> type-inference.ts (pure, no imports)
 *   template-registry.ts ─┘
 */

export interface InferredType {
  type: string;
  icon: string;
  confidence: number;
}

/**
 * Infer record "type" from the modules it contains.
 * Data-up philosophy: the modules ARE the type.
 *
 * Returns type, icon, and confidence score (0-1).
 */
export function inferTypeFromModules(moduleTypes: string[]): InferredType {
  const typeSet = new Set(moduleTypes);

  // Person: has birthday AND (email/phone OR relationship)
  if (
    typeSet.has("birthday") &&
    (typeSet.has("email") || typeSet.has("phone") ||
      typeSet.has("relationship"))
  ) {
    return { type: "person", icon: "\u{1F464}", confidence: 0.9 };
  }

  // Recipe: has timing (cooking-specific module)
  if (typeSet.has("timing")) {
    return { type: "recipe", icon: "\u{1F373}", confidence: 0.85 };
  }

  // Project: has timeline AND status
  if (typeSet.has("timeline") && typeSet.has("status")) {
    return { type: "project", icon: "\u{1F4BC}", confidence: 0.85 };
  }

  // Place: has location OR address (but not birthday - that's a person)
  if (
    (typeSet.has("location") || typeSet.has("address")) &&
    !typeSet.has("birthday")
  ) {
    return { type: "place", icon: "\u{1F4CD}", confidence: 0.8 };
  }

  // Family: has address AND relationship (but not birthday - individual person)
  if (
    typeSet.has("address") && typeSet.has("relationship") &&
    !typeSet.has("birthday")
  ) {
    return {
      type: "family",
      icon: "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}",
      confidence: 0.75,
    };
  }

  // Default: generic record
  return { type: "record", icon: "\u{1F4CB}", confidence: 0.5 };
}
