// registry.ts - Sub-charm registry with type definitions and pattern constructors
// Now imports from peer patterns in packages/patterns/

import type { SubCharmType } from "./types.ts";

// Import metadata and patterns from peer patterns
import {
  BirthdayModule,
  MODULE_METADATA as BirthdayMeta,
} from "../birthday.tsx";
import { MODULE_METADATA as RatingMeta, RatingModule } from "../rating.tsx";
import { MODULE_METADATA as TagsMeta, TagsModule } from "../tags.tsx";
import {
  ContactModule,
  MODULE_METADATA as ContactMeta,
} from "../contact-info.tsx";
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
import type { ModuleMetadata } from "../container-protocol.ts";

// NOTE: TypePickerMeta is NOT imported here to avoid circular dependency:
// type-picker.tsx -> template-registry.ts -> registry.ts -> type-picker.tsx
// TypePicker metadata is inlined below since it's a special controller module anyway.

// NOTE: Note is NOT imported here - it's created directly in record.tsx
// with the correct linkPattern (avoids global state for passing Record's pattern JSON)

// NOTE: TypePickerModule is imported directly in record.tsx to avoid circular dependency
// and because it needs ContainerCoordinationContext

// Type for pattern constructors - returns unknown since we store heterogeneous charm types
type PatternConstructor = () => unknown;

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

// Helper to create SubCharmDefinition from ModuleMetadata
function fromMetadata(
  meta: ModuleMetadata,
  createInstance: PatternConstructor,
): SubCharmDefinition {
  return {
    type: meta.type as SubCharmType,
    label: meta.label,
    icon: meta.icon,
    createInstance,
    internal: meta.internal,
    schema: meta.schema,
    fieldMapping: meta.fieldMapping,
  };
}

// Static registry - defines available sub-charm types
// Now built from peer pattern metadata
export const SUB_CHARM_REGISTRY: Record<string, SubCharmDefinition> = {
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
      notes: { type: "string", description: "Free-form notes" },
    },
    fieldMapping: ["notes", "content"],
  },

  // Data modules - imported from peer patterns
  birthday: fromMetadata(BirthdayMeta, () => BirthdayModule({} as any)),
  rating: fromMetadata(RatingMeta, () => RatingModule({} as any)),
  tags: fromMetadata(TagsMeta, () => TagsModule({} as any)),
  contact: fromMetadata(ContactMeta, () => ContactModule({} as any)),
  status: fromMetadata(StatusMeta, () => StatusModule({} as any)),
  address: fromMetadata(AddressMeta, () => AddressModule({} as any)),
  timeline: fromMetadata(TimelineMeta, () => TimelineModule({} as any)),
  social: fromMetadata(SocialMeta, () => SocialModule({} as any)),
  link: fromMetadata(LinkMeta, () => LinkModule({} as any)),
  location: fromMetadata(LocationMeta, () => LocationModule({} as any)),
  relationship: fromMetadata(
    RelationshipMeta,
    () => RelationshipModule({} as any),
  ),
  giftprefs: fromMetadata(GiftPrefsMeta, () => GiftPrefsModule({} as any)),
  timing: fromMetadata(TimingMeta, () => TimingModule({} as any)),
  "age-category": fromMetadata(
    AgeCategoryMeta,
    () => AgeCategoryModule({} as any),
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
  type: SubCharmType | string,
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
