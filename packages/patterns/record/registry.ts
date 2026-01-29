// registry.ts - Sub-piece registry with type definitions and pattern constructors
// Now imports from peer patterns in packages/patterns/
//
// =============================================================================
// ADDING A NEW MODULE? You need to update THREE places:
// =============================================================================
// 1. Import the module and its metadata below
// 2. Add it to SUB_CHARM_REGISTRY (around line 90)
// 3. Add it to SubPieceType in ./types.ts
//
// AI extraction schema is discovered dynamically from pattern.resultSchema
// at creation time - no manual schema maintenance needed!
// =============================================================================

import type { SubPieceType } from "./types.ts";

// Import metadata and patterns from peer patterns
import {
  BirthdayModule,
  MODULE_METADATA as BirthdayMeta,
} from "../birthday.tsx";
import { MODULE_METADATA as RatingMeta, RatingModule } from "../rating.tsx";
import { MODULE_METADATA as TagsMeta, TagsModule } from "../tags.tsx";
import { MODULE_METADATA as StatusMeta, StatusModule } from "../status.tsx";
import { AddressModule, MODULE_METADATA as AddressMeta } from "../address.tsx";
import {
  MODULE_METADATA as TimelineMeta,
  TimelineModule,
} from "../timeline.tsx";
import { MODULE_METADATA as SocialMeta, SocialModule } from "../social.tsx";
import { LinkModule, MODULE_METADATA as LinkMeta } from "../link.tsx";
import {
  LocationModule,
  MODULE_METADATA as LocationMeta,
} from "../location.tsx";
import {
  LocationTrackModule,
  MODULE_METADATA as LocationTrackMeta,
} from "../location-track.tsx";
import {
  MODULE_METADATA as RelationshipMeta,
  RelationshipModule,
} from "../relationship.tsx";
import {
  GiftPrefsModule,
  MODULE_METADATA as GiftPrefsMeta,
} from "../giftprefs.tsx";
import { MODULE_METADATA as TimingMeta, TimingModule } from "../timing.tsx";
import {
  AgeCategoryModule,
  MODULE_METADATA as AgeCategoryMeta,
} from "../age-category.tsx";
import {
  DietaryRestrictionsModule,
  MODULE_METADATA as DietaryMeta,
} from "../dietary-restrictions.tsx";
import { GenderModule, MODULE_METADATA as GenderMeta } from "../gender.tsx";
import { EmailModule, MODULE_METADATA as EmailMeta } from "../email.tsx";
import { MODULE_METADATA as PhoneMeta, PhoneModule } from "../phone.tsx";
import {
  MODULE_METADATA as RecordIconMeta,
  RecordIconModule,
} from "../record-icon.tsx";
import {
  MODULE_METADATA as NicknameMeta,
  NicknameModule,
} from "../nickname.tsx";
import {
  MODULE_METADATA as SimpleListMeta,
  SimpleListModule,
} from "../simple-list/simple-list.tsx";
import { MODULE_METADATA as PhotoMeta, PhotoModule } from "../photo.tsx";
import {
  CustomFieldModule,
  MODULE_METADATA as CustomFieldMeta,
} from "../custom-field.tsx";
import {
  MODULE_METADATA as OccurrenceTrackerMeta,
  OccurrenceTrackerModule,
} from "../occurrence-tracker.tsx";
import {
  MODULE_METADATA as TextImportMeta,
  TextImportModule,
} from "../text-import.tsx";
import type { ModuleMetadata } from "../container-protocol.ts";

// NOTE: TypePickerMeta is NOT imported here to avoid circular dependency:
// type-picker.tsx -> template-registry.ts -> registry.ts -> type-picker.tsx
// TypePicker metadata is inlined below since it's a special controller module anyway.

// NOTE: Note is NOT imported here - it's created directly in record.tsx
// with the correct linkPattern (avoids global state for passing Record's pattern JSON)

// NOTE: TypePickerModule is imported directly in record.tsx to avoid circular dependency
// and because it needs ContainerCoordinationContext

// Type for pattern constructors - returns unknown since we store heterogeneous piece types
// Now accepts optional initial values for import/restore functionality
type PatternConstructor = (initialValues?: Record<string, unknown>) => unknown;

export interface SubPieceDefinition {
  type: SubPieceType;
  label: string;
  icon: string;
  // Pattern constructor for creating instances (can accept initial values)
  createInstance: PatternConstructor;
  // Internal modules don't appear in "Add" dropdown (e.g., type-picker)
  internal?: boolean;
  // Multi-instance modules show "add another" button (e.g., email, phone)
  allowMultiple?: boolean;
  // For Phase 2 extraction:
  schema?: Record<string, unknown>;
  fieldMapping?: string[];
  // If true, this module exports a settingsUI for configuration
  hasSettings?: boolean;
  // If true, always include schema in extraction even with no instances
  alwaysExtract?: boolean;
  // Extraction mode: "single" (default) or "array" (each array item creates a module instance)
  extractionMode?: "single" | "array";
}

// Helper to create SubPieceDefinition from ModuleMetadata
// The moduleFactory is the actual recipe function that accepts input
function fromMetadata(
  meta: ModuleMetadata,
  moduleFactory: (input: Record<string, unknown>) => unknown,
): SubPieceDefinition {
  return {
    type: meta.type as SubPieceType,
    label: meta.label,
    icon: meta.icon,
    // createInstance now accepts optional initial values
    createInstance: (initialValues?: Record<string, unknown>) =>
      moduleFactory(initialValues || {}),
    internal: meta.internal,
    allowMultiple: meta.allowMultiple,
    schema: meta.schema,
    fieldMapping: meta.fieldMapping,
    hasSettings: meta.hasSettings,
    alwaysExtract: meta.alwaysExtract,
    extractionMode: meta.extractionMode,
  };
}

// Static registry - defines available sub-piece types
// Now built from peer pattern metadata
export const SUB_CHARM_REGISTRY: Record<string, SubPieceDefinition> = {
  // Notes is special - must be created in record.tsx with linkPattern
  notes: {
    type: "notes",
    label: "Notes",
    icon: "\u{1F4DD}", // 📝
    createInstance: () => {
      throw new Error(
        "Notes must be created directly with linkPattern, not through registry",
      );
    },
    schema: {
      content: {
        type: "string",
        description:
          "IMPORTANT: Output the REMAINING text that should stay in Notes after extraction. Include any text that was NOT extracted into structured fields above (preferences, personality traits, conversational context, hobby mentions, etc). Return null ONLY if ALL content was extracted into structured fields.",
      },
    },
    fieldMapping: ["content", "notes"],
  },

  // Data modules - imported from peer patterns
  // Each module factory receives initial values when createInstance is called
  birthday: fromMetadata(BirthdayMeta, (init) => BirthdayModule(init as any)),
  rating: fromMetadata(RatingMeta, (init) => RatingModule(init as any)),
  tags: fromMetadata(TagsMeta, (init) => TagsModule(init as any)),
  status: fromMetadata(StatusMeta, (init) => StatusModule(init as any)),
  address: fromMetadata(AddressMeta, (init) => AddressModule(init as any)),
  timeline: fromMetadata(TimelineMeta, (init) => TimelineModule(init as any)),
  social: fromMetadata(SocialMeta, (init) => SocialModule(init as any)),
  link: fromMetadata(LinkMeta, (init) => LinkModule(init as any)),
  location: fromMetadata(LocationMeta, (init) => LocationModule(init as any)),
  "location-track": fromMetadata(
    LocationTrackMeta,
    (init) => LocationTrackModule(init as any),
  ),
  relationship: fromMetadata(
    RelationshipMeta,
    (init) => RelationshipModule(init as any),
  ),
  giftprefs: fromMetadata(
    GiftPrefsMeta,
    (init) => GiftPrefsModule(init as any),
  ),
  timing: fromMetadata(TimingMeta, (init) => TimingModule(init as any)),
  "age-category": fromMetadata(
    AgeCategoryMeta,
    (init) => AgeCategoryModule(init as any),
  ),
  "dietary-restrictions": fromMetadata(
    DietaryMeta,
    (init) => DietaryRestrictionsModule(init as any),
  ),
  gender: fromMetadata(GenderMeta, (init) => GenderModule(init as any)),
  email: fromMetadata(EmailMeta, (init) => EmailModule(init as any)),
  phone: fromMetadata(PhoneMeta, (init) => PhoneModule(init as any)),
  "record-icon": fromMetadata(
    RecordIconMeta,
    (init) => RecordIconModule(init as any),
  ),
  nickname: fromMetadata(NicknameMeta, (init) => NicknameModule(init as any)),
  "simple-list": fromMetadata(
    SimpleListMeta,
    (init) => SimpleListModule(init as any),
  ),
  photo: fromMetadata(PhotoMeta, (init) => PhotoModule(init as any)),
  "custom-field": fromMetadata(
    CustomFieldMeta,
    (init) => CustomFieldModule(init as any),
  ),
  "occurrence-tracker": fromMetadata(
    OccurrenceTrackerMeta,
    (init) => OccurrenceTrackerModule(init as any),
  ),
  "text-import": fromMetadata(
    TextImportMeta,
    (init) => TextImportModule(init as any),
  ),

  // Controller modules - TypePicker needs special handling in record.tsx
  // Metadata is inlined here to avoid circular dependency (see note at top)
  "type-picker": {
    type: "type-picker",
    label: "Type Picker",
    icon: "\u{1F3AF}", // 🎯 target emoji
    createInstance: () => {
      throw new Error(
        "Use TypePickerModule directly with ContainerCoordinationContext",
      );
    },
    internal: true,
  },
  // ExtractorModule is imported directly in record.tsx
  "extractor": {
    type: "extractor",
    label: "AI Extract",
    icon: "\u2728", // ✨
    // createInstance is a no-op - record.tsx imports ExtractorModule directly
    createInstance: () => {
      throw new Error("Use ExtractorModule directly, not through registry");
    },
    internal: false, // Show in Add dropdown - user can add this
  },
};

// Helper functions
export function getAvailableTypes(): SubPieceDefinition[] {
  return Object.values(SUB_CHARM_REGISTRY);
}

// Get types available for "Add" dropdown (excludes internal modules like type-picker)
export function getAddableTypes(): SubPieceDefinition[] {
  return Object.values(SUB_CHARM_REGISTRY).filter((def) => !def.internal);
}

export function getDefinition(
  type: SubPieceType | string,
): SubPieceDefinition | undefined {
  return SUB_CHARM_REGISTRY[type];
}

// Create a new sub-piece instance by type, optionally with initial values
// Used for import/restore functionality
export function createSubPiece(
  type: string,
  initialValues?: Record<string, unknown>,
): unknown {
  const def = SUB_CHARM_REGISTRY[type];
  if (!def) {
    throw new Error(`Unknown sub-piece type: ${type}`);
  }
  return def.createInstance(initialValues);
}

// Phase 2: Build combined extraction schema
export function buildExtractionSchema(): {
  type: "object";
  properties: Record<string, unknown>;
} {
  const properties: Record<string, unknown> = {
    // Record's own title field - for extracting names/titles
    // Use "name" as field since LLMs naturally extract person names to "name"
    name: {
      type: "string",
      description:
        "The primary name for this record - person's full name, recipe name, place name, project name, etc. This becomes the record's title.",
    },
  };

  for (const def of Object.values(SUB_CHARM_REGISTRY)) {
    if (!def.schema) continue;

    // Add primary schema fields
    Object.assign(properties, def.schema);

    // Add fieldMapping aliases to schema for LLM flexibility
    // This allows LLMs to extract to natural field names like "email" instead of just "address"
    if (def.fieldMapping && def.fieldMapping.length > 0) {
      // First entry in fieldMapping is the primary field (already in schema)
      const primaryField = def.fieldMapping[0];
      const primarySchema = def.schema[primaryField];

      // Add aliases (indices 1+) that reference the same type/format
      for (let i = 1; i < def.fieldMapping.length; i++) {
        const aliasField = def.fieldMapping[i];

        // Skip if alias already exists in properties (avoid conflicts)
        if (properties[aliasField]) continue;

        // Create alias schema entry with clear description
        if (primarySchema && typeof primarySchema === "object") {
          properties[aliasField] = {
            ...primarySchema,
            description: `${
              (primarySchema as { description?: string }).description || ""
            } (alias for ${primaryField})`.trim(),
          };
        } else {
          // Fallback if primary schema is malformed
          properties[aliasField] = {
            type: "string",
            description: `Alias for ${primaryField} in ${def.type} module`,
          };
        }
      }
    }
  }

  return { type: "object", properties };
}

// Phase 2: Get field to sub-piece type mapping
export function getFieldToTypeMapping(): Record<string, string> {
  const fieldToType: Record<string, string> = {};

  // Special mapping for Record's title field
  // "name" extracts to "record-title" pseudo-type, handled specially in applySelected
  fieldToType["name"] = "record-title";

  for (const def of Object.values(SUB_CHARM_REGISTRY)) {
    if (def.fieldMapping) {
      for (const field of def.fieldMapping) {
        fieldToType[field] = def.type;
      }
    }
  }
  return fieldToType;
}
