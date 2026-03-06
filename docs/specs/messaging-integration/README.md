# Messaging Integration Architecture

## Status

Draft

## Overview

Common Tools needs bidirectional integration with messaging platforms (WhatsApp,
Telegram, Signal, Discord, iMessage, Slack). Some services have public APIs and
can run server-side in toolshed. Others (iMessage, Signal) have no API and
require a local daemon on the user's machine.

Today the only precedent is a crude Deno script that shells out to `ct` CLI
commands every 5 minutes to sync iMessage data. This document designs a proper
architecture.

---

## Two Tiers of Integration

### Tier 1: Server-Side (API-Accessible Services)

**Services:** Telegram (Bot API), Discord (Bot API/webhooks), Slack (Bot API),
WhatsApp Business API

**Architecture:** Toolshed integration modules, following the existing pattern at
`packages/toolshed/routes/integrations/`. Each service gets:

- A toolshed route (`/api/integrations/{service}/`) for OAuth/token setup and
  message sending
- A webhook receiver endpoint for incoming messages (or polling adapter)
- Integration with the existing **webhook ingress system**
  (`/api/webhooks/:id`) to push inbound messages into pattern Stream cells
- A **background-charm-service integration** for scheduled operations (see
  `packages/background-charm-service/CLAUDE.md` for the integration pattern)

**Data flow (inbound):**

```
External Service --> Toolshed webhook endpoint --> sendToStream() --> Pattern Stream cell --> handler
```

**Data flow (outbound):**

```
Pattern handler --> writes to outbox cell --> toolshed watches via cell.sink() --> External Service API
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
sources into the cell fabric.

---

## Common Gateway: Local Daemon Design

### Core Architecture

```
                    Common Gateway (Deno process)
                    +----------------------------------+
                    |                                  |
                    |  +----------+  +--------------+  |
                    |  | Channel  |  | CT Runtime   |  |
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

### Channel Adapter Interface

Each messaging platform implements a common adapter interface:

```typescript
interface ChannelAdapter {
  id: string;           // "imessage", "signal", "whatsapp-local"
  name: string;

  // Lifecycle
  initialize(config: ChannelConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;

  // Inbound: adapter calls this when messages arrive
  onMessage: (msg: NormalizedMessage) => void;

  // Outbound: gateway calls this to send
  send(msg: OutboundMessage): Promise<SendResult>;

  // Status
  status(): ChannelStatus;
}
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

## NormalizedMessage Schema

Both tiers normalize to the same message schema so patterns don't care where
messages came from.

```typescript
interface NormalizedMessage {
  id: string;
  platform: string;       // "imessage" | "signal" | "telegram" | ...
  chatId: string;
  senderId: string;
  senderName?: string;
  text: string | null;
  timestamp: string;       // ISO 8601
  attachments?: Attachment[];
  isFromMe: boolean;
  replyToId?: string;
}

interface Attachment {
  mimeType: string;
  filename?: string;
  url?: string;            // data: URI or http URL
  size?: number;
}

interface OutboundMessage {
  id: string;              // client-generated for dedup
  platform: string;
  chatId: string;
  text: string;
  replyToId?: string;
  attachments?: Attachment[];
}

interface SendResult {
  success: boolean;
  externalId?: string;     // platform-assigned message ID
  error?: string;
}
```

### Cell Schema for Messaging

Patterns that consume messages use standardized cell shapes:

```typescript
// Inbound message stream -- daemon/webhook pushes here
type MessageInbox = Stream<NormalizedMessage>;

// Outbox cell -- pattern writes here, daemon/toolshed watches
type MessageOutbox = {
  pending: OutboundMessage[];
};

// Conversation state -- pattern maintains
type Conversation = {
  chatId: string;
  platform: string;
  participants: Participant[];
  messages: NormalizedMessage[];
  lastActivity: string;
};
```

---

## Reactive Data Flow

The daemon uses **`cell.sink()`** for reactive watching wherever possible, only
falling back to polling when the data source demands it.

### Inbound messages (local source -> fabric)

- **iMessage:** Poll `chat.db` via `fs.watch`/kqueue on the WAL file, or
  short-interval poll (5-10s). Push new messages via `sendToStream()`.
- **Signal:** `signal-cli` JSON-RPC pushes messages as they arrive
  (event-driven, no polling).
- **WhatsApp/Baileys:** Event-driven WebSocket connection (no polling).

### Outbound messages (fabric -> local send)

Daemon calls `cell.sink()` on the outbox cell for each channel. When a pattern
writes an outbound message, the sink fires immediately and the daemon routes to
the appropriate adapter's `send()`.

```typescript
// Reactive outbox watching
outboxCell.sink((outbox) => {
  for (const msg of outbox.pending) {
    const adapter = adapters.get(msg.platform);
    adapter?.send(msg).then(() => {
      removePending(outboxCell, msg.id);
    });
  }
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
   starts enabled channel adapters, sets up `cell.sink()` watchers on outbox
   cells.
3. **Running:** Inbound messages flow reactively into Stream cells. Outbox
   changes fire sink callbacks for outbound delivery.
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

## Unified Messaging Pattern

A single "Unified Inbox" pattern that works with both Tier 1 and Tier 2
services:

```
+----------------------------------------------+
|  Unified Inbox Pattern                       |
|                                              |
|  +-----------+  +-------------------------+  |
|  | Server    |  | Local daemon            |  |
|  | webhooks  |  | streams                 |  |
|  | (Telegram |  | (iMessage, Signal,      |  |
|  |  Discord) |  |  WhatsApp-local)        |  |
|  +-----+-----+  +-----------+-------------+  |
|        |                    |                |
|        +--------+-----------+                |
|                 v                             |
|        NormalizedMessage[]                    |
|        (unified cell)                         |
|                 |                             |
|                 v                             |
|        +----------------+                     |
|        | Chat UI        |                     |
|        | (conversation  |                     |
|        |  list + detail)|                     |
|        +----------------+                     |
+----------------------------------------------+
```

Both tiers normalize to the same `NormalizedMessage` schema. The pattern doesn't
care where messages came from.

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

**Key architectural difference:** OpenClaw is a monolith -- everything runs in
one process. CT's approach is distributed -- server-side services run in
toolshed, local-only services run in the daemon, and they both write to the same
cell fabric. This means:

- Server-side services work without the daemon running
- The daemon only needs to handle truly local things
- State is always available via the web (even if daemon is offline, you see
  last-synced messages)

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

---

## Implementation Roadmap

### Phase 1: Foundation

- [ ] Define `NormalizedMessage` schema and messaging cell conventions in
      `packages/common-gateway/src/types.ts`
- [ ] Build Common Gateway skeleton (Deno, runtime client, adapter interface)
- [ ] iMessage adapter (read-only, based on existing SQLite approach)
- [ ] Simple viewer pattern for testing

### Phase 2: Bidirectional

- [ ] iMessage send via AppleScript
- [ ] Outbox cell convention and daemon-side watcher
- [ ] Chat UI pattern (conversation list + detail + compose)

### Phase 3: More Channels

- [ ] Signal adapter (signal-cli)
- [ ] Telegram server-side integration in toolshed
- [ ] Discord server-side integration (upgrade existing webhook-only)
- [ ] WhatsApp local adapter (Baileys)

### Phase 4: Tauri

- [ ] `deno compile` the gateway into a standalone binary
- [ ] Tauri desktop app wrapping the CT shell
- [ ] Sidecar integration (start/stop gateway from Tauri)
- [ ] QR code pairing UI for WhatsApp within Tauri

### Phase 5: Polish

- [ ] Unified Inbox pattern
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
