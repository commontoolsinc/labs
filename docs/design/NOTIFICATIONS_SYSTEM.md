# Notification System Design

> **Status**: Draft v4 — Ready for Review
> **Date**: 2026-01-09
> **Author**: Alex + Claude
> **Branch**: `feat/notifications-system`

---

## TL;DR (30 seconds)

**What**: Patterns can notify users about content. Notifications aggregate in an inbox in home space. Users control what interrupts them.

**Key decisions needing validation**:
1. **Charm × Channel control** — Users mute by charm, by channel, or both. Is this the right granularity?
2. **notify() as built-in** — Runtime injects charm identity. Patterns can't spoof who they are.
3. **Annotations for seen state** — Your "seen" annotations are private, stored in your space. Multi-user ready.
4. **Tauri as dumb projection** — Inbox owns state; Tauri just renders to OS. Scheduled notifications for background snooze.

---

## The 3-Minute Version

### The Core Model

```
Pattern calls notify({ ref: myCell, channel: 'messages' })
                          ↓
Runtime injects charm identity (did:charm:..., slug, name)
                          ↓
Inbox pattern in home space receives notification
                          ↓
User rules applied: Is this charm:channel muted?
                          ↓
        ┌─────────────────┴─────────────────┐
        ↓                                   ↓
   Show in inbox                      Discard silently
   Update badge                       (muted)
   Maybe OS notification
   Maybe sound
```

### Two State Machines (Android's Key Insight)

| State Machine | Owner | Purpose |
|---------------|-------|---------|
| **Notification state** | Inbox | Is this active/noticed/dismissed/snoozed? |
| **Content seen state** | Annotations | Has user viewed the actual content? |

These are **independent**. You can dismiss without viewing. You can view without dismissing. Inbox observes seen state reactively.

### User Control: Charm × Channel

Every notification has a coordinate: `(charmId, channelId)`

```
                     Channels
                 messages  reminders  background
              ┌──────────┬──────────┬──────────┐
Charms   Chat │ ●        │          │          │
              ├──────────┼──────────┼──────────┤
        Email │ ●        │ ●        │ ●        │
              └──────────┴──────────┴──────────┘
```

**User rules**:
- `*:background` → Mute all background notifications
- `did:charm:slack:*` → Mute everything from Slack
- `did:charm:slack:messages` → Mute Slack messages, keep Email messages

**Why charm DID?** Stable identity. Renaming "Slack Sync" to "Slack Integration" doesn't break rules.

### Channels are Folksonomy

Multiple charms using `channel: 'messages'` share user settings. Mute "messages" → all message-like notifications muted. This is a feature for coordination, with per-charm escape hatch.

---

## The 10-Minute Version

### Data Model

```typescript
interface InboxEntry {
  id: string;
  ref: NormalizedLink;           // Cross-space reference to content
  addedAt: Date;

  // Notification state (inbox-owned)
  state: 'active' | 'noticed' | 'dismissed' | 'snoozed';
  snoozedUntil?: Date;
  expiresAt?: Date;              // Optional auto-dismiss

  // Charm identity (injected by runtime)
  charmId: string;               // did:charm:... — stable
  charmSlug: string;             // Current slug
  charmName: string;             // Current display name

  // Channel
  channelId: string;             // Folksonomy coordination

  // Grouping
  groupKey: string | null;       // Visual batching

  // Cached for display
  cachedName?: string;
  cachedPreview?: string;
}
```

### The notify() API

```typescript
// Built-in, available in all patterns
notify({ ref: todoItem });

// With channel
notify({
  ref: message,
  channel: 'messages',
  channelImportance: 'high',
});

// With expiry
notify({
  ref: eventReminder,
  channel: 'reminders',
  expiresAt: event.startTime,
});
```

Runtime injects `charmId`, `charmSlug`, `charmName` from execution context. Patterns cannot lie about identity.

### Importance Levels

| Level | Sound | OS Notification | Use Case |
|-------|-------|-----------------|----------|
| `urgent` | Yes | Heads-up | Calls, alarms, timers |
| `high` | Yes | Yes | Direct messages |
| `default` | Yes | Optional | Most notifications |
| `low` | No | No | Social updates |
| `min` | No | No | Background sync |

### Annotations (Seen State)

```typescript
// Multi-user: seen state is per-user, private
markSeen(messageRef);  // Writes to YOUR annotations in YOUR space

// Inbox checks seen state
function isContentSeen(ref: NormalizedLink): boolean {
  const annotation = getAnnotation(ref);
  if (annotation?.seen) return true;

  // Fallback for single-user patterns
  const content = $(ref);
  if (content?.seen) return true;

  return false;
}
```

**Why annotations?** In multi-user, you can't write "seen" to shared content. Your seen state is private.

### Time Reactivity

```typescript
// wish('#now') provides reactive time
const now = wish('#now', { interval: 1000 });

// Expiry and snooze are just computeds
const activeEntries = computed(() => {
  const t = now.get();
  return entries
    .filter(e => !e.expiresAt || e.expiresAt > t)
    .map(e => {
      if (e.state === 'snoozed' && e.snoozedUntil <= t) {
        return { ...e, state: 'active' };
      }
      return e;
    });
});
```

### Tauri Integration

**Principle**: Inbox owns state. Tauri is a dumb renderer.

| Tauri Does | Tauri Does NOT Do |
|------------|-------------------|
| Show OS notification | Decide when to notify |
| Cancel OS notification | Track notification state |
| Update badge | Handle snooze logic |
| Schedule future notification | Rate limit |
| Emit click/dismiss events | Own any state |

**Background snooze**: When user snoozes, we schedule an OS notification for wake-up time. Works even when app is closed.

```typescript
// When user snoozes
inbox.snooze({ id: entryId, until });
tauriScheduleNotification({
  id: `snooze-${entryId}`,
  at: until,
  title: entry.charmName,
  body: 'Snoozed reminder',
});
```

---

## Deep Dive: Key Design Decisions

### Why Charm DID for Identity?

**Problem**: Users need to mute specific charms. What identifies a charm?

| Option | Stability | Uniqueness |
|--------|-----------|------------|
| Display name | Changes on rename | Not unique |
| Slug | Changes on rename | Unique within space |
| **Charm DID** | Content-addressed, stable | Globally unique |

Charm DID survives renames. Rule for "Slack Sync" still works when renamed to "Slack Integration".

### Why Folksonomy Channels?

**Problem**: How do charms coordinate notification categories?

**Android's answer**: Per-app channels. No coordination.

**Our answer**: Shared namespace. `channel: 'messages'` from any charm shares settings.

**Tradeoff**:
- Pro: User mutes "messages" → all message-like things muted
- Con: User can't mute Slack messages but keep Email messages

**Solution**: Charm × Channel rules. Folksonomy for coordination, per-charm override for escape.

### Why Two State Machines?

**Problem**: When I view a message, does the notification go away?

**Android's answer**: They're separate. App owns "read" state. OS owns notification state. Linked but independent.

**Our answer**: Same. Inbox owns notification state. Source/annotations own seen state. Inbox observes seen state reactively.

**Benefits**:
- Dismiss without viewing ✓
- View without dismissing ✓
- View → auto-dismiss ✓ (optional, reactive)
- Snooze (changes notification state, not seen state) ✓

### Why Annotations for Seen State?

**Problem**: In multi-user, where does "seen" live?

| Option | Works for Multi-User? |
|--------|----------------------|
| `message.seen = true` | No — shared content |
| `message.seenBy.push(me)` | Privacy leak |
| **My annotation on message** | Yes — my space, my data |

Annotations are private. Your seen state doesn't leak to others.

### Why Tauri as Dumb Projection?

**Problem**: Who owns notification state? Rust or TypeScript?

**Answer**: TypeScript (inbox pattern). Tauri just projects.

**Benefits**:
- Single source of truth
- Testable without Tauri
- Works in browser (fallback to Web Notifications)
- Minimal Rust code (~150 lines)

**Snooze twist**: Reactive computations don't run when app is closed. We schedule OS notifications for background snooze.

---

## Grouping

Notifications can be grouped for visual batching:

```typescript
notify({
  ref: message,
  channel: 'messages',
  group: `conversation:${conversationId}`,
  groupTitle: 'Team Chat',
});
```

- Same `group` → batched visually
- One sound per group arrival, not per notification
- Dismiss group → dismisses all entries
- Group is orthogonal to channel (channel = interruption, group = batching)

---

## Implementation Phases

### Phase 1: MVP
- Inbox pattern with entries cell
- `notify()` built-in with charm identity
- Default channel only
- Basic inbox UI (list, dismiss)
- Annotations shim

### Phase 2: Full State Machine + Channels
- States: active, noticed, dismissed, snoozed
- Channel system with folksonomy
- Charm × channel user rules
- `#now` for time-based features

### Phase 3: Tauri
- OS notifications as projection
- Scheduled notifications for snooze
- Badge sync
- Deep linking

### Phase 4: Production Polish
- Grouping
- Channel filtering
- Real annotations (remove shim)
- Multi-device sync

---

## Open Questions

1. **Rule conflict resolution**: When two rules match with same specificity, last-defined wins. Is this right?

2. **Snooze UI**: What snooze intervals? "1 hour", "Tomorrow morning", custom?

3. **Notification expiry**: Should expired notifications transition to 'dismissed' or just disappear?

4. **Channel discovery**: How do users discover what channels exist? Just from settings UI?

5. **Rate limiting**: Per-charm limits? Per-channel? Global? Where enforced?

---

## References

- [Android Notification Philosophy](https://developer.android.com/develop/ui/views/notifications)
- [Fabric URL Structure PRD](../../Downloads/Fabric%20URL%20Structure%20-%20Product%20Requirements%20Document.md) — Charm identity model
- [Tauri Notification Plugin](https://v2.tauri.app/plugin/notification/)
