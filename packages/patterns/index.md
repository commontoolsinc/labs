# Common Patterns

Prefix the URLs with
`https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/packages/patterns/`

## `counter.tsx`

A simple counter demo.

### Input Schema

```ts
interface CounterInput {
  value: number;
}
```

### Result Schema

```ts
interface CounterOutput {
  value?: number;
  increment: Stream<void>;
  decrement: Stream<void>;
}
```

## `todo-list.tsx`

A todo list with AI suggestions.

### Input Schema

```ts
interface Input {}
```

### Result Schema

```ts
interface TodoItem {
  title: string;
  done: Default<boolean, false>;
}

interface Output {
  items: Writable<TodoItem[]>;
}
```

## `notes/note.tsx`

A note demo.

### Input Schema

```ts
type NoteInput = {
  /** The title of the note */
  title: string;
  /** The content of the note */
  content: string;
};
```

### Result Schema

```ts
type NoteOutput = {
  /** The content of the note */
  content: string;
  grep: Stream<{ query: string }>;
  translate: Stream<{ language: string }>;
  editContent: Stream<{ detail: { value: string } }>;
};
```

## `gpa-stats-source.tsx`

Source piece for piece linking example. Computes statistics from GPA data and
exposes them for other pieces to consume.

**Keywords:** piece-linking, source, lift, computed-stats

### Input Schema

```ts
interface Input {
  name: Default<string, "gpa-source-v1">;
  rawData: Default<string, "">;
}
```

### Output Schema

```ts
interface Stats {
  average: number;
  count: number;
  min: number;
  max: number;
}

interface Output {
  name: string;
  rawData: string;
  gpaStats: Stats | null; // Exposed for linking
}
```

## `gpa-stats-reader.tsx`

Consumer piece for piece linking example. Receives linked statistics from
gpa-stats-source and displays them.

**Keywords:** piece-linking, consumer, Default-null

### Input Schema

```ts
interface Stats {
  average: number;
  count: number;
  min: number;
  max: number;
}

interface Input {
  name: Default<string, "gpa-reader-v1">;
  gpaStats: Default<Stats | null, null>; // null until linked
}
```

## `chatbot.tsx`

Full-featured AI chat assistant with tool support, model selection, and
mentionables. Deploy this to have a conversational AI interface.

**Keywords:** llm, chat, tools, llmDialog, generateObject

### Input Schema

```ts
type ChatInput = {
  messages?: Writable<Default<Array<BuiltInLLMMessage>, []>>;
  tools?: any;
  theme?: any;
  system?: string;
};
```

### Output Schema

```ts
type ChatOutput = {
  messages: Array<BuiltInLLMMessage>;
  pending: boolean | undefined;
  addMessage: Stream<BuiltInLLMMessage>;
  clearChat: Stream<void>;
  cancelGeneration: Stream<void>;
  title?: string;
  pinnedCells: Array<PromptAttachment>;
  tools: any;
};
```

## `examples/profile-aware-writer.tsx`

Example pattern demonstrating how to use the `#profile` wish to personalize LLM
output. Fetches the user's profile summary and injects it into the system prompt
for personalized text generation.

**Keywords:** profile, wish, generateText, llm, personalization

### Input Schema

```ts
type Input = {
  topic?: Writable<Default<string, "">>;
};
```

### Output Schema

```ts
type Output = {
  topic: string;
  response: BuiltInLLMContent;
};
```

## `notes/voice-note.tsx`

Record voice notes with automatic transcription and note history. Hold the
microphone button to record, release to transcribe.

**Keywords:** voice, transcription, audio, ct-voice-input

### Input Schema

```ts
type Input = {
  title?: Writable<Default<string, "Voice Note">>;
};
```

### Output Schema

```ts
interface TranscriptionData {
  id: string;
  text: string;
  chunks?: TranscriptionChunk[];
  audioData?: string;
  duration: number;
  timestamp: number;
}

type Output = {
  transcription: Default<TranscriptionData | null, null>;
  notes: Default<TranscriptionData[], []>;
};
```

## `image-analysis.tsx`

Upload images and get AI-powered analysis and descriptions. Supports multiple
images with customizable prompts.

**Keywords:** vision, image, generateText, ct-image-input

### Input Schema

```ts
type ImageChatInput = {
  systemPrompt?: string;
  model?: string;
};
```

### Output Schema

```ts
type ImageChatOutput = {
  images: Writable<ImageData[]>;
  prompt: Writable<string>;
  response: string | undefined;
  pending: boolean | undefined;
};
```

## `scrabble/scrabble.tsx`

Free-for-all multiplayer Scrabble game with lobby, tile bag, game board, and
scoring. Two players can join and play simultaneously.

**Keywords:** game, multiplayer, scrabble, navigateTo

### Input Schema

```ts
interface LobbyInput {
  gameName: Default<string, "Scrabble Match">;
  boardJson: Writable<Default<string, "">>;
  bagJson: Writable<Default<string, "">>;
  bagIndex: Writable<Default<number, 0>>;
  playersJson: Writable<Default<string, "[]">>;
  gameEventsJson: Writable<Default<string, "[]">>;
  allRacksJson: Writable<Default<string, "{}">>;
  allPlacedJson: Writable<Default<string, "{}">>;
}
```

### Output Schema

```ts
interface LobbyOutput {
  gameName: string;
  boardJson: string;
  bagJson: string;
  bagIndex: number;
  playersJson: string;
  gameEventsJson: string;
  allRacksJson: string;
  allPlacedJson: string;
}
```

## `system/favorites-manager.tsx`

View and manage favorited pieces with tags. Uses the wish system to query
`#favorites` and allows removing items.

**Keywords:** favorites, wish, ct-cell-link

### Input Schema

```ts
type Input = Record<string, never>;
```

### Output Schema

```ts
// Uses wish<Array<Favorite>>({ query: "#favorites" }) internally
// Displays favorited pieces with remove functionality
```

## `contacts/contact-book.tsx`

Manage contacts with search, notes, and relationships between contacts. Contacts
can be linked together with labels (friend, spouse, colleague, etc.).

**Keywords:** contacts, relationships, search, lift

### Input Schema

```ts
interface Contact {
  name: string;
  email: Default<string, "">;
  phone: Default<string, "">;
  company: Default<string, "">;
  tags: Default<string[], []>;
  notes: Default<string, "">;
  createdAt: number;
}

interface Relationship {
  fromName: string;
  toName: string;
  label: Default<string, "">;
}

interface Input {
  contacts: Writable<Default<Contact[], []>>;
  relationships: Writable<Default<Relationship[], []>>;
}
```

### Output Schema

```ts
interface Output {
  contacts: Contact[];
  relationships: Relationship[];
}
```

## `habit-tracker.tsx`

Track daily habits with streak counting and 7-day history visualization. Mark
habits complete for today and see your progress over time.

**Keywords:** habits, streaks, daily-tracking, lift

### Input Schema

```ts
interface Habit {
  name: string;
  icon: Default<string, "✓">;
  color: Default<string, "#3b82f6">;
}

interface HabitLog {
  habitName: string;
  date: string; // YYYY-MM-DD
  completed: boolean;
}

interface Input {
  habits: Writable<Default<Habit[], []>>;
  logs: Writable<Default<HabitLog[], []>>;
}
```

### Output Schema

```ts
interface Output {
  habits: Habit[];
  logs: HabitLog[];
  todayDate: string;
}
```

## `calendar.tsx`

Minimal calendar for managing events with date and time. Events are grouped by
date with today highlighted.

**Keywords:** calendar, events, dates, lift

### Input Schema

```ts
interface Event {
  title: string;
  date: string; // YYYY-MM-DD
  time: Default<string, "">; // HH:MM or empty for all-day
  notes: Default<string, "">;
}

interface Input {
  events: Writable<Default<Event[], []>>;
}
```

### Output Schema

```ts
interface Output {
  events: Event[];
  todayDate: string;
}
```

## `reading-list.tsx`

**Canonical list-detail example.** Track books, articles, papers, and videos.
Demonstrates: footer forms, `navigateTo()` for details, `lift()` for filtering.

**Keywords:** reading, books, articles, status-tracking, lift, navigateTo

### Input Schema

```ts
type ItemType = "book" | "article" | "paper" | "video";
type ItemStatus = "want" | "reading" | "finished" | "abandoned";

interface ReadingItem {
  title: string;
  author: Default<string, "">;
  url: Default<string, "">;
  type: Default<ItemType, "article">;
  status: Default<ItemStatus, "want">;
  rating: Default<number | null, null>; // 1-5 stars
  notes: Default<string, "">;
  addedAt: number;
  finishedAt: Default<number | null, null>;
}

interface Input {
  items: Writable<Default<ReadingItem[], []>>;
}
```

### Output Schema

```ts
interface Output {
  items: ReadingItem[];
}
```

## `contacts/contact-detail.tsx`

Detail/edit view for a single contact. Use with `navigateTo()` from contact-book
or as a standalone contact editor.

**Keywords:** contact, detail, edit, form, navigateTo

### Input Schema

```ts
interface Contact {
  name: string;
  email: Default<string, "">;
  phone: Default<string, "">;
  company: Default<string, "">;
  tags: Default<string[], []>;
  notes: Default<string, "">;
  createdAt: number;
}

interface Input {
  contact: Contact;
}
```

### Output Schema

```ts
interface Output {
  contact: Contact;
}
```

## `event-detail.tsx`

Detail/edit view for a single calendar event. Use with `navigateTo()` from
calendar or as a standalone event editor.

**Keywords:** event, detail, edit, form, navigateTo

### Input Schema

```ts
interface Event {
  title: string;
  date: string;
  time: Default<string, "">;
  notes: Default<string, "">;
}

interface Input {
  event: Event;
}
```

### Output Schema

```ts
interface Output {
  event: Event;
}
```

## `reading-item-detail.tsx`

Detail/edit view for a single reading list item. Use with `navigateTo()` from
reading-list or as a standalone item editor.

**Keywords:** reading, book, article, detail, edit, form, navigateTo

### Input Schema

```ts
type ItemType = "book" | "article" | "paper" | "video";
type ItemStatus = "want" | "reading" | "finished" | "abandoned";

interface ReadingItem {
  title: string;
  author: Default<string, "">;
  url: Default<string, "">;
  type: Default<ItemType, "article">;
  status: Default<ItemStatus, "want">;
  rating: Default<number | null, null>;
  notes: Default<string, "">;
  addedAt: number;
  finishedAt: Default<number | null, null>;
}

interface Input {
  item: ReadingItem;
}
```

### Output Schema

```ts
interface Output {
  item: ReadingItem;
}
```

## `deep-research.tsx`

Deep research agent that searches the web and synthesizes findings into a
structured response. Give it a question and optional context, and it will
search, read sources, and provide a comprehensive answer.

**Keywords:** llm, research, web-search, tools, generateObject, agent

### Input Schema

```ts
type Input = {
  /** The research question to investigate */
  question: string;
  /** Optional context to provide to the agent */
  context?: { [id: string]: any };
};
```

### Output Schema

```ts
type ResearchResult = {
  summary: string;
  findings: { title: string; source: string; content: string }[];
  sources: string[];
  confidence: "high" | "medium" | "low";
};

type Output = {
  question: string;
  result: Writable<ResearchResult | undefined>;
  pending: boolean;
  error: string | undefined;
};
```

## `record.tsx`

Flexible container pattern for structured records with composable field modules.
Supports dynamic type selection, soft-delete with restore, and LLM-powered data
extraction. Used for contacts, businesses, places, and other structured data.

**Keywords:** record, container, sub-pieces, type-picker, modules, composable

### Input Schema

```ts
interface Input {
  title?: Default<string, "">;
}
```

### Output Schema

```ts
interface SubCharmEntry {
  type: string;
  piece: unknown;
}

interface Output {
  title: string;
  subCharms: SubCharmEntry[];
}
```

---

# Record Field Modules

These patterns are composable field modules designed to work with `record.tsx`
but can also be used standalone. Each exports `MODULE_METADATA` for
self-description.

## `birthday.tsx`

Birthday/date of birth tracking with optional birth year.

**Keywords:** birthday, date, record-module

### Schema

```ts
interface BirthdayModuleInput {
  birthDate: Default<string, "">;
  birthYear: Default<number | null, null>;
}
```

## `rating.tsx`

Star rating (1-5) with visual star display.

**Keywords:** rating, stars, record-module

### Schema

```ts
interface RatingModuleInput {
  rating: Default<number | null, null>;
}
```

## `tags.tsx`

Comma-separated tags/labels.

**Keywords:** tags, labels, record-module

### Schema

```ts
interface TagsModuleInput {
  tags: Default<string[], []>;
}
```

## `status.tsx`

Status tracking with customizable options (active, inactive, pending, etc.).

**Keywords:** status, state, record-module

### Schema

```ts
interface StatusModuleInput {
  status: Default<string, "">;
}
```

## `address.tsx`

Physical address with street, city, state, postal code, and country.

**Keywords:** address, location, record-module

### Schema

```ts
interface AddressModuleInput {
  street: Default<string, "">;
  city: Default<string, "">;
  state: Default<string, "">;
  postalCode: Default<string, "">;
  country: Default<string, "">;
}
```

## `timeline.tsx`

Key dates tracking (met, started, ended, etc.).

**Keywords:** dates, timeline, history, record-module

### Schema

```ts
interface TimelineModuleInput {
  metDate: Default<string, "">;
  startDate: Default<string, "">;
  endDate: Default<string, "">;
}
```

## `social.tsx`

Social media profile (platform, handle, URL).

**Keywords:** social, twitter, linkedin, github, record-module

### Schema

```ts
interface SocialModuleInput {
  platform: Default<string, "">;
  handle: Default<string, "">;
  url: Default<string, "">;
}
```

## `link.tsx`

URL/link with optional title.

**Keywords:** link, url, web, record-module

### Schema

```ts
interface LinkModuleInput {
  url: Default<string, "">;
  title: Default<string, "">;
}
```

## `location.tsx`

Geographic coordinates (latitude, longitude) with optional label.

**Keywords:** location, coordinates, geo, record-module

### Schema

```ts
interface LocationModuleInput {
  latitude: Default<number | null, null>;
  longitude: Default<number | null, null>;
  label: Default<string, "">;
}
```

## `relationship.tsx`

Relationship to another entity with type and notes.

**Keywords:** relationship, connection, record-module

### Schema

```ts
interface RelationshipModuleInput {
  relationshipType: Default<string, "">;
  relatedTo: Default<string, "">;
  notes: Default<string, "">;
}
```

## `giftprefs.tsx`

Gift preferences and ideas.

**Keywords:** gifts, preferences, record-module

### Schema

```ts
interface GiftPrefsModuleInput {
  likes: Default<string, "">;
  dislikes: Default<string, "">;
  giftIdeas: Default<string[], []>;
}
```

## `timing.tsx`

Best times to contact (morning, afternoon, evening, etc.).

**Keywords:** timing, availability, schedule, record-module

### Schema

```ts
interface TimingModuleInput {
  bestTime: Default<string, "">;
  timezone: Default<string, "">;
}
```

## `type-picker.tsx`

Controller module for selecting record type. Internal use only - applies
templates to parent container and then removes itself.

**Keywords:** type-picker, controller, internal, record-module

### Schema

```ts
interface TypePickerInput {
  context: ContainerCoordinationContext<SubCharmEntry>;
  dismissed?: Default<boolean, false>;
}
```

## `age-category.tsx`

Age categorization with two-tier selection: Adult/Child groups with specific
subcategories (Senior, Young Adult, Teenager, etc.).

**Keywords:** age, category, adult, child, record-module

### Schema

```ts
type AgeCategory =
  | "adult"
  | "child"
  | "senior"
  | "adult-specific"
  | "young-adult"
  | "teenager"
  | "school-age"
  | "toddler"
  | "baby";

interface AgeCategoryModuleInput {
  ageCategory: Default<AgeCategory, "adult">;
}
```

## `dietary-restrictions.tsx`

Comprehensive dietary restriction tracking with severity levels. Handles
allergies, intolerances, and lifestyle diets (vegetarian, vegan, halal, kosher,
keto, etc.) with automatic expansion of diet groups to specific food items.

**Keywords:** dietary, allergies, diet, vegan, vegetarian, record-module

### Schema

```ts
type RestrictionLevel = "flexible" | "prefer" | "strict" | "absolute";

interface RestrictionEntry {
  name: string;
  level: RestrictionLevel;
}

interface DietaryRestrictionsInput {
  restrictions: Default<RestrictionEntry[], []>;
}
```

## `email.tsx`

Email address with customizable label. Supports multiple instances per Record
with smart default labels (Personal, Work, School, Other).

**Keywords:** email, contact, record-module, multi-instance

### Schema

```ts
interface EmailModuleInput {
  label: Default<string, "Personal">;
  address: Default<string, "">;
}
```

## `phone.tsx`

Phone number with customizable label. Supports multiple instances per Record
with smart default labels (Mobile, Home, Work, Other).

**Keywords:** phone, contact, record-module, multi-instance

### Schema

```ts
interface PhoneModuleInput {
  label: Default<string, "Mobile">;
  number: Default<string, "">;
}
```

---

# Utility Patterns

## `record-backup.tsx`

Import/export utility for Records. Exports all Records in a space to JSON and
imports them back. Designed for data survival after server wipes.

**Keywords:** backup, export, import, records, data-migration

### Input Schema

```ts
interface Input {
  importJson: Default<string, "">;
}
```

### Output Schema

```ts
interface Output {
  exportedJson: string;
  importJson: string;
  recordCount: number;
  importResult: ImportResult | null;
}
```

---

# Protocol Types

## `container-protocol.ts`

Protocol definitions for controller patterns that coordinate with parent
containers.

**Keywords:** protocol, container, coordination, types

### Types

```ts
interface ContainerCoordinationContext<TEntry = unknown> {
  entries: Writable<TEntry[]>;
  trashedEntries: Writable<(TEntry & { trashedAt: string })[]>;
  createModule: (type: string) => unknown;
}

interface ModuleMetadata {
  type: string;
  label: string;
  icon: string;
  internal?: boolean;
  schema?: Record<string, unknown>;
  fieldMapping?: string[];
}
```
