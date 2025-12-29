// registry.ts - Sub-charm registry with type definitions and pattern constructors
// Now imports from peer patterns in packages/patterns/
//
// =============================================================================
// ADDING A NEW MODULE? You need to update THREE places:
// =============================================================================
// 1. Import the module and its metadata below
// 2. Add it to SUB_CHARM_REGISTRY (around line 90)
// 3. Add it to SubCharmType in ./types.ts
//
// AI extraction schema is discovered dynamically from pattern.resultSchema
// at creation time - no manual schema maintenance needed!
// =============================================================================

import type { SubCharmType } from "./types.ts";
import { getRecipeEnvironment } from "commontools";

// NOTE: TypePickerMeta is NOT imported here to avoid circular dependency:
// type-picker.tsx -> template-registry.ts -> registry.ts -> type-picker.tsx
// TypePicker metadata is inlined below since it's a special controller module anyway.

// NOTE: Note is NOT imported here - it's created directly in record.tsx
// with the correct linkPattern (avoids global state for passing Record's pattern JSON)

// NOTE: TypePickerModule is imported directly in record.tsx to avoid circular dependency
// and because it needs ContainerCoordinationContext

export interface SubCharmDefinition {
  type: SubCharmType;
  label: string;
  icon: string;
  // URL to the module pattern file
  url: string;
  // Internal modules don't appear in "Add" dropdown (e.g., type-picker)
  internal?: boolean;
  // Multi-instance modules show "add another" button (e.g., email, phone)
  allowMultiple?: boolean;
  // For Phase 2 extraction:
  schema?: Record<string, unknown>;
  fieldMapping?: string[];
}

// Static registry - defines available sub-charm types
// URLs are relative to packages/patterns/ directory
export const SUB_CHARM_REGISTRY: Record<string, SubCharmDefinition> = {
  // Notes is special - must be created in record.tsx with linkPattern
  notes: {
    type: "notes",
    label: "Notes",
    icon: "\u{1F4DD}", // 📝
    url: "notes/note.tsx",
    schema: {
      content: { type: "string", description: "Free-form notes and content" },
    },
    fieldMapping: ["content", "notes"],
  },

  // Data modules - loaded dynamically via URL
  birthday: {
    type: "birthday",
    label: "Birthday",
    icon: "\u{1F382}", // 🎂
    url: "birthday.tsx",
    schema: {
      birthDate: {
        type: "string",
        description: "Birth date (MM-DD or YYYY-MM-DD)",
      },
      birthYear: { type: "number", description: "Birth year (YYYY)" },
    },
    fieldMapping: ["birthDate", "birthYear", "birthday"],
  },
  rating: {
    type: "rating",
    label: "Rating",
    icon: "\u2B50", // ⭐
    url: "rating.tsx",
    schema: {
      rating: { type: "number", description: "Rating (1-5 stars)" },
    },
    fieldMapping: ["rating", "stars"],
  },
  tags: {
    type: "tags",
    label: "Tags",
    icon: "\u{1F3F7}\uFE0F", // 🏷️
    url: "tags.tsx",
    allowMultiple: false,
    schema: {
      tags: { type: "array", description: "List of tags" },
    },
    fieldMapping: ["tags"],
  },
  status: {
    type: "status",
    label: "Status",
    icon: "\u{1F6A6}", // 🚦
    url: "status.tsx",
    schema: {
      status: {
        type: "string",
        description: "Status (active, inactive, completed, etc.)",
      },
    },
    fieldMapping: ["status"],
  },
  address: {
    type: "address",
    label: "Address",
    icon: "\u{1F3E0}", // 🏠
    url: "address.tsx",
    allowMultiple: true,
    schema: {
      address: { type: "string", description: "Street address" },
      label: {
        type: "string",
        description: "Address label (Home, Work, etc.)",
      },
    },
    fieldMapping: ["address"],
  },
  timeline: {
    type: "timeline",
    label: "Timeline",
    icon: "\u{1F4C5}", // 📅
    url: "timeline.tsx",
    schema: {
      events: { type: "array", description: "Timeline events" },
    },
    fieldMapping: ["timeline", "events"],
  },
  social: {
    type: "social",
    label: "Social",
    icon: "\u{1F517}", // 🔗
    url: "social.tsx",
    schema: {
      social: { type: "object", description: "Social media links" },
    },
    fieldMapping: ["social", "twitter", "linkedin", "github"],
  },
  link: {
    type: "link",
    label: "Link",
    icon: "\u{1F517}", // 🔗
    url: "link.tsx",
    schema: {
      url: { type: "string", description: "URL" },
      title: { type: "string", description: "Link title" },
    },
    fieldMapping: ["url", "link"],
  },
  location: {
    type: "location",
    label: "Location",
    icon: "\u{1F30D}", // 🌍
    url: "location.tsx",
    schema: {
      latitude: { type: "number", description: "Latitude" },
      longitude: { type: "number", description: "Longitude" },
    },
    fieldMapping: ["location", "latitude", "longitude", "coordinates"],
  },
  relationship: {
    type: "relationship",
    label: "Relationship",
    icon: "\u{1F465}", // 👥
    url: "relationship.tsx",
    schema: {
      relationship: {
        type: "string",
        description: "Relationship type (friend, family, colleague, etc.)",
      },
    },
    fieldMapping: ["relationship"],
  },
  giftprefs: {
    type: "giftprefs",
    label: "Gift Preferences",
    icon: "\u{1F381}", // 🎁
    url: "giftprefs.tsx",
    schema: {
      favorites: { type: "array", description: "Favorite things" },
      dislikes: { type: "array", description: "Things to avoid" },
    },
    fieldMapping: ["favorites", "dislikes", "gifts", "preferences"],
  },
  timing: {
    type: "timing",
    label: "Timing",
    icon: "\u23F1\uFE0F", // ⏱️
    url: "timing.tsx",
    schema: {
      prepTime: { type: "number", description: "Preparation time (minutes)" },
      cookTime: { type: "number", description: "Cooking time (minutes)" },
    },
    fieldMapping: ["prepTime", "cookTime", "totalTime", "timing"],
  },
  "age-category": {
    type: "age-category",
    label: "Age Category",
    icon: "\u{1F476}", // 👶
    url: "age-category.tsx",
    schema: {
      category: {
        type: "string",
        description: "Age category (child, teen, adult, senior)",
      },
    },
    fieldMapping: ["ageCategory", "age"],
  },
  "dietary-restrictions": {
    type: "dietary-restrictions",
    label: "Dietary Restrictions",
    icon: "\u{1F957}", // 🥗
    url: "dietary-restrictions.tsx",
    schema: {
      restrictions: { type: "array", description: "Dietary restrictions" },
    },
    fieldMapping: ["dietary", "restrictions", "allergies"],
  },
  email: {
    type: "email",
    label: "Email",
    icon: "\u2709\uFE0F", // ✉️
    url: "email.tsx",
    allowMultiple: true,
    schema: {
      email: { type: "string", description: "Email address" },
      label: {
        type: "string",
        description: "Email label (Personal, Work, etc.)",
      },
    },
    fieldMapping: ["email"],
  },
  phone: {
    type: "phone",
    label: "Phone",
    icon: "\u{1F4DE}", // 📞
    url: "phone.tsx",
    allowMultiple: true,
    schema: {
      phone: { type: "string", description: "Phone number" },
      label: {
        type: "string",
        description: "Phone label (Mobile, Home, Work, etc.)",
      },
    },
    fieldMapping: ["phone", "mobile", "telephone"],
  },
  "record-icon": {
    type: "record-icon",
    label: "Icon",
    icon: "\u{1F3A8}", // 🎨
    url: "record-icon.tsx",
    internal: true,
    schema: {
      icon: { type: "string", description: "Custom icon emoji" },
    },
    fieldMapping: ["icon"],
  },
  nickname: {
    type: "nickname",
    label: "Nickname",
    icon: "\u{1F4DB}", // 📛
    url: "nickname.tsx",
    allowMultiple: true,
    schema: {
      nickname: { type: "string", description: "Nickname or alias" },
    },
    fieldMapping: ["nickname", "alias"],
  },
  "simple-list": {
    type: "simple-list",
    label: "Checklist",
    icon: "\u2611\uFE0F", // ☑️
    url: "simple-list.tsx",
    schema: {
      items: { type: "array", description: "List items" },
    },
    fieldMapping: ["items", "checklist", "list"],
  },

  // Controller modules - TypePicker needs special handling in record.tsx
  "type-picker": {
    type: "type-picker",
    label: "Type Picker",
    icon: "\u{1F3AF}", // 🎯 target emoji
    url: "type-picker.tsx",
    internal: true,
  },
  // ExtractorModule is imported directly in record.tsx
  "extractor": {
    type: "extractor",
    label: "AI Extract",
    icon: "\u2728", // ✨
    url: "record/extraction/extractor-module.tsx",
    internal: false, // Show in Add dropdown - user can add this
  },
};

// ===== Dynamic Module Loading Types =====

export interface ModuleLoadInfo {
  url: string;
  definition: SubCharmDefinition;
}

export interface ModuleLoadError {
  error: string;
}

// ===== Helper Functions =====

export function getAvailableTypes(): SubCharmDefinition[] {
  return Object.values(SUB_CHARM_REGISTRY);
}

// Get types available for "Add" dropdown (excludes internal modules like type-picker)
export function getAddableTypes(): SubCharmDefinition[] {
  return Object.values(SUB_CHARM_REGISTRY).filter((def) => !def.internal);
}

export function getDefinition(
  type: SubCharmType | string,
): SubCharmDefinition | undefined {
  return SUB_CHARM_REGISTRY[type];
}

/**
 * Get module URL for dynamic loading.
 * Returns either { url, definition } for success or { error } for failure.
 */
export function getModuleUrl(
  type: string,
): ModuleLoadInfo | ModuleLoadError {
  const def = SUB_CHARM_REGISTRY[type];
  if (!def) {
    return { error: `Unknown module type: ${type}` };
  }

  // Get base URL from recipe environment
  const env = getRecipeEnvironment();
  // deno-lint-ignore no-explicit-any
  const baseUrl = (env as any)?.baseUrl || "";

  // Construct full URL - def.url is relative to packages/patterns/
  const url = baseUrl ? `${baseUrl}/${def.url}` : def.url;

  return { url, definition: def };
}

// Phase 2: Build combined extraction schema
export function buildExtractionSchema(): {
  type: "object";
  properties: Record<string, unknown>;
} {
  const properties: Record<string, unknown> = {};
  for (const def of Object.values(SUB_CHARM_REGISTRY)) {
    if (def.schema) {
      Object.assign(properties, def.schema);
    }
  }
  return { type: "object", properties };
}

// Phase 2: Get field to sub-charm type mapping
export function getFieldToTypeMapping(): Record<string, string> {
  const fieldToType: Record<string, string> = {};
  for (const def of Object.values(SUB_CHARM_REGISTRY)) {
    if (def.fieldMapping) {
      for (const field of def.fieldMapping) {
        fieldToType[field] = def.type;
      }
    }
  }
  return fieldToType;
}
