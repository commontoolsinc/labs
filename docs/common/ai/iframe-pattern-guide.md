# Iframe-first pattern guide

Use this guide to build a Common Fabric pattern whose application lives inside
one sandboxed `cf-iframe`. The wrapper is deliberately mechanical: it exposes
three named Cell resources (`input`, `state`, and `output`), optionally exposes
SQLite databases, embeds the guest and its dependencies into one HTML string,
and returns the state and output through the normal pattern result.

No other pattern guide is required for this shape.

## Source layout

Keep these files together:

```text
packages/patterns/quick-notes/
├── contract.ts  # input, durable state, output, scopes, optional databases
├── guest.ts     # the iframe application; guest.tsx is also accepted
├── guest.html   # optional custom document shell
└── main.tsx     # generated wrapper; do not hand-edit
```

The generated `main.tsx` contains the bundled guest. Deploying the pattern does
not require a guest module server or a second build artifact. Keep the source
guest and contract beside it so regeneration remains possible.

## Describe the data contract

Create `contract.ts`. The three data types are intentionally explicit:

- `IframeInputData` is supplied when the pattern is instantiated. The guest
  receives it as a read-only Cell.
- `IframeStateData` is durable application state the guest may change.
- `IframeOutputData` is the public result the guest may change and the wrapper
  returns to callers.

Keep this module declarative and free of side effects. The wrapper helper
imports it to read the defaults and `IFRAME_PATTERN` configuration.

```typescript
interface Note {
  id: string;
  text: string;
}

export interface IframeInputData {
  heading: string;
  seedNotes: Note[];
}

export interface IframeStateData {
  notes: Note[];
  selectedId: string | null;
}

export interface IframeOutputData {
  noteCount: number;
  selectedId: string | null;
}

export const DEFAULT_INPUT: IframeInputData = {
  heading: "Quick notes",
  seedNotes: [],
};

export const DEFAULT_STATE: IframeStateData = {
  notes: [],
  selectedId: null,
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  noteCount: 0,
  selectedId: null,
};

export const IFRAME_PATTERN = {
  name: "QuickNotes",
  displayName: "Quick notes",
  stateScope: "space",
  outputScope: "space",
  frameHeight: "100vh",
  databases: {},
} as const;
```

`name` is a TypeScript identifier used for the generated interfaces. The three
available scopes are:

| Scope | Meaning |
| --- | --- |
| `space` | Shared by every user and session in the piece |
| `user` | Separate for each user, shared by that user's sessions |
| `session` | Separate for each browser session |

Choose scope independently for state and output. Do not put transient DOM state
such as hover or an open tooltip in a Fabric Cell; keep that inside the guest.

## Write the guest

The guest is an ordinary browser entry. The wrapper bundles it, including its
imports, into the iframe document. A small DOM guest can start like this:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { DEFAULT_INPUT, DEFAULT_OUTPUT, DEFAULT_STATE } from "./contract.ts";

const fabric = connectFabric();
const input = fabric.cell<typeof DEFAULT_INPUT>("input");
const state = fabric.cell<typeof DEFAULT_STATE>("state");
const output = fabric.cell<typeof DEFAULT_OUTPUT>("output");

const root = document.querySelector<HTMLDivElement>("#root")!;
const heading = document.createElement("h1");
const add = document.createElement("button");
add.textContent = "Add note";
root.append(heading, add);

const render = () => {
  heading.textContent = input.get()?.heading ?? "Loading";
};

const stops = [input.sink(render), state.sink(render), output.sink(render)];
void Promise.all([input.pull(), state.pull(), output.pull()]);

add.addEventListener("click", () => {
  const note = { id: crypto.randomUUID(), text: "New note" };
  void state.key("notes").push(note).then(async () => {
    const current = await state.pull();
    await output.set({
      noteCount: current.notes.length,
      selectedId: current.selectedId,
    });
  });
});

globalThis.addEventListener("pagehide", () => {
  stops.forEach((stop) => stop());
  fabric.disconnect();
}, { once: true });
```

The Cell contract matches the rest of Common Fabric:

- `get()` synchronously samples the guest cache and may be stale or undefined.
- `pull()` waits for the host Cell's full update barrier, including work that
  must settle before that value is current.
- `sink(listener)` calls the listener synchronously with `get()`, then calls it
  for later values. Call `pull()` when the first render needs fresh data.
- `key(nameOrIndex)` derives a path-specific handle. Its sink observes that path
  rather than the whole root value.
- `set(value)` replaces a value. `update(fn)` serializes a read-modify-write
  against other operations on the same root.
- `push(...values)` sends a mergeable array append and conflicts less than
  reading and replacing the entire array.

An array index is a position, not an identity. Resolve the item before keeping a
long-lived subscription or write target:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import { DEFAULT_STATE } from "./contract.ts";

const fabric = connectFabric();
const state = fabric.cell<typeof DEFAULT_STATE>("state");
const notes = state.key("notes");
await notes.pull();
const note = await notes.key(0).resolve();
const stop = note.key("text").sink((text) => console.log(text));
await note.key("text").set("Still the same note after a reorder");
```

`resolve()` returns an opaque capability anchored to the entity document. The
guest may inspect its identity metadata, but it cannot turn an arbitrary ID into
authority. Write through the resolved handle.

### React guests

React belongs to the guest bundle, not the wrapper. Import the React instance
chosen by the guest and pass that exact instance to
`createFabricReact(React, fabric)` from
`@commonfabric/iframe-sandbox/react`. Its `useCell(name)` hook uses
`useSyncExternalStore`, returns `loading`, `ready`, or `error`, accepts a value or
functional setter, and exposes `refresh()` as the explicit pull. The direct Cell
API remains useful for fine-grained `key(...).sink(...)` subscriptions and
stable resolved items.

## Optional SQLite

Declare database tables in `IFRAME_PATTERN`. The wrapper creates the database,
adds it to the iframe context, and marks it as a SQLite resource:

```typescript
export const IFRAME_PATTERN = {
  name: "QuickNotes",
  displayName: "Quick notes",
  stateScope: "session",
  outputScope: "space",
  frameHeight: "100vh",
  databases: {
    appDatabase: {
      scope: "user",
      tables: {
        notes: {
          id: "integer primary key",
          text: "text not null",
        },
      },
    },
  },
} as const;
```

Use it from the guest by its declared name:

```typescript
// Shown at module scope.
import { connectFabric } from "@commonfabric/iframe-sandbox/guest";

const fabric = connectFabric();
const database = fabric.sqlite("appDatabase");
const refreshRows = async () => {
  const { rows } = await database.query<{ id: number; text: string }>(
    "SELECT id, text FROM notes ORDER BY id",
  );
  return rows;
};
await database.exec(
  "INSERT INTO notes (text) VALUES (?)",
  ["Stored for this user"],
);
const rows = await refreshRows();
const stop = database.sink(() => void refreshRows());
```

SQLite scopes have the same `space`, `user`, and `session` meanings as Cells.
An active query should use `sink()` to refresh after committed writes.
Database resource names, table names, and column names are data rather than
generated TypeScript bindings. They may use reserved words. When the exact name
`__proto__` is required in `contract.ts`, write it as a computed property
(`["__proto__"]`) so JavaScript creates an own property.

## Generate the wrapper

Run the checked-in helper from the repository root:

```bash
deno run -A skills/pattern-iframe/scripts/write-wrapper.ts \
  --contract packages/patterns/quick-notes/contract.ts \
  --guest packages/patterns/quick-notes/guest.ts \
  --out packages/patterns/quick-notes/main.tsx
```

The helper refuses to overwrite a file. Pass `--force` when regenerating the
same `main.tsx` after changing the contract or guest.

For a custom HTML shell, put `<!-- PATTERN_IFRAME_SCRIPT -->` exactly once where
the bundled module should run, then add `--html .../guest.html`. Without it, the
helper supplies a complete document with `<div id="root"></div>`.

## Verify

Format and compile the result:

```bash
deno fmt packages/patterns/quick-notes
deno task cf check packages/patterns/quick-notes/main.tsx --no-run
```

Then run the pattern and exercise its meaningful interaction. Check that input
renders, state survives at its declared scope, output changes only when the
guest intends, and any SQLite data has the declared isolation. A generated
wrapper that compiles but never loads the guest is not complete.
