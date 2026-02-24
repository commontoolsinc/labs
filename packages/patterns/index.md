# Common Patterns

Prefix the URLs with
`https://raw.githubusercontent.com/commontoolsinc/labs/refs/heads/main/packages/patterns/`

---

## `counter/counter.tsx`

A simple counter demo.

### Input Schema

```ts
interface CounterInput {
  value?: Writable<Default<number, 0>>;
}
```

### Output Schema

```ts
interface CounterOutput {
  value: number;
  increment: Stream<void>;
  decrement: Stream<void>;
}
```

## `do-list/do-list.tsx`

A task list pattern with AI suggestions per item, indent-based subtasks, and
LLM-friendly title-based handlers.

**Keywords:** do-list, tasks, AI-suggestions, indent, suggestion, llmDialog

### Input Schema

```ts
interface DoItem {
  title: string;
  done: Default<boolean, false>;
  indent: Default<number, 0>;
  aiEnabled: Default<boolean, false>;
}

interface DoListInput {
  items?: Writable<Default<DoItem[], []>>;
}
```

### Output Schema

```ts
interface DoListOutput {
  items: DoItem[];
  itemCount: number;
  compactUI: VNode;
  addItem: OpaqueRef<Stream<{ title: string; indent?: number }>>;
  removeItem: OpaqueRef<Stream<{ item: DoItem }>>;
  updateItem: OpaqueRef<
    Stream<{ item: DoItem; title?: string; done?: boolean }>
  >;
  addItems: OpaqueRef<
    Stream<{ items: Array<{ title: string; indent?: number }> }>
  >;
  removeItemByTitle: OpaqueRef<Stream<{ title: string }>>;
  updateItemByTitle: OpaqueRef<
    Stream<{ title: string; newTitle?: string; done?: boolean }>
  >;
}
```

## `todo-list/todo-list.tsx`

A todo list with AI suggestions.

### Input Schema

```ts
interface TodoItem {
  title: string;
  done: Default<boolean, false>;
}

interface TodoListInput {
  items?: Writable<Default<TodoItem[], []>>;
}
```

### Output Schema

```ts
interface TodoListOutput {
  items: TodoItem[];
  itemCount: number;
  addItem: Stream<{ title: string }>;
  removeItem: Stream<{ item: TodoItem }>;
}
```

## `simple-list/simple-list.tsx`

A checklist with indent support. Works standalone or embedded in Record
containers.

**Keywords:** checklist, indentation, composable

### Input Schema

```ts
interface SimpleListItem {
  text: string;
  indented: Default<boolean, false>;
  done: Default<boolean, false>;
}

interface SimpleListInput {
  items?: Writable<Default<SimpleListItem[], []>>;
}
```

### Output Schema

```ts
interface SimpleListOutput {
  items: SimpleListItem[];
  addItem: Stream<{ text: string }>;
  deleteItem: Stream<{ index: number }>;
  toggleIndent: Stream<{ index: number }>;
}
```

## `shopping-list.tsx`

Shopping list with AI-powered aisle sorting. Pair with `store-mapper.tsx` for
store-specific layouts.

**Keywords:** shopping, groceries, AI-sorting, generateObject

### Input Schema

```ts
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  aisleSeed: Default<number, 0>;
  aisleOverride: Default<string, "">;
}

interface Input {
  items: Writable<Default<ShoppingItem[], []>>;
  storeLayout: Writable<Default<string, "">>;
}
```

### Output Schema

```ts
interface Output {
  items: ShoppingItem[];
  totalCount: number;
  doneCount: number;
  remainingCount: number;
  storeLayout: string;
  addItem: OpaqueRef<Stream<{ detail: { message: string } }>>;
  addItems: OpaqueRef<Stream<{ itemNames: string[] }>>;
}
```

## `notes/note.tsx`

A note with wiki-links, backlinks, and embedding support. Managed by
`notes/notebook.tsx`.

**Keywords:** note, wiki-links, backlinks, embedding

### Input Schema

```ts
type Input = {
  title?: Writable<Default<string, "Untitled Note">>;
  content?: Writable<Default<string, "">>;
  isHidden?: Default<boolean, false>;
  noteId?: Default<string, "">;
  parentNotebook?: any;
};
```

### Output Schema

```ts
type Output = {
  content: string;
  isHidden: boolean;
  noteId: string;
  backlinks: MentionablePiece[];
  grep: PatternToolResult<{ content: string }>;
  translate: PatternToolResult<{ content: string }>;
  editContent: Stream<{ detail: { value: string } }>;
};
```

## `notes/notebook.tsx`

Notebook pattern managing notes and nested notebooks. Creates and organizes
`notes/note.tsx` pieces.

**Keywords:** notebook, notes, nested, navigateTo

### Input Schema

```ts
interface Input {
  title?: Default<string, "Notebook">;
  notes?: Writable<Default<NotePiece[], []>>;
  isNotebook?: Default<boolean, true>;
  isHidden?: Default<boolean, false>;
  parentNotebook?: any;
}
```

### Output Schema

```ts
interface Output {
  title: string;
  notes: NotePiece[];
  noteCount: number;
  isNotebook: boolean;
  isHidden: boolean;
  backlinks: MentionablePiece[];
  createNote: Stream<{ title: string; content: string }>;
  createNotes: Stream<{ notesData: Array<{ title: string; content: string }> }>;
  setTitle: Stream<{ newTitle: string }>;
  createNotebook: Stream<{
    title: string;
    notesData?: Array<{ title: string; content: string }>;
  }>;
}
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

## `calendar/calendar.tsx`

Calendar for managing events with date and time. Events are sorted by date with
today highlighted.

**Keywords:** calendar, events, dates, navigateTo

### Input Schema

```ts
interface CalendarInput {
  events?: Writable<Default<EventPiece[], []>>;
}
```

### Output Schema

```ts
interface CalendarOutput {
  events: EventPiece[];
  sortedEvents: EventPiece[];
  todayDate: string;
  addEvent: Stream<{ title: string; date: string; time: string }>;
  removeEvent: Stream<{ event: EventPiece }>;
}
```

## `weekly-calendar/weekly-calendar.tsx`

Weekly calendar with drag-and-drop event creation and resizing. Manages
`weekly-calendar/event.tsx` pieces.

**Keywords:** weekly, calendar, drag-drop, events, navigateTo

### Input Schema

```ts
interface Input {
  title?: Default<string, "Weekly Calendar">;
  events: Writable<Default<EventPiece[], []>>;
  isCalendar?: Default<boolean, true>;
  isHidden?: Default<boolean, false>;
}
```

### Output Schema

```ts
interface Output {
  title: string;
  events: EventPiece[];
  eventCount: number;
  isCalendar: boolean;
  isHidden: boolean;
  backlinks: MentionablePiece[];
  createEvent: Stream<{
    title: string;
    date: string;
    startTime: string;
    endTime: string;
  }>;
  setTitle: Stream<{ newTitle: string }>;
}
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

interface ContactBookInput {
  contacts: Writable<Default<Contact[], []>>;
  relationships: Writable<Default<Relationship[], []>>;
}
```

### Output Schema

```ts
interface ContactBookOutput {
  contacts: Contact[];
  relationships: Relationship[];
  onAddContact: Stream<void>;
}
```

## `habit-tracker/habit-tracker.tsx`

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

interface HabitTrackerInput {
  habits: Writable<Default<Habit[], []>>;
  logs: Writable<Default<HabitLog[], []>>;
}
```

### Output Schema

```ts
interface HabitTrackerOutput {
  habits: Habit[];
  logs: HabitLog[];
  todayDate: string;
  toggleHabit: Stream<{ habitName: string }>;
  addHabit: Stream<{ name: string; icon: string }>;
  deleteHabit: Stream<{ habit: Habit }>;
}
```

## `reading-list/reading-list.tsx`

**Canonical list-detail example.** Track books, articles, papers, and videos.
Demonstrates: footer forms, `navigateTo()` for details, `lift()` for filtering.

**Keywords:** reading, books, articles, status-tracking, lift, navigateTo

### Input Schema

```ts
type ItemType = "book" | "article" | "paper" | "video";
type ItemStatus = "want" | "reading" | "finished" | "abandoned";

interface ReadingListInput {
  items?: Writable<Default<ReadingItemPiece[], []>>;
}
```

### Output Schema

```ts
interface ReadingListOutput {
  items: ReadingItemPiece[];
  totalCount: number;
  currentFilter: ItemStatus | "all";
  filteredItems: ReadingItemPiece[];
  filteredCount: number;
  addItem: Stream<{ title: string; author: string; type: ItemType }>;
  removeItem: Stream<{ item: ReadingItemPiece }>;
  setFilter: Stream<{ status: ItemStatus | "all" }>;
  updateItem: Stream<{
    item: ReadingItemPiece;
    status?: ItemStatus;
    rating?: number | null;
    notes?: string;
  }>;
}
```

## `budget-tracker/main.tsx`

Track expenses by category with budget limits and spending visualization.
Multi-file pattern using sub-patterns for the form and data views.

**Keywords:** budget, expenses, categories, sub-patterns

### Input Schema

```ts
interface Expense {
  description: string;
  amount: number;
  category: Default<string, "Other">;
  date: string; // YYYY-MM-DD
}

interface CategoryBudget {
  category: string;
  limit: number;
}

interface Input {
  expenses: Writable<Default<Expense[], []>>;
  budgets: Writable<Default<CategoryBudget[], []>>;
}
```

### Output Schema

```ts
interface Output {
  expenses: Expense[];
  budgets: CategoryBudget[];
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
  pinnedCells: Array<{ path: string; name: string }>;
  tools: any;
};
```

## `group-chat-lobby.tsx`

Multiplayer group chat lobby where users join, pick colors, and enter a shared
chat room. Uses `navigateTo()` to transition into `group-chat-room.tsx`.

**Keywords:** multiplayer, chat, lobby, navigateTo

### Input Schema

```ts
interface Message {
  id: string;
  author: string;
  content: string;
  timestamp: number;
  type: "chat" | "system" | "image";
  imageUrl?: string;
  reactions: Reaction[];
}

interface User {
  name: string;
  joinedAt: number;
  color: string;
  avatarImage?: { url: string };
}

interface LobbyInput {
  chatName: Default<string, "Group Chat">;
  messages: Writable<Default<Message[], []>>;
  users: Writable<Default<User[], []>>;
  sessionId: Writable<Default<string, "">>;
}
```

### Output Schema

```ts
interface LobbyOutput {
  chatName: string;
  messages: Message[];
  users: User[];
  sessionId: string;
}
```

## `store-mapper.tsx`

Capture grocery store layouts through manual aisle entry, perimeter department
positioning, and item location corrections. Generates layout data used by
`shopping-list.tsx` for AI-powered aisle sorting.

**Keywords:** store-layout, grocery, aisles, generateObject

### Input Schema

```ts
interface Aisle {
  name: string;
  description: Default<string, "">;
}

interface Department {
  name: string;
  icon: string;
  location: Default<WallPosition, "unassigned">;
  description: Default<string, "">;
}

interface Entrance {
  position: WallPosition;
}

interface ItemLocation {
  itemName: string;
  correctAisle: string;
  incorrectAisle: Default<string, "">;
  timestamp: number;
}

interface Input {
  storeName: Writable<Default<string, "My Store">>;
  aisles: Writable<Default<Aisle[], []>>;
  departments: Writable<Default<Department[], []>>;
  entrances: Writable<Default<Entrance[], []>>;
  itemLocations: Writable<Default<ItemLocation[], []>>;
}
```

### Output Schema

```ts
interface Output {
  storeName: string;
  aisles: Aisle[];
  departments: Department[];
  entrances: Entrance[];
  itemLocations: ItemLocation[];
  storeLayout: string; // Generated markdown layout description
}
```

## `image.tsx`

Display an image from a URL or data URI with optional caption. Useful for
rendering images when an LLM has a URL to display.

**Keywords:** image, photo, picture, display, url, data-uri, base64

### Input Schema

```ts
interface ImageInput {
  url?: Default<string, "">;
  caption?: Default<string, "">;
}
```

### Output Schema

```ts
interface ImageOutput {
  url: string;
  caption: string;
}
```

---

# AI & Capability Demos

## `deep-research.tsx`

Deep research agent that uses llmDialog to search the web and synthesize
findings. Shows live progress via ct-message-beads and renders a structured
result with summary, confidence, and sources. Supports follow-up refinement.

**Keywords:** llm, research, web-search, tools, llmDialog, agent, beads

### Input Schema

```ts
type Input = {
  /** The research question to investigate */
  situation: Default<string, "What are the latest developments in AI agents?">;
  /** Message history (managed by llmDialog) */
  messages?: Writable<Default<Array<BuiltInLLMMessage>, []>>;
  /** Optional context cells to provide to the agent */
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
  result: ResearchResult | undefined;
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

## `examples/profile-aware-writer.tsx`

Example pattern demonstrating how to use the `#profile` wish to personalize LLM
output. Fetches the user's profile summary and injects it into the system prompt
for personalized text generation.

**Keywords:** profile, wish, generateText, llm, personalization

### Input Schema

```ts
type Input = {
  title?: Default<string, "Profile-Aware Writer">;
};
```

### Output Schema

```ts
type Output = {
  topic: Writable<string>;
  response: string | undefined;
};
```

---

# Detail Views

These patterns are used with `navigateTo()` from their parent patterns and can
also work standalone.

## `calendar/event-detail.tsx`

Detail/edit view for a single calendar event.

**Keywords:** event, detail, edit, form, navigateTo

### Input Schema

```ts
interface EventDetailInput {
  title?: Writable<Default<string, "">>;
  date?: Writable<Default<string, "">>;
  time?: Writable<Default<string, "">>;
  notes?: Writable<Default<string, "">>;
}
```

### Output Schema

```ts
interface EventDetailOutput {
  title: string;
  date: string;
  time: string;
  notes: string;
  setTitle: Stream<{ title: string }>;
  setDate: Stream<{ date: string }>;
  setTime: Stream<{ time: string }>;
  setNotes: Stream<{ notes: string }>;
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

interface ContactDetailInput {
  contact: Writable<Contact>;
}
```

### Output Schema

```ts
interface ContactDetailOutput {
  contact: Contact;
}
```

## `reading-list/reading-item-detail.tsx`

Detail/edit view for a single reading list item. Use with `navigateTo()` from
reading-list or as a standalone item editor.

**Keywords:** reading, book, article, detail, edit, form, navigateTo

### Input Schema

```ts
type ItemType = "book" | "article" | "paper" | "video";
type ItemStatus = "want" | "reading" | "finished" | "abandoned";

interface ReadingItemDetailInput {
  title?: Writable<Default<string, "">>;
  author?: Writable<Default<string, "">>;
  url?: Writable<Default<string, "">>;
  type?: Writable<Default<ItemType, "article">>;
  status?: Writable<Default<ItemStatus, "want">>;
  rating?: Writable<Default<number | null, null>>;
  notes?: Writable<Default<string, "">>;
  addedAt?: Default<number, 0>;
  finishedAt?: Default<number | null, null>;
}
```

### Output Schema

```ts
interface ReadingItemDetailOutput {
  title: string;
  author: string;
  url: string;
  type: ItemType;
  status: ItemStatus;
  rating: number | null;
  notes: string;
  addedAt: number;
  finishedAt: number | null;
  setStatus: Stream<{ status: ItemStatus }>;
  setRating: Stream<{ rating: number | null }>;
  setNotes: Stream<{ notes: string }>;
}
```

---

# Suggestable Patterns

Lightweight, LLM-powered utility patterns designed as building blocks for the
suggestion system (`system/suggestion.tsx`). Each takes `topic` and `context`
inputs and produces a focused output.

## `suggestable/summary.tsx`

Generates a concise summary of provided context using an LLM.

**Keywords:** summary, generateText, suggestion-fuel

### Input Schema

```ts
type SummaryInput = {
  topic?: Default<string, "">;
  context?: Default<Record<string, any>, Record<string, never>>;
};
```

### Output Schema

```ts
type SummaryOutput = {
  topic: string;
  summary: string;
  pending: boolean;
};
```

## `suggestable/checklist.tsx`

Generates a checklist of actionable steps from a topic and context.

**Keywords:** checklist, generateObject, suggestion-fuel

### Input Schema

```ts
type ChecklistInput = {
  topic?: Default<string, "">;
  context?: Default<Record<string, any>, Record<string, never>>;
};
```

### Output Schema

```ts
type ChecklistItem = {
  label: string;
  done: Default<boolean, false>;
};

type ChecklistOutput = {
  topic: string;
  items: ChecklistItem[];
  pending: boolean;
};
```

## `suggestable/question.tsx`

Generates a clarifying question with optional multiple-choice options.

**Keywords:** question, generateObject, suggestion-fuel

### Input Schema

```ts
type QuestionInput = {
  topic?: Default<string, "">;
  context?: Default<Record<string, any>, Record<string, never>>;
};
```

### Output Schema

```ts
type QuestionOutput = {
  topic: string;
  question: string;
  options: string[];
  answer: Writable<string>;
  pending: boolean;
};
```

## `suggestable/diagram.tsx`

Generates an ASCII diagram illustrating relationships, flows, or structures.
Rendered in a `<pre>` tag with monospace styling.

**Keywords:** diagram, ASCII, generateText, suggestion-fuel

### Input Schema

```ts
type DiagramInput = {
  topic?: Default<string, "">;
  context?: Default<Record<string, any>, Record<string, never>>;
};
```

### Output Schema

```ts
type DiagramOutput = {
  topic: string;
  diagram: string;
  pending: boolean;
};
```

## `suggestable/budget-planner.tsx`

Generates a budget breakdown with editable amounts for each category. The LLM
suggests spending categories that sum to the given budget ceiling.

**Keywords:** budget, generateObject, suggestion-fuel

### Input Schema

```ts
type BudgetInput = {
  topic?: Default<string, "">;
  context?: Default<Record<string, any>, Record<string, never>>;
  maxAmount?: Default<number, 1000>;
};
```

### Output Schema

```ts
type BudgetItem = {
  name: string;
  amount: Default<number, 0>;
};

type BudgetOutput = {
  topic: string;
  items: BudgetItem[];
  total: number;
  remaining: number;
  pending: boolean;
};
```

## `suggestable/people-list.tsx`

Displays people from local data using the wish system.

**Keywords:** people, wish, suggestion-fuel

### Input Schema

```ts
type PersonListInput = Record<string, never>;
```

### Output Schema

```ts
type Person = {
  contact: {
    name: string;
    email: Default<string, "">;
  };
};

type PersonListOutput = {
  people: Person[];
};
```

## `suggestable/event-list.tsx`

Displays events from local data using the wish system.

**Keywords:** events, wish, suggestion-fuel

### Input Schema

```ts
type EventListInput = Record<string, never>;
```

### Output Schema

```ts
type Event = {
  title: string;
  date: string;
  time: string;
  notes: string;
};

type EventListOutput = {
  events: Event[];
};
```

---

# System Patterns

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

## `system/piece-grid.tsx`

A thumbnail tile grid view for pieces with scaled-down ct-render previews.

**Keywords:** grid, pieces, thumbnail, preview, ct-render

### Input Schema

```ts
type Input = {
  pieces: Piece[];
};
```

### Output Schema

```ts
// Returns a 3-column grid view of pieces with live previews
```
