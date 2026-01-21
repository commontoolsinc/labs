# User Profile System Plan

## Executive Summary

Build a user profile system that learns about users through their actions and
direct questions, enabling personalized wish fulfillment and suggestions.

## Key Decisions (Resolved)

1. **Narrative generation**: Use `llmDialog()` with manual `addMessage.send()`
2. **Question presentation**: Dedicated pattern for asking profile questions
3. **Profile architecture**: Combine ProfileLearned with profile.tsx (single
   unified profile)
4. **Journal fix approach**: Modify home.tsx handlers (with nuance - see
   Phase 1)

## Current State Analysis

### Existing profile.tsx

- **Location**: `packages/patterns/profile.tsx`
- **Purpose**: Structured data store for personal information
- **Contents**: People (self, partner, children, parents, in-laws), addresses,
  vehicles, memberships, banks, employment
- **Discovery**: `wish<ProfileOutput>({ query: "#profile" })`
- **Limitation**: Only stores structured data entered manually; no learning from
  user behavior

### Journal System (BROKEN)

- **Location**: `packages/charm/src/journal.ts`
- **Purpose**: Records user events with LLM-generated narratives
- **Schema**: timestamp, eventType, subject (cell ref), snapshot, narrative,
  tags, space

**THE BUG**: Journal entries are never written during favorite/unfavorite
operations:

1. `FavoriteButton` (shell component) calls
   `runtime.favorites().addFavorite(charmId)`
2. `FavoritesManager` (runtime-client) calls the `addFavorite` handler on
   `home.tsx`
3. `home.tsx` handler only pushes to favorites array - **no journal call**
4. The journal logic in `packages/charm/src/favorites.ts` is never invoked

The charm package's `favorites.ts` has proper journal integration, but it's not
used by the shell.

### Home Pattern

- **Location**: `packages/patterns/system/home.tsx`
- **Owns**: `favorites` and `journal` cells
- **Handlers**: `addFavorite`, `removeFavorite`, `addJournalEntry`
- **Problem**: Handlers don't compose - addFavorite doesn't call addJournalEntry

---

## Phase 1: Fix Journal Integration

### The Nuance

Pattern handlers in home.tsx are **synchronous**. The existing journal.ts in the
charm package uses async/await for LLM narrative generation, which won't work
directly in pattern handlers.

**Solution**: Use a two-phase approach:

1. Handler adds journal entry immediately (with empty narrative)
2. A reactive computation (`generateText`) watches for entries needing
   narratives
3. When generation completes, update the entry with the narrative

### 1.1 Modify home.tsx addFavorite handler

Add journal entry creation to the existing handler:

```tsx
// Handler to add a favorite - synchronous
const addFavorite = handler<
  { charm: Writable<{ [NAME]?: string }>; tag?: string; spaceName?: string },
  { favorites: Writable<Favorite[]>; journal: Writable<JournalEntry[]> }
>(({ charm, tag, spaceName }, { favorites, journal }) => {
  const current = favorites.get();
  if (!current.some((f) => equals(f.cell, charm))) {
    // ... existing logic to add favorite ...

    // Add journal entry synchronously (narrative will be filled reactively)
    const snapshot = captureSnapshot(charm);
    journal.push({
      timestamp: Date.now(),
      eventType: "charm:favorited",
      subject: charm,
      snapshot,
      narrative: "", // Empty - will be filled by reactive enrichment
      narrativePending: true, // Flag for enrichment
      tags: extractTags(snapshot.schemaTag),
      space: spaceName || "",
    });
  }
});
```

### 1.2 Add reactive narrative enrichment

Use `llmDialog()` to generate narratives for entries that need them:

```tsx
// In home.tsx pattern body
const narrativeDialog = llmDialog({
  system: "Generate brief journal narratives...",
  messages: narrativeMessages,
  model: "anthropic:claude-sonnet-4-5",
});

// Watch for entries needing narratives
const pendingEntries = computed(() =>
  journal.get().filter((e) => e.narrativePending)
);

// When we have pending entries, send a message to generate narrative
// This is reactive - triggers when pendingEntries changes
const narrativeRequest = computed(() => {
  const entries = pendingEntries.get();
  if (entries.length === 0) return null;
  const entry = entries[0]; // Process one at a time
  return {
    entryTimestamp: entry.timestamp,
    prompt:
      `Generate narrative for: ${entry.eventType} - ${entry.snapshot?.name}`,
  };
});

// Handler to process narrative responses
const processNarrative = handler((response, { journal }) => {
  // Update the journal entry with the generated narrative
  // Clear the narrativePending flag
});
```

**Alternative simpler approach**: Use `generateText` directly:

```tsx
// Simpler reactive approach
const pendingEntry = computed(() =>
  journal.get().find((e) => e.narrativePending)
);

const narrativeGen = generateText({
  prompt: computed(() =>
    pendingEntry ? `Generate narrative for: ${pendingEntry.eventType}...` : ""
  ),
  system: "Generate brief journal narratives...",
});

// Watch for completed narratives and update entries
// (This needs a mechanism to write back - may need effect/handler)
```

**DECISION**: Use `generateText` with idempotent `computed()` for writeback.

### Key Pattern: Idempotent Writeback

From `/docs/common/concepts/computed/side-effects.md`, we can use `computed()`
with side effects IF they are idempotent (check-before-write):

```tsx
// Watch for pending entries and generate narrative
const pendingEntry = computed(() =>
  journal.get().find((e) => e.narrativePending && !e.narrative)
);

const narrativeGen = generateText({
  prompt: computed(() => {
    const entry = pendingEntry.get();
    if (!entry) return ""; // No-op when nothing pending
    return `Generate a brief journal narrative for: ${entry.eventType}
      Item: ${entry.snapshot?.name}
      Content: ${entry.snapshot?.valueExcerpt?.slice(0, 100)}`;
  }),
  system: "Write brief, personal journal entries about user actions.",
  model: "anthropic:claude-sonnet-4-5",
});

// Idempotent writeback - update entry when narrative is ready
const writeNarrative = computed(() => {
  const result = narrativeGen.result;
  const pending = narrativeGen.pending;
  const entry = pendingEntry.get();

  // Guard: only proceed when we have a result and entry
  if (pending || !result || !entry) return null;

  // Idempotent check: already written?
  if (entry.narrative !== "") return null;

  // Find and update the entry in the array
  const entries = journal.get();
  const idx = entries.findIndex((e) => e.timestamp === entry.timestamp);
  if (idx === -1) return null;

  // Create updated entry
  const updatedEntry = {
    ...entries[idx],
    narrative: result,
    narrativePending: false,
  };

  // Replace in array and set
  const newEntries = [...entries];
  newEntries[idx] = updatedEntry;
  journal.set(newEntries);

  return result; // Return for debugging/logging
});
```

**Important**: The check `entry.narrative !== ""` makes this idempotent. The
scheduler may re-run this computed multiple times, but after the first write,
subsequent runs will see the non-empty narrative and skip.

### 1.3 Update JournalEntry schema

Add `narrativePending` flag to track entries needing narrative generation:

```tsx
// packages/home-schemas/journal.ts
type JournalEntry = {
  timestamp: number;
  eventType: JournalEventType;
  subject: Cell<unknown>;
  snapshot: JournalSnapshot;
  narrative: string;
  narrativePending?: boolean; // NEW: true when narrative needs generation
  tags: string[];
  space: string;
};
```

**Files to modify**:

- `packages/patterns/system/home.tsx` - Add journal calls + narrative enrichment
- `packages/home-schemas/journal.ts` - Add narrativePending field

### 1.4 Helper functions

Need to port or import from charm package:

```tsx
// captureSnapshot - extract NAME, schema, value excerpt from cell
function captureSnapshot(cell: Writable<unknown>): JournalSnapshot {
  // Similar to packages/charm/src/journal.ts:captureSnapshot
  // But works with pattern-level cells
}

// extractTags - pull hashtags from schema string
function extractTags(schemaTag: string): string[] {
  const tags: string[] = [];
  const hashtagMatches = schemaTag.match(/#([a-z0-9-]+)/gi);
  if (hashtagMatches) {
    tags.push(...hashtagMatches.map((t) => t.toLowerCase()));
  }
  return tags;
}
```

**Option**: Could these be shared from a common module? Or just duplicate the
simple logic in home.tsx.

---

## Phase 2: Unified Profile with Learning

### 2.1 Extend profile.tsx with learned data

Instead of a separate ProfileLearned, extend the existing profile.tsx to include
learned/inferred data alongside structured data:

```tsx
// Add to packages/patterns/profile.tsx

// NEW: Learned/inferred data (alongside existing structured data)
interface LearnedSection {
  facts: Fact[]; // "User likes cooking", "User has kids"
  preferences: Preference[]; // "Prefers dark mode", "Likes cats"
  openQuestions: Question[]; // Questions to ask the user
  personas: string[]; // "busy parent", "home cook", "techie"
  lastJournalProcessed: number; // Timestamp of last processed journal entry
}

interface Fact {
  content: string;
  confidence: number; // 0-1, higher = more certain
  source: string; // e.g., "journal:1234567890" or "user:direct"
  timestamp: number;
}

interface Preference {
  key: string; // e.g., "cooking_style", "communication_tone"
  value: string;
  confidence: number;
  source: string;
}

interface Question {
  id: string;
  question: string;
  category: string; // "preferences", "personal", "context"
  priority: number; // Higher = ask sooner
  options?: string[]; // For multiple choice
  status: "pending" | "asked" | "answered" | "skipped";
  answer?: string;
  askedAt?: number;
  answeredAt?: number;
}

// Extended ProfileOutput
export interface ProfileOutput {
  [NAME]: string;
  [UI]: VNode;
  // ... existing structured fields ...
  self: Person;
  partner: Person;
  // etc.

  // NEW: Learned section
  learned: LearnedSection;
}
```

### 2.2 Profile learning via journal watching

Add reactive logic to profile.tsx that watches the journal:

```tsx
// In profile.tsx pattern body

// Get journal from home space via wish
const journalEntries = wish<JournalEntry[]>({ query: "#journal" });

// Track what we've already processed
const lastProcessedTimestamp = Writable.of(0).for("lastJournalProcessed");

// Find new entries to process
const newEntries = computed(() => {
  const entries = journalEntries ?? [];
  const lastTs = lastProcessedTimestamp.get();
  return entries.filter((e) => e.timestamp > lastTs);
});

// Generate profile updates for new entries (batched)
const profileUpdate = generateObject<ProfileUpdateResult>({
  prompt: computed(() => {
    const entries = newEntries.get();
    if (entries.length === 0) return "";
    return `Analyze these user actions and extract profile information:
${
      entries.map((e) => `- ${e.eventType}: ${e.narrative || e.snapshot?.name}`)
        .join("\n")
    }

Current profile facts: ${JSON.stringify(learned.facts.get())}

Return new facts, updated preferences, and questions to ask.`;
  }),
  system: `You extract user profile information from their actions.
Be conservative - only add facts you're confident about.
Suggest questions when you need clarification.`,
  schema: toSchema<ProfileUpdateResult>(),
});

// Apply updates when generation completes
// (Need effect or watch mechanism - TBD)
```

### 2.3 Storage: Profile owned by home.tsx

home.tsx creates and owns the profile cell, similar to favorites and journal:

```tsx
// home.tsx - add profile alongside favorites/journal
const profile = Writable.of<Profile>({
  // Structured data (existing profile.tsx fields)
  self: EMPTY_PERSON,
  partner: EMPTY_PERSON,
  children: [],
  // ... etc

  // Learned data
  learned: {
    facts: [],
    preferences: [],
    openQuestions: [],
    personas: [],
    lastJournalProcessed: 0,
  },
}).for("profile");

// Export for wish() discovery
return {
  // ...existing exports
  profile, // Available via wish("#profile")
};
```

The profile pattern (profile.tsx) then becomes a **UI pattern** that uses
`wish("#profile")` to access and display/edit the data owned by home.tsx.

### 2.4 Profile UI additions

Add a "Learned" section to profile.tsx UI showing:

- Inferred facts with confidence indicators
- Pending questions (using ct-question)
- Personas/tags

```tsx
{/* === LEARNED FACTS === */}
<ct-vstack style={{ gap: "8px" }}>
  <button
    type="button"
    style={sectionHeaderStyle}
    onClick={() => learnedExpanded.set(!learnedExpanded.get())}
  >
    <span style={{ fontSize: "18px" }}>🧠</span>
    <span style={{ flex: 1, textAlign: "left" }}>What I've Learned</span>
  </button>
  <div
    style={{
      display: computed(() => learnedExpanded.get() ? "block" : "none"),
    }}
  >
    {learned.facts.map((fact) => (
      <ct-card>
        <ct-hstack justify="between">
          <span>{fact.content}</span>
          <ct-badge variant={fact.confidence > 0.8 ? "success" : "warning"}>
            {Math.round(fact.confidence * 100)}%
          </ct-badge>
        </ct-hstack>
      </ct-card>
    ))}
  </div>
</ct-vstack>;

{/* === QUESTIONS === */}
{
  pendingQuestions.length > 0 && (
    <ct-vstack style={{ gap: "8px" }}>
      <h3>Help me understand you better</h3>
      {pendingQuestions.slice(0, 3).map((q) => (
        <ct-question
          question={q.question}
          options={q.options}
          onCtAnswer={(e) => handleQuestionAnswer(q.id, e.detail.answer)}
        />
      ))}
    </ct-vstack>
  );
}
```

---

## Phase 3: ct-question Component

### 3.1 Component specification

A component for asking single questions and collecting answers.

**Attributes**:

- `question`: string - The question text
- `options`: string[] - Optional multiple choice options
- `$answer`: Writable<string> - Two-way binding for answer

**Events**:

- `ct-answer`: Fired when user submits an answer

**Usage**:

```tsx
<ct-question
  question="What's your preferred cooking style?"
  options={["Quick & easy", "Elaborate meals", "Healthy focus", "Kid-friendly"]}
  $answer={profile.cookingPreference}
/>;
```

### 3.2 Implementation

```tsx
// packages/ui/src/v2/components/ct-question/ct-question.ts

@customElement("ct-question")
export class CTQuestion extends BaseElement {
  @property()
  question = "";
  @property({ type: Array })
  options: string[] = [];
  @property({ attribute: "$answer" })
  $answer?: Writable<string>;

  @state()
  private _selectedOption: string | null = null;
  @state()
  private _customAnswer = "";
  @state()
  private _isSubmitted = false;

  render() {
    if (this._isSubmitted) {
      return html`
        <div class="answered">
          <ct-badge variant="success">Answered</ct-badge>
          <span>${this.$answer?.get()}</span>
        </div>
      `;
    }

    return html`
      <ct-card>
        <div class="question">${this.question}</div>
        ${this.options.length > 0
          ? this._renderOptions()
          : this._renderTextInput()}
        <ct-button @click="${this._handleSubmit}">Submit</ct-button>
      </ct-card>
    `;
  }

  private _renderOptions() {
    return html`
      <div class="options">
        ${this.options.map((opt) =>
          html`
            <ct-chip
              ?selected="${this._selectedOption === opt}"
              @click="${() => this._selectedOption = opt}"
            >${opt}</ct-chip>
          `
        )}
      </div>
    `;
  }

  private _handleSubmit() {
    const answer = this._selectedOption || this._customAnswer;
    if (!answer) return;

    this.$answer?.set(answer);
    this._isSubmitted = true;
    this.emit("ct-answer", { answer });
  }
}
```

### 3.3 Usage in patterns

```tsx
// In profile-updater.tsx or a question-presenter pattern

const pendingQuestions = computed(() =>
  profileLearned.openQuestions.filter((q) => !q.asked)
);

return {
  [UI]: (
    <ct-vstack>
      {pendingQuestions.slice(0, 1).map((q) => (
        <ct-question
          question={q.question}
          options={q.options}
          onCtAnswer={(e) => handleAnswer(q.id, e.detail.answer)}
        />
      ))}
    </ct-vstack>
  ),
};
```

---

## Phase 4: Profile Usage in wish() and Suggestions

### 4.1 Pass profile context to suggestion.tsx

Modify suggestion.tsx to include profile context:

```tsx
const suggestion = generateObject({
  system: `Find a useful pattern, run it, pass link to final result.

User profile:
- Facts: ${profile.facts.map((f) => f.content).join(", ")}
- Preferences: ${profile.preferences.map((p) => p.content).join(", ")}
- Personas: ${profile.personas.join(", ")}`,
  prompt: situation,
  context: { ...context, profile },
  // ...
});
```

### 4.2 Integrate profile into wish fulfillment

When `wish()` is called, include profile as part of the context:

```tsx
// Somewhere in the wish resolution logic
const profile = await getProfile(runtime);
const enrichedContext = {
  ...context,
  userProfile: profile,
};
```

---

## Open Questions

### RESOLVED

**Q1: Handler async in patterns?**

- **Answer**: Handlers are synchronous. Use two-phase approach:
  1. Add entry synchronously with `narrativePending: true`
  2. Reactive `generateText` fills in narratives

**Q2: Where to trigger profile updates?**

- **Answer**: In profile.tsx itself, watching journal via `wish("#journal")`

**Q3: Question presentation UX?**

- **Answer**: Dedicated pattern (profile-questions.tsx or within profile.tsx)

**Q4: Profile merge strategy?**

- **Answer**: Merge into single profile.tsx with `learned` section

### REMAINING QUESTIONS

**Q5: How to apply generateText/generateObject results back to cells?**

- **RESOLVED**: Use idempotent `computed()` with check-before-write pattern
- Key: Check if already written before setting (e.g.,
  `if (entry.narrative !== "") return`)
- See Phase 1.2 "Idempotent Writeback" pattern for full example

**Q6: Profile initialization**

- **RESOLVED**: Created automatically by home.tsx, available via
  `wish("#profile")`
- home.tsx owns the profile cell, similar to favorites/journal

**Q7: Question deduplication**

- **RESOLVED**: LLM checks existing questions before generating new ones
- Include current questions in the prompt context

**Q8: Narrative generation model**

- **RESOLVED**: Use Sonnet (`anthropic:claude-sonnet-4-5`) for quality
  narratives

---

## Implementation Order

### Sprint 1: Foundation (Journal Fix) ✅ COMPLETE

1. ✅ **Phase 1.3**: Update JournalEntry schema with `narrativePending` field
2. ✅ **Phase 1.1**: Modify home.tsx handlers to create journal entries
3. ✅ **Phase 1.4**: Add helper functions (captureSnapshot, extractTags)
4. ✅ **Phase 1.2**: Add reactive narrative enrichment (generateText)
5. **Test**: Favorite a charm → verify journal entry appears

### Sprint 2: Profile Infrastructure ✅ COMPLETE

1. ✅ **Phase 2.1**: Add learned section types to profile.tsx
2. ✅ **Phase 3.2**: Build ct-question component
3. ✅ **Phase 2.4**: Add learned section UI to profile.tsx
4. **Test**: Manual fact/question addition works

### Sprint 3: Profile Learning

1. **Phase 2.2**: Add journal watching + LLM extraction to profile.tsx
2. **Phase 2.3**: Ensure profile is accessible from home space
3. **Test**: Favorite items → facts appear in profile

### Sprint 4: Integration

1. **Phase 4.1**: Pass profile to suggestion.tsx
2. **Phase 4.2**: Integrate profile into wish fulfillment
3. **Test**: Suggestions reflect learned preferences

---

## Files to Create

```
packages/ui/src/v2/components/ct-question/
├── ct-question.ts      # Question component
├── index.ts            # Export
└── styles.ts           # Optional separate styles
```

## Files to Modify

| File                                      | Changes                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| `packages/home-schemas/journal.ts`        | Add `narrativePending?: boolean` field                |
| `packages/patterns/system/home.tsx`       | Add journal calls in handlers, narrative enrichment   |
| `packages/patterns/profile.tsx`           | Add `learned` section, journal watching, questions UI |
| `packages/patterns/system/suggestion.tsx` | Add profile context to LLM                            |
| `packages/ui/src/v2/index.ts`             | Export ct-question                                    |

---

## Testing Strategy

1. **Journal fix**: Favorite a charm, verify journal entry appears
2. **Profile learning**: Favorite several related charms, verify facts extracted
3. **ct-question**: Unit tests for component, verify answer binding
4. **Integration**: End-to-end flow from action → journal → profile → suggestion

---

## Risk Assessment

| Risk                    | Impact | Mitigation                                 |
| ----------------------- | ------ | ------------------------------------------ |
| LLM latency in handlers | High   | Make LLM calls non-blocking, queue updates |
| Profile data quality    | Medium | Add confidence scores, allow user editing  |
| Privacy concerns        | High   | All data local, clear user control         |
| Over-questioning        | Medium | Rate limit questions, prioritize by value  |
