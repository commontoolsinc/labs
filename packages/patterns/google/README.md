# Google Services Patterns

> **Status: Work In Progress**
>
> These patterns are experimental and may have bugs or incomplete features. They
> are being actively developed and tested.

This folder contains patterns for integrating with Google services (Gmail,
Calendar, Docs) via OAuth authentication.

## Important: Fork Status

The `google-auth.tsx` pattern in this folder is a **fork** of the original from
the community-patterns repository. This version includes additional features and
enhancements, but may also have introduced regressions or bugs.

**Long-term goal:** Rationalize these two implementations to maintain a single,
well-tested version.

## Pattern Categories

### Google Auth

| Pattern                    | Description                                 |
| -------------------------- | ------------------------------------------- |
| `google-auth.tsx`          | OAuth2 authentication flow for Google APIs  |
| `google-auth-personal.tsx` | Wrapper that adds `#googleAuthPersonal` tag |
| `google-auth-work.tsx`     | Wrapper that adds `#googleAuthWork` tag     |
| `google-auth-switcher.tsx` | Post-login account type classification      |

### Gmail

| Pattern                     | Description                                    |
| --------------------------- | ---------------------------------------------- |
| `gmail-importer.tsx`        | Import emails from Gmail with search queries   |
| `gmail-sender.tsx`          | Send emails via Gmail API                      |
| `gmail-label-manager.tsx`   | Add/remove labels from emails                  |
| `gmail-agentic-search.tsx`  | Base pattern for Gmail-based agentic searchers |
| `gmail-search-registry.tsx` | Community query database for Gmail searches    |

### Gmail Agentic Patterns

| Pattern                            | Description                              |
| ---------------------------------- | ---------------------------------------- |
| `hotel-membership-gmail-agent.tsx` | Extract hotel loyalty numbers from Gmail |
| `favorite-foods-gmail-agent.tsx`   | Extract food preferences from emails     |

### Calendar

| Pattern                        | Description                            |
| ------------------------------ | -------------------------------------- |
| `google-calendar-importer.tsx` | Import events from Google Calendar     |
| `calendar-event-manager.tsx`   | Create, update, delete calendar events |
| `calendar-viewer.tsx`          | View calendar events                   |

### Google Docs

| Pattern                                | Description                            |
| -------------------------------------- | -------------------------------------- |
| `google-docs-comment-orchestrator.tsx` | AI assistant for Google Docs comments  |
| `google-docs-comment-confirm.ts`       | Side effects handler for Docs comments |

### WIP (Work In Progress)

| Pattern                          | Description                        |
| -------------------------------- | ---------------------------------- |
| `WIP/usps-informed-delivery.tsx` | USPS mail analyzer with LLM vision |
| `WIP/google-docs-importer.tsx`   | Import Google Docs content         |

> **Note:** `google-docs-importer.tsx` imports from `../../notes/note.tsx` and
> requires deploying with `--root packages/patterns` to resolve cross-folder
> imports.

## Prerequisites

1. **Google Cloud Console Setup**
   - Create a project at
     [Google Cloud Console](https://console.cloud.google.com)
   - Enable the APIs you need (Gmail API, Calendar API, Docs API, etc.)
   - Create OAuth 2.0 credentials (Web application type)
   - Add authorized redirect URIs for your deployment

2. **OAuth Scopes** The patterns request various scopes depending on their
   needs:
   - `email`, `profile` - Basic user info
   - `gmail.readonly` - Read emails
   - `gmail.send` - Send emails
   - `gmail.modify` - Modify labels
   - `calendar.readonly` - Read calendar
   - `calendar.events` - Manage calendar events
   - `documents.readonly` - Read Google Docs

## Quick Start

1. Deploy `google-auth.tsx` first
2. Complete the OAuth flow in the browser
3. Deploy other patterns (gmail-importer, google-calendar-importer, etc.)
4. Link the auth charm to other patterns via `wish()` or manual linking

## Manual Charm Linking

When `wish()` isn't working (e.g., favorites disabled), you can manually link
charms via CLI.

### Steps

#### 1. Deploy both charms

```bash
# Deploy google-auth
ct charm new google-auth.tsx

# Deploy gmail-importer
ct charm new gmail-importer.tsx
```

#### 2. Authenticate with Google Auth charm

Navigate to the google-auth charm in browser and complete OAuth flow.

#### 3. Link the charms

```bash
# Format: source/path target/path
ct charm link \
  GOOGLE_AUTH_CHARM_ID/auth \
  GMAIL_IMPORTER_CHARM_ID/linkedAuth
```

**Critical paths:**

- Source: `GOOGLE_AUTH_CHARM_ID/auth` - the auth result from google-auth
- Target: `GMAIL_IMPORTER_CHARM_ID/linkedAuth` - the linkedAuth input of
  gmail-importer

#### 4. Verify the link

```bash
# Check that linkedAuth is populated
ct charm inspect --charm GMAIL_IMPORTER_CHARM_ID
```

You should see `linkedAuth` in the Source (Inputs) with token, user info, etc.

### Important Notes

1. **Path format**: Use forward slashes, e.g., `charmId/auth` not `charmId.auth`

2. **Link direction**: Source -> Target. The target charm "reads from" the
   source.

3. **The pattern must support linkedAuth**: The gmail-importer has:
   ```typescript
   linkedAuth?: Auth;
   ```
   This optional input is what receives the linked auth data.

4. **Check "Reading From" in inspect**: After linking, `ct charm inspect` shows:
   ```
   --- Reading From ---
     - sourceCharmId (Google Auth (email@example.com))
   ```

## Troubleshooting

### Link exists but auth not working in UI

- The pattern might be showing both the "Connect Google Account" UI AND using
  linkedAuth
- Check that the pattern's logic correctly uses linkedAuth when available
- The charm name should show the email if linkedAuth is working (e.g., "GMail
  Importer email@example.com")

### Settings not being read in handler

If pattern defaults aren't reaching the handler, ensure the handler's type
definition includes all fields:

```typescript
const myHandler = handler<unknown, {
  settings: Writable<{
    // All fields must be listed here!
    field1: string;
    field2: boolean;
    newField: boolean;  // <-- Don't forget new fields!
  }>;
}>(...);
```

Missing fields in the handler's type definition can cause them to be unavailable
when calling `.get()`.

## Origin

These patterns were originally developed by jkomoros in the
[community-patterns](https://github.com/user/community-patterns) repository.
