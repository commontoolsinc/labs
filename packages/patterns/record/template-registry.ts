// template-registry.ts - Pre-assembled module sets ("lego sets")
// Defines common record types and their associated modules

import {
  getModuleUrl,
  type ModuleLoadError,
  type ModuleLoadInfo,
} from "./registry.ts";
import type { SubCharmEntry } from "./types.ts";

// ===== Template Types =====

export interface TemplateDefinition {
  id: string;
  name: string;
  icon: string;
  description: string;
  modules: string[]; // Module types to create (order matters)
  defaultPinned: string[]; // Which modules start pinned
}

// ===== Template Registry =====

export const TEMPLATE_REGISTRY: Record<string, TemplateDefinition> = {
  person: {
    id: "person",
    name: "Person",
    icon: "\u{1F464}", // 👤
    description: "People you know",
    modules: ["notes", "email", "phone", "birthday", "relationship", "tags"],
    defaultPinned: ["notes"],
  },
  recipe: {
    id: "recipe",
    name: "Recipe",
    icon: "\u{1F373}", // 🍳
    description: "Cooking recipes",
    modules: ["notes", "timing", "tags", "rating"],
    defaultPinned: ["notes"],
  },
  place: {
    id: "place",
    name: "Place",
    icon: "\u{1F4CD}", // 📍
    description: "Locations and venues",
    modules: ["notes", "address", "location", "rating", "tags"],
    defaultPinned: ["notes"],
  },
  project: {
    id: "project",
    name: "Project",
    icon: "\u{1F4BC}", // 💼
    description: "Work or personal projects",
    modules: ["notes", "timeline", "status", "tags"],
    defaultPinned: ["notes"],
  },
  family: {
    id: "family",
    name: "Family",
    icon: "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}", // 👨‍👩‍👧‍👦
    description: "Household or group",
    modules: ["notes", "address", "relationship", "tags"],
    defaultPinned: ["notes"],
  },
  blank: {
    id: "blank",
    name: "Blank",
    icon: "\u{1F4DD}", // 📝
    description: "Start with just notes",
    modules: ["notes"],
    defaultPinned: ["notes"],
  },
};

// ===== Pure Helper Functions =====

/**
 * Get list of all available templates for UI display.
 * Returns in display order (person, recipe, place, project, family, blank).
 */
export function getTemplateList(): TemplateDefinition[] {
  // Explicit order for consistent UI
  return [
    TEMPLATE_REGISTRY.person,
    TEMPLATE_REGISTRY.recipe,
    TEMPLATE_REGISTRY.place,
    TEMPLATE_REGISTRY.project,
    TEMPLATE_REGISTRY.family,
    TEMPLATE_REGISTRY.blank,
  ];
}

/**
 * Get a specific template definition by ID.
 */
export function getTemplate(id: string): TemplateDefinition | undefined {
  return TEMPLATE_REGISTRY[id];
}

// ===== Type Inference =====

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

  // Place: has location OR address (but not birthday - that's a person)
  if (
    (typeSet.has("location") || typeSet.has("address")) &&
    !typeSet.has("birthday")
  ) {
    return { type: "place", icon: "\u{1F4CD}", confidence: 0.8 };
  }

  // Default: generic record
  return { type: "record", icon: "\u{1F4CB}", confidence: 0.5 };
}

// ===== Template Module Creation =====

/**
 * Factory function type for creating modules.
 * Called with module type and initial values, returns the charm.
 * For pattern-level usage (fetchAndRunPattern), pass a factory that
 * handles the async loading.
 */
export type ModuleFactory = (
  type: string,
  initialValues?: Record<string, unknown>,
) => unknown;

/**
 * Create all modules for a template, returning SubCharmEntry array.
 * Notes is pinned by default in all templates.
 *
 * @param templateId - ID of the template to create modules for
 * @param createModule - Factory function to create module charms.
 *                       This should handle async loading (e.g., via fetchAndRunPattern).
 *                       For notes, can return synchronous Note() result.
 */
export function createTemplateModules(
  templateId: string,
  createModule: ModuleFactory,
): SubCharmEntry[] {
  const template = TEMPLATE_REGISTRY[templateId];
  if (!template) return [];

  const entries: SubCharmEntry[] = [];

  for (const moduleType of template.modules) {
    try {
      const charm = createModule(moduleType);
      if (charm !== undefined) {
        entries.push({
          type: moduleType,
          pinned: template.defaultPinned.includes(moduleType),
          charm,
        });
      }
    } catch (error) {
      console.warn(
        `Failed to create module "${moduleType}" for template "${templateId}":`,
        error,
      );
      // Continue with other modules - don't let one failure break the template
    }
  }

  return entries;
}

/**
 * Get module loading info for a template.
 * Returns URL info for each module type that can be dynamically loaded.
 * The caller should use fetchAndRunPattern to load each module.
 */
export function getTemplateModuleUrls(
  templateId: string,
): Array<
  { type: string; pinned: boolean; loadInfo: ModuleLoadInfo | ModuleLoadError }
> {
  const template = TEMPLATE_REGISTRY[templateId];
  if (!template) return [];

  return template.modules.map((moduleType) => ({
    type: moduleType,
    pinned: template.defaultPinned.includes(moduleType),
    loadInfo: getModuleUrl(moduleType),
  }));
}
