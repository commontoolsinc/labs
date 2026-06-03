# Live Element Precedents for MyCar on Profile

## Objective

Document existing patterns for instantiating an arbitrary live pattern instance
and registering it discoverable in the system. Goal: add a user's `MyCar`
pattern instance as a LIVE element on their profile, exposing its `selfClaims`
output discoverable via `wish({query:"#car", scope:["profile"]})`.

---

## Survey of Precedents

### 1. Profile Home's addElement Handler & ProfileCatalogCard

**Location:**
`/Users/alex/Code/labs/packages/patterns/system/profile-home.tsx:131–151, 94–103, 106–118`

**What it does:**

- Instantiates lightweight pattern shells (`ProfileCatalogCard`,
  `UrlPatternReference`) on demand
- Registers them into the owner-protected `elements` Writable array via
  `addElement` handler
- Uses `.for(tag)` to give each instance a stable, discoverable identity
- Pattern instances are stored as `cell: any` with metadata (tag, title,
  userTags)

**Implementation detail:**

```tsx
const cell = source === "url"
  ? (UrlPatternReference({ title, url: event.patternUrl ?? "" }) as any).for(
    tag,
  )
  : (ProfileCatalogCard({ title }) as any).for(tag);
appendElement(
  { cell, tag, userTags: event.userTags ?? [], title, source },
  elements,
);
```

**Reusable for MyCar?** ✅ **YES, strong precedent**

- Shows how to instantiate a pattern, stamp it with `.for(tag)`, and push to a
  Writable array
- Mirrors profile-home's ownership model (owner-protected writes via handler)
- Could directly instantiate `MyCar({})` and push to `elements` with
  `tag: CAR_TAG`
- Caveat: ProfileCatalogCard is intentionally minimal (inert display); MyCar is
  a full reactive pattern

---

### 2. The addPiece Handler & addElement Handler Contracts

**Location:** `/Users/alex/Code/labs/docs/common/conventions/adding-pieces.md`,
`/Users/alex/Code/labs/packages/patterns/system/default-app.tsx:120–131`

**What it does:**

- Defines a reusable handler pattern for registering mentionable pieces to a
  list
- `addPiece` sends `{ piece: MentionablePiece }` to a Stream, which then pushes
  to `allPieces`
- Enforces deduplication and type safety via handler contract
- Used by daily-journal to register notes into default-app's piece list

**Implementation detail:**

```tsx
const addPiece = handler<
  { piece: MentionablePiece },
  { allPieces: Writable<MentionablePiece[]> }
>((event, { allPieces }) => {
  const piece = event?.piece;
  if (!piece) return;
  const current = allPieces.get();
  if (!current.some((c) => equals(c, piece))) {
    allPieces.push(piece);
  }
});
```

**Reusable for MyCar?** ✅ **YES, for cross-space registration**

- Best pattern if MyCar needs to be discovered from `#default` or another global
  registry
- Profile-home's `addElement` is the local analogue for profile-scoped
  registration
- MyCar would need to export itself via a handler stream if discoverable at
  default-app level

---

### 3. Email Pattern Launcher's Reactive Pattern Instantiation

**Location:**
`/Users/alex/Code/labs/packages/patterns/google/extractors/email-pattern-launcher.tsx:220–265`

**What it does:**

- Reactively instantiates patterns (via imported pattern functions) in a
  computed loop
- Each pattern is stamped with `.for(patternUri)` for stable identity
- Patterns are stored in a `launchedPatterns` array as
  `{ result: computed(...) }`
- Exposes pattern instances for navigation via `navigateTo(patternInfo.result)`

**Implementation detail:**

```tsx
const launchedPatterns = patternMatches.map((matchInfo) => {
  const compiled = {
    result: computed(() => {
      const patternUri = matchInfo.patternUri;
      const pattern = PATTERNS[patternUri];
      if (!pattern) return null;
      return pattern({} as any).for(patternUri);
    }),
  };
  return { patternUri: matchInfo.patternUri, result: compiled.result, ... };
});
```

**Reusable for MyCar?** ✅ **YES, for reactive instantiation**

- Shows how to wrap pattern instantiation in a computed for reactivity
- Demonstrates `.for(tag)` usage with URI-like identifiers
- Could adapt to create `MyCar` instance reactively within profile-home's render

---

### 4. Home Favorites & Mentionables (Favorites Manager)

**Location:**
`/Users/alex/Code/labs/packages/patterns/system/home.tsx:58–81, 171–172`

**What it does:**

- `addFavorite` handler stores a piece cell + tag + spaceName/Did in a
  `favorites` Writable array
- Each favorite is a
  `{ cell: Writable<...>, tag: string, userTags: [], spaceName?, spaceDid? }`
- Favorites are user-curated references to pieces (not instances, just links)
- Used for cross-space piece referencing (home tracks favorite pieces from other
  spaces)

**Implementation detail:**

```tsx
const addFavorite = handler<
  { piece: Writable<{ [NAME]?: string }>; tag?: string; spaceName?: string },
  { favorites: Writable<Favorite[]> }
>(({ piece, tag, spaceName }, { favorites }) => {
  const current = favorites.get();
  if (!current.some((f) => f && equals(f.cell, piece))) {
    favorites.push({
      cell: piece,
      tag: schemaTag,
      userTags: [],
      spaceName,
      spaceDid,
    });
  }
});
```

**Reusable for MyCar?** ⚠️ **PARTIAL, for discovery metadata**

- Shows how to store piece references with tags for later query
- Home's `favorites` is for user-curated links, not auto-added patterns
- Could reuse the `{ cell, tag, userTags }` structure for profile elements
- Profile-home's `elements` is the closer fit (profile-local, handler-driven)

---

### 5. CFC Group Chat Demo's Pattern Composition & Cell Sharing

**Location:**
`/Users/alex/Code/labs/packages/patterns/cfc-group-chat-demo/main.tsx:250–294, 403–418`

**What it does:**

- Composes multiple child patterns (SharedTranscript, RoomsList,
  TrustedProfileSaveSurface, etc.)
- Passes typed cell references to each child pattern (MyProfileCell,
  SharedMessagesCell, etc.)
- Each child pattern is instantiated via direct function call with cell inputs
- Parent pattern exposes composed cells for external discovery via output
  interface

**Implementation detail:**

```tsx
const SharedTranscript = pattern<SharedTranscriptInput, { [NAME]: string; [UI]: any }>(
  ({ myProfile, messages, id }: SharedTranscriptInput) => { ... }
);
// Composed into parent:
{SharedTranscript({
  myProfile: myProfileCell,
  messages: messagesCell,
  id: "trusted-conversation-preview",
} as SharedTranscriptInputArg)}
```

**Reusable for MyCar?** ⚠️ **PARTIAL, for cell-aware composition**

- Shows composition of patterns with shared/passed cells
- MyCar needs to be instantiated within profile-home's context and own its state
  cells
- Not directly applicable: group chat composes pre-defined child types;
  profile-home adds arbitrary patterns dynamically

---

### 6. Profile-Aware Writer's Wish-Based Discovery

**Location:**
`/Users/alex/Code/labs/packages/patterns/examples/profile-aware-writer.tsx:31–40`

**What it does:**

- Discovers a profile cell via
  `wish<Cell<string>>({ query: "#learnedSummary" })`
- Reads the profile context and uses it in a computed `systemPrompt`
- No instantiation or registration; pure consumption of a wished-for element

**Implementation detail:**

```tsx
const profile = wish<Cell<string>>({ query: "#learnedSummary" });
const systemPrompt = computed(() => {
  const profileText = profile.result!.get();
  return `You are a helpful writing assistant.${profileSection}Write content personalized to the user...`;
});
```

**Reusable for MyCar?** ❌ **NO, read-only consumption**

- Only reads from wished elements; doesn't show how to instantiate or register
- Profile-aware writer consumes what another pattern publishes, not the inverse
- Relevant for how _other_ patterns would consume `#car` tag, not how to make it
  discoverable

---

### 7. Shared Profile Demo's Wish-Based Render

**Location:**
`/Users/alex/Code/labs/packages/patterns/shared-profile-demo/main.tsx:1–32`

**What it does:**

- Wishes for profile and profileName via `wish({ query: "#profile" })`
- Uses `cf-render` to dynamically render the wished profile pattern
- Each user resolves their own profile when viewing the shared pattern

**Implementation detail:**

```tsx
const profileWish = wish({ query: "#profile" });
const displayName = computed(() =>
  (profileWish.result as { initialNameApplied?: string } | undefined)
    ?.initialNameApplied ?? "No profile"
);
return { [UI]: <cf-render $cell={profile as any} /> };
```

**Reusable for MyCar?** ⚠️ **PARTIAL, for wish-based discovery**

- Shows how to discover a pattern instance via wish + render
- Each user's profile is auto-discovered when shared pattern loads
- Could apply to MyCar if it's published with a tag and rendered via `cf-render`
- Caveat: doesn't show how to _register_ the instance, only how to _consume_ it

---

### 8. Note Pattern Creation & Default-App Registration (Daily Journal)

**Location:**
`/Users/alex/Code/labs/packages/patterns/notes/daily-journal.tsx:80–107, 145–177`
(addNote handler)

**What it does:**

- Creates a new Note pattern instance on user action
- Simultaneously adds it to local journal entries AND broadcasts to default-app
  via `addPiece`
- Uses wish to get the `addPiece` handler from default-app:
  `wish<{ addPiece: Stream }>({ query: "#default" })`
- Sends `{ piece: note }` to the handler to globally register the piece

**Implementation detail:**

```tsx
const { addPiece } = wish<{ addPiece: Stream<{ piece: MentionablePiece }> }>({
  query: "#default",
}).result!;

const addNote = handler<
  CreateNoteEvent,
  { entries: Writable<Note[]>; addPiece: Stream }
>((_event, { entries, addPiece }) => {
  const note = Note({ title: "New Note", content: "", noteId: generateId() });
  entries.push(note);
  addPiece.send({ piece: note as any });
  return navigateTo(note);
});
```

**Reusable for MyCar?** ✅ **YES, for global + local registration**

- Dual registration: local (profile entries) + global (default-app)
- MyCar could use this pattern: instantiate, add to profile `elements`, _and_
  broadcast to default-app
- Strongest pattern for discoverable global registration via wish

---

## Comparative Table

| Precedent                  | File:Line                            | Instantiation                      | Registration                          | Discovery                          | Reusable?      |
| -------------------------- | ------------------------------------ | ---------------------------------- | ------------------------------------- | ---------------------------------- | -------------- |
| **Profile addElement**     | profile-home.tsx:131–151             | `Pattern({...}).for(tag)`          | Push to `elements` Writable + handler | Profile-scoped; iterate `elements` | ✅ **STRONG**  |
| **addPiece Handler**       | default-app.tsx:120–131              | Via handler input                  | Handler pushes to `allPieces`         | Global via `#default` wish         | ✅ **STRONG**  |
| **Email Pattern Launcher** | email-pattern-launcher.tsx:220–265   | `pattern({}).for(uri)` in computed | Stored in `launchedPatterns` array    | Array iteration + `navigateTo`     | ✅ **PATTERN** |
| **Home Favorites**         | home.tsx:58–81                       | Piece cell (not instance)          | Handler pushes to `favorites`         | Tag + space lookup                 | ⚠️ **PARTIAL** |
| **CFC Group Chat**         | cfc-group-chat-demo/main.tsx:250–294 | Direct function call               | Shared via output interface           | Pattern composition                | ⚠️ **PARTIAL** |
| **Profile-Aware Writer**   | profile-aware-writer.tsx:31–40       | N/A (consumes only)                | N/A                                   | Via wish + render                  | ❌ **NO**      |
| **Shared Profile Demo**    | shared-profile-demo/main.tsx:1–32    | N/A (consumes only)                | N/A                                   | Via wish + cf-render               | ⚠️ **PARTIAL** |
| **Daily Journal**          | daily-journal.tsx:80–107             | `Note({...})`                      | Dual: local + `addPiece` stream       | Local + global (#default)          | ✅ **STRONG**  |

---

## Strongest Reusable Precedents

### 1. **Profile Home's addElement Pattern (PRIMARY)**

- **File:**
  `/Users/alex/Code/labs/packages/patterns/system/profile-home.tsx:131–151`
- **Why:** Direct fit for profile-scoped pattern instances with handler-driven
  registration
- **Reuse:** Instantiate `MyCar({})`, wrap with `.for(CAR_TAG)`, push via
  `appendElement` handler
- **Caveat:** ProfileCatalogCard is inert; MyCar is live. Requires wrapping
  MyCar instance as a profile element cell

**Pseudocode:**

```tsx
const addCarElement = handler<void, { elements: Writable<ProfileElement[]> }>(
  (_, { elements }) => {
    const carInstance = (MyCar({}) as any).for(CAR_TAG); // instantiate + stamp
    appendElement({
      cell: carInstance,
      tag: CAR_TAG,
      title: "My Car",
      userTags: [],
    }, elements);
  },
);
```

### 2. **Daily Journal's Dual Registration Pattern (SECONDARY)**

- **File:**
  `/Users/alex/Code/labs/packages/patterns/notes/daily-journal.tsx:80–107`
- **Why:** Enables both profile-local discovery AND global discovery via `#car`
  query
- **Reuse:** After adding MyCar to profile `elements`, broadcast to default-app
  via `addPiece` stream
- **Benefit:** MyCar discoverable both via
  `wish({ query: "#car", scope: ["profile"] })` AND `wish({ query: "#car" })`
  (global)

**Pseudocode:**

```tsx
const { addPiece } = wish<{ addPiece: Stream<{ piece: MentionablePiece }> }>({
  query: "#default",
}).result!;

// In profile-home:
const addCarElement = handler<void, { elements: Writable<ProfileElement[]>; addPiece: Stream }>(
  (_, { elements, addPiece }) => {
    const carInstance = (MyCar({}) as any).for(CAR_TAG);
    appendElement({ cell: carInstance, tag: CAR_TAG, ... }, elements);
    addPiece.send({ piece: carInstance as any }); // also broadcast globally
  }
);
```

---

## Recommended Approach for MyCar

**Step 1:** Adapt profile-home's `addElement` handler to instantiate `MyCar({})`
on demand

- Instantiate: `const myCar = MyCar({}).for(CAR_TAG);`
- Store: `appendElement({ cell: myCar, tag: CAR_TAG, ... }, elements);`

**Step 2 (Optional Global Discovery):** Broadcast to default-app's `addPiece`
handler

- Wish for `#default` in profile-home (if not already done)
- Send `{ piece: myCar }` to the `addPiece` stream
- Enables global discovery: `wish({ query: "#car" })` from anywhere

**Step 3 (Profile-Scoped Discovery):** Export `elements` with tag metadata

- Profile-home already exports `elements` array
- Consumers call `wish({ query: "#car", scope: ["profile"] })` to find MyCar
  instance in profile elements

---

## Design Notes

1. **Pattern vs. Inert Container:** Profile-home currently uses inert
   `ProfileCatalogCard` + `UrlPatternReference` shells. MyCar is a full reactive
   pattern. The `.for(tag)` mechanism works for both.

2. **Ownership & Authorization:** Profile-home uses owner-protected CFC types
   for `elements`. MyCar's `selfClaims` is similarly owner-protected. Ensure
   ownership context is preserved through the cell reference.

3. **Discovery Mechanism:** A profile element IS discoverable at profile scope
   by its `userTags` — `wish({ query: "#car", scope: ["profile"] })` searches
   `profileDefault.elements` and matches `userTags` first (then `tag`). So MyCar
   only needs `userTags: ["car"]`; no extra export from profile-home is required
   (see live-element-feasibility.md Q2). A `default-app` `addPiece` broadcast
   (the daily-journal pattern) is only needed for GLOBAL discovery via
   `wish({ query: "#car" })` _without_ the profile scope.

4. **Reactive vs. Static:** Email-pattern-launcher shows reactive instantiation
   in a computed. For profile, instantiation likely happens on user action (add
   button), not reactively.
