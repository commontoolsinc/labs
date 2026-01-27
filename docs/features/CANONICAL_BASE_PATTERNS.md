# Canonical Base Patterns Design - person.tsx

**Status:** Ready for Architect Review
**Date:** 2026-01-26
**Author:** Claude (with Alex & Berni)

---

## Executive Summary

Design a set of ~8 canonical base patterns (person, project, task, family, event, etc.) that are:
- **Minimal**: Simple core schema (e.g., `name: string` for Person)
- **Extensible**: Via an `[ANNOTATIONS]` system for arbitrary extensions
- **Pragmatic**: Usable immediately, not a research project
- **Late-bindable**: Sub-patterns (annotations) use `compileAndRun`, not static imports

This replaces the heavyweight "record.tsx" approach with something simpler and more composable.

---

## Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Tags** | Regular `.tags: string[]` field | Simple, works with existing `<ct-tags>` component |
| **Type Identity (now)** | `baseType: "person"` field | Works with existing wish/schema queries |
| **Type Identity (future)** | Schema `description` field | More idiomatic, architect-preferred |
| **Annotation Discovery** | Static index file | Lists annotation patterns per base type |
| **record.tsx Relationship** | person.tsx replaces it | Simpler, more pragmatic approach |
| **Annotation Storage** | Cells with `[UI]` (optionally `[NAME]`) | `[NAME]` = mentionable/navigable; `[UI]` only = renderable |

---

## Architecture Overview

### Core Concept: Entity + Annotations

```
┌─────────────────────────────────────────────────────────────┐
│                        Person                                │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ baseType: "person"                                      ││
│  │ name: "John Smith"                                      ││
│  │ notes: ["Met at conference..."]                         ││
│  │ tags: ["professional", "tech"]                          ││
│  └─────────────────────────────────────────────────────────┘│
│                                                              │
│  [ANNOTATIONS]: [                                            │
│    ┌───────────────────┐  ┌───────────────────┐             │
│    │ SSN Annotation    │  │ Address Annotation│             │
│    │ type: "ssn"       │  │ type: "address"   │             │
│    │ ssn: "***-**-1234"│  │ street: "123 Main"│             │
│    │ [ANNOTATES]: [^]  │  │ [ANNOTATES]: [^]  │             │
│    └───────────────────┘  └───────────────────┘             │
│  ]                                                           │
└─────────────────────────────────────────────────────────────┘
```

Key properties:
- **Annotations can have multiple parents** (e.g., shared address for family)
- **Late-bound via compileAndRun** (not compiled into base pattern)
- **Discovery via static index** (lists available annotations per base type)

### New Symbols

```typescript
// packages/api/index.ts additions
export const ANNOTATIONS = "$ANNOTATIONS";  // Array of annotations on an entity
export const ANNOTATES = "$ANNOTATES";      // Back-reference from annotation to parent(s)
```

---

## person.tsx - Reference Implementation

```typescript
/// <cts-enable />
import {
  pattern, NAME, UI, Writable, Default, computed, handler, VNode
} from "commontools";

// Base type marker for queries (v1: explicit field, v2: schema description)
export const PERSON_BASE_TYPE = "person" as const;

export interface Person {
  baseType: typeof PERSON_BASE_TYPE;
  name: string;
  notes: Default<string[], [""]>;  // Always at least one note slot
  tags: Default<string[], []>;
}

export interface Annotation {
  type: string;           // e.g., "ssn", "address", "hobbies"
  [ANNOTATES]: unknown[]; // Back-reference to parent entity(ies)
  // ... annotation-specific fields handled by annotation pattern
}

interface Input {
  person?: Writable<Person>;
}

interface Output {
  [NAME]: string;
  [UI]: VNode;
  person: Person;
  annotations: Annotation[];
  addAnnotation: Stream<{ type: string; source: string }>;
}

export default pattern<Input, Output>(({ person }) => {
  // Initialize defaults
  const data = person ?? {
    baseType: PERSON_BASE_TYPE,
    name: "",
    notes: [""],
    tags: [],
  };

  const annotations = Writable.of<Annotation[]>([]);

  // Add annotation via compileAndRun (late-binding)
  const addAnnotation = handler<{ type: string; source: string }>(
    async (event, { annotations }) => {
      // Fetch and compile annotation pattern dynamically
      const result = await compileAndRun({
        files: [{ path: event.source, content: await fetch(event.source).then(r => r.text()) }],
        main: event.type,
        input: { [ANNOTATES]: [person] },
      });
      if (result.result) {
        annotations.push(result.result);
      }
    },
  );

  return {
    [NAME]: computed(() => `👤 ${data.name || "Person"}`),
    [UI]: (
      <ct-screen>
        <ct-vstack gap="md">
          {/* Core fields */}
          <ct-input $value={data.key("name")} placeholder="Name" />
          <ct-text-area $value={data.key("notes").key(0)} placeholder="Notes..." />
          <ct-tags tags={data.key("tags")} />

          {/* Annotations rendered dynamically */}
          <ct-divider />
          <ct-text variant="label">Annotations</ct-text>
          {annotations.map(ann => (
            <AnnotationRenderer annotation={ann} />
          ))}

          {/* Add annotation dropdown */}
          <AddAnnotationDropdown
            baseType={PERSON_BASE_TYPE}
            onAdd={addAnnotation}
          />
        </ct-vstack>
      </ct-screen>
    ),
    person: data,
    annotations,
    addAnnotation,
  };
});
```

---

## Annotation Pattern Example: ssn.tsx

```typescript
/// <cts-enable />
import { recipe, NAME, UI, ANNOTATES, computed, Default } from "commontools";

export interface SSNData {
  [ANNOTATES]: unknown[];  // The person(s) this SSN belongs to
  ssn: Default<string, "">;
}

// Metadata for discovery and UI
export const MODULE_METADATA = {
  type: "ssn",
  label: "Social Security Number",
  icon: "🔢",
  baseTypes: ["person"],  // Applicable to person base type
  schema: {
    ssn: { type: "string", pattern: "^\\d{3}-\\d{2}-\\d{4}$" },
  },
};

export default recipe<SSNData, SSNData>("SSN", ({ ssn, [ANNOTATES]: annotates }) => ({
  [NAME]: computed(() => `🔢 SSN: ${ssn ? "***-**-" + ssn.slice(-4) : "Not set"}`),
  [UI]: (
    <ct-vstack gap="sm">
      <ct-input
        $value={ssn}
        placeholder="123-45-6789"
        type="password"
        pattern="\\d{3}-\\d{2}-\\d{4}"
      />
    </ct-vstack>
  ),
  ssn,
  [ANNOTATES]: annotates,
}));
```

---

## Annotation Discovery: annotations/person/index.md

```markdown
# Person Annotations

Available annotation patterns for the `person` base type:

| Type | Label | Source | Description |
|------|-------|--------|-------------|
| ssn | Social Security Number | ./ssn.tsx | US SSN (masked display) |
| address | Address | ./address.tsx | Physical address with street, city, state, zip |
| phone | Phone Number | ./phone.tsx | Phone with type label (mobile, work, etc.) |
| email | Email | ./email.tsx | Email address with type label |
| birthday | Birthday | ./birthday.tsx | Birth date |
| hobbies | Hobbies & Interests | ./hobbies.tsx | Array of hobby strings |
| relationship | Relationship | ./relationship.tsx | Connection to another person |
```

---

## Computed Projection Pattern: person-with-hobbies.tsx

For patterns that need specific annotation data materialized as fields:

```typescript
/// <cts-enable />
import { pattern, computed, ANNOTATIONS } from "commontools";
import type { Person, Annotation } from "./person.tsx";

export interface PersonWithHobbies {
  name: string;
  hobbies: string[];  // Materialized from annotations
}

// Takes a Person, scans annotations, produces flat projection
export default pattern<{ person: Person & { [ANNOTATIONS]: Annotation[] } }, { result: PersonWithHobbies }>(
  ({ person }) => {
    const hobbies = computed(() => {
      const anns = person[ANNOTATIONS] ?? [];
      return anns
        .filter(a => a.type === "hobbies" || a.type === "interests")
        .flatMap(a => (a as any).hobbies ?? (a as any).interests ?? []);
    });

    return {
      result: computed(() => ({
        name: person.name,
        hobbies: hobbies.get(),
      })),
    };
  }
);
```

**Future**: `AnnotatedPerson<T>` where T describes desired schema, with CTS generating the bridge code.

---

## Type Identity Evolution

### Phase 1 (Now): `baseType` Field

```typescript
interface Person {
  baseType: "person";  // Explicit marker
  name: string;
  // ...
}

// Query all persons
wish({
  query: "#allCharms",
  schema: { properties: { baseType: { const: "person" } } }
});
```

### Phase 2 (Future): Schema `description`

```typescript
// Schema-level identity (more idiomatic)
const personSchema = {
  type: "object",
  description: "common:person/v1",  // Namespaced type identifier
  properties: {
    name: { type: "string" },
    // ... no baseType field needed
  },
} as const satisfies JSONSchema;

// Query via schema description (requires new infrastructure)
runtime.queryBySchemaDescription("common:person/v1");
```

---

## Proposed Base Types (~8)

| Type | Key Fields | Notes |
|------|------------|-------|
| **person.tsx** | `name` | Individual humans |
| **project.tsx** | `title`, `status` | Work initiatives |
| **task.tsx** | `title`, `done` | Actionable items |
| **event.tsx** | `title`, `date`, `location` | Calendar events |
| **family.tsx** | `name`, `members` | Family units (members are person refs) |
| **place.tsx** | `name`, `address`, `coordinates` | Locations |
| **organization.tsx** | `name` | Companies, groups |
| **document.tsx** | `title`, `content` | Content containers |

All share:
- `baseType: string` (for queries)
- `notes: string[]` (always length >= 1)
- `tags: string[]` (optional)
- `[ANNOTATIONS]: Annotation[]` (optional)

---

## Critical Files to Modify

| File | Change |
|------|--------|
| `packages/api/index.ts` | Add `ANNOTATIONS`, `ANNOTATES` symbols |
| `packages/patterns/base/person.tsx` | New canonical person pattern |
| `packages/patterns/annotations/` | New directory for annotation patterns |
| `packages/patterns/annotations/person/index.md` | Annotation discovery index |

---

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Define `ANNOTATIONS` and `ANNOTATES` symbols in `packages/api/index.ts`
- [ ] Export from "commontools" entrypoint
- [ ] Create annotation type interfaces

### Phase 2: person.tsx
- [ ] Create `packages/patterns/base/person.tsx` with minimal schema
- [ ] Implement annotation rendering (iterate `[ANNOTATIONS]`, render each with compileAndRun)
- [ ] Create AddAnnotationDropdown component (reads index, triggers compileAndRun)

### Phase 3: Example Annotations
- [ ] `ssn.tsx` - Simple single-field annotation
- [ ] `address.tsx` - Multi-field annotation
- [ ] `hobbies.tsx` - Array-based annotation

### Phase 4: Computed Projections
- [ ] `person-with-hobbies.tsx` example
- [ ] Document projection pattern for others

### Phase 5: Additional Base Types
- [ ] Implement remaining ~7 base types following person.tsx idiom

---

## Verification Plan

1. **Unit test person.tsx**: Create person, add annotations, verify rendering
2. **Test compileAndRun integration**: Add SSN annotation dynamically, verify it compiles and renders
3. **Test queries**: Create multiple persons, query by `baseType: "person"`, verify all returned
4. **Test projection**: Create person with hobbies annotation, use person-with-hobbies.tsx, verify hobbies materialized
5. **Manual test**: Deploy to local toolshed, create person via UI, add annotations interactively

---

## Questions for Architect (Berni)

1. **Symbol naming**: Is `$ANNOTATIONS` / `$ANNOTATES` the right convention? Or should these be true Symbols like `SELF`?

2. **Annotation storage**: Should annotations be stored inline in the parent's `[ANNOTATIONS]` array, or as separate cells with `[ANNOTATES]` pointing back? (Affects whether they appear in sidebar/mentions.)

3. **Discovery mechanism**: Static index.md vs. dynamic registry query - is static sufficient for v1?

4. **Schema description timeline**: When should we prioritize migrating from `baseType` field to schema `description` for type identity?

5. **compileAndRun caching**: Are compiled annotation patterns cached appropriately, or do we need additional caching layer?

---

## Appendix: Research Sources

- **Whiteboard photo**: `~/Downloads/IMG_9072.HEIC` (2026-01-26 meeting)
- **Meeting transcript**: Inline in conversation (2026-01-26, 16:12 PST)
- **Record PRD**: `labs-2` branch `prd/record-functionality:docs/features/RECORD_PRD.md`
- **compileAndRun source**: `packages/runner/src/builtins/compile-and-run.ts`
- **Current symbols**: `packages/api/index.ts`, `packages/runner/src/builder/types.ts`
- **Tags pattern**: `packages/patterns/tags.tsx`
- **Contact pattern**: `packages/patterns/contacts/contact-detail.tsx`
