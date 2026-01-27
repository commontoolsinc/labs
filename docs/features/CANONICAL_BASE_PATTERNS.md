# Canonical Base Patterns Design - person.tsx

**Status:** Ready for Architect Review
**Date:** 2026-01-27 (Updated)
**Author:** Claude (with Alex & Berni)

---

## Executive Summary

Design a set of ~8 canonical base patterns (person, project, task, family, event, etc.) that are:
- **Minimal**: Simple core schema (e.g., `name: string` for Person)
- **Extensible**: Via an `[ANNOTATIONS]` system for arbitrary extensions
- **Pragmatic**: Usable immediately, not a research project
- **Late-bindable**: Sub-patterns (annotations) use `compileAndRun`, not static imports
- **Computed-friendly**: Support speculative/computed annotations, not just explicit ones

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
| **Computed Annotations** | Supported via adapter patterns | Three classes unified for consumers |

---

## Three Classes of Annotations

A key insight from architect review: annotations aren't just explicit user additions. There are three classes that consumers should treat uniformly:

| Class | Description | Example |
|-------|-------------|---------|
| **Built-in** | Original data structures with all fields already | A contact record that already has `dietaryRestrictions: string[]` |
| **Explicit Link** | Base data + annotation sub-pattern linked via `[ANNOTATIONS]` | User adds SSN annotation to a person |
| **Computed** | Pattern computes annotations speculatively (no explicit link yet) | LLM scans emails to infer dietary restrictions for all contacts |

### Why This Matters

Consider a `DietaryRestrictionsScanner` pattern that uses LLM/email-scanning to compute dietary restrictions for all contacts. Another pattern wants to query "persons with their dietary restrictions":

- **With only explicit annotations**: Query fails - computed results aren't in `[ANNOTATIONS]`
- **With computed annotation support**: Query succeeds - adapter merges explicit + computed

### Consumer Transparency

To something consuming this data, there should be **little to no difference** between the three classes. A "person with dietary restrictions" view shouldn't care whether:
- The person record always had a `dietaryRestrictions` field
- A user explicitly added a dietary restrictions annotation
- A pattern computed it from email analysis

### Confirmation Flow

Users should be able to:
1. **Control sources**: Mark a computed source as trusted/untrusted
2. **Confirm annotations**: Confirming a computed annotation adds an explicit `[ANNOTATES]` link (= approval)
3. **Override**: Explicit annotations take precedence over computed ones

### New Symbol: `[ANNOTATION_SOURCE]`

To support provenance tracking:

```typescript
// packages/api/index.ts additions
export const ANNOTATION_SOURCE = "$ANNOTATION_SOURCE";

interface AnnotationSource {
  type: 'explicit' | 'computed' | 'imported';
  pattern?: CellRef;      // Which pattern computed this
  confirmed: boolean;     // User has approved
  confidence?: number;    // For LLM-computed annotations (0-1)
  createdAt: number;
}

interface AnnotationWithSource extends Annotation {
  [ANNOTATION_SOURCE]?: AnnotationSource;
}
```

### Pragmatic Approach

Per architect guidance: "Don't need all of this immediately - build interim patterns that convert, then later optimize with runtime features (backlinks/joins)."

**Phase 1 (Now)**: Adapter patterns that manually merge sources
**Phase 2 (Later)**: Runtime backlink queries via `wish`

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
export const ANNOTATIONS = "$ANNOTATIONS";        // Array of explicit annotations on an entity
export const ANNOTATES = "$ANNOTATES";            // Back-reference from annotation to parent(s)
export const ANNOTATION_SOURCE = "$ANNOTATION_SOURCE";  // Provenance metadata for annotations
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

## Computed Annotations: Adapter Patterns

### The Problem

A `DietaryRestrictionsScanner` pattern computes dietary restrictions for all contacts:

```typescript
// Output: Array of { person: PersonRef, restrictions: string[] }
// These are NOT in each person's [ANNOTATIONS] array
```

How do consumers query "persons with their dietary restrictions"?

### Solution: Adapter Pattern (v1)

Create adapter patterns that merge explicit + computed annotations:

```typescript
/// <cts-enable />
import { pattern, computed, ANNOTATIONS, ANNOTATION_SOURCE } from "commontools";
import type { Person, Annotation } from "./person.tsx";

interface ComputedAnnotationSource {
  sourcePattern: CellRef;
  annotationsForPerson: (person: Person) => Annotation[];
}

interface PersonWithAllAnnotations {
  person: Person;
  annotations: Annotation[];  // Combined: explicit + computed
}

// Adapter that merges explicit + computed annotations
export default pattern<{
  person: Person & { [ANNOTATIONS]?: Annotation[] };
  computedSources?: ComputedAnnotationSource[];
}, { result: PersonWithAllAnnotations }>(
  ({ person, computedSources }) => {
    const annotations = computed(() => {
      // Start with explicit annotations
      const explicit = person[ANNOTATIONS] ?? [];

      // Merge in computed annotations (if sources provided)
      const computed = (computedSources ?? []).flatMap(source => {
        const anns = source.annotationsForPerson(person);
        // Tag computed annotations with source metadata
        return anns.map(ann => ({
          ...ann,
          [ANNOTATION_SOURCE]: {
            type: 'computed' as const,
            pattern: source.sourcePattern,
            confirmed: false,
            createdAt: Date.now(),
          },
        }));
      });

      return [...explicit, ...computed];
    });

    return {
      result: computed(() => ({
        person,
        annotations: annotations.get(),
      })),
    };
  }
);
```

### Solution: Runtime Backlinks (v2 - Future)

Once the runtime supports backlink queries:

```typescript
// Query all annotations that [ANNOTATES] this person
const computedAnnotations = wish({
  query: "#backlinks",
  target: person,
  schema: {
    type: "object",
    properties: {
      [ANNOTATES]: { contains: { $ref: person } },
      type: { const: "dietary-restrictions" }
    }
  }
});
```

### Confirmation Handler

When a user confirms a computed annotation:

```typescript
const confirmAnnotation = handler<{ annotation: Annotation }>(
  async (event, { person }) => {
    const ann = event.annotation;

    // 1. Add explicit [ANNOTATES] link
    ann[ANNOTATES] = [...(ann[ANNOTATES] ?? []), person];

    // 2. Add to person's [ANNOTATIONS] array
    person[ANNOTATIONS] = [...(person[ANNOTATIONS] ?? []), ann];

    // 3. Mark as confirmed
    ann[ANNOTATION_SOURCE] = {
      ...ann[ANNOTATION_SOURCE],
      confirmed: true,
      type: 'explicit',
    };
  }
);
```

---

## Projection Pattern: person-with-hobbies.tsx

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
| `packages/api/index.ts` | Add `ANNOTATIONS`, `ANNOTATES`, `ANNOTATION_SOURCE` symbols |
| `packages/patterns/base/person.tsx` | New canonical person pattern |
| `packages/patterns/base/person-with-annotations.tsx` | Adapter pattern merging explicit + computed |
| `packages/patterns/annotations/` | New directory for annotation patterns |
| `packages/patterns/annotations/person/index.md` | Annotation discovery index |

---

## Implementation Phases

### Phase 1: Core Infrastructure
- [ ] Define `ANNOTATIONS`, `ANNOTATES`, `ANNOTATION_SOURCE` symbols in `packages/api/index.ts`
- [ ] Export from "commontools" entrypoint
- [ ] Create annotation type interfaces (including `AnnotationSource`)

### Phase 2: person.tsx
- [ ] Create `packages/patterns/base/person.tsx` with minimal schema
- [ ] Implement annotation rendering (iterate `[ANNOTATIONS]`, render each with compileAndRun)
- [ ] Create AddAnnotationDropdown component (reads index, triggers compileAndRun)

### Phase 3: Example Annotations
- [ ] `ssn.tsx` - Simple single-field annotation
- [ ] `address.tsx` - Multi-field annotation
- [ ] `hobbies.tsx` - Array-based annotation

### Phase 4: Computed Annotation Support
- [ ] `person-with-annotations.tsx` adapter pattern (merges explicit + computed)
- [ ] Confirmation handler for promoting computed -> explicit
- [ ] Example computed annotation source (e.g., dietary restrictions scanner)

### Phase 5: Projections & Views
- [ ] `person-with-hobbies.tsx` example
- [ ] Document projection pattern for others

### Phase 6: Additional Base Types
- [ ] Implement remaining ~7 base types following person.tsx idiom

### Phase 7 (Future): Runtime Optimizations
- [ ] Backlink index for `[ANNOTATES]` links
- [ ] `wish` support for backlink queries
- [ ] Automatic annotation merging in runtime (remove need for adapter patterns)

---

## Verification Plan

### Explicit Annotations
1. **Unit test person.tsx**: Create person, add annotations, verify rendering
2. **Test compileAndRun integration**: Add SSN annotation dynamically, verify it compiles and renders
3. **Test queries**: Create multiple persons, query by `baseType: "person"`, verify all returned

### Computed Annotations
4. **Test adapter pattern**: Create person + computed source, verify merged annotations
5. **Test confirmation flow**: Confirm a computed annotation, verify it becomes explicit
6. **Test provenance**: Verify `[ANNOTATION_SOURCE]` metadata is preserved and queryable

### Projections
7. **Test projection**: Create person with hobbies annotation, use person-with-hobbies.tsx, verify hobbies materialized

### Integration
8. **Manual test**: Deploy to local toolshed, create person via UI, add annotations interactively
9. **Computed source test**: Run dietary restrictions scanner, verify results appear in person-with-annotations adapter

---

## Questions for Architect (Berni)

### Previously Discussed (Incorporated)

1. ~~**Annotation storage**: Should annotations be stored inline or as separate cells?~~
   - **Answer**: Support both explicit (inline) AND computed (separate cells). Adapter patterns merge them.

2. ~~**Computed annotations**: How do we handle speculative/computed annotations?~~
   - **Answer**: Three classes (built-in, explicit, computed) unified via adapter patterns now, runtime backlinks later.

### Still Open

1. **Symbol naming**: Is `$ANNOTATIONS` / `$ANNOTATES` / `$ANNOTATION_SOURCE` the right convention? Or should these be true Symbols like `SELF`?

2. **Discovery mechanism**: Static index.md vs. dynamic registry query - is static sufficient for v1?

3. **Schema description timeline**: When should we prioritize migrating from `baseType` field to schema `description` for type identity?

4. **compileAndRun caching**: Are compiled annotation patterns cached appropriately, or do we need additional caching layer?

5. **Backlink query priority**: When should we invest in runtime backlink queries (`wish` with `#backlinks`) to replace adapter patterns?

6. **Confidence thresholds**: For computed annotations with confidence scores, should there be a system-wide threshold for display, or per-source configuration?

---

## Appendix: Research Sources

- **Whiteboard photo**: `~/Downloads/IMG_9072.HEIC` (2026-01-26 meeting)
- **Meeting transcript**: Inline in conversation (2026-01-26, 16:12 PST)
- **Record PRD**: `labs-2` branch `prd/record-functionality:docs/features/RECORD_PRD.md`
- **compileAndRun source**: `packages/runner/src/builtins/compile-and-run.ts`
- **Current symbols**: `packages/api/index.ts`, `packages/runner/src/builder/types.ts`
- **Tags pattern**: `packages/patterns/tags.tsx`
- **Contact pattern**: `packages/patterns/contacts/contact-detail.tsx`
