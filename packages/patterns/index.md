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
  items: Cell<TodoItem[]>;
}
```

## `note.tsx`

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

Source charm for charm linking example. Computes statistics from GPA data and
exposes them for other charms to consume.

**Keywords:** charm-linking, source, lift, computed-stats

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

Consumer charm for charm linking example. Receives linked statistics from
gpa-stats-source and displays them.

**Keywords:** charm-linking, consumer, Default-null

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
  messages?: Cell<Default<Array<BuiltInLLMMessage>, []>>;
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

## `voice-note.tsx`

Record voice notes with automatic transcription and note history. Hold the
microphone button to record, release to transcribe.

**Keywords:** voice, transcription, audio, ct-voice-input

### Input Schema

```ts
type Input = {
  title?: Cell<Default<string, "Voice Note">>;
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
  images: Cell<ImageData[]>;
  prompt: Cell<string>;
  response: string | undefined;
  pending: boolean | undefined;
};
```

## `chatbot-outliner.tsx`

Structured outliner with integrated AI chat that can manipulate the outline via
tools. The AI assistant can add nodes to your outline.

**Keywords:** outliner, chat, tools, ct-outliner

### Input Schema

```ts
type OutlinerNode = {
  body: Default<string, "">;
  children: Default<OutlinerNode[], []>;
  attachments: Default<OpaqueRef<any>[], []>;
};

type LLMTestInput = {
  title?: Cell<Default<string, "LLM Test">>;
  messages?: Cell<Default<Array<BuiltInLLMMessage>, []>>;
  expandChat?: Cell<Default<boolean, false>>;
  outline?: Default<
    { root: OutlinerNode },
    { root: { body: "Untitled Page"; children: []; attachments: [] } }
  >;
};
```

### Output Schema

```ts
type LLMTestResult = {
  messages: Default<Array<BuiltInLLMMessage>, []>;
};
```

## `scrabble.tsx`

Free-for-all multiplayer Scrabble game with lobby, tile bag, game board, and
scoring. Two players can join and play simultaneously.

**Keywords:** game, multiplayer, scrabble, navigateTo

### Input Schema

```ts
interface LobbyInput {
  gameName: Default<string, "Scrabble Match">;
  boardJson: Cell<Default<string, "">>;
  bagJson: Cell<Default<string, "">>;
  bagIndex: Cell<Default<number, 0>>;
  playersJson: Cell<Default<string, "[]">>;
  gameEventsJson: Cell<Default<string, "[]">>;
  allRacksJson: Cell<Default<string, "{}">>;
  allPlacedJson: Cell<Default<string, "{}">>;
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

## `favorites-manager.tsx`

View and manage favorited charms with tags. Uses the wish system to query
`#favorites` and allows removing items.

**Keywords:** favorites, wish, ct-cell-link

### Input Schema

```ts
type Input = Record<string, never>;
```

### Output Schema

```ts
// Uses wish<Array<Favorite>>({ query: "#favorites" }) internally
// Displays favorited charms with remove functionality
```

## `contact-book.tsx`

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
  contacts: Cell<Default<Contact[], []>>;
  relationships: Cell<Default<Relationship[], []>>;
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
  habits: Cell<Default<Habit[], []>>;
  logs: Cell<Default<HabitLog[], []>>;
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
  events: Cell<Default<Event[], []>>;
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

Track books, articles, papers, and videos you want to read or have read. Filter
by status (want/reading/finished/abandoned) and rate items.

**Keywords:** reading, books, articles, status-tracking, lift

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
  items: Cell<Default<ReadingItem[], []>>;
}
```

### Output Schema

```ts
interface Output {
  items: ReadingItem[];
}
```

## `contact-detail.tsx`

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
  result: Cell<ResearchResult | undefined>;
  pending: boolean;
  error: string | undefined;
};
```

## `record.tsx`

Flexible container pattern for structured records with composable field modules.
Supports dynamic type selection, soft-delete with restore, and LLM-powered data
extraction. Used for contacts, businesses, places, and other structured data.

**Keywords:** record, container, sub-charms, type-picker, modules, composable

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
  charm: unknown;
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

---

# Protocol Types

## `container-protocol.ts`

Protocol definitions for controller patterns that coordinate with parent
containers.

**Keywords:** protocol, container, coordination, types

### Types

```ts
interface ContainerCoordinationContext<TEntry = unknown> {
  entries: Cell<TEntry[]>;
  trashedEntries: Cell<(TEntry & { trashedAt: string })[]>;
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
