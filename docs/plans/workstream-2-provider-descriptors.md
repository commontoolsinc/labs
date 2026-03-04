# Workstream 2: Provider Descriptor Registry

## Current State

### Files That Exist

The OAuth integration layer lives under
`packages/toolshed/routes/integrations/`. It is organised as one subdirectory
per provider plus a shared `oauth2-common/` module.

#### Shared module — `oauth2-common/`

| File | Purpose |
|---|---|
| `oauth2-common.types.ts` | `OAuth2ProviderConfig`, `OAuth2Tokens`, `UserInfo`, `CallbackResult`, `OAuth2HandlerOptions` |
| `oauth2-common.utils.ts` | `createOAuth2Client`, `getBaseUrl`, `fetchUserInfo`, `persistTokens`, `clearAuthData`, `tokenToGenericAuthData`, all `create*Response` helpers |
| `oauth2-common.handlers.ts` | `createOAuth2Handlers(config, options)` — returns `{ login, callback, refresh, logout, backgroundIntegration }` |
| `oauth2-common.routes.ts` | `createOAuth2Routes(providerName)` — returns the five typed Hono/zod-openapi route definitions |
| `oauth2-common.index.ts` | Re-exports everything above |

#### Google provider — `google-oauth/`

| File | Purpose |
|---|---|
| `google-oauth.utils.ts` | `GoogleProviderConfig`, `tokenToAuthData` (backward-compat mapper: uses `token` field instead of `accessToken`), `EMPTY_GOOGLE_AUTH_DATA`, backward-compat re-exports |
| `google-oauth.handlers.ts` | Calls `createOAuth2Handlers(GoogleProviderConfig, { tokenMapper, authSchema, emptyAuthData })`, exports typed handlers |
| `google-oauth.routes.ts` | Full copy of all five route definitions — does NOT use `createOAuth2Routes`; written by hand with per-route `AppRouteHandler` type exports |
| `google-oauth.index.ts` | Assembles the Hono router, applies CORS middleware, exports default |

#### Airtable provider — `airtable-oauth/`

| File | Purpose |
|---|---|
| `airtable-oauth.config.ts` | `AirtableProviderConfig` — the only provider-specific config |
| `airtable-oauth.handlers.ts` | Calls `createOAuth2Handlers(AirtableProviderConfig)`, exports handlers |
| `airtable-oauth.routes.ts` | Calls `createOAuth2Routes("airtable")`, exports typed routes |
| `airtable-oauth.index.ts` | Assembles the Hono router, applies CORS middleware, exports default |

#### App registration — `app.ts`

Each provider router is imported individually and registered by hand:

```typescript
import googleOAuth from "@/routes/integrations/google-oauth/google-oauth.index.ts";
import airtableOAuth from "@/routes/integrations/airtable-oauth/airtable-oauth.index.ts";
import plaidOAuth from "@/routes/integrations/plaid-oauth/plaid-oauth.index.ts";
// ...
const routes = [googleOAuth, airtableOAuth, plaidOAuth, ...] as const;
```

### How Adding a New Provider Currently Works

To wire in a new standard OAuth2 provider today, a developer must create or
edit all of the following:

1. **`{provider}-oauth/{provider}-oauth.config.ts`** — Define `OAuth2ProviderConfig` with
   endpoints, scopes, `tokenAuthMethod`, `userInfoMapper`, etc.
2. **`{provider}-oauth/{provider}-oauth.handlers.ts`** — Import `createOAuth2Handlers` and
   the config, call it (optionally with `tokenMapper`/`authSchema`/`emptyAuthData`
   overrides), export named handlers.
3. **`{provider}-oauth/{provider}-oauth.routes.ts`** — Import `createOAuth2Routes`, call
   it with the provider name, re-export the routes and their derived types.
4. **`{provider}-oauth/{provider}-oauth.index.ts`** — Create the Hono router, call
   `.openapi(route, handler)` five times, apply the CORS middleware for the
   provider path, export default.
5. **`app.ts`** — Add a new `import` line for the provider's index file, add the
   router to the `routes` array.

That is 4 new files and 2 lines added to `app.ts` for a provider that differs
from the defaults only in its endpoint URLs and scope list. Google requires an
additional divergence: a custom `tokenMapper`, a custom `authSchema`, a custom
`emptyAuthData`, and its own hand-written `google-oauth.routes.ts` (because it
was written before `createOAuth2Routes` existed). Google's `utils` file also
carries backward-compatibility re-exports that have nothing to do with its
descriptor.

---

## Goal

Adding a new standard OAuth2 provider should require writing a single
descriptor object and adding one registry entry. No boilerplate Hono wiring,
no copy-pasted CORS middleware, no repeated `.openapi(route, handler)` calls.

Target:

- **Standard provider** (like Airtable): 1 new file (`{provider}.descriptor.ts`)
  plus 1 line in `provider-registry.ts`. Zero other files.
- **Custom provider** (like Google): 1 descriptor file that overrides specific
  fields (`tokenMapper`, `authSchema`, `emptyAuthData`). No separate utils or
  handlers file needed unless the token exchange itself is non-standard.
- The `backgroundIntegration` route stays registered exactly once (not per
  provider), owned by the registry router itself.

---

## Design

### ProviderDescriptor Type

Add to `oauth2-common.types.ts`:

```typescript
import type { JSONSchema } from "@commontools/runner";
import type { OAuth2Tokens, UserInfo } from "./oauth2-common.types.ts";

/**
 * Everything needed to describe an OAuth2 provider and auto-wire its routes.
 * Replaces the combination of {provider}.config.ts + {provider}.handlers.ts +
 * {provider}.routes.ts + {provider}.index.ts.
 */
export interface ProviderDescriptor {
  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /** Lowercase slug used in URL paths: /api/integrations/{name}-oauth/... */
  name: string;

  /**
   * Optional hex brand color for future UI use (e.g. "#FF3366").
   * Not used by the server today; stored for completeness.
   */
  brandColor?: string;

  // -------------------------------------------------------------------------
  // OAuth2 Endpoints
  // -------------------------------------------------------------------------

  /** Authorization endpoint. If omitted, resolved via metadataUrl discovery. */
  authorizationEndpoint?: string;

  /** Token endpoint. If omitted, resolved via metadataUrl discovery. */
  tokenEndpoint?: string;

  /**
   * URL of the provider's OAuth authorization server metadata document
   * (RFC 8414, /.well-known/oauth-authorization-server or
   * /.well-known/openid-configuration). When provided, `authorizationEndpoint`
   * and `tokenEndpoint` can be omitted; they will be discovered at startup and
   * cached in memory.
   */
  metadataUrl?: string;

  /**
   * Endpoint to fetch user profile after token exchange.
   * Omit if the provider does not expose a user-info endpoint.
   */
  userInfoEndpoint?: string;

  // -------------------------------------------------------------------------
  // Client credentials (resolved from env at registration time)
  // -------------------------------------------------------------------------

  clientId: string;
  clientSecret: string;

  // -------------------------------------------------------------------------
  // Token exchange behaviour
  // -------------------------------------------------------------------------

  /**
   * How to authenticate against the token endpoint.
   * - "body" (default): client_id + client_secret in POST body
   * - "basic": HTTP Basic Authorization header
   */
  tokenAuthMethod?: "body" | "basic";

  /** Space-separated default scope string. */
  defaultScopes: string;

  /**
   * Extra query parameters appended to the authorization URL.
   * Example: { access_type: "offline", prompt: "consent" } for Google.
   */
  extraAuthParams?: Record<string, string>;

  // -------------------------------------------------------------------------
  // Data mapping
  // -------------------------------------------------------------------------

  /**
   * Map raw user-info JSON to the normalized UserInfo shape.
   * Defaults to identity (assumes the provider returns compatible JSON).
   */
  userInfoMapper?: (raw: Record<string, unknown>) => UserInfo;

  /**
   * Map the raw OAuth2Tokens object to the auth cell data shape that will be
   * written to the runner cell.
   *
   * Defaults to tokenToGenericAuthData (uses `accessToken` field).
   *
   * Override for providers whose cell schema uses a different field name.
   * Example: Google uses `token` instead of `accessToken` for legacy reasons.
   */
  tokenMapper?: (token: OAuth2Tokens) => Record<string, unknown>;

  /**
   * JSON schema applied when reading/writing the auth cell.
   * Defaults to OAuth2TokenSchema from @commontools/runner.
   */
  authSchema?: JSONSchema;

  /**
   * The value written to the auth cell on logout (clears credentials).
   * Defaults to EMPTY_OAUTH2_DATA defined in oauth2-common.handlers.ts.
   */
  emptyAuthData?: Record<string, unknown>;
}
```

The `ProviderDescriptor` is a strict superset of `OAuth2ProviderConfig` plus
`OAuth2HandlerOptions`. The registry can derive both from a single descriptor,
so neither `OAuth2ProviderConfig` nor `OAuth2HandlerOptions` need to be touched
by provider authors.

### Well-Known Metadata Discovery

Add `discoverProviderConfig()` to `oauth2-common.utils.ts`:

```typescript
// In-memory cache: metadataUrl → discovered endpoints
const metadataCache = new Map<string, {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}>();

/**
 * Fetch /.well-known/oauth-authorization-server (RFC 8414) or
 * /.well-known/openid-configuration (OIDC) and return the resolved endpoints.
 * Results are cached indefinitely for the lifetime of the process.
 */
export async function discoverProviderConfig(metadataUrl: string): Promise<{
  authorizationEndpoint: string;
  tokenEndpoint: string;
}> {
  const cached = metadataCache.get(metadataUrl);
  if (cached) return cached;

  const response = await fetch(metadataUrl);
  if (!response.ok) {
    throw new Error(
      `Metadata discovery failed for ${metadataUrl}: ${response.status}`,
    );
  }
  const doc = await response.json();
  const result = {
    authorizationEndpoint: doc.authorization_endpoint as string,
    tokenEndpoint: doc.token_endpoint as string,
  };
  if (!result.authorizationEndpoint || !result.tokenEndpoint) {
    throw new Error(
      `Metadata document at ${metadataUrl} missing required fields`,
    );
  }
  metadataCache.set(metadataUrl, result);
  return result;
}
```

Discovery runs at registry startup (inside `createProviderRouter`) and falls
back to explicit config values when `metadataUrl` is not set. This means most
providers can omit endpoint URLs entirely if their well-known document is
stable, but the system does not require it.

### Provider Registry

New file: `packages/toolshed/routes/integrations/provider-registry.ts`

```typescript
import { createRouter } from "@/lib/create-app.ts";
import { cors } from "@hono/hono/cors";
import { createOAuth2Handlers } from "./oauth2-common/oauth2-common.handlers.ts";
import { createOAuth2Routes } from "./oauth2-common/oauth2-common.routes.ts";
import { discoverProviderConfig } from "./oauth2-common/oauth2-common.utils.ts";
import type { ProviderDescriptor } from "./oauth2-common/oauth2-common.types.ts";
import type { OAuth2ProviderConfig } from "./oauth2-common/oauth2-common.types.ts";

// ---------------------------------------------------------------------------
// Registered descriptors
// ---------------------------------------------------------------------------

import { AirtableDescriptor } from "./airtable-oauth/airtable.descriptor.ts";
import { GoogleDescriptor } from "./google-oauth/google.descriptor.ts";

const DESCRIPTORS: ProviderDescriptor[] = [
  AirtableDescriptor,
  GoogleDescriptor,
];

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Build a Hono router for a single provider descriptor.
 * Performs metadata discovery if needed, then wires all five routes.
 */
export async function createProviderRouter(descriptor: ProviderDescriptor) {
  // Resolve endpoints via discovery or explicit values
  let authorizationEndpointUri = descriptor.authorizationEndpoint ?? "";
  let tokenUri = descriptor.tokenEndpoint ?? "";

  if (descriptor.metadataUrl && (!authorizationEndpointUri || !tokenUri)) {
    const discovered = await discoverProviderConfig(descriptor.metadataUrl);
    authorizationEndpointUri ||= discovered.authorizationEndpoint;
    tokenUri ||= discovered.tokenEndpoint;
  }

  const providerConfig: OAuth2ProviderConfig = {
    name: descriptor.name,
    clientId: descriptor.clientId,
    clientSecret: descriptor.clientSecret,
    authorizationEndpointUri,
    tokenUri,
    userInfoEndpoint: descriptor.userInfoEndpoint,
    userInfoMapper: descriptor.userInfoMapper,
    defaultScopes: descriptor.defaultScopes,
    extraAuthParams: descriptor.extraAuthParams,
    tokenAuthMethod: descriptor.tokenAuthMethod,
  };

  const handlerOptions = {
    tokenMapper: descriptor.tokenMapper,
    authSchema: descriptor.authSchema,
    emptyAuthData: descriptor.emptyAuthData,
  };

  const handlers = createOAuth2Handlers(providerConfig, handlerOptions);
  const routes = createOAuth2Routes(descriptor.name);

  const router = createRouter()
    .openapi(routes.login, handlers.login)
    .openapi(routes.callback, handlers.callback)
    .openapi(routes.refresh, handlers.refresh)
    .openapi(routes.logout, handlers.logout);

  router.use(
    `/api/integrations/${descriptor.name}-oauth/*`,
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: ["Content-Length", "X-Disk-Cache"],
      maxAge: 3600,
      credentials: true,
    }),
  );

  return router;
}

/**
 * Build and return all provider routers plus the single shared
 * backgroundIntegration router.
 *
 * Usage in app.ts:
 *   const providerRouters = await buildProviderRouters();
 *   providerRouters.forEach((r) => app.route("/", r));
 */
export async function buildProviderRouters() {
  const routers = await Promise.all(
    DESCRIPTORS.map((d) => createProviderRouter(d)),
  );

  // The backgroundIntegration route is shared across all providers.
  // Register it once here, tagged generically, to avoid duplication.
  const { backgroundIntegration: bgHandler } = createOAuth2Handlers(
    // Minimal config — only the name field is used by the bg handler
    { name: "integrations" } as OAuth2ProviderConfig,
  );
  const { backgroundIntegration: bgRoute } = createOAuth2Routes("integrations");
  const bgRouter = createRouter().openapi(bgRoute, bgHandler);

  return [...routers, bgRouter];
}
```

### Migration Plan

#### Airtable — before vs. after

**Before** (4 files):

```
airtable-oauth/
  airtable-oauth.config.ts    ← OAuth2ProviderConfig object
  airtable-oauth.handlers.ts  ← calls createOAuth2Handlers, exports handlers
  airtable-oauth.routes.ts    ← calls createOAuth2Routes, re-exports routes
  airtable-oauth.index.ts     ← assembles router, applies CORS
```

**After** (1 file):

```
airtable-oauth/
  airtable.descriptor.ts      ← ProviderDescriptor object, nothing else
```

```typescript
// airtable-oauth/airtable.descriptor.ts
import env from "@/env.ts";
import type { ProviderDescriptor } from "../oauth2-common/oauth2-common.types.ts";

export const AirtableDescriptor: ProviderDescriptor = {
  name: "airtable",
  clientId: env.AIRTABLE_CLIENT_ID,
  clientSecret: env.AIRTABLE_CLIENT_SECRET,
  authorizationEndpoint: "https://airtable.com/oauth2/v1/authorize",
  tokenEndpoint: "https://airtable.com/oauth2/v1/token",
  userInfoEndpoint: "https://api.airtable.com/v0/meta/whoami",
  userInfoMapper: (raw) => ({
    id: raw.id as string,
    email: raw.email as string,
    name: (raw.email as string) || "",
  }),
  defaultScopes: "data.records:read schema.bases:read",
  tokenAuthMethod: "basic",
};
```

The four old files are deleted.

#### Google — before vs. after

**Before** (4 files, with special cases):

```
google-oauth/
  google-oauth.utils.ts    ← GoogleProviderConfig, tokenToAuthData, EMPTY_GOOGLE_AUTH_DATA,
                              plus backward-compat re-exports of oauth2-common symbols
  google-oauth.handlers.ts ← calls createOAuth2Handlers with tokenMapper/authSchema/emptyAuthData
  google-oauth.routes.ts   ← full hand-written copy of all five routes (pre-dates createOAuth2Routes)
  google-oauth.index.ts    ← assembles router, applies CORS
```

**After** (1 file, or 2 if backward-compat re-exports must be preserved):

```
google-oauth/
  google.descriptor.ts        ← ProviderDescriptor with overrides
  google-oauth.utils.ts       ← KEPT if other packages still import tokenToAuthData or AuthData from here
```

```typescript
// google-oauth/google.descriptor.ts
import env from "@/env.ts";
import { AuthSchema } from "@commontools/runner";
import type { JSONSchema } from "@commontools/runner";
import type { ProviderDescriptor } from "../oauth2-common/oauth2-common.types.ts";
import type { OAuth2Tokens } from "../oauth2-common/oauth2-common.types.ts";

function tokenToAuthData(token: OAuth2Tokens): Record<string, unknown> {
  return {
    token: token.accessToken,   // "token" not "accessToken" — legacy field name
    tokenType: token.tokenType,
    scope: token.scope,
    expiresIn: token.expiresIn,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresIn
      ? Date.now() + token.expiresIn * 1000
      : undefined,
  };
}

const EMPTY_GOOGLE_AUTH_DATA = {
  token: "",
  tokenType: "",
  scope: [],
  expiresIn: 0,
  expiresAt: 0,
  refreshToken: "",
  user: { email: "", name: "", picture: "" },
};

export const GoogleDescriptor: ProviderDescriptor = {
  name: "google",
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  userInfoEndpoint: "https://www.googleapis.com/oauth2/v2/userinfo",
  defaultScopes:
    "email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
  extraAuthParams: {
    access_type: "offline",
    prompt: "consent",
  },
  tokenMapper: tokenToAuthData,
  authSchema: AuthSchema as unknown as JSONSchema,
  emptyAuthData: EMPTY_GOOGLE_AUTH_DATA,
};
```

`google-oauth.utils.ts` can be preserved as a thin re-export shim if any
external code (pattern-side auth managers, tests) imports `tokenToAuthData`,
`AuthData`, or `EMPTY_GOOGLE_AUTH_DATA` from it directly. If no external
imports exist, it can be deleted entirely.

#### `app.ts` — before vs. after

**Before:**

```typescript
import googleOAuth from "@/routes/integrations/google-oauth/google-oauth.index.ts";
import airtableOAuth from "@/routes/integrations/airtable-oauth/airtable-oauth.index.ts";
import plaidOAuth from "@/routes/integrations/plaid-oauth/plaid-oauth.index.ts";
// ...
const routes = [
  ...,
  googleOAuth,
  airtableOAuth,
  plaidOAuth,
  ...,
] as const;
routes.forEach((route) => app.route("/", route));
```

**After:**

```typescript
import { buildProviderRouters } from "@/routes/integrations/provider-registry.ts";
// plaidOAuth stays manual — it uses a fully custom flow (not standard OAuth2)

const providerRouters = await buildProviderRouters();
providerRouters.forEach((r) => app.route("/", r));

// All other non-OAuth routes remain in the static `routes` array as before
```

Note: Plaid is intentionally excluded from the registry because it uses a
custom Plaid Link token flow rather than standard OAuth2 authorization-code
PKCE. It keeps its own directory and is registered manually.

#### Adding the third provider (e.g. GitHub)

With the registry in place, the entire addition is:

1. Create `github-oauth/github.descriptor.ts` with a `ProviderDescriptor`.
2. Import it in `provider-registry.ts` and push it onto `DESCRIPTORS`.

No other files need to be created or edited.

---

## Files to Modify or Create

### New files

| File | Description |
|---|---|
| `packages/toolshed/routes/integrations/provider-registry.ts` | Registry: `DESCRIPTORS` array, `createProviderRouter()`, `buildProviderRouters()` |
| `packages/toolshed/routes/integrations/airtable-oauth/airtable.descriptor.ts` | `AirtableDescriptor` — replaces the four existing airtable files |
| `packages/toolshed/routes/integrations/google-oauth/google.descriptor.ts` | `GoogleDescriptor` — replaces google handlers/routes/index, subsumes google-oauth.utils.ts logic |

### Modified files

| File | Change |
|---|---|
| `packages/toolshed/routes/integrations/oauth2-common/oauth2-common.types.ts` | Add `ProviderDescriptor` interface |
| `packages/toolshed/routes/integrations/oauth2-common/oauth2-common.utils.ts` | Add `discoverProviderConfig()` with in-memory cache |
| `packages/toolshed/routes/integrations/oauth2-common/oauth2-common.index.ts` | Export `ProviderDescriptor` and `discoverProviderConfig` |
| `packages/toolshed/app.ts` | Replace per-provider imports + array entries with `buildProviderRouters()` call; keep Plaid manual |

### Files to delete (after migration verified)

| File | Reason |
|---|---|
| `packages/toolshed/routes/integrations/airtable-oauth/airtable-oauth.config.ts` | Replaced by `airtable.descriptor.ts` |
| `packages/toolshed/routes/integrations/airtable-oauth/airtable-oauth.handlers.ts` | Replaced by registry factory |
| `packages/toolshed/routes/integrations/airtable-oauth/airtable-oauth.routes.ts` | Replaced by registry factory |
| `packages/toolshed/routes/integrations/airtable-oauth/airtable-oauth.index.ts` | Replaced by registry factory |
| `packages/toolshed/routes/integrations/google-oauth/google-oauth.handlers.ts` | Replaced by registry factory |
| `packages/toolshed/routes/integrations/google-oauth/google-oauth.routes.ts` | Replaced by `createOAuth2Routes` inside factory |
| `packages/toolshed/routes/integrations/google-oauth/google-oauth.index.ts` | Replaced by registry factory |
| `packages/toolshed/routes/integrations/google-oauth/google-oauth.utils.ts` | Logic moved to `google.descriptor.ts`; delete only if no external imports remain |

### Files left unchanged

| File | Reason |
|---|---|
| `packages/toolshed/routes/integrations/oauth2-common/oauth2-common.handlers.ts` | No changes needed |
| `packages/toolshed/routes/integrations/oauth2-common/oauth2-common.routes.ts` | No changes needed |
| `packages/toolshed/routes/integrations/plaid-oauth/*` | Custom flow; stays manual |
| `packages/toolshed/routes/integrations/discord/*` | Not OAuth2; stays manual |

---

## Verification

### 1. Route shape unchanged

Run the toolshed server locally and confirm every pre-existing route still
responds correctly:

```bash
# Airtable login — should return { url: "https://airtable.com/oauth2/..." }
curl -s -X POST http://localhost:8000/api/integrations/airtable-oauth/login \
  -H "Content-Type: application/json" \
  -d '{"authCellId":"{\"test\":true}","integrationPieceId":"pid-1"}' | jq .

# Google login — should return { url: "https://accounts.google.com/..." }
curl -s -X POST http://localhost:8000/api/integrations/google-oauth/login \
  -H "Content-Type: application/json" \
  -d '{"authCellId":"{\"test\":true}","integrationPieceId":"pid-2"}' | jq .

# Background integration — single route, not duplicated
curl -s -X POST http://localhost:8000/api/integrations/bg \
  -H "Content-Type: application/json" \
  -d '{"pieceId":"abc","space":"did:key:abc","integration":"google"}' | jq .
```

### 2. OpenAPI spec unchanged

The generated OpenAPI document at `/doc` should list the same paths for Google
and Airtable as before. Confirm with:

```bash
curl -s http://localhost:8000/doc | jq '.paths | keys | map(select(contains("oauth")))'
```

Expected output includes all `/api/integrations/airtable-oauth/*` and
`/api/integrations/google-oauth/*` paths, plus `/api/integrations/bg`.

### 3. Full OAuth flow end-to-end

Follow the existing manual test procedure in `manual-test-gmail-importer.md`
for Google and the analogous Airtable flow after migration. Confirm that:

- Login redirects to the correct provider authorization page.
- The callback persists tokens to the auth cell.
- Token refresh returns new credentials.
- Logout clears the auth cell to the correct empty shape.

### 4. Google field-name compatibility

After completing a Google OAuth flow, read the auth cell and confirm the token
is stored under the key `token` (not `accessToken`). This verifies that
`tokenMapper` wiring through the descriptor is applied correctly.

### 5. No external import breakage

Search for any imports of the deleted files:

```bash
grep -r "google-oauth.utils" packages/
grep -r "google-oauth.handlers" packages/
grep -r "google-oauth.routes" packages/
grep -r "airtable-oauth.config" packages/
grep -r "airtable-oauth.handlers" packages/
grep -r "airtable-oauth.routes" packages/
```

If any hits appear outside the files being deleted, add a re-export shim or
update the import to point at the new location before deleting the old file.
