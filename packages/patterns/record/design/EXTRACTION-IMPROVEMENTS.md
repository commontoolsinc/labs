# AI Extraction Module Improvements

## Status: Complete

This document captures planned improvements to the AI extraction module
(`extraction/extractor-module.tsx`) based on analysis of community patterns and
best practices.

---

## Summary

| Improvement              | Complexity | Impact | Priority | Status     |
| ------------------------ | ---------- | ------ | -------- | ---------- |
| Prompt Improvements      | S          | High   | 1        | ✅ Done    |
| Validation Improvements  | M          | High   | 2        | ✅ Done    |
| Confidence Scoring       | M          | High   | 3        | ✅ Done    |
| Per-Source Extraction    | M          | Medium | 4        | ⚠️ Revised |
| Schema Selection Pattern | M          | Medium | 5        | ✅ Done    |

---

## 1. Prompt Improvements

**Complexity:** Small (15-30 min) **Impact:** High - improves extraction
accuracy immediately

### Problem

Current prompts lack:

- Field-specific pattern examples
- Explicit stopping rules
- Example input/output
- Guidance on field aliases and normalization

### Solution

Enhance `EXTRACTION_SYSTEM_PROMPT` with:

```typescript
const EXTRACTION_SYSTEM_PROMPT = `You are a precise data extractor...

=== FIELD EXTRACTION PATTERNS ===

EMAIL (field: "address"):
- Patterns: user@domain.com, name+tag@company.org
- Example: "reach me at john.doe@acme.com" -> "john.doe@acme.com"

PHONE (field: "number"):
- PRESERVE original formatting exactly
- Example: "Cell: (415) 555-1234" -> "(415) 555-1234"

BIRTHDAY (fields: "birthMonth", "birthDay", "birthYear"):
- Extract as SEPARATE components, not combined date
- Example: "March 15, 1990" -> birthMonth: "3", birthDay: "15", birthYear: "1990"

ADDRESS (fields: "street", "city", "state", "zip"):
- state: Use 2-letter abbreviation (CA, NY, TX)
- Example: "123 Main St, San Francisco, CA 94102"

SOCIAL MEDIA (fields: "platform", "handle"):
- platform: Normalize to lowercase (twitter, linkedin, github)
- handle: WITHOUT the @ prefix

=== STOPPING RULES ===
1. Extract ONLY fields in the schema
2. Return null for fields without data
3. Do NOT infer or fabricate data
`;
```

### Files to Modify

- `extraction/extractor-module.tsx` lines 94-106 (EXTRACTION_SYSTEM_PROMPT)
- `extraction/extractor-module.tsx` lines 114-139 (NOTES_CLEANUP_SYSTEM_PROMPT -
  minor)

---

## 2. Validation Improvements

**Complexity:** Medium (~430 lines) **Impact:** High - catches bugs before apply

### Problem

Current validation:

- Binary pass/fail only
- No handling for LLM returning string `"null"` instead of actual `null`
- No duplicate detection
- No format validation
- Silent failures (only console.warn)

### Solution

#### New ValidationResult Interface

```typescript
interface ValidationIssue {
  code: string; // "TYPE_MISMATCH", "STRING_NULL", "DUPLICATE"
  message: string;
  severity: "error" | "warning" | "info";
  suggestion?: string;
}

interface FieldValidationResult {
  valid: boolean;
  transformed: boolean; // true if value was sanitized
  sanitizedValue: unknown;
  issues: ValidationIssue[];
}

interface ExtractionValidationResult {
  canApply: boolean; // false if any errors
  errorCount: number;
  warningCount: number;
  fieldResults: Record<string, FieldValidationResult>;
  globalIssues: ValidationIssue[]; // e.g., duplicates
}
```

#### Key Validations

1. **String "null" handling**: Convert `"null"` string to actual `null`
2. **Duplicate detection**: Warn if extracting duplicate email/phone
3. **Format validation**: Check email format, URL format, date format
4. **Type checking**: Enhanced with suggestions

#### UI Changes

- Show validation summary before field list
- Per-field validation indicators (green/yellow/red)
- Disable Apply button when errors exist
- Show warnings (non-blocking) distinctly from errors (blocking)

### Files to Modify/Create

- `extraction/types.ts` - Add ValidationResult interfaces
- `extraction/validation.ts` (NEW) - Pure validation functions
- `extraction/extractor-module.tsx` - Integrate validation, add UI

---

## 3. Confidence Scoring

**Complexity:** Medium (4-6 hours) **Impact:** High - user trust and quality
filtering

### Problem

Users have no visibility into extraction quality. Low-confidence extractions
look the same as high-confidence ones.

### Solution

#### Schema Changes

```typescript
interface ExtractedField {
  fieldName: string;
  targetModule: string;
  extractedValue: unknown;
  currentValue?: unknown;
  confidence: number; // NEW: 0-1 score
  confidenceLevel: "high" | "medium" | "low";
  confidenceReason?: string; // NEW: LLM explanation
}
```

#### LLM Schema Wrapping

Instead of `{ email: { type: "string" } }`, use:

```typescript
{
  email: {
    type: "object",
    properties: {
      value: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string" }
    }
  }
}
```

#### UI Components

- Confidence badges: High (green checkmark), Medium (yellow dot), Low (red
  warning)
- Filter buttons: All | High | Medium | Review
- Auto-deselect low-confidence fields by default
- Show reason tooltip on hover

### Files to Modify

- `extraction/types.ts` - Add ConfidenceLevel, update ExtractedField
- `extraction/schema-utils.ts` - Add wrapSchemaWithConfidence()
- `extraction/extractor-module.tsx` - Prompt, buildPreview, UI

---

## 4. Per-Source Extraction

**Complexity:** Medium (6-7 hours) **Impact:** Medium - performance and caching
**Status:** Revised - using combined extraction instead

### Original Problem

Current approach combines all sources into single LLM call. Changing one source
re-extracts everything. No per-source caching.

### Attempted Solution

Use "dumb map approach" from folk wisdom - one `generateObject()` per source:

```typescript
// Attempted: Per-source calls with .map()
const sourceExtractions = selectedSources.map((source) => ({
  sourceIndex: source.index,
  sourceType: source.type,
  extraction: generateObject({
    prompt: computed(() => source.content), // Per-source prompt
    schema,
    model,
  }),
}));
```

### Why It Didn't Work

Creating `computed()` inside `.map()` callbacks caused infinite reactive loops.
The issue was specific to this case because:

1. `selectedSourcesForExtraction` depends on `extractPhase` (volatile state)
2. When `generateObject()` completes, state changes propagate back
3. This triggers re-evaluation of the `.map()`, creating new computed nodes
4. New nodes invalidate subscriptions, causing another evaluation loop

**Note:** OCR in the same file successfully uses `.map()` + `computed()` because
`photoSources` is stable (photos don't change during extraction flow).

See:
`community-docs/superstitions/2026-01-08-computed-inside-map-callback-infinite-loop.md`

### Current Implementation: Combined Extraction

Instead of per-source extraction, we use a single combined prompt:

```typescript
// Build single prompt from all sources
const combinedExtractionPrompt = computed(() => {
  const promptParts: string[] = [];
  for (const source of selectedSources) {
    if (source.type === "photo") {
      promptParts.push(
        `--- ${source.label} (OCR) ---\n${ocrResults[source.index]}`,
      );
    } else {
      promptParts.push(`--- ${source.label} ---\n${source.content}`);
    }
  }
  return promptParts.join("\n\n");
});

// Single extraction call
const singleExtraction = generateObject({
  prompt: combinedExtractionPrompt,
  schema: RECOMMENDATIONS_SCHEMA,
  model: "anthropic:claude-haiku-4-5",
});
```

### Trade-offs

**Lost benefits:**

- No per-source caching (changing one source re-extracts all)
- No incremental progress (can't see each source complete)

**Gained benefits:**

- Works reliably (no infinite loops)
- Simpler code
- Single LLM call is often faster than multiple small calls
- LLM can cross-reference data between sources in combined context

### Files Modified

- `extraction/types.ts` - Added SourceExtraction interface (still used for
  status)
- `extraction/extractor-module.tsx` - Uses combined extraction with synthetic
  per-source array for UI compatibility

---

## 5. Schema Selection Pattern

**Complexity:** Medium (12-17 hours) **Impact:** Medium - better UX, follows
framework philosophy

### Problem

Current "mega-schema" approach:

- Combines all module types into one huge schema
- No explanation of WHY fields were extracted
- All-or-nothing acceptance
- Field collision between similar module types

### Solution

Replace combined schema with recommendations array:

```typescript
interface ExtractionRecommendation {
  type: string; // "email", "birthday", "phone"
  score: number; // 0-100 confidence
  explanation: string; // "Found email format in signature"
  extractedData: Record<string, unknown>;
  sourceExcerpt?: string; // "Contact: john@example.com"
}

// LLM returns
{
  recommendations: [
    {
      type: "email",
      score: 95,
      explanation: "Explicit email address found",
      extractedData: { address: "john@example.com" },
    },
    {
      type: "birthday",
      score: 60,
      explanation: "Date found but unclear if birthday",
      extractedData: { birthMonth: "3", birthDay: "15" },
    },
  ];
}
```

#### UI Preview

```
+--------------------------------------------------+
| [x] 📧 Email                     95% confidence  |
|     "Found email format in signature"            |
|     address: john@example.com                    |
+--------------------------------------------------+
| [x] 📱 Phone                     88% confidence  |
|     "Phone in standard US format"                |
|     number: (415) 555-1234                       |
+--------------------------------------------------+
| [ ] 🎂 Birthday                  45% confidence  |
|     "Date found but may not be birthday"         |
|     ⚠ Low confidence - review before accepting  |
+--------------------------------------------------+
| Auto-accept threshold: [====70%======]           |
+--------------------------------------------------+
```

#### Benefits

- Users see WHY each field was extracted
- Sorted by confidence (high first)
- Low-confidence auto-deselected
- Individual accept/reject per recommendation
- Follows "data-up" philosophy (framework author recommendation)

### Migration Path

1. Add recommendations mode behind feature flag
2. Test in parallel with existing approach
3. Make default after validation
4. Remove old combined schema code

### Files to Modify

- `extraction/types.ts` - Add ExtractionRecommendation interface
- `extraction/schema-utils.ts` - Add buildRecommendationsSchema()
- `extraction/extractor-module.tsx` - New prompt, UI, apply logic

---

## Implementation Order Rationale

1. **Prompts first**: Quick win, immediate accuracy improvement, no structural
   changes
2. **Validation second**: Catches bugs like string "null", improves reliability
3. **Confidence third**: Builds on validation, gives users quality visibility
4. **Per-source fourth**: Performance improvement, leverages framework caching
5. **Schema selection last**: Largest change, best UX but requires most testing

---

## References

- `community-docs/superstitions/2025-12-18-llm-extraction-schema-selection-not-combined.md`
  (community-patterns repo)
- `community-docs/superstitions/2025-11-29-llm-generateObject-returns-string-null.md`
  (community-patterns repo)
- `community-docs/folk_wisdom/llm.md` (community-patterns repo)
- `patterns/jkomoros/hotel-membership-gmail-agent.tsx` (community-patterns repo)

---

## Changelog

- 2026-01-08: Per-source extraction revised - changed to combined extraction due
  to infinite loop issues with `.map()` + `computed()`. Documented trade-offs.
- 2026-01-08: All improvements completed - per-source extraction and schema
  selection pattern with confidence scoring implemented
- 2026-01-08: v2 improvements completed (prompts, validation, error messages,
  progress feedback, helper refactoring)
- 2026-01-06: Initial document created from research and sub-agent planning
