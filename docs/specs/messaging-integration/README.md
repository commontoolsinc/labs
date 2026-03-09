# Messaging Integration Architecture

## Status

Draft (revised per architect review)

## Overview

Common Tools needs bidirectional integration with messaging platforms (WhatsApp,
Telegram, Signal, Discord, iMessage, Slack). Some services have public APIs and
can run server-side in toolshed. Others (iMessage, Signal) have no API and
require a local daemon on the user's machine.

Each platform is its own pattern with its own lossless types. Platform-specific
adapters write platform-specific inbound types into platform-specific cells.
Outbound messaging is via per-platform `sendMessage` Stream handlers. A
higher-level "Unified Inbox" pattern can optionally normalize for display, but
normalization is a consumer choice, not a transport requirement.

---

## Two Tiers of Integration

### Tier 1: Server-Side (API-Accessible Services)

**Services:** Telegram (Bot API), Discord (Bot API/webhooks), Slack (Bot API),
WhatsApp Business API

**Architecture:** Toolshed integration modules, following the existing pattern at
`packages/toolshed/routes/integrations/`. Each service gets:

- A toolshed route (`/api/integrations/{service}/`) for OAuth/token setup
- A webhook receiver endpoint for incoming messages (or polling adapter)
- Integration with the existing **webhook ingress system**
  (`/api/webhooks/:id`) to push inbound messages into platform-specific Stream
  cells
- A **background-charm-service integration** for scheduled operations (see
  `packages/background-charm-service/CLAUDE.md` for the integration pattern)
- A per-platform **`sendMessage` Stream handler** for outbound messages

**Data flow (inbound):**

```
External Service --> Toolshed webhook endpoint --> sendToStream() --> Platform-specific Stream cell --> handler
```

**Data flow (outbound):**

```
Pattern --> calls platform sendMessage handler --> toolshed integration --> External Service API
```

**Key existing code to reuse:**

| Code | Role |
|------|------|
| `packages/toolshed/routes/webhooks/` | Webhook ingress system |
| `packages/toolshed/routes/integrations/discord/` | Existing Discord integration model |
| `packages/toolshed/routes/integrations/google-oauth/` | OAuth flow model |
| `packages/background-charm-service/` | Server-side charm execution with `bgUpdater` |
| `packages/ui/src/v2/components/ct-webhook/` | Webhook UI component |

### Tier 2: Local Daemon (No-API Services)

**Services:** iMessage, Signal (via signal-cli), WhatsApp (via Baileys/QR --
inherently local)

**Architecture:** A standalone Deno process ("Common Gateway") that runs on the
user's machine, imports the CT runtime library directly, and bridges local data
sources into the cell fabric. Each platform adapter is its own pattern with its
own types and its own `sendMessage` handler.

---

## Common Gateway: Local Daemon Design

### Core Architecture

```
                    Common Gateway (Deno process)
                    +----------------------------------+
                    |                                  |
                    |  +----------+  +--------------+  |
                    |  | Platform |  | CT Runtime   |  |
                    |  | Patterns |  | Client       |  |
  Local Data ------+--| iMessage |--| getCellFrom  |--+---- Toolshed API
  Sources          |  | Signal   |  | Link(), sync |  |     (storage)
  (chat.db,        |  | WhatsApp |  | editWithRetry|  |
   signal-cli)     |  +----------+  +--------------+  |
                    |                                  |
                    |  +------------------------------+|
                    |  | Gateway API (localhost:18790) ||
                    |  | - Status / health             ||
                    |  | - QR code display (WhatsApp)  ||
                    |  | - Channel management          ||
                    |  +------------------------------+|
                    +----------------------------------+
```

### Communication with the Fabric

The daemon uses the **runtime library directly** (`@commontools/runner`), the
same approach as `background-charm-service`. This means:

- **No CLI shelling** (unlike the existing apple-sync approach of calling
  `ct charm set`)
- **No custom protocol** -- uses the same cell read/write/sync primitives as
  toolshed itself
- **Identity-based auth** -- daemon loads the user's identity key and signs UCAN
  tokens for storage access

**Key runtime primitives** (from
`packages/toolshed/routes/webhooks/webhooks.utils.ts`):

```typescript
// Get a cell reference from a link
const cell = runtime.getCellFromLink(parsedCellLink);
await cell.sync();
await runtime.storageManager.synced();

// Write to a cell
const { error } = await cell.runtime.editWithRetry((tx) => {
  cell.withTx(tx).set(data);
});

// Send to a Stream (for inbound messages)
const streamCell = cell.asSchema({ asStream: true });
streamCell.withTx(tx).send(payload);
```

### Per-Platform Implementation Notes

**iMessage:**

- Read: SQLite queries on `~/Library/Messages/chat.db`
- Write: AppleScript via `osascript` (macOS only)
- Polling: Watch chat.db for changes via `kqueue`/`fs.watch` or poll every 5-10
  seconds
- macOS only, requires Full Disk Access permission

**Signal:**

- Read/Write: `signal-cli` subprocess with JSON-RPC over stdio
- Requires phone number registration and verification
- Cross-platform (Linux/macOS/Windows)

**WhatsApp (local):**

- Read/Write: Baileys library (WhatsApp Web protocol)
- Requires QR code pairing (gateway API serves a QR endpoint)
- Stores credentials locally in `~/.common-gateway/credentials/`
- Note: WhatsApp Business API is Tier 1 (server-side), Baileys is Tier 2

---

## Message Schemas

Each platform defines its own lossless message type that preserves all
platform-specific fields. A common base provides shared structure, but each
platform type is a superset -- nothing is discarded at the transport layer.

### Common Base

```typescript
// Shared fields that every platform message includes
interface MessageBase {
  text: string | null;
  timestamp: string;       // ISO 8601
  isFromMe: boolean;
  attachments?: Attachment[];
}

interface Attachment {
  mimeType: string;
  filename?: string;
  url?: string;            // data: URI or http URL
  size?: number;
}
```

### Platform-Specific Message Types (Lossless)

Each platform extends the base with all of its native fields:

```typescript
// iMessage -- preserves all chat.db columns
interface IMessageMessage extends MessageBase {
  rowId: number;              // chat.db ROWID
  guid: string;               // iMessage GUID
  handleId: string;
  chatGuid: string;           // e.g. "iMessage;+;chat12345"
  service: string;            // "iMessage" | "SMS"
  isDelivered: boolean;
  isRead: boolean;
  dateSent: number;           // Core Data timestamp
  threadOriginatorGuid?: string;
  tapbackType?: number;
  associatedMessageGuid?: string;
  // ... all other chat.db fields as needed
}

// Signal -- preserves signal-cli JSON-RPC fields
interface SignalMessage extends MessageBase {
  envelope: {
    source: string;           // phone number
    sourceDevice: number;
    timestamp: number;
  };
  groupId?: string;
  groupName?: string;
  expiresInSeconds?: number;
  quote?: {
    id: number;
    author: string;
    text: string;
  };
  reaction?: {
    emoji: string;
    targetTimestamp: number;
    targetAuthor: string;
  };
  // ... all signal-cli fields
}

// Telegram -- preserves Bot API Update fields
interface TelegramMessage extends MessageBase {
  messageId: number;
  from: { id: number; firstName: string; username?: string };
  chat: { id: number; type: string; title?: string };
  replyToMessage?: TelegramMessage;
  forwardFrom?: { id: number; firstName: string };
  editDate?: number;
  entities?: Array<{ type: string; offset: number; length: number }>;
  // ... all Telegram Bot API fields
}

// Discord -- preserves Discord API fields
interface DiscordMessage extends MessageBase {
  messageId: string;
  channelId: string;
  guildId?: string;
  author: { id: string; username: string; discriminator: string };
  embeds?: Array<Record<string, unknown>>;
  reactions?: Array<{ emoji: string; count: number }>;
  referencedMessage?: DiscordMessage;
  // ... all Discord API fields
}
```

### Per-Platform Cell Schemas

Each platform is its own pattern with its own cell types. Entities (chats,
messages, participants) are referenced via cell links, not string IDs.

```typescript
// === iMessage Pattern ===

// Inbound: daemon pushes platform-specific messages here
type IMessageInbox = Stream<IMessageMessage>;

// Chat entity -- a fabric entity, referenced by cell link
type IMessageChat = {
  chatGuid: string;
  displayName?: string;
  participants: CellLink[];   // links to contact entities
  messages: CellLink[];       // links to message entities
  lastActivity: string;
};

// === Signal Pattern ===

type SignalInbox = Stream<SignalMessage>;

type SignalConversation = {
  phoneNumber: string;        // direct message
  groupId?: string;           // group chat
  groupName?: string;
  participants: CellLink[];
  messages: CellLink[];
  lastActivity: string;
};

// === Telegram Pattern ===

type TelegramInbox = Stream<TelegramMessage>;

type TelegramChat = {
  chatEntity: CellLink;       // link to the telegram chat entity
  messages: CellLink[];
  lastActivity: string;
};

// (Discord, Slack, WhatsApp follow the same per-platform pattern)
```

---

## Per-Platform Send Handlers

Outbound messaging uses per-platform `sendMessage` Stream handlers instead of a
shared outbox. Each platform exposes its own handler with platform-appropriate
parameters. The handler interface is a Stream -- even if the implementation
internally queues, the caller interacts with a handler, not a data structure.

```typescript
// === iMessage ===
type IMessageSend = Stream<{
  chat: CellLink;             // link to the iMessage chat entity
  text: string;
  replyTo?: CellLink;         // link to a message entity
  attachments?: Attachment[];
}>;

// === Signal ===
type SignalSend = Stream<{
  conversation: CellLink;     // link to the Signal conversation entity
  text: string;
  replyTo?: CellLink;         // link to a message entity
  attachments?: Attachment[];
  expiresInSeconds?: number;  // platform-specific: disappearing messages
}>;

// === Telegram ===
type TelegramSend = Stream<{
  chat: CellLink;             // link to the Telegram chat entity
  text: string;
  replyTo?: CellLink;         // link to a message entity
  parseMode?: "HTML" | "Markdown";  // platform-specific
  attachments?: Attachment[];
}>;

// === Discord ===
type DiscordSend = Stream<{
  channel: CellLink;          // link to the Discord channel entity
  text: string;
  replyTo?: CellLink;         // link to a message entity
  embeds?: Array<Record<string, unknown>>;  // platform-specific
  attachments?: Attachment[];
}>;
```

### Send Result

Each handler returns a platform-specific result:

```typescript
interface SendResult {
  success: boolean;
  externalId?: string;     // platform-assigned message ID
  error?: string;
}
```

---

## Reactive Data Flow

The daemon uses **`cell.sink()`** for reactive watching wherever possible, only
falling back to polling when the data source demands it.

### Inbound messages (local source -> fabric)

- **iMessage:** Poll `chat.db` via `fs.watch`/kqueue on the WAL file, or
  short-interval poll (5-10s). Push new `IMessageMessage` entries via
  `sendToStream()` to the iMessage inbox.
- **Signal:** `signal-cli` JSON-RPC pushes messages as they arrive
  (event-driven, no polling). Pushed as `SignalMessage` to Signal inbox.
- **WhatsApp/Baileys:** Event-driven WebSocket connection (no polling). Pushed
  as platform-specific messages to WhatsApp inbox.

### Outbound messages (fabric -> local send)

Each platform's `sendMessage` Stream handler is watched by the daemon via
`cell.sink()`. When a pattern sends a message through the handler, the sink
fires and the daemon dispatches to the appropriate platform adapter.

```typescript
// Per-platform handler watching (iMessage example)
iMessageSendStream.sink((message) => {
  const chat = resolveEntity(message.chat);  // resolve cell link to chat entity
  const replyTo = message.replyTo
    ? resolveEntity(message.replyTo)
    : undefined;
  iMessageAdapter.send(chat, message.text, replyTo);
});

// Signal example
signalSendStream.sink((message) => {
  const conversation = resolveEntity(message.conversation);
  signalAdapter.send(conversation, message.text, {
    expiresInSeconds: message.expiresInSeconds,
  });
});
```

### Single-Machine Assumption

The daemon runs on one "main" machine per user. Multi-device coordination is out
of scope. The cell fabric naturally prevents data conflicts since there's only
one writer for local-source data.

---

## Daemon Lifecycle

1. **First run:** Interactive setup -- prompts for toolshed URL, identity key
   path, space name. Saves config to `~/.common-gateway/config.json`.
2. **Start:** Loads config, initializes runtime client, connects to storage,
   starts enabled platform adapters, sets up `cell.sink()` watchers on each
   platform's send handler.
3. **Running:** Inbound messages flow reactively into per-platform Stream cells.
   Send handler sinks fire callbacks for outbound delivery.
4. **`--daemon` mode:** Runs as a background process. On macOS, can install as a
   launchd service.

---

## Tauri Integration

### Daemon as Sidecar

The Common Gateway is designed to be bundled as a **Tauri sidecar**:

- Built with `deno compile` to produce a standalone binary
- No external dependencies at runtime (SQLite access via Deno's built-in,
  signal-cli bundled separately)
- Communicates via localhost HTTP API (Tauri frontend <-> Gateway sidecar)
- Tauri manages the sidecar lifecycle (start on app launch, stop on quit)

### Tauri App Structure

```
common-tools-app/
+-- src-tauri/
|   +-- src/main.rs            # Tauri app entry, sidecar management
|   +-- binaries/
|   |   +-- common-gateway-{target-triple}   # deno compile'd binary
|   +-- tauri.conf.json        # externalBin: ["binaries/common-gateway"]
+-- src/                       # Web app (wraps existing shell)
```

### Mobile Considerations (Tauri v2)

- **iOS/Android:** Sidecar binaries won't work on mobile. Use Tauri mobile
  plugins (Swift/Kotlin) for platform-specific messaging access.
- **iOS iMessage:** Not possible -- Apple doesn't expose iMessage to third-party
  apps on iOS.
- **Android SMS:** Possible via Kotlin Tauri plugin using Android's SMS
  ContentProvider.
- **Desktop gets full daemon. Mobile gets a subset via native plugins.**

### Progressive Enhancement Path

1. **Now:** Standalone Deno daemon, works without Tauri
2. **Soon:** Tauri desktop app wraps web shell + bundles daemon as sidecar
3. **Later:** Tauri mobile app with native plugins for mobile-accessible
   messaging
4. **Future:** Daemon auto-updates via Tauri's built-in updater

---

## Unified Inbox Pattern (Higher-Level Consumer)

The Unified Inbox is a **consumer pattern** that optionally normalizes
per-platform messages for display. It is not part of the transport layer --
it subscribes to the per-platform inboxes and projects into a common view.

```
+----------------------------------------------+
|  Unified Inbox Pattern                       |
|  (higher-level normalization consumer)       |
|                                              |
|  +-----------+  +-------------------------+  |
|  | Telegram  |  | iMessage inbox          |  |
|  | inbox     |  | Signal inbox            |  |
|  | Discord   |  | WhatsApp inbox          |  |
|  | inbox     |  | (platform-specific      |  |
|  | (lossless)|  |  lossless types)        |  |
|  +-----+-----+  +-----------+-------------+  |
|        |                    |                |
|        +--------+-----------+                |
|                 v                             |
|        normalize() -- project to             |
|        common display fields                 |
|        (consumer's choice, lossy)            |
|                 |                             |
|                 v                             |
|        +----------------+                     |
|        | Chat UI        |                     |
|        | (conversation  |                     |
|        |  list + detail)|                     |
|        +----------------+                     |
|                 |                             |
|                 v (reply)                     |
|        route to per-platform                  |
|        sendMessage handler                    |
+----------------------------------------------+
```

The Unified Inbox pattern:

- Subscribes to each platform's inbox Stream cells
- Projects platform-specific types into a common display format (lossy
  normalization -- only for rendering, not storage)
- Routes outbound replies to the correct per-platform `sendMessage` handler
  based on which conversation the user is viewing
- Individual platform patterns work independently without the Unified Inbox

---

## Comparison with OpenClaw

| Aspect | OpenClaw | Common Tools |
|--------|----------|-------------|
| Runtime | Single Node.js Gateway process | Split: server-side (toolshed) + local daemon |
| API services | All local | Server-side in toolshed |
| Local services | Same process | Local daemon (Common Gateway) |
| Communication | Internal function calls | Cell fabric (runtime library) |
| State | In-memory + local DB | Reactive cells in shared storage |
| UI | Chat apps themselves | CT patterns (web UI) |
| iMessage | BlueBubbles bridge | Direct SQLite + AppleScript |
| Signal | signal-cli JSON-RPC | signal-cli JSON-RPC (same) |
| Packaging | Docker / systemd | Standalone binary / Tauri sidecar |
| Message types | Normalized at transport | Per-platform lossless, normalize at consumer |
| Outbound | Shared send queue | Per-platform Stream handlers |

**Key architectural difference:** OpenClaw is a monolith -- everything runs in
one process. CT's approach is distributed -- server-side services run in
toolshed, local-only services run in the daemon, and they both write to the same
cell fabric. Each platform is its own pattern with its own lossless types and
its own send handler. This means:

- Server-side services work without the daemon running
- The daemon only needs to handle truly local things
- State is always available via the web (even if daemon is offline, you see
  last-synced messages)
- No information is lost at the transport layer -- platform-specific features
  (reactions, threads, disappearing messages) are preserved

---

## Open Questions

1. **WhatsApp: Tier 1 or Tier 2?** WhatsApp Business API is server-side but
   requires a business account. Baileys (WhatsApp Web protocol) is local but
   more accessible to individual users. Likely support both.

2. **Rate limiting and backpressure:** How to handle high-volume channels
   without overwhelming the cell fabric?

3. **Credential storage:** Where do platform credentials live? Options: local
   keychain (via Tauri's security plugin), encrypted cells in the fabric, or
   local config files.

4. **Message history vs. streaming:** Should the daemon backfill historical
   messages on first connect, or only forward new messages from the point of
   connection?

5. **Attachment storage:** Large media (images, videos) -- store in the cell
   fabric or reference externally?

6. **Entity granularity:** Should each message be its own cell entity, or should
   messages be stored as arrays within conversation entities? Per-message
   entities enable fine-grained linking but increase cell count.

---

## Implementation Roadmap

### Phase 1: Foundation

- [ ] Define per-platform message types and cell schemas in
      `packages/common-gateway/src/types/`
- [ ] Build Common Gateway skeleton (Deno, runtime client)
- [ ] iMessage adapter with lossless `IMessageMessage` type (read-only)
- [ ] iMessage `sendMessage` Stream handler
- [ ] Simple iMessage viewer pattern for testing

### Phase 2: Bidirectional

- [ ] iMessage send via AppleScript (wired to `sendMessage` handler)
- [ ] Signal adapter with lossless `SignalMessage` type
- [ ] Signal `sendMessage` Stream handler
- [ ] Per-platform chat UI patterns

### Phase 3: More Channels

- [ ] Telegram server-side integration in toolshed with `TelegramMessage` type
- [ ] Discord server-side integration with `DiscordMessage` type
- [ ] WhatsApp local adapter (Baileys) with lossless type
- [ ] Each with its own `sendMessage` handler

### Phase 4: Tauri

- [ ] `deno compile` the gateway into a standalone binary
- [ ] Tauri desktop app wrapping the CT shell
- [ ] Sidecar integration (start/stop gateway from Tauri)
- [ ] QR code pairing UI for WhatsApp within Tauri

### Phase 5: Unified Experience

- [ ] Unified Inbox pattern (higher-level normalization consumer)
- [ ] Cross-platform reply routing via per-platform send handlers
- [ ] Notification integration (Tauri native notifications)
- [ ] Mobile Tauri plugins (Android SMS)
- [ ] Auto-update for daemon/app

---

## Key Files Reference

| File | Role |
|------|------|
| `packages/toolshed/routes/webhooks/webhooks.utils.ts` | Runtime cell read/write primitives (sendToStream, getCellFromLink) |
| `packages/toolshed/routes/webhooks/webhooks.handlers.ts` | Webhook ingress API |
| `packages/toolshed/routes/webhooks/webhooks.routes.ts` | Webhook route definitions |
| `packages/toolshed/routes/integrations/discord/` | Existing server-side integration model |
| `packages/background-charm-service/` | Server-side charm execution (bgUpdater pattern) |
| `packages/ui/src/v2/components/ct-webhook/` | Webhook UI component |
| `docs/specs/webhook-ingress/README.md` | Webhook system design spec |
