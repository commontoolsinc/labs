# Messaging Integration Architecture

## Status

Draft (revised per architect review)

## Overview

Common Tools needs bidirectional integration with messaging platforms (WhatsApp,
Telegram, Signal, Discord, iMessage, Slack). Some services can authenticate from
a server. Others (iMessage, Signal) can only connect from the user's machine.

Each platform is its own pattern with its own lossless types. Platform-specific
adapters write platform-specific inbound types into platform-specific cells.
Outbound messaging is via per-platform `sendMessage` Stream handlers. A
higher-level "Unified Inbox" pattern can optionally normalize for display, but
normalization is a consumer choice, not a transport requirement.

---

## Two Axes of Integration

The architecture is determined by two independent axes:

| | Server can authenticate | Only user's machine can connect |
|---|---|---|
| **Webhook/push** | Telegram (webhook), Discord, Slack | -- |
| **Polling** | Telegram (getUpdates) | iMessage (chat.db), Signal, WhatsApp/Baileys |

### Axis 1: Where does the connection live?

**Server-side** (toolshed): Telegram bot tokens, Discord bot tokens, Slack bot
tokens, WhatsApp Business API tokens can all be stored and used server-side.
These use the existing infrastructure -- no new architecture needed.

**User's machine** (local daemon): iMessage requires macOS filesystem access.
Signal requires local phone registration via signal-cli. WhatsApp/Baileys
requires local QR code pairing. Only the user's machine can connect.

### Axis 2: What is the connection model?

**Push/webhook**: External service POSTs to a toolshed webhook endpoint. Uses
the existing webhook ingress system (`/api/webhooks/:id` -> `sendToStream()`).
Near-instant delivery.

**Polling**: Adapter periodically checks for new data. Server-side polling uses
`bgUpdater` (60s interval). Local polling uses `fs.watch` or short-interval
timers.

**Persistent connection**: Some protocols (Discord gateway WebSocket, Signal
JSON-RPC, Baileys WebSocket) need a long-lived connection. These cannot use
`bgUpdater` (which is fire-and-forget per tick). They need a dedicated process --
either a toolshed long-running service or the local daemon.

---

## Server-Side Integrations (Existing Infrastructure)

Server-side messaging follows the **same pattern as the Google OAuth
integration** (`packages/toolshed/routes/integrations/google-oauth/`). No new
architecture is needed -- just new integration modules using existing primitives:

1. **Auth/setup**: Toolshed route at `/api/integrations/{service}/` handles bot
   token or OAuth configuration
2. **Inbound (push)**: Register a webhook via the existing webhook ingress
   system. External service POSTs to `/api/webhooks/:id`, toolshed calls
   `sendToStream()` into the pattern's inbox stream cell
3. **Inbound (poll)**: Register the pattern for background updates via
   `setBGCharm()`. The `bgUpdater` handler fetches new messages every 60 seconds
4. **Outbound**: Toolshed integration route proxies send requests to the
   external API

**Example: Telegram webhook mode**

```
1. Toolshed route stores bot token, calls Telegram setWebhook pointing to /api/webhooks/:id
2. Telegram POSTs updates to /api/webhooks/:id
3. Webhook handler calls sendToStream() into the Telegram pattern's inbox
4. Pattern's sendMessage handler calls toolshed route to proxy to Telegram sendMessage API
```

**Example: Telegram polling mode**

```
1. Toolshed route stores bot token, registers charm via setBGCharm()
2. Every 60s, bgUpdater fires, charm calls getUpdates with stored offset
3. New messages pushed to inbox stream
4. Outbound same as webhook mode
```

**Key existing code:**

| Code | Role |
|------|------|
| `packages/toolshed/routes/webhooks/` | Webhook ingress (`sendToStream()`) |
| `packages/toolshed/routes/integrations/google-oauth/` | Auth + `setBGCharm()` template |
| `packages/toolshed/routes/integrations/discord/` | Existing Discord integration |
| `packages/background-charm-service/` | `bgUpdater` polling (60s) |

---

## Common Gateway: Local Daemon (User's Machine Only)

For platforms that can only connect from the user's machine, a standalone Deno
process ("Common Gateway") runs locally, imports the CT runtime library directly,
and bridges local data sources into the cell fabric.

The daemon is scoped strictly to local-only services. Server-side services use
the existing toolshed infrastructure described above.

### Core Architecture

```
                    Common Gateway (Deno process)
                    +----------------------------------+
                    |                                  |
                    |  +----------+  +--------------+  |
                    |  | Platform |  | CT Runtime   |  |
                    |  | Adapters |  | Client       |  |
  Local Data ------+--| iMessage |--| getCellFrom  |--+---- Toolshed API
  Sources          |  | Signal   |  | Link(), sync |  |     (storage)
  (chat.db,        |  | WhatsApp |  | editWithRetry|  |
   signal-cli)     |  +----------+  +--------------+  |
                    |                                  |
                    |  +------------------------------+|
                    |  | Gateway API (localhost:18790) ||
                    |  | - Status / health             ||
                    |  | - QR code display (WhatsApp)  ||
                    |  | - Adapter management          ||
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

### Per-Platform Adapter Notes

**iMessage:**

- Read: SQLite queries on `~/Library/Messages/chat.db`
- Write: AppleScript via `osascript` (macOS only)
- Polling: Watch chat.db for changes via `kqueue`/`fs.watch` or poll every 5-10
  seconds
- macOS only, requires Full Disk Access permission

**Signal:**

- Read/Write: `signal-cli` subprocess with JSON-RPC over stdio (event-driven,
  persistent connection)
- Requires phone number registration and verification
- Cross-platform (Linux/macOS/Windows)

**WhatsApp (local):**

- Read/Write: Baileys library (WhatsApp Web protocol, persistent WebSocket)
- Requires QR code pairing (gateway API serves a QR endpoint)
- Stores credentials locally in `~/.common-gateway/credentials/`
- Note: WhatsApp Business API is server-side, Baileys is local-only

---

## Message Schemas

Each platform defines its own lossless message type that preserves all
platform-specific fields. There is no shared base interface -- each type is fully
self-contained, following the established pattern convention (e.g., how
`gmail-importer.tsx` defines a flat `Email` type with all Gmail-specific fields).

Normalization, if desired, happens at a higher consumer layer.

### Platform-Specific Message Types

```typescript
// iMessage -- preserves all chat.db columns
interface IMessageMessage {
  rowId: number;              // chat.db ROWID
  guid: string;               // iMessage GUID
  text: string | null;
  handleId: string;
  chatGuid: string;           // e.g. "iMessage;+;chat12345"
  service: string;            // "iMessage" | "SMS"
  isFromMe: boolean;
  isDelivered: boolean;
  isRead: boolean;
  timestamp: string;          // ISO 8601
  dateSent: number;           // Core Data timestamp
  threadOriginatorGuid?: string;
  tapbackType?: number;
  associatedMessageGuid?: string;
  attachments?: IMessageAttachment[];
  // ... all other chat.db fields as needed
}

interface IMessageAttachment {
  filename: string;
  mimeType: string;
  transferName: string;
  totalBytes: number;
  // iMessage-specific attachment fields from chat.db
}

// Signal -- preserves signal-cli JSON-RPC fields
interface SignalMessage {
  text: string | null;
  timestamp: number;
  isFromMe: boolean;
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
  attachments?: SignalAttachment[];
  // ... all signal-cli fields
}

interface SignalAttachment {
  contentType: string;
  filename?: string;
  size: number;
  id: string;
  // signal-cli attachment fields
}

// Telegram -- preserves Bot API Update fields
interface TelegramMessage {
  messageId: number;
  text: string | null;
  timestamp: number;          // unix epoch from date field
  isFromMe: boolean;
  from: { id: number; firstName: string; username?: string };
  chat: { id: number; type: string; title?: string };
  replyToMessage?: TelegramMessage;
  forwardFrom?: { id: number; firstName: string };
  editDate?: number;
  entities?: Array<{ type: string; offset: number; length: number }>;
  photo?: Array<{ fileId: string; width: number; height: number }>;
  // ... all Telegram Bot API fields
}

// Discord -- preserves Discord API fields
interface DiscordMessage {
  messageId: string;
  text: string | null;
  timestamp: string;
  isFromMe: boolean;
  channelId: string;
  guildId?: string;
  author: { id: string; username: string; discriminator: string };
  embeds?: Array<Record<string, unknown>>;
  reactions?: Array<{ emoji: string; count: number }>;
  referencedMessage?: DiscordMessage;
  attachments?: DiscordAttachment[];
  // ... all Discord API fields
}

interface DiscordAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  proxyUrl: string;
}
```

### Per-Platform Cell Schemas

Each platform is its own pattern with its own cell types. Messages are stored as
inline data arrays within conversation entities, following the established
pattern convention (e.g., how `chatbot.tsx` stores `messages: BuiltInLLMMessage[]`
inline).

```typescript
// === iMessage Pattern ===

// Inbound: daemon pushes platform-specific messages here
type IMessageInbox = Stream<IMessageMessage>;

// Chat entity -- messages stored inline
type IMessageChat = {
  chatGuid: string;
  displayName?: string;
  participants: string[];       // handle IDs
  messages: IMessageMessage[];  // inline array, not links
  lastActivity: string;
};

// === Signal Pattern ===

type SignalInbox = Stream<SignalMessage>;

type SignalConversation = {
  phoneNumber: string;          // direct message
  groupId?: string;             // group chat
  groupName?: string;
  participants: string[];       // phone numbers
  messages: SignalMessage[];
  lastActivity: string;
};

// === Telegram Pattern ===

type TelegramInbox = Stream<TelegramMessage>;

type TelegramChat = {
  chatId: number;
  chatType: string;
  title?: string;
  messages: TelegramMessage[];
  lastActivity: string;
};

// (Discord, Slack, WhatsApp follow the same per-platform pattern)
```

---

## Per-Platform Send Handlers

Outbound messaging uses per-platform `sendMessage` Stream handlers. Each
platform exposes its own handler with platform-appropriate parameters. The
handler interface is a Stream -- callers call `.send()` which is fire-and-forget.

Stream `.send()` returns `void`. If delivery confirmation is needed, it flows
back through a separate delivery-status cell, not as a return value.

```typescript
// === iMessage ===
type IMessageSend = Stream<{
  chatGuid: string;             // which chat to send to
  text: string;
  replyToGuid?: string;         // iMessage GUID of message to reply to
  attachments?: IMessageAttachment[];
}>;

// === Signal ===
type SignalSend = Stream<{
  phoneNumber?: string;         // direct message recipient
  groupId?: string;             // or group chat
  text: string;
  quoteTimestamp?: number;      // Signal quote by timestamp
  expiresInSeconds?: number;    // disappearing messages
  attachments?: SignalAttachment[];
}>;

// === Telegram ===
type TelegramSend = Stream<{
  chatId: number;               // Telegram chat ID
  text: string;
  replyToMessageId?: number;    // Telegram message ID
  parseMode?: "HTML" | "Markdown";
}>;

// === Discord ===
type DiscordSend = Stream<{
  channelId: string;            // Discord channel ID
  text: string;
  replyToMessageId?: string;    // Discord message ID
  embeds?: Array<Record<string, unknown>>;
}>;
```

### Delivery Status (Optional)

Since Stream sends are fire-and-forget, patterns that need delivery confirmation
observe a separate status cell updated by the daemon or toolshed after the
external API call completes:

```typescript
type DeliveryStatus = {
  pending: number;
  lastError?: string;
  lastDelivered?: string;       // ISO 8601
};
```

---

## Reactive Data Flow

### Inbound (local source -> fabric, daemon only)

- **iMessage:** Poll `chat.db` via `fs.watch`/kqueue on the WAL file, or
  short-interval poll (5-10s). Push new `IMessageMessage` entries via
  `sendToStream()` to the iMessage inbox.
- **Signal:** `signal-cli` JSON-RPC pushes messages as they arrive
  (event-driven, persistent connection). Pushed as `SignalMessage` to inbox.
- **WhatsApp/Baileys:** Event-driven WebSocket (persistent connection). Pushed
  as platform-specific messages to inbox.

### Inbound (server-side, existing infrastructure)

- **Telegram (webhook):** External service POSTs to `/api/webhooks/:id`,
  toolshed calls `sendToStream()`.
- **Telegram (poll):** `bgUpdater` fires every 60s, charm calls `getUpdates`.
- **Discord/Slack:** Webhook ingress or long-running service.

### Outbound (fabric -> external, daemon)

Each platform's `sendMessage` Stream handler is watched by the daemon via
`cell.sink()`. When a pattern sends a message, the sink fires and the daemon
dispatches to the appropriate adapter.

```typescript
// iMessage example
iMessageSendStream.sink((message) => {
  iMessageAdapter.send(message.chatGuid, message.text, message.replyToGuid);
});

// Signal example
signalSendStream.sink((message) => {
  signalAdapter.send(message.phoneNumber, message.text, {
    expiresInSeconds: message.expiresInSeconds,
  });
});
```

### Outbound (fabric -> external, server-side)

Pattern's `sendMessage` handler calls a toolshed integration route that proxies
to the external API (same model as existing Discord integration).

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

- Subscribes to each platform's inbox Stream cells (discovered via `wish()`)
- Projects platform-specific types into a common display format (lossy
  normalization -- only for rendering, not storage)
- Routes outbound replies to the correct per-platform `sendMessage` handler
  based on which conversation the user is viewing
- Individual platform patterns work independently without the Unified Inbox

---

## Comparison with OpenClaw

| Aspect | OpenClaw | Common Tools |
|--------|----------|-------------|
| Runtime | Single Node.js Gateway process | Split: toolshed (server) + daemon (local) |
| Server services | All local | Existing toolshed infra (webhooks, bgUpdater) |
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
one process. CT's approach is distributed -- server-side services use existing
toolshed infrastructure (webhook ingress, `setBGCharm()`, integration routes),
local-only services run in the daemon, and they both write to the same cell
fabric. Each platform is its own pattern with its own lossless types and its own
send handler. This means:

- Server-side services work without the daemon running
- The daemon only handles truly local things (filesystem, local subprocesses)
- State is always available via the web (even if daemon is offline, you see
  last-synced messages)
- No information is lost at the transport layer -- platform-specific features
  (reactions, threads, disappearing messages) are preserved

---

## Open Questions

1. **WhatsApp: server-side or local?** WhatsApp Business API can authenticate
   server-side but requires a business account. Baileys requires local QR
   pairing but is more accessible to individual users. Likely support both.

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

6. **Entity granularity:** Should each message be its own cell entity (using
   `asCell` in the schema), or should messages be stored as inline arrays within
   conversation entities? Existing patterns strongly favor inline arrays, but
   per-message entities enable fine-grained addressability.

7. **Persistent connections server-side:** Discord gateway and Slack socket mode
   need long-lived connections that don't fit the `bgUpdater` model. Should
   these run as dedicated toolshed services, or should webhook mode be the
   default for server-side?

---

## Implementation Roadmap

### Phase 1: Foundation

- [ ] Define per-platform message types (flat, self-contained, lossless)
- [ ] Build Common Gateway skeleton (Deno, runtime client, adapter interface)
- [ ] iMessage adapter with lossless `IMessageMessage` type (read-only)
- [ ] Simple iMessage viewer pattern for testing

### Phase 2: Bidirectional

- [ ] iMessage `sendMessage` Stream handler + AppleScript send
- [ ] Signal adapter with lossless `SignalMessage` type + send handler
- [ ] Per-platform chat UI patterns

### Phase 3: Server-Side Channels

- [ ] Telegram integration in toolshed (webhook ingress + `setBGCharm()` +
      send route, following Google OAuth model)
- [ ] Discord integration upgrade (currently webhook-only, add full messaging)
- [ ] WhatsApp local adapter (Baileys) with lossless type and send handler

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
| `packages/toolshed/routes/webhooks/webhooks.utils.ts` | Runtime cell primitives (`sendToStream`, `getCellFromLink`) |
| `packages/toolshed/routes/webhooks/webhooks.handlers.ts` | Webhook ingress API |
| `packages/toolshed/routes/integrations/google-oauth/` | Auth + `setBGCharm()` template for server-side integrations |
| `packages/toolshed/routes/integrations/discord/` | Existing server-side integration |
| `packages/background-charm-service/` | `bgUpdater` polling (60s interval) |
| `packages/ui/src/v2/components/ct-webhook/` | Webhook UI component |
| `docs/specs/webhook-ingress/README.md` | Webhook system design spec |
