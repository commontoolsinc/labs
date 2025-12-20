// registry.ts - Sub-charm registry with type definitions and pattern constructors
// Defines available sub-charm types and their metadata
// Includes pattern constructors for true sub-charm architecture

import type { Cell } from "commontools";
import type { SubCharmType } from "./types.ts";

// NOTE: Note is NOT imported here - it's created directly in record.tsx
// with the correct linkPattern (avoids global state for passing Record's pattern JSON)

// Import all module patterns
import { BirthdayModule } from "./modules/birthday-module.tsx";
import { RatingModule } from "./modules/rating-module.tsx";
import { TagsModule } from "./modules/tags-module.tsx";
import { ContactModule } from "./modules/contact-module.tsx";
import { StatusModule } from "./modules/status-module.tsx";
import { AddressModule } from "./modules/address-module.tsx";
import { TimelineModule } from "./modules/timeline-module.tsx";
import { SocialModule } from "./modules/social-module.tsx";
import { LinkModule } from "./modules/link-module.tsx";
import { LocationModule } from "./modules/location-module.tsx";
import { RelationshipModule } from "./modules/relationship-module.tsx";
import { GiftPrefsModule } from "./modules/giftprefs-module.tsx";
import { TimingModule } from "./modules/timing-module.tsx";
// NOTE: TypePickerModule is NOT imported here to avoid circular dependency
// (registry → type-picker → template-registry → registry)
// Instead, record.tsx imports it directly.

// Type for pattern constructors - uses any to bypass Opaque type requirements
// deno-lint-ignore no-explicit-any
type PatternConstructor = (...args: any[]) => any;

export interface SubCharmDefinition {
  type: SubCharmType;
  label: string;
  icon: string;
  // Pattern constructor for creating instances
  createInstance: PatternConstructor;
  // Internal modules don't appear in "Add" dropdown (e.g., type-picker)
  internal?: boolean;
  // For Phase 2 extraction:
  schema?: Record<string, unknown>;
  fieldMapping?: string[];
}

// Static registry - defines available sub-charm types
// Note: createInstance uses {} as any to bypass Opaque type requirements
// The framework will provide defaults for all fields
//
// NOTE: "notes" is special - createInstance throws because it must be created
// in record.tsx with the correct linkPattern. The metadata is here for
// getDefinition() and getAddableTypes() to work.
export const SUB_CHARM_REGISTRY: Record<string, SubCharmDefinition> = {
  notes: {
    type: "notes",
    label: "Notes",
    icon: "\u{1F4DD}", // 📝
    // createInstance throws - Notes must be created directly in record.tsx
    // with the correct linkPattern for wiki-links to work
    createInstance: () => {
      throw new Error("Notes must be created directly with linkPattern, not through registry");
    },
    schema: {
      notes: { type: "string", description: "Free-form notes" },
    },
    fieldMapping: ["notes", "content"],
  },
  birthday: {
    type: "birthday",
    label: "Birthday",
    icon: "\u{1F382}", // 🎂
    createInstance: () => BirthdayModule({} as any),
    schema: {
      birthDate: { type: "string", description: "Birthday YYYY-MM-DD" },
      birthYear: { type: "number", description: "Birth year" },
    },
    fieldMapping: ["birthDate", "birthYear"],
  },
  rating: {
    type: "rating",
    label: "Rating",
    icon: "\u{2B50}", // ⭐
    createInstance: () => RatingModule({} as any),
    schema: {
      rating: { type: "number", minimum: 1, maximum: 5, description: "Rating 1-5" },
    },
    fieldMapping: ["rating"],
  },
  tags: {
    type: "tags",
    label: "Tags",
    icon: "\u{1F3F7}", // 🏷️
    createInstance: () => TagsModule({} as any),
    schema: {
      tags: { type: "array", items: { type: "string" }, description: "Tags" },
    },
    fieldMapping: ["tags"],
  },
  contact: {
    type: "contact",
    label: "Contact",
    icon: "\u{1F4E7}", // 📧
    createInstance: () => ContactModule({} as any),
    schema: {
      email: { type: "string", description: "Email address" },
      phone: { type: "string", description: "Phone number" },
      website: { type: "string", description: "Website URL" },
    },
    fieldMapping: ["email", "phone", "website"],
  },
  // Wave 2 modules
  status: {
    type: "status",
    label: "Status",
    icon: "\u{1F4CA}", // 📊
    createInstance: () => StatusModule({} as any),
    schema: {
      status: { type: "string", enum: ["planned", "active", "blocked", "done", "archived"], description: "Project status" },
    },
    fieldMapping: ["status"],
  },
  address: {
    type: "address",
    label: "Address",
    icon: "\u{1F4CD}", // 📍
    createInstance: () => AddressModule({} as any),
    schema: {
      street: { type: "string", description: "Street address" },
      city: { type: "string", description: "City" },
      state: { type: "string", description: "State/Province" },
      zip: { type: "string", description: "ZIP/Postal code" },
    },
    fieldMapping: ["street", "city", "state", "zip"],
  },
  timeline: {
    type: "timeline",
    label: "Timeline",
    icon: "\u{1F4C5}", // 📅
    createInstance: () => TimelineModule({} as any),
    schema: {
      startDate: { type: "string", format: "date", description: "Start date" },
      targetDate: { type: "string", format: "date", description: "Target completion date" },
      completedDate: { type: "string", format: "date", description: "Actual completion date" },
    },
    fieldMapping: ["startDate", "targetDate", "completedDate"],
  },
  social: {
    type: "social",
    label: "Social",
    icon: "\u{1F517}", // 🔗
    createInstance: () => SocialModule({} as any),
    schema: {
      platform: { type: "string", enum: ["twitter", "linkedin", "github", "instagram", "facebook", "youtube", "tiktok", "mastodon", "bluesky"], description: "Social platform" },
      handle: { type: "string", description: "Username/handle" },
      url: { type: "string", format: "uri", description: "Profile URL" },
    },
    fieldMapping: ["platform", "handle"],
  },
  link: {
    type: "link",
    label: "Link",
    icon: "\u{1F310}", // 🌐
    createInstance: () => LinkModule({} as any),
    schema: {
      url: { type: "string", format: "uri", description: "URL" },
      linkTitle: { type: "string", description: "Link title" },
      description: { type: "string", description: "Description" },
    },
    fieldMapping: ["url", "linkTitle", "description"],
  },
  // Wave 3 modules
  location: {
    type: "location",
    label: "Location",
    icon: "\u{1F5FA}", // 🗺️
    createInstance: () => LocationModule({} as any),
    schema: {
      locationName: { type: "string", description: "Location name" },
      locationAddress: { type: "string", description: "Full address" },
      coordinates: { type: "string", description: "Coordinates (lat,lng)" },
    },
    fieldMapping: ["locationName", "locationAddress", "coordinates"],
  },
  relationship: {
    type: "relationship",
    label: "Relationship",
    icon: "\u{1F465}", // 👥
    createInstance: () => RelationshipModule({} as any),
    schema: {
      relationTypes: { type: "array", items: { type: "string" }, description: "Relationship types" },
      closeness: { type: "string", enum: ["intimate", "close", "casual", "distant"], description: "Closeness level" },
      howWeMet: { type: "string", description: "How we met" },
      innerCircle: { type: "boolean", description: "Inner circle member" },
    },
    fieldMapping: ["relationTypes", "closeness", "howWeMet", "innerCircle"],
  },
  giftprefs: {
    type: "giftprefs",
    label: "Gift Prefs",
    icon: "\u{1F381}", // 🎁
    createInstance: () => GiftPrefsModule({} as any),
    schema: {
      giftTier: { type: "string", enum: ["always", "occasions", "reciprocal", "none"], description: "Gift giving tier" },
      favorites: { type: "array", items: { type: "string" }, description: "Favorite things" },
      avoid: { type: "array", items: { type: "string" }, description: "Things to avoid" },
    },
    fieldMapping: ["giftTier", "favorites", "avoid"],
  },
  timing: {
    type: "timing",
    label: "Timing",
    icon: "\u{23F1}", // ⏱️
    createInstance: () => TimingModule({} as any),
    schema: {
      prepTime: { type: "number", description: "Prep time in minutes" },
      cookTime: { type: "number", description: "Cook time in minutes" },
      restTime: { type: "number", description: "Rest time in minutes" },
    },
    fieldMapping: ["prepTime", "cookTime", "restTime"],
  },
  // Controller modules - metadata only (no createInstance to avoid circular deps)
  // TypePickerModule is imported directly in record.tsx
  "type-picker": {
    type: "type-picker",
    label: "Type Picker",
    icon: "\u{1F3AF}", // 🎯
    // createInstance is a no-op - record.tsx imports TypePickerModule directly
    createInstance: () => {
      throw new Error("Use TypePickerModule directly, not through registry");
    },
    internal: true, // Don't show in Add dropdown
  },
};

// Helper functions
export function getAvailableTypes(): SubCharmDefinition[] {
  return Object.values(SUB_CHARM_REGISTRY);
}

// Get types available for "Add" dropdown (excludes internal modules like type-picker)
export function getAddableTypes(): SubCharmDefinition[] {
  return Object.values(SUB_CHARM_REGISTRY).filter((def) => !def.internal);
}

export function getDefinition(
  type: SubCharmType | string
): SubCharmDefinition | undefined {
  return SUB_CHARM_REGISTRY[type];
}

// Create a new sub-charm instance by type
export function createSubCharm(type: string): unknown {
  const def = SUB_CHARM_REGISTRY[type];
  if (!def) {
    throw new Error(`Unknown sub-charm type: ${type}`);
  }
  return def.createInstance();
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

