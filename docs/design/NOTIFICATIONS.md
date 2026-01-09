# Common Tools Notification System Design

> **Status**: Draft v2
> **Date**: 2026-01-09
> **Branch**: `feat/notifications-system`

---

## Executive Summary

This document describes the design for a notification system in Common Tools. The system enables patterns to notify users about content requiring attention, with an inbox pattern aggregating notifications across all spaces.

**Core Philosophy** (inspired by Android):
- Notifications are **persistent information layers**, not ephemeral alerts
- Notifications are a **TODO list** of pending attention, not an interrupt stream
- **User agency is paramount** - users control their attention budget
- **High integrity** - clicking always shows current, live content
- **Two state machines** - notification state and content seen state are separate

---

## The Two State Machines Model

This is the foundational insight of the design, derived from Android's 15-year evolution.

### Why Two State Machines?

In Android, there's a clear separation:
1. **Content state** (e.g., "is this email read?") - owned by the app, synced across devices
2. **Notification state** (e.g., "is this notification dismissed?") - owned by the OS, per-device

When you read an email on your phone:
- Gmail marks the *email* as read (app state, shared)
- Android dismisses the *notification* (OS state, local)
- Your tablet's notification also clears (because Gmail syncs read state)

**The notification system doesn't own "read" state. The app owns it. The notification system observes it.**

### State Machine 1: Content Seen State (Source-Owned)

This is the *semantic* state - "has this user seen this content?"

```
CONTENT SEEN STATE (per-user, owned by source app or user's projection)

  ┌──────────┐                      ┌──────────┐
  │  UNSEEN  │ ────────────────────►│   SEEN   │
  └──────────┘   user views content └──────────┘
                 in source app
```

Where this state lives depends on the scenario:
- **Single-user pattern**: `seen: boolean` on the source cell
- **Multi-user pattern**: User's annotation in their projection space

### State Machine 2: Notification State (Inbox-Owned)

This is the *attention management* state - "what should I do with this notification?"

```
NOTIFICATION STATE (per-user, owned by inbox)

                                        ┌───────────┐
                                        │  SNOOZED  │
                                        │ (returns  │
                                        │  later)   │
                                        └─────┬─────┘
                                              │ timer expires
                                              ▼
┌──────────┐   user glances    ┌──────────┐   user dismisses   ┌───────────┐
│  ACTIVE  │ ─────────────────►│ NOTICED  │ ──────────────────►│ DISMISSED │
│(new,loud)│                   │(seen in  │                    │(archived) │
└──────────┘                   │ inbox)   │                    └───────────┘
     │                         └──────────┘                          ▲
     │                               │                               │
     │                               │ user snoozes                  │
     │                               ▼                               │
     │                         ┌───────────┐                         │
     │                         │  SNOOZED  │                         │
     │                         └───────────┘                         │
     │                                                               │
     └─────────────── user dismisses directly ───────────────────────┘
```

### Independence of the Two Machines

The two state machines are **linked but independent**:

| Action | Content State | Notification State |
|--------|---------------|-------------------|
| User dismisses notification | Unchanged | → DISMISSED |
| User views content in app | → SEEN | Can auto-transition or stay |
| User snoozes notification | Unchanged | → SNOOZED |
| Content marked seen elsewhere | → SEEN | Inbox observes, can react |

This independence enables:
- Dismiss notification without viewing content ✓
- View content without dismissing notification ✓
- View content → auto-dismiss notification ✓ (reactive, optional)
- Snooze notification for later ✓

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SHELL LAYER                                     │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────────────────┐   │
│  │ HeaderView   │  │ NotificationBell │  │ NotificationDropdown         │   │
│  │              │──│ (badge count)    │──│ (entry list, actions)        │   │
│  └──────────────┘  └──────────────────┘  └──────────────────────────────┘   │
│         │                   │                        │                       │
│         └───────────────────┼────────────────────────┘                       │
│                             │                                                │
│                    ┌────────▼────────┐                                       │
│                    │ InboxController │ ← wish('#inbox')                      │
│                    └────────┬────────┘                                       │
└─────────────────────────────┼───────────────────────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────────────────────┐
│                      RUNTIME LAYER                                           │
│                              │                                               │
│  ┌───────────────────────────▼───────────────────────────────────────────┐  │
│  │                     HOME SPACE (User's DID)                            │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │  INBOX PATTERN (tagged #inbox)                                    │ │  │
│  │  │                                                                   │ │  │
│  │  │  entries[]          - Notification state (ACTIVE/NOTICED/etc)    │ │  │
│  │  │  unseenCount        - Computed: active entries with unseen content│ │  │
│  │  │  send: Stream       - Handler adds entries, validates            │ │  │
│  │  │                                                                   │ │  │
│  │  │  Observes content seen state via cross-space subscriptions       │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  │                                                                        │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │  USER'S PROJECTION SPACE (for multi-user content)                 │ │  │
│  │  │                                                                   │ │  │
│  │  │  Annotations: { source: ref, seen: true, seenAt: Date }          │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│               │ Cross-space refs (NormalizedLink)                            │
│               ▼                                                              │
│  ┌────────────────────────────┐  ┌────────────────────────────────┐         │
│  │ SOURCE SPACE A (single)    │  │ SOURCE SPACE B (multi-user)    │         │
│  │ ┌────────────────────────┐ │  │ ┌────────────────────────────┐ │         │
│  │ │ Todo Cell              │ │  │ │ Message Cell               │ │         │
│  │ │ { task, seen: bool }   │ │  │ │ { content, author }        │ │         │
│  │ │                        │ │  │ │ // NO seen field!          │ │         │
│  │ │ Single-user: seen here │ │  │ │ // seen in user projection │ │         │
│  │ └────────────────────────┘ │  │ └────────────────────────────┘ │         │
│  └────────────────────────────┘  └────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Data Model

### Inbox Entry (Notification State)

```typescript
interface InboxEntry {
  id: string;                              // Unique entry ID
  ref: NormalizedLink;                     // Cross-space reference to source

  // Notification state (inbox-owned)
  state: NotificationState;
  priority: Priority;
  addedAt: Date;
  noticedAt?: Date;                        // When user first saw in inbox
  snoozedUntil?: Date;

  // Seen strategy for this notification
  seenStrategy: SeenStrategy;

  // Cached data for display/offline
  cachedName?: string;                     // Last known [NAME]
  sourceSpaceName?: string;
}

type NotificationState =
  | 'active'      // In inbox, demanding attention
  | 'noticed'     // User has seen it exists (opened inbox)
  | 'dismissed'   // User archived/swiped away
  | 'snoozed';    // Temporarily hidden

type Priority = 'low' | 'normal' | 'high' | 'urgent';
```

### Seen Strategy

How the inbox determines if content has been seen:

```typescript
type SeenStrategy =
  | { type: 'source-field' }                    // Source has `seen: boolean`
  | { type: 'source-multi'; field?: string }    // Source has `seenBy: DID[]`
  | { type: 'annotation'; field?: string }      // Check user's projection space
  | { type: 'manual' };                         // Only manual dismiss, no auto-clear

// Default detection:
// - Source has `seen: boolean` → 'source-field'
// - Source has `seenBy` → 'source-multi'
// - Neither → 'manual'
```

### Notification Payload (for sending)

```typescript
interface NotificationPayload {
  ref: NormalizedLink;                     // Reference to content cell

  // Optional overrides
  seenStrategy?: SeenStrategy;             // How to check seen state
  priority?: Priority;
  channel?: string;                        // Future: grouping/filtering
  hints?: {
    title?: string;                        // Override display title
    icon?: string;
  };
}
```

### Inbox Pattern Interface

```typescript
interface InboxInterface {
  // State
  entries: Cell<InboxEntry[]>;

  // Computed (reactive)
  activeCount: Cell<number>;               // Entries in 'active' state
  unseenCount: Cell<number>;               // Active entries with unseen content

  // Actions
  send: Stream<NotificationPayload>;       // Add notification
  dismiss: Stream<{ id: string }>;         // Archive notification
  snooze: Stream<{ id: string; until: Date }>;
  markNoticed: Stream<{ id: string }>;     // User saw it in inbox
}
```

---

## Content Seen State: Three Approaches

### Approach 1: Single-User (Simple)

For patterns with one user, put `seen` on the source cell:

```typescript
// patterns/todo-list.tsx
interface TodoItem {
  title: string;
  done: boolean;
  seen: boolean;  // Simple and direct
}

// When item created, notify
handler(onNewItem, (item) => {
  notify({ ref: item });  // Auto-detects seenStrategy: 'source-field'
});

// When user views, mark seen (notification auto-clears)
function onItemViewed(item: TodoItem) {
  item.seen = true;
}
```

### Approach 2: Multi-User with Source Tracking (Privacy Tradeoff)

For multi-user patterns where it's OK to share who's seen what:

```typescript
// patterns/team-updates.tsx
interface Announcement {
  title: string;
  body: string;
  seenBy: DID[];  // Everyone can see who's read it
}

// Notify all team members
handler(onNewAnnouncement, async (announcement, { teamMembers }) => {
  for (const member of teamMembers) {
    await notifyUser(member, {
      ref: announcement,
      seenStrategy: { type: 'source-multi', field: 'seenBy' },
    });
  }
});

// When user views
function onViewed(announcement: Announcement, viewer: DID) {
  if (!announcement.seenBy.includes(viewer)) {
    announcement.seenBy.push(viewer);
  }
}
```

### Approach 3: Multi-User with Annotations (Private, Preferred)

For multi-user patterns where seen state should be private:

```typescript
// patterns/chat.tsx
interface Message {
  content: string;
  author: DID;
  timestamp: Date;
  // NO seen field - that's per-user private state
}

// Notify recipient
handler(onNewMessage, async (message, { recipient }) => {
  await notifyUser(recipient, {
    ref: message,
    seenStrategy: { type: 'annotation' },
  });
});

// Chat UI writes annotation when message scrolls into view
function onMessageVisible(message: Message, user: DID) {
  // Writes to user's projection space, not source
  await annotate(message, { seen: true, seenAt: new Date() });
}
```

The inbox observes the user's projection space for the annotation:

```typescript
// In inbox pattern, checking if content is seen
function isContentSeen(entry: InboxEntry, currentUser: DID): boolean {
  switch (entry.seenStrategy.type) {
    case 'source-field':
      const content = $(entry.ref);
      return content?.seen === true;

    case 'source-multi':
      const multi = $(entry.ref);
      const field = entry.seenStrategy.field ?? 'seenBy';
      return multi?.[field]?.includes(currentUser);

    case 'annotation':
      // Query user's projection space for annotation
      const annotation = getAnnotation(entry.ref, currentUser);
      const field = entry.seenStrategy.field ?? 'seen';
      return annotation?.[field] === true;

    case 'manual':
      return false;  // Never auto-seen, must be dismissed
  }
}
```

---

## Multi-User Architecture Detail

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SHARED SPACE (Chat)                           │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Message Cell (msg-123)                                      │    │
│  │  {                                                           │    │
│  │    id: "msg-123",                                           │    │
│  │    content: "Hello team!",                                  │    │
│  │    author: did:alice,                                       │    │
│  │    timestamp: "2026-01-09T10:00:00Z"                        │    │
│  │    // NO seen field - multi-user!                           │    │
│  │  }                                                           │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
          │                              │
          │ Alice's view                 │ Bob's view
          ▼                              ▼
┌─────────────────────────┐    ┌─────────────────────────┐
│ ALICE'S HOME SPACE      │    │ BOB'S HOME SPACE        │
│                         │    │                         │
│ ┌─────────────────────┐ │    │ ┌─────────────────────┐ │
│ │ Projection/         │ │    │ │ Projection/         │ │
│ │ Annotation:         │ │    │ │ Annotation:         │ │
│ │                     │ │    │ │                     │ │
│ │ msg-123: {          │ │    │ │ msg-123: {          │ │
│ │   seen: true,       │ │    │ │   seen: false       │ │
│ │   seenAt: 10:30     │ │    │ │ }                   │ │
│ │ }                   │ │    │ │                     │ │
│ └─────────────────────┘ │    │ └─────────────────────┘ │
│                         │    │                         │
│ ┌─────────────────────┐ │    │ ┌─────────────────────┐ │
│ │ Inbox Entry:        │ │    │ │ Inbox Entry:        │ │
│ │ {                   │ │    │ │ {                   │ │
│ │   ref: msg-123,     │ │    │ │   ref: msg-123,     │ │
│ │   state: DISMISSED, │ │    │ │   state: ACTIVE,    │ │
│ │   seenStrategy:     │ │    │ │   seenStrategy:     │ │
│ │     'annotation'    │ │    │ │     'annotation'    │ │
│ │ }                   │ │    │ │ }                   │ │
│ └─────────────────────┘ │    │ └─────────────────────┘ │
└─────────────────────────┘    └─────────────────────────┘

Alice has seen and dismissed.     Bob hasn't seen yet.
Her annotation: seen: true        His annotation: seen: false
Her notification: DISMISSED       His notification: ACTIVE
```

### Why Annotations Over `seenBy` on Source?

| Concern | `seenBy` on Source | Annotations |
|---------|-------------------|-------------|
| Privacy | Everyone sees who read | Only you know |
| Permissions | Need write access to shared content | Only write to your space |
| Scalability | O(users) per message | O(1) per user |
| Separation | Content knows about notifications | Content is pure content |

---

## Key Design Decisions

### 1. References, Not Copies

The inbox stores **pointers** to source content, not copies. This ensures:
- Clicking notification shows **current** content (high integrity)
- Source updates propagate automatically (reactivity)
- No data duplication or drift

### 2. Content Cells Have No Required Fields

Unlike the earlier design, we do NOT require `seen: boolean` on source cells. The `seenStrategy` tells the inbox how to determine seen state. This allows:
- Pure content cells (no notification system coupling)
- Flexible per-pattern seen tracking
- Multi-user privacy via annotations

### 3. Inbox Observes, Doesn't Own, Content Seen State

The inbox *reactively observes* content seen state but doesn't own it. This matches Android's model where the notification system responds to app state changes.

### 4. Inbox in Home Space

The inbox pattern lives in the user's home space (DID = identity DID). This ensures:
- Notifications aggregate across ALL spaces
- User always has access to their inbox
- Annotations also live here (user's projection)

### 5. Stream-Based Sending

Patterns send notifications via a stream:
```typescript
const inbox = await wish('#inbox');
inbox.send({ ref: myCell });
```

### 6. Deduplication by Reference

Same `space + cell` combination = one notification. The existing entry's state is preserved (not reset to 'active').

---

## Android-Inspired Design Principles

From deep research on Android's 15-year notification evolution:

1. **Notifications are information layers, not interruptions**
   - They exist alongside user activity, not against it

2. **Persistence signals pending status**
   - Notifications remain until explicitly resolved (TODO list model)

3. **User agency is paramount**
   - Apps propose, users decide; granular control (channels)

4. **Attention is finite currency**
   - Every notification spends from a limited budget; priority matters

5. **Interruption is a spectrum**
   - Badge icon → inbox drawer → heads-up → OS notification

6. **Actions enable in-place resolution**
   - Mark noticed, dismiss, snooze without navigation

7. **Grouping manages cognitive load**
   - Batch related notifications; one semantic event = one interruption

8. **Human communication is special**
   - Conversations deserve elevated treatment

9. **Notification state ≠ content state**
   - Two independent state machines, linked but separate

10. **The system observes, apps own semantics**
    - Notification system doesn't define "read" - apps do

---

## Shell Integration

### Bell Icon in Header

```typescript
// packages/shell/src/views/HeaderView.ts
<notification-bell
  .count=${this.inboxController.unseenCount}
  @click=${() => this.openInbox()}
/>
```

The `unseenCount` is computed:
```typescript
// Active notifications where content is not yet seen
unseenCount = entries
  .filter(e => e.state === 'active')
  .filter(e => !isContentSeen(e, currentUser))
  .length;
```

### Inbox Actions

| Action | Notification State Change | Content State Change |
|--------|--------------------------|---------------------|
| Open inbox | entries → 'noticed' | None |
| Click entry | Navigate to source | App may mark seen |
| Swipe dismiss | entry → 'dismissed' | None |
| Snooze | entry → 'snoozed' | None |
| View content in app | None (observed) | → seen (by app) |

### Tauri OS Notifications (Phase 2)

Background service watches inbox cell, triggers native notifications for new 'active' entries.

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Source cell deleted | Show tombstone in inbox, user can dismiss |
| Access revoked | Same as deletion |
| Duplicate notify() | Dedupe by ref, keep existing entry state |
| Rapid-fire notifications | Batch UI updates, rate-limit OS notifications |
| Content marked seen before notification | Inbox observes, shows as already seen |
| User on multiple devices | Inbox syncs (home space), annotations sync |
| Very old notifications | No auto-expiry (user's TODO list) |
| No annotation infrastructure yet | Fall back to 'manual' seenStrategy |

---

## Open Questions

1. **Annotation infrastructure**: Does the runtime support annotations yet? If not, what's the fallback?

2. **Cross-space subscription cost**: How expensive is observing content seen state across many spaces?

3. **Notification permissions**: Should patterns need explicit permission to notify?

4. **Channels/grouping**: Should we implement Android-style channels for filtering?

5. **Swappable inbox**: How does a user replace `inbox.tsx` with their own implementation?

6. **Snooze UX**: What snooze duration options? Custom time picker?

---

## Implementation Phases

### Phase 1: MVP (Single-User Focus)
- Inbox pattern with entries cell and send stream
- notify() helper API
- SeenStrategy: 'source-field' and 'manual' only
- Shell bell icon with badge
- Basic inbox UI (list, navigate, dismiss)
- Notification states: active, dismissed

### Phase 2: Full State Machine
- Notification states: noticed, snoozed
- SeenStrategy: 'source-multi'
- Grouping by source/channel
- Tauri OS notifications
- Animation and feedback

### Phase 3: Multi-User
- SeenStrategy: 'annotation'
- Per-user projection space integration
- Annotation read/write helpers
- Collaborative notification patterns

---

## References

- [Android Notification Design Philosophy](https://developer.android.com/develop/ui/views/notifications)
- [Material Design Notifications](https://m3.material.io/foundations/content-design/notifications)
- Common Tools Roadmap: Multi-User Scopes, Annotations
- PRD: See companion document
- Technical Design: See companion document
