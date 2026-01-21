# Google Services Patterns

This folder contains patterns for integrating with Google services (Gmail,
Calendar, Docs) via OAuth authentication.

## Directory Structure

```
packages/patterns/google/
├── building-blocks/          # Core, engineering-supported patterns
│   ├── util/                 # Shared utilities (clients, auth manager)
│   │   ├── gmail-client.ts
│   │   ├── gmail-send-client.ts
│   │   ├── calendar-write-client.ts
│   │   ├── google-auth-manager.tsx
│   │   ├── google-docs-client.ts
│   │   ├── google-docs-markdown.ts
│   │   └── agentic-tools.ts
│   │
│   ├── google-auth.tsx           # Core OAuth2
│   ├── google-auth-personal.tsx  # Personal account wrapper
│   ├── google-auth-work.tsx      # Work account wrapper
│   ├── gmail-importer.tsx        # Email fetching (heavily used)
│   ├── google-calendar-importer.tsx
│   ├── imported-calendar.tsx
│   ├── processing-status.tsx
│   │
│   └── experimental/             # Less hardened
│       ├── google-auth-switcher.tsx
│       ├── gmail-agentic-search.tsx
│       ├── gmail-sender.tsx
│       ├── gmail-label-manager.tsx
│       ├── gmail-search-registry.tsx
│       ├── calendar-event-manager.tsx
│       ├── calendar-viewer.tsx
│       └── google-docs-comment-orchestrator.tsx
│
├── extractors/               # End-user patterns
│   ├── usps-informed-delivery.tsx
│   ├── email-notes.tsx
│   ├── chase-bill-tracker.tsx
│   ├── bofa-bill-tracker.tsx
│   ├── pge-bill-tracker.tsx
│   ├── berkeley-library.tsx
│   ├── united-flight-tracker.tsx
│   ├── hotel-membership-gmail-agent.tsx
│   ├── favorite-foods-gmail-agent.tsx
│   ├── email-pattern-launcher.tsx
│   └── ...
│
└── WIP/                      # Work in progress
    └── google-docs-importer.tsx
```

## Quick Start

### For Staging/Production (Recommended)

OAuth is pre-configured. Just:

1. Visit your homespace (e.g., `https://toolshed.common.tools/`)
2. Deploy `google-auth.tsx`
3. Click "Sign in with Google" and complete OAuth
4. Click the star to favorite it (tags it as `#googleAuth`)
5. Deploy any Google pattern - it auto-discovers your auth via `wish()`

### For Local Development

You need your own Google OAuth credentials:

1. Create project at [Google Cloud Console](https://console.cloud.google.com)
2. Create OAuth 2.0 Client ID (Web application)
3. Add redirect URI:
   `http://localhost:8000/api/integrations/google-oauth/callback`
4. Enable APIs: Gmail, Calendar, Drive (as needed)
5. Add to `packages/toolshed/.env`:
   ```
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-client-secret
   ```
6. Follow the staging/production steps above

### Token Refresh

Tokens expire after ~1 hour. When expired:

1. Find your google-auth charm (in favorites or homespace)
2. Click "Refresh Token" button
3. Other patterns automatically get the refreshed token

## Pattern Architectures

This folder contains two main architectural approaches for building Gmail-based
patterns:

### Smart Importers

Patterns that fetch specific emails and process them with LLM vision or text
analysis.

**Example:** `usps-informed-delivery.tsx`

**How it works:**

1. Embeds `gmail-importer` with a hardcoded search query
2. Filters and extracts data (e.g., mail piece images)
3. Uses `generateObject()` with vision to analyze each item
4. Exposes enriched results + aggregate counts to other patterns

**Architecture:**

```
Your Pattern
  └─ Instantiates GmailImporter({ gmailFilterQuery: "from:..." })
       └─ Gets raw emails
  └─ computed() chain for filtering/extraction
  └─ .map() with generateObject() for LLM analysis
  └─ Exports: enriched data, counts, previewUI
```

**Key code (usps-informed-delivery.tsx):**

- Line 294-295: Hardcoded query
  `from:USPSInformeddelivery@email.informeddelivery.usps.com`
- Lines 362-442: Per-item LLM analysis with vision using `.map()` and
  `generateObject()`
- Lines 460-495: Aggregate category counts computed from analysis results

### Agentic Search Patterns

Patterns where an LLM strategizes and loops to find information dynamically.

**Example:** `hotel-membership-gmail-agent.tsx`

**How it works:**

1. Instantiates `GmailAgenticSearch` with goal, schema, prompts
2. LLM decides which searches to run
3. LLM extracts results matching the schema
4. Loops until goal is satisfied or limits reached

**Architecture:**

```
Your Pattern
  └─ Defines: goal, resultSchema, systemPrompt, additionalTools
  └─ Instantiates GmailAgenticSearch({...})
       └─ generateObject() with tools: searchGmail + your tools
       └─ LLM loop: search → analyze → extract → repeat
  └─ Composes UI: searcher.ui.{auth, controls, progress}
  └─ Exports: extracted results
```

**Key code (hotel-membership-gmail-agent.tsx):**

- Lines 54-88: Schema definition with `defineItemSchema()`
- Lines 287-391: Dynamic goal generation based on scan mode
- Lines 408-429: System prompt with workflow instructions

## Pattern Categories

### building-blocks/ — Core Auth

| Pattern                                    | Description                                 |
| ------------------------------------------ | ------------------------------------------- |
| `building-blocks/google-auth.tsx`          | OAuth2 authentication flow for Google APIs  |
| `building-blocks/google-auth-personal.tsx` | Wrapper that adds `#googleAuthPersonal` tag |
| `building-blocks/google-auth-work.tsx`     | Wrapper that adds `#googleAuthWork` tag     |

### building-blocks/ — Gmail & Calendar

| Pattern                                        | Description                                  |
| ---------------------------------------------- | -------------------------------------------- |
| `building-blocks/gmail-importer.tsx`           | Import emails from Gmail with search queries |
| `building-blocks/google-calendar-importer.tsx` | Import events from Google Calendar           |
| `building-blocks/imported-calendar.tsx`        | Display local calendar events                |
| `building-blocks/processing-status.tsx`        | Loading/progress UI component                |

### building-blocks/experimental/ — Less Hardened

| Pattern                                                             | Description                                    |
| ------------------------------------------------------------------- | ---------------------------------------------- |
| `building-blocks/experimental/google-auth-switcher.tsx`             | Post-login account type classification         |
| `building-blocks/experimental/gmail-sender.tsx`                     | Send emails via Gmail API                      |
| `building-blocks/experimental/gmail-label-manager.tsx`              | Add/remove labels from emails                  |
| `building-blocks/experimental/gmail-agentic-search.tsx`             | Base pattern for Gmail-based agentic searchers |
| `building-blocks/experimental/gmail-search-registry.tsx`            | Community query database for Gmail searches    |
| `building-blocks/experimental/calendar-event-manager.tsx`           | Create, update, delete calendar events         |
| `building-blocks/experimental/calendar-viewer.tsx`                  | View calendar events                           |
| `building-blocks/experimental/google-docs-comment-orchestrator.tsx` | AI assistant for Google Docs comments          |
| `building-blocks/experimental/google-docs-comment-confirm.ts`       | Side effects handler for Docs comments         |

### extractors/ — End-User Patterns

| Pattern                                       | Description                              |
| --------------------------------------------- | ---------------------------------------- |
| `extractors/usps-informed-delivery.tsx`       | USPS mail analyzer with LLM vision       |
| `extractors/email-notes.tsx`                  | Task notes sent to self                  |
| `extractors/chase-bill-tracker.tsx`           | Chase credit card bill tracker           |
| `extractors/bofa-bill-tracker.tsx`            | Bank of America bill tracker             |
| `extractors/pge-bill-tracker.tsx`             | PGE utility bill tracker                 |
| `extractors/berkeley-library.tsx`             | Library holds and due dates              |
| `extractors/united-flight-tracker.tsx`        | United Airlines flight tracking          |
| `extractors/hotel-membership-gmail-agent.tsx` | Extract hotel loyalty numbers from Gmail |
| `extractors/favorite-foods-gmail-agent.tsx`   | Extract food preferences from emails     |
| `extractors/email-pattern-launcher.tsx`       | Auto-launch patterns based on emails     |
| `extractors/calendar-change-detector.tsx`     | Detect schedule changes                  |

### WIP/ — Work In Progress

| Pattern                        | Description                |
| ------------------------------ | -------------------------- |
| `WIP/google-docs-importer.tsx` | Import Google Docs content |

> **Note:** `google-docs-importer.tsx` imports from `../../notes/note.tsx` and
> requires deploying with `--root packages/patterns` to resolve cross-folder
> imports.

## OAuth Scopes

The patterns request various scopes depending on their needs:

- `email`, `profile` - Basic user info (OpenID Connect)
- `https://www.googleapis.com/auth/gmail.readonly` - Read emails
- `https://www.googleapis.com/auth/gmail.send` - Send emails
- `https://www.googleapis.com/auth/gmail.modify` - Modify labels
- `https://www.googleapis.com/auth/calendar.readonly` - Read calendar
- `https://www.googleapis.com/auth/calendar.events` - Manage calendar events
- `https://www.googleapis.com/auth/documents.readonly` - Read Google Docs

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

## Fork Status

The `google-auth.tsx` pattern in this folder is a **fork** of the original from
the community-patterns repository. This version includes additional features and
enhancements, but may also have introduced regressions or bugs.

**Long-term goal:** Rationalize these two implementations to maintain a single,
well-tested version.

## Origin

These patterns were originally developed by jkomoros in the
[community-patterns](https://github.com/user/community-patterns) repository.
