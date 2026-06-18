# Multi-User Patterns

Use this guide when one pattern instance should behave differently for different
people or browser sessions while still sharing common state.

The core design step is deciding the sharing boundary for each field before
building the UI.

| State kind                                                                | Scope           |
| ------------------------------------------------------------------------- | --------------- |
| shared records, rooms, messages, documents, role registries               | `PerSpace<T>`   |
| profile, display name, personal preferences, durable personal drafts      | `PerUser<T>`    |
| selected tab, selected room, modal state, local filter text, focused item | `PerSession<T>` |

If a value should be visible to everyone in the same space, make it
`PerSpace<T>`. If it should follow the authenticated user across tabs and
sessions, make it `PerUser<T>`. If opening the same piece in a new tab should
start with a fresh value, make it `PerSession<T>`.

Scopes are data-addressing boundaries, not authorization boundaries. Use CFC/IFC
policy for enforcement, trusted writes, and role-protected operations.

## Basic Shape

Prefer object-shaped shared state and scoped writable aliases when handlers need
stable cell handles.

```tsx
import {
  Default,
  handler,
  pattern,
  type PerSession,
  type PerSpace,
  type PerUser,
  safeDateNow,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface ChatProfile {
  name: string;
}

const DEFAULT_PROFILE = { name: "" } satisfies ChatProfile;
type ProfileCell = Writable<ChatProfile | Default<typeof DEFAULT_PROFILE>>;

interface ChatMessage {
  authorProfile: ProfileCell;
  authorName: string;
  body: string;
  sentAt: number;
}

interface ChatRoom {
  name: string;
  messages: ChatMessage[] | Default<[]>;
}

interface Conversation {
  rooms: ChatRoom[] | Default<[]>;
}

interface SelectedRoom {
  room?: ChatRoom;
}

const DEFAULT_CONVERSATION = { rooms: [] } satisfies Conversation;

type ConversationCell = Writable<
  Conversation | Default<typeof DEFAULT_CONVERSATION>
>;
type SelectedRoomCell = Writable<
  SelectedRoom | Default<Record<PropertyKey, never>>
>;
type DraftCell = Writable<string | Default<"">>;

interface ChatInput {
  profile?: PerUser<ProfileCell>;
  conversation?: PerSpace<ConversationCell>;
  selectedRoom?: PerSession<SelectedRoomCell>;
  draft?: PerUser<DraftCell>;
}

interface ChatOutput {
  [UI]: VNode;
  profile: PerUser<ProfileCell>;
  conversation: PerSpace<ConversationCell>;
  selectedRoom: PerSession<SelectedRoomCell>;
  draft: PerUser<DraftCell>;
}

const sendMessage = handler<void, {
  profile: ProfileCell;
  conversation: ConversationCell;
  selectedRoom: SelectedRoomCell;
  draft: DraftCell;
}>((_, { profile, conversation, selectedRoom, draft }) => {
  const body = draft.get().trim();
  const currentProfile = profile.get();
  if (!body || !currentProfile.name) return;

  const selectedRoomRef = selectedRoom.key("room");
  const roomRef = selectedRoomRef.get()
    ? selectedRoomRef
    : conversation.key("rooms", 0);
  if (!roomRef.get()) return;

  roomRef.key("messages").push({
    authorProfile: profile,
    authorName: currentProfile.name,
    body,
    sentAt: safeDateNow(),
  });
  draft.set("");
});

export default pattern<ChatInput, ChatOutput>(
  ({ profile, conversation, selectedRoom, draft }) => {
    const send = sendMessage({ profile, conversation, selectedRoom, draft });

    return {
      [UI]: (
        <cf-vstack>
          <cf-input $value={draft} placeholder="Message" />
          <cf-button onClick={send}>Send</cf-button>
        </cf-vstack>
      ),
      profile,
      conversation,
      selectedRoom,
      draft,
    };
  },
);
```

Use a plain data-shaped input style when the pattern should expose a simple API
and only reads values:

```ts
interface ChatInput {
  profile?: PerUser<ChatProfile | Default<typeof DEFAULT_PROFILE>>;
  conversation?: PerSpace<Conversation | Default<typeof DEFAULT_CONVERSATION>>;
  selectedRoom?: PerSession<SelectedRoom | Default<Record<PropertyKey, never>>>;
}
```

Use scoped `Writable` aliases when handlers need `.get()`, `.set()`, `.push()`,
`.key(...)`, or stable cell references.

## Shared Directories And "Me"

For a shared list of participants, keep the directory in `PerSpace<T>` and keep
each viewer's pointer or profile in `PerUser<T>`.

```tsx
interface User {
  displayName: string;
}

interface Directory {
  users: User[] | Default<[]>;
}

interface MyUser {
  user?: User;
}

const DEFAULT_DIRECTORY = { users: [] } satisfies Directory;

type DirectoryCell = Writable<Directory | Default<typeof DEFAULT_DIRECTORY>>;
type MyUserCell = Writable<MyUser | Default<Record<PropertyKey, never>>>;

interface DirectoryInput {
  directory?: PerSpace<DirectoryCell>;
  me?: PerUser<MyUserCell>;
}

const joinAs = handler<{ name: string }, {
  directory: DirectoryCell;
  me: MyUserCell;
}>(({ name }, { directory, me }) => {
  const displayName = name.trim();
  if (!displayName) return;

  const users = directory.key("users");
  users.push({ displayName });
  me.set({ user: users.key(users.get().length - 1) });
});
```

This keeps the participant list shared while letting each authenticated user
remember which entry is theirs. For simpler demos where names are immutable and
unique enough for the domain, a `PerUser<string>` display name plus shared
records that carry that name can also be acceptable.

Source identity from the viewer's **shared profile** rather than a free-text
field: `wish({ query: "#profile" })` resolves the current viewer's profile, and
its built-in `[UI]` covers the whole lifecycle (create surface when the user has
no profile, a picker with inline create when they have several). On join, store
a **link to that profile cell** in the shared entry and render every participant
with a live, visitable `<cf-profile-badge $profile={p.profile} />` — cross-space
reads resolve for any authorized viewer (CT-1667/1687), so the badge stays
current, carries the verified-identity seal, and links to each contributor's
profile. Snapshotting the `#profileName` / `#profileAvatar` strings instead is
the self-containment fallback (renders with remote profile spaces offline). See
`docs/specs/shared-profile-rosters.md`; canonical live-link demo:
`packages/patterns/profile-roster-live-demo.tsx`; worked examples:
`packages/patterns/profile-group-chat/main.tsx`,
`packages/patterns/scrabble/scrabble.tsx`,
`packages/patterns/battleship/multiplayer/lobby.tsx`,
`packages/patterns/lunch-poll/main.tsx`.

**`<cf-profile-badge>` is the one idiomatic way to render an identity** — avatar +
name + the runtime-attested generative seal (a DID-derived aura ring + cursor
glint; there is no shield icon), navigable to the person's profile. Prefer it
anywhere an identity appears (rosters, message authors, "playing as",
scoreboards); inline a name into a string only as an explicit fallback. Four
variants, all carrying the same seal (CT-1761):

| variant | shows | use for |
| ------- | ----- | ------- |
| `full` (default) | avatar + name pill | roster rows, "playing as" |
| `chip` | name + compact seal dot (no avatar) | inline names in dense UI, participant strips |
| `circle` | avatar + seal ring only (name on hover / for AT) | avatar strips, message gutters |
| `hero` | large avatar over name | profile page header (pair with `noNavigate`) |

Storing a live profile **cell** in shared state is what lets every viewer render
the badge. Keep that shared state **object-wrapped** (`{ items: [...] }`, like the
roster's `Roster` or scrabble's `PlayerRoster`) rather than a bare
`Writable<T[]>`: a bare array with a nested live cell unwraps to a weak object and
breaks CTS handler-state / `.get()`-snapshot output typing. Two rules make it
work (see `scrabble.tsx`): type the **input** value-side — `PerSpace<Roster>`,
not `PerSpace<Writable<Roster>>` (handlers still take `Writable<Roster>` state, so
the body uses field access `players.list` while handlers use `.get()`/`.key()`);
and type the **output** as a profile-less view (`Omit<Player, "profile">`) so the
flat `.get()` snapshot doesn't try to reconcile the live cell. With both, the
whole scrabble scoreboard renders `circle` badges for every player.

Do not store user DIDs, session ids, or generated ids only to simulate scoped
visibility. Let `PerUser<T>` and `PerSession<T>` select the right storage
instance. When comparing object or cell identity, use `equals()` instead of
custom `id` fields.

## UI State

Default UI-local state to `PerSession<T>`:

- selected room
- selected tab
- open modal
- local filter text
- focused or highlighted item
- one-tab form state that should not follow the user elsewhere

Use `PerUser<T>` only when the value should persist for that user, such as a
profile, durable preference, or draft that should resume in another tab.

For pattern-owned local cells that are not inputs, use scoped constructors:

```ts
const sharedBoard = new Writable.perSpace(DEFAULT_BOARD);
const displayName = new Writable.perUser("");
const selectedItem = new Writable.perSession<string | null>(null);
```

Plain `new Writable(...)` inherits the containing pattern or factory scope. Use
the scoped constructors when the local cell must have a specific sharing
boundary.

## Authorization And Admin Roles

Scopes decide which data instance a user sees. They do not decide who may write
a protected value.

If a multi-user pattern has admins, moderators, managers, or protected writes:

1. Keep the shared role registry in `PerSpace<T>`.
2. Keep any current-user credential in `PerUser<T>` or a local trusted surface,
   depending on how the credential is granted.
3. Define role names, subjects, and integrity strings beside the owning pattern.
4. Reuse `packages/patterns/cfc/admin/mod.ts` for the registry shape and lookup
   helpers.
5. Use CFC integrity types and trusted surfaces for enforcement.

```ts
import {
  type ActiveAdminRole,
  type AdminManagerCredential,
  adminManagerCredentialIsActive,
  adminRegistryEntries,
  type AdminRegistryValue,
  subjectHasAdminRole,
} from "../cfc/admin/mod.ts";
import { type RequiresIntegrity, type Writable } from "commonfabric";

const CHAT_ADMIN = "chat-admin" as const;
const CHAT_ADMIN_MANAGER = "chat-admin-manager" as const;

type ChatAdminRole = ActiveAdminRole<ProfileCell, typeof CHAT_ADMIN>;
type ChatAdminRegistry = RequiresIntegrity<
  AdminRegistryValue<ChatAdminRole>,
  readonly [typeof CHAT_ADMIN_MANAGER]
>;
type ChatAdminManager = AdminManagerCredential<typeof CHAT_ADMIN_MANAGER>;

type AdminRegistryCell = Writable<ChatAdminRegistry>;
type AdminManagerCell = Writable<ChatAdminManager | null>;

const currentUserCanManageAdmins = (
  manager: AdminManagerCell,
): boolean => adminManagerCredentialIsActive(manager.get());

const currentUserIsAdmin = (
  registry: AdminRegistryCell,
  profile: ProfileCell,
): boolean => subjectHasAdminRole(adminRegistryEntries(registry), profile);
```

For protected writes that must come from reviewed UI, check the shared CFC
helper docs before copying from a demo:

- `packages/patterns/cfc/README.md`
- `packages/patterns/cfc/INDEX.md`
- `docs/common/ai/cfc-helper-authoring-guide.md`

Shared CFC helpers provide reusable policy structure. The pattern still owns its
domain policy: role names, integrity strings, subjects, trusted surfaces, and
which operations require which integrity.

## Mapping Shared Lists

`map` is the normal way to render shared lists. Pass object references or cell
references through handlers instead of inventing lookup ids.

```ts
const roomButtons = conversation.rooms.map((room) => (
  <cf-button onClick={selectRoom({ selectedRoom, room })}>
    {room.name}
  </cf-button>
));
```

For editable nested objects, pass a writable item reference and use `.key(...)`
inside the child pattern or handler.

## Testing Multi-User Behavior

Use pattern tests for deterministic state transitions and browser/integration
tests for identity behavior. A single runtime (or one page that switches
identities) cannot catch cross-user leaks or fails-to-propagate bugs.

Three escalating options:

1. **Multi-user pattern tests (`cf test`)** — the default for pattern
   authors. Export a `multiUserTest({ setup, participants })` descriptor;
   each participant pattern runs in its own isolated runtime against one
   shared space, coordinating via `{ label }` / `{ await }` markers. See the
   "Multi-User Tests" section of `docs/common/ai/pattern-testing-guide.md`
   and the example `packages/patterns/cfc-group-chat-demo/multi-user.test.tsx`.
2. **Multi-runtime integration harness**
   (`packages/patterns/integration/multi-runtime-harness.ts`): opens an
   existing piece in several worker-isolated runtimes (distinct identities,
   or one identity in two sessions); supports trusted-surface CFC events
   headlessly. See `cfc-group-chat-demo-multi-runtime.test.ts`.
3. **Two simultaneous browsers**
   (`cfc-group-chat-demo-two-browsers.test.ts`): guards the real DOM input
   binding / event-provenance / login stack.

Expected visibility:

- `PerSpace<T>` data should be visible to every identity in the same space.
- `PerUser<T>` data should be isolated by active user DID.
- `PerSession<T>` data should be isolated by active user DID and browser/runtime
  session.

When a test is not intentionally multi-user, use one identity everywhere: CLI,
browser, FUSE, and browser-driving agents. When a test is intentionally
multi-user, use separate browser sessions and verify each active DID before
debugging missing data.

See:

- `docs/development/SHARED_IDENTITY.md`
- `docs/common/ai/manual-testing-guide.md`
- `docs/development/debugging/gotchas/scoped-cell-pitfalls.md`

## Good Examples

- `packages/patterns/scoped-group-chat/main-plain-inputs.tsx`: data-shaped
  scoped inputs.
- `packages/patterns/scoped-group-chat/main-with-writable-inputs.tsx`: scoped
  writable aliases for mutation-heavy UI.
- `packages/patterns/scoped-user-directory/`: per-user pointer into a shared
  directory.
- `packages/patterns/battleship/multiplayer/`: shared match state with per-user
  player identity.
- `packages/patterns/cfc-group-chat-demo/`: multi-user chat with CFC-backed
  authorship and admin-protected room creation.

## Checklist

- Shared canonical data is `PerSpace<T>`.
- User-owned durable data is `PerUser<T>`.
- Tab/session-local UI state is `PerSession<T>`.
- Handlers use scoped `Writable` aliases when they need stable cell handles.
- The pattern does not store user ids or session ids to fake isolation.
- Object identity uses references and `equals()`, not synthetic ids.
- Authorization is modeled with CFC/IFC policy, not scopes.
- `PerAny<T>` is reserved for truly scope-polymorphic inner values.
- Multi-user tests verify the active identity for each browser or CLI session.
