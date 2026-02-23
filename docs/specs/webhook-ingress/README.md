# Webhook Ingress System

## Status

Draft — seeking framework author review

## Overview

The webhook ingress system allows external services (GitHub, Stripe, Slack, etc.) to push data into Common Tools patterns via standard HTTP webhooks. Each webhook is a stable HTTPS endpoint that accepts JSON payloads authenticated with a bearer token and writes them into a reactive cell.

This is a generalization of the OAuth callback flow: any external service that can POST to a URL can inject data into the reactive cell graph. Patterns subscribe to the inbox cell and react to new payloads automatically.

## Trust Model

Secrets (the webhook URL and bearer token) flow through the system without patterns needing to read them directly:

1. A pattern creates an inbox cell and a **confidential config cell** (CFC-labeled)
2. The pattern calls `POST /api/webhooks` with both cell links
3. Toolshed generates the ID and secret, stores the registration in its own service space, and writes `{ url, secret }` into the confidential config cell
4. The pattern binds the confidential config cell to `<ct-secret-viewer>` components
5. The user clicks "Reveal" in the trusted UI component to see and copy the values
6. The pattern code never reads the URL or secret directly

This approach means even a compromised or malicious pattern cannot exfiltrate webhook secrets — they exist only in CFC-labeled cells displayed by trusted system components.

**Exception:** A Webhook Manager pattern (trusted-by-policy) may read the confidential config cell directly for administrative purposes.

## Data Flow

```
Pattern                     Toolshed                    External Service
  │                           │                              │
  ├─ Creates inbox cell       │                              │
  ├─ Creates config cell      │                              │
  │  (CFC "confidential")    │                              │
  │                           │                              │
  ├─ POST /api/webhooks ─────►│                              │
  │  { cellLink,              │                              │
  │    confidentialCellLink } │                              │
  │                           ├─ Generate ID + secret        │
  │                           ├─ Store registration in       │
  │                           │  service space               │
  │                           ├─ Write URL+secret to         │
  │                           │  config cell                 │
  │◄── { id, name, mode } ───┤                              │
  │                           │                              │
  ├─ Bind config cell to      │                              │
  │  <ct-secret-viewer>       │                              │
  │                           │                              │
  │  User copies URL+token    │                              │
  │  from ct-secret-viewer    │                              │
  │  and configures external  │         ┌─────────────────── │
  │  service                  │         │                    │
  │                           │         ▼                    │
  │                           │◄─ POST /api/webhooks/:id ───┤
  │                           │   Authorization: Bearer ...  │
  │                           │   { payload }                │
  │                           │                              │
  │                           ├─ Verify bearer token         │
  │                           ├─ Write payload to inbox cell │
  │                           │                              │
  ├─ Reactively observes      │                              │
  │  inbox cell update        │                              │
```

## Storage Architecture

All state lives in cells — no in-memory indexes, no server-side registries that are lost on restart.

### Per-webhook registration cell

Stored in **toolshed's service space** (`identity.did()`):
- Entity: `of:${sha256("ct:webhook:" + webhookId)}`
- Contains: `{ id, secretHash, cellLink, mode, enabled, name, createdBy, createdAt }`
- Any of the 21 toolshed instances can read this via shared storage

### Confidential config cell

Stored in **user's space** (pattern-created, CFC-labeled):
- Written once by toolshed at creation time
- Contains: `{ url, secret }`
- Displayed to user via `<ct-secret-viewer>`

### Inbox cell

Stored in **user's space** (pattern-created, plain cell):
- Written on each webhook delivery
- Mode "replace": overwrites with latest payload
- Mode "append": maintains array of recent payloads (max 1000)

### Per-space webhook index

Stored in **toolshed's service space**:
- Entity: `of:${sha256("ct:webhooks-for:" + space)}`
- Contains: `string[]` of webhook IDs belonging to that space
- Used by the admin list endpoint; patterns should not depend on this

### Discovery

Patterns that create webhooks export their webhook metadata as output properties, discoverable via the wish/summary-index mechanism. This is the idiomatic CT approach — no server-side registry array needed for pattern-level discovery.

## API Reference

### `POST /api/webhooks` — Create webhook

Called by pattern handlers to register a new webhook.

**Request body:**
```json
{
  "name": "GitHub Push Events",
  "cellLink": "<serialized inbox cell link>",
  "confidentialCellLink": "<serialized config cell link>",
  "mode": "append"
}
```

**Response (200):**
```json
{
  "id": "wh_abc123...",
  "name": "GitHub Push Events",
  "mode": "append"
}
```

The URL and secret are NOT returned in the HTTP response. They are written to the confidential config cell.

### `POST /api/webhooks/:id` — Ingest payload

Called by external services to deliver webhook payloads.

**Headers:** `Authorization: Bearer whsec_...`

**Request body:** Any valid JSON

**Response (200):** `{ "received": true }`

**Response (401):** `{ "error": "Invalid request" }` — uniform for missing webhook, disabled webhook, wrong token

### `GET /api/webhooks?space=...` — List webhooks (trusted admin)

System-level admin endpoint. Not intended for use by patterns.

**Response (200):**
```json
{
  "webhooks": [
    {
      "id": "wh_abc123...",
      "name": "GitHub Push Events",
      "cellLink": "...",
      "enabled": true,
      "mode": "append",
      "createdAt": "2026-02-23T...",
      "createdBy": "did:key:..."
    }
  ]
}
```

`secretHash` is stripped from the response.

### `DELETE /api/webhooks/:id` — Delete webhook

Removes a webhook registration. Space is derived from the stored registration's cellLink.

**Response (200):** `{ "deleted": true }`

## Security Properties

### Bearer token hashing
Secrets are hashed with SHA-256 before storage. The plaintext secret is written to the confidential config cell and never stored server-side.

### Timing-safe verification
Token comparison uses constant-time byte comparison to prevent timing attacks.

### Uniform 401 responses
The ingest endpoint returns the same `{ "error": "Invalid request" }` for missing webhooks, disabled webhooks, and wrong tokens. When a webhook is not found, the token is hashed against a dummy value to prevent timing oracles.

### Body limit
A 1MB body limit is enforced on the ingest endpoint via Hono middleware.

### CFC confidentiality labels
The config cell is CFC-labeled as confidential by the pattern that creates it. This prevents untrusted code from reading the secret.

### Scoped writes
Each webhook writes to exactly one cell. A compromised bearer token can only affect that single cell.

## `ct-secret-viewer` Component

A trusted UI component for displaying confidential strings.

### Default state
Shows greeked text: `••••••••••••hJ9k` (last 4 characters visible)

### Interactions
- **Reveal button**: Toggles between masked and full display
- **Copy button**: Copies full value regardless of reveal state
- **Auto-hide**: Reverts to masked state after 30 seconds

### Properties
| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `value` | `string` | `""` | The secret string |
| `label` | `string` | `""` | Label displayed above the value |
| `trailing-chars` | `number` | `4` | Visible characters at end when masked |

### Usage
```html
<ct-secret-viewer
  label="Webhook URL"
  value={config.url}
  trailing-chars={4}
/>
<ct-secret-viewer
  label="Bearer Token"
  value={config.secret}
  trailing-chars={4}
/>
```

## Multi-Instance Behavior

Toolshed runs across 21 instances behind a load balancer. The webhook system has no in-memory state — all data lives in cells via shared storage. Any instance can:

- Create webhooks (writes to service space)
- Ingest payloads (reads registration from service space, writes to user space)
- List or delete webhooks (reads from service space)

No coordination between instances is required.

## Future Work

- **Webhook provider system pattern**: A pattern that acts as a webhook management UI, using the admin list endpoint as a backstop
- **Webhook manager pattern**: Trusted pattern for bulk webhook administration
- **HMAC signature verification**: Support HMAC-SHA256 verification for providers that sign payloads (GitHub, Stripe)
- **DID auth on management endpoints**: Authenticate create/delete/list with DID-based auth rather than open access
- **Per-instance LRU cache**: For high-throughput scenarios, cache hot webhook registrations in memory with a short TTL
- **Webhook delivery retries**: Queue failed deliveries for retry with exponential backoff
- **Rate limiting**: Per-webhook and per-space rate limits on the ingest endpoint
