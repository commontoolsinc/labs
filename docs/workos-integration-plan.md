# WorkOS Integration Plan

First take at adding enterprise SSO, organization management, and directory sync
to Common Tools via WorkOS.

## Context

Common Tools currently authenticates users with WebAuthn passkeys, deriving
Ed25519 DID identities client-side. There is no enterprise SSO, no
team/organization model, and ACL management is disabled. The goal is to add
WorkOS as an **additional auth path** (not replacing passkeys) that unlocks
enterprise deployment.

---

## Architecture Overview

```
                     ┌─────────────────────────┐
                     │     WorkOS Dashboard     │
                     │  (SSO connections,       │
                     │   directory sync,        │
                     │   org management)        │
                     └────────┬────────────────┘
                              │
     ┌────────────────────────┼────────────────────────┐
     │                        │                        │
     ▼                        ▼                        ▼
┌──────────┐          ┌─────────────┐          ┌──────────────┐
│ SSO/SAML │          │  Directory  │          │ Admin Portal │
│ via IdP  │          │  Sync/SCIM  │          │ (self-serve) │
└────┬─────┘          └──────┬──────┘          └──────┬───────┘
     │                       │                        │
     └───────────┬───────────┘────────────────────────┘
                 │
                 ▼
     ┌───────────────────────────────────────────────────┐
     │              Toolshed (Deno/Hono)                 │
     │                                                   │
     │  /api/auth/workos/          NEW routes            │
     │    ├── login      → redirect to WorkOS AuthKit    │
     │    ├── callback   → exchange code, map identity   │
     │    ├── session    → validate session, return user  │
     │    └── logout     → clear session                 │
     │                                                   │
     │  /api/auth/workos/admin/    Admin Portal          │
     │    └── portal     → generate Admin Portal link    │
     │                                                   │
     │  /api/auth/workos/directory/  Directory Sync      │
     │    └── webhook    → handle SCIM events            │
     │                                                   │
     │  lib/workos.ts    → WorkOS client, user→DID map   │
     │  lib/identity.ts  → unchanged (server identity)   │
     └──────────────────────┬────────────────────────────┘
                            │
                            ▼
     ┌───────────────────────────────────────────────────┐
     │              Identity Bridge                      │
     │                                                   │
     │  WorkOS user ID ──deterministic──→ Ed25519 DID    │
     │  WorkOS org ID  ──deterministic──→ Space DID      │
     │  Directory groups ──mapped to──→ ACL entries       │
     └──────────────────────────────────────────────────┘
```

---

## Phase 1: Core SSO Login Flow

**Goal:** A user can click "Sign in with SSO" in the shell, authenticate through
their company's IdP via WorkOS, and land in Common Tools with a valid identity.

### 1.1 Environment & Dependencies

**File: `packages/toolshed/env.ts`**

Add WorkOS environment variables to the Zod schema:

```typescript
// WorkOS Integration
WORKOS_API_KEY: z.string().default(""),
WORKOS_CLIENT_ID: z.string().default(""),
WORKOS_REDIRECT_URI: z.string().default(""),
WORKOS_WEBHOOK_SECRET: z.string().default(""),
// Dedicated secret for deriving WorkOS user/org DIDs.
// Separate from IDENTITY_PASSPHRASE to isolate from server key rotation.
// MUST be kept stable — changing this re-keys all WorkOS-derived identities.
WORKOS_IDENTITY_SECRET: z.string().default(""),
```

**Dependency:** Add the `@workos-inc/node` SDK. It supports Deno via the
standard Node compatibility layer. The SDK is a thin REST wrapper, so
alternatively we can call the REST API directly with `fetch` to avoid the
dependency — decide during implementation.

### 1.2 WorkOS Client Library

**New file: `packages/toolshed/lib/workos.ts`**

Initializes the WorkOS client and provides helper functions:

```typescript
import WorkOS from "@workos-inc/node";
import env from "@/env.ts";

export const workos = new WorkOS(env.WORKOS_API_KEY, {
  clientId: env.WORKOS_CLIENT_ID,
});

// Or if the SDK doesn't work cleanly in Deno, use raw fetch:
export class WorkOSClient {
  private apiKey: string;
  private clientId: string;
  private baseUrl = "https://api.workos.com";

  constructor(apiKey: string, clientId: string) { ... }

  async getAuthorizationURL(opts: {
    organization?: string;
    redirectUri: string;
    state?: string;
  }): Promise<string> { ... }

  async getProfileAndToken(code: string): Promise<{
    profile: WorkOSProfile;
    accessToken: string;
  }> { ... }

  async listDirectoryUsers(directoryId: string): Promise<DirectoryUser[]> { ... }
  async listOrganizations(): Promise<Organization[]> { ... }
  async generatePortalLink(opts: {
    organization: string;
    intent: "sso" | "dsync";
  }): Promise<string> { ... }
}
```

### 1.3 Identity Bridge — WorkOS User → DID

**New file: `packages/toolshed/lib/workos-identity.ts`**

The critical design decision: how to map a WorkOS user to a Common Tools DID.

**Approach: Dedicated WorkOS root key, separate from server identity**

A dedicated root key (derived from `WORKOS_IDENTITY_SECRET` env var) is used
exclusively for WorkOS identity derivation. This is intentionally decoupled
from the server's operational identity (`IDENTITY` / `IDENTITY_PASSPHRASE`) so
that server key rotation doesn't break WorkOS-derived DIDs.

WorkOS user IDs are globally unique (prefixed UUIDs like
`user_01E4ZCR3C56J083X43JQXF3JK5`), so the derivation path
`workos:user:{id}` is collision-free.

The derived identities are standard Ed25519 keypairs and produce `did:key:*`
DIDs. They participate in the existing UCAN/ACL auth system without any changes
to the identity or memory packages.

```typescript
import { Identity } from "@commontools/identity";
import env from "@/env.ts";

// Dedicated root key for all WorkOS identity derivation.
// Separate from the server's operational identity to isolate
// from server key rotation.
const workosRoot: Identity = await Identity.fromPassphrase(
  env.WORKOS_IDENTITY_SECRET,
);

/**
 * Derive a deterministic Common Tools identity for a WorkOS user.
 * Same user ID always yields the same DID.
 */
export async function identityForWorkOSUser(
  workosUserId: string,
): Promise<Identity> {
  return workosRoot.derive(`workos:user:${workosUserId}`);
}

/**
 * Derive a deterministic space identity for a WorkOS organization.
 *
 * This identity owns the org space (signs the first transaction to
 * anchor it). It immediately delegates to org members via ACL entries.
 * The server holds this key and uses it for:
 *   - initial space creation (first transaction)
 *   - ACL changes triggered by directory sync webhooks
 *
 * Once the platform supports proper key rotation / delegation chains,
 * this becomes one node in that delegation tree.
 */
export async function spaceForWorkOSOrg(
  workosOrgId: string,
): Promise<Identity> {
  return workosRoot.derive(`workos:org:${workosOrgId}`);
}
```

#### Space Ownership Model

When a WorkOS org space is first accessed:

1. The server derives the space identity via `spaceForWorkOSOrg(orgId)`
2. The server signs the first transaction with this identity, anchoring the
   space in an unforgeable `did:key:*` — same as any other space
3. The server immediately sets up ACL entries granting org members access
4. Ongoing ACL mutations (from directory sync webhooks) are signed by this
   same org space identity

The org space identity is held server-side. Individual users interact with
the space using their own `did:key:*` (derived from their WorkOS user ID),
authorized via ACL entries.

#### Company-Provided Keys (Opt-in, Future)

For enterprises that want sovereign control over their space:

1. Company generates their own Ed25519 keypair
2. Their space DID is `did:key:{company_pubkey}` — they own it
3. They create a delegation granting the WorkOS-derived org identity
   OWNER-level access in the ACL
4. WorkOS integration operates under this delegation
5. Company can revoke and re-key independently

This inverts the trust model: the company is the root, WorkOS is the delegate.
Requires the company to manage key material, so it's opt-in for sophisticated
deployments.

### 1.4 Server Routes

**New directory: `packages/toolshed/routes/auth/workos/`**

Following the existing integration pattern (google-oauth), create:

#### `workos.routes.ts` — Route definitions

```
POST /api/auth/workos/login        → initiate SSO (returns redirect URL)
GET  /api/auth/workos/callback     → handle IdP callback
GET  /api/auth/workos/session      → validate session, return user + identity
POST /api/auth/workos/logout       → clear session
POST /api/auth/workos/admin-portal → generate Admin Portal link (org admin only)
POST /api/auth/workos/webhook      → directory sync webhook receiver
```

#### `workos.handlers.ts` — Handler implementations

**Login handler:**
```typescript
export const login: AppRouteHandler<LoginRoute> = async (c) => {
  const { organizationId } = await c.req.json();

  const authorizationUrl = workos.sso.getAuthorizationUrl({
    organization: organizationId,  // or use connection, or let user choose
    redirectUri: env.WORKOS_REDIRECT_URI,
    state: crypto.randomUUID(),     // CSRF protection, store in cookie
  });

  return c.json({ url: authorizationUrl });
};
```

**Callback handler:**
```typescript
export const callback: AppRouteHandler<CallbackRoute> = async (c) => {
  const { code } = c.req.query();

  // Exchange code for profile
  const { profile, accessToken } = await workos.sso.getProfileAndToken(code);

  // Derive deterministic Common Tools identity for this user
  const userIdentity = await identityForWorkOSUser(profile.id);

  // If user belongs to an org, derive the org space
  const orgSpace = profile.organizationId
    ? await spaceForWorkOSOrg(profile.organizationId)
    : undefined;

  // Create a server-side session (signed JWT or opaque token)
  const sessionToken = await createWorkOSSession({
    workosUserId: profile.id,
    workosOrgId: profile.organizationId,
    email: profile.email,
    firstName: profile.firstName,
    lastName: profile.lastName,
    did: userIdentity.did(),
    orgSpaceDid: orgSpace?.did(),
  });

  // Set session cookie and redirect to shell
  setCookie(c, "workos_session", sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });

  // Redirect back to shell — the shell will call /session to get identity
  return c.redirect("/");
};
```

**Session handler:**
```typescript
export const session: AppRouteHandler<SessionRoute> = async (c) => {
  const token = getCookie(c, "workos_session");
  if (!token) return c.json({ authenticated: false }, 401);

  const session = await validateWorkOSSession(token);
  if (!session) return c.json({ authenticated: false }, 401);

  // Re-derive identity (deterministic, so this is safe)
  const userIdentity = await identityForWorkOSUser(session.workosUserId);

  return c.json({
    authenticated: true,
    user: {
      email: session.email,
      name: `${session.firstName} ${session.lastName}`,
      did: userIdentity.did(),
      organizationId: session.workosOrgId,
      orgSpaceDid: session.orgSpaceDid,
    },
    // Serialize the private key for the client to use
    // (the client needs it to sign UCAN invocations)
    identity: serializeIdentity(userIdentity),
  });
};
```

### 1.5 Shell Login View Changes

**File: `packages/shell/src/views/LoginView.ts`**

Add WorkOS SSO as a third auth option alongside passkey and passphrase:

```typescript
// New method in LoginView
private async handleWorkOSSSOLogin() {
  // Check if there's already a WorkOS session
  const res = await fetch("/api/auth/workos/session");
  if (res.ok) {
    const { identity: rawKey } = await res.json();
    const identity = await Identity.fromRaw(rawKey.privateKey);
    await this.keyStore?.set(ROOT_KEY, identity);
    this.command({ type: "set-identity", identity });
    return;
  }

  // No session — redirect to SSO
  // Could show org selector first, or use email domain discovery
  const loginRes = await fetch("/api/auth/workos/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),  // org could be pre-selected
  });
  const { url } = await loginRes.json();
  window.location.href = url;
}
```

Add a "Sign in with SSO" button to the login view template. On return from
the IdP redirect, the shell loads and calls `/api/auth/workos/session` to
retrieve the identity.

### 1.6 Whoami Enhancement

**File: `packages/toolshed/routes/whoami/whoami.handlers.ts`**

Extend to check WorkOS session cookie in addition to Tailscale headers:

```typescript
export const whoamiHandler: AppRouteHandler<typeof whoami> = async (c) => {
  // Try WorkOS session first
  const workosSession = await getWorkOSSessionFromCookie(c);
  if (workosSession) {
    return c.json({
      name: `${workosSession.firstName} ${workosSession.lastName}`,
      email: workosSession.email,
      shortName: workosSession.email.split("@")[0],
      avatar: null,
    });
  }

  // Fall back to Tailscale headers
  return c.json({
    name: c.req.header("tailscale-user-name") || null,
    email: c.req.header("tailscale-user-login") || null,
    shortName: c.req.header("tailscale-user-login")?.split("@")[0] || "system",
    avatar: c.req.header("tailscale-user-profile-pic") || null,
  });
};
```

### 1.7 Route Registration

**File: `packages/toolshed/app.ts`**

```typescript
import workos from "@/routes/auth/workos/workos.index.ts";

const routes = [
  health,
  // ... existing routes
  workos,    // Add WorkOS routes
] as const;
```

---

## Phase 2: Organization Spaces

**Goal:** When a user authenticates via WorkOS SSO belonging to an organization,
they get access to a shared organization space alongside their personal space.

### 2.1 Org-Space Mapping

Each WorkOS organization gets a deterministic space DID (from Phase 1's
`spaceForWorkOSOrg`). When a user authenticates:

1. Their personal space = their user DID (unchanged)
2. Their org space = derived from `workos:org:{orgId}`

The shell needs to present both spaces. This requires extending the navigation
to show "Personal" and "Organization" space selectors.

### 2.2 ACL Provisioning for Org Members

When a user authenticates via SSO for an org, add their DID to the org space's
ACL:

**File: `packages/toolshed/lib/workos-identity.ts`** (extend)

```typescript
import { type ACL, type Capability } from "@commontools/memory";

/**
 * Build an ACL for an org space based on WorkOS org membership.
 * All org members get WRITE access; org admins get OWNER.
 */
export async function buildOrgACL(
  orgId: string,
  members: Array<{ workosUserId: string; role: string }>,
): Promise<ACL> {
  const acl: ACL = {};
  for (const member of members) {
    const identity = await identityForWorkOSUser(member.workosUserId);
    const capability: Capability = member.role === "admin" ? "OWNER" : "WRITE";
    acl[identity.did()] = capability;
  }
  return acl;
}
```

### 2.3 Re-enable ACL Management

The ACL system in `packages/memory/acl.ts` and `packages/memory/access.ts` is
already implemented but the UI is disabled. WorkOS integration provides a reason
to re-enable it — org membership from WorkOS directly populates ACL entries.

---

## Phase 3: Directory Sync

**Goal:** When users are added/removed from the enterprise directory (Okta,
Azure AD, Google Workspace), their Common Tools access is automatically
updated.

### 3.1 Webhook Receiver

WorkOS sends webhook events for directory changes. We need a handler:

**Route: `POST /api/auth/workos/webhook`**

```typescript
export const webhook: AppRouteHandler<WebhookRoute> = async (c) => {
  const payload = await c.req.text();
  const sigHeader = c.req.header("workos-signature");

  // Verify webhook signature
  const event = workos.webhooks.constructEvent({
    payload,
    sigHeader,
    secret: env.WORKOS_WEBHOOK_SECRET,
  });

  switch (event.event) {
    case "dsync.user.created": {
      // New user in directory → derive their DID, add to org ACL
      const { directoryId, user } = event.data;
      const org = await resolveOrgForDirectory(directoryId);
      const userIdentity = await identityForWorkOSUser(user.id);
      await addToOrgACL(org.id, userIdentity.did(), "WRITE");
      break;
    }

    case "dsync.user.deleted": {
      // User removed → remove from org ACL
      const { directoryId, user } = event.data;
      const org = await resolveOrgForDirectory(directoryId);
      const userIdentity = await identityForWorkOSUser(user.id);
      await removeFromOrgACL(org.id, userIdentity.did());
      break;
    }

    case "dsync.group.user_added": {
      // User added to group → could map to finer-grained permissions
      break;
    }

    case "dsync.group.user_removed": {
      // User removed from group
      break;
    }
  }

  return c.json({ received: true });
};
```

### 3.2 Directory-to-Org Mapping

Maintain a mapping of WorkOS directory IDs to org IDs. This can be stored in
a dedicated cell/space or a simple server-side KV store. WorkOS's API provides
this mapping via the `organizationId` field on directories.

---

## Phase 4: Admin Portal

**Goal:** Let IT admins self-service configure their org's SSO connection and
directory sync through the WorkOS Admin Portal.

### 4.1 Portal Link Generation

**Route: `POST /api/auth/workos/admin-portal`**

```typescript
export const adminPortal: AppRouteHandler<AdminPortalRoute> = async (c) => {
  const { organizationId, intent } = await c.req.json();

  // Verify the requesting user is an admin of this org
  // (check their WorkOS role or ACL OWNER status)

  const portalLink = await workos.portal.generateLink({
    organization: organizationId,
    intent: intent, // "sso" or "dsync"
    returnUrl: `${env.API_URL}/settings`,
  });

  return c.json({ url: portalLink.link });
};
```

### 4.2 Shell Settings UI

Add an "Enterprise Settings" section (visible only to org admins) in the shell
that provides buttons to:
- "Configure SSO" → opens Admin Portal with `intent: "sso"`
- "Configure Directory Sync" → opens Admin Portal with `intent: "dsync"`

---

## File Change Summary

### New Files

| File | Purpose |
|------|---------|
| `packages/toolshed/lib/workos.ts` | WorkOS client initialization |
| `packages/toolshed/lib/workos-identity.ts` | User/org → DID mapping |
| `packages/toolshed/lib/workos-session.ts` | Session token creation/validation |
| `packages/toolshed/routes/auth/workos/workos.routes.ts` | Route definitions |
| `packages/toolshed/routes/auth/workos/workos.handlers.ts` | Handler implementations |
| `packages/toolshed/routes/auth/workos/workos.index.ts` | Router setup |

### Modified Files

| File | Change |
|------|--------|
| `packages/toolshed/env.ts` | Add `WORKOS_*` env vars |
| `packages/toolshed/app.ts` | Register WorkOS routes |
| `packages/toolshed/routes/whoami/whoami.handlers.ts` | Check WorkOS session |
| `packages/shell/src/views/LoginView.ts` | Add SSO login button + flow |
| `packages/shell/shared/app/state.ts` | Possibly extend state for org context |

### Untouched (but utilized)

| File | Why |
|------|-----|
| `packages/identity/src/identity.ts` | `Identity.derive()` already does what we need |
| `packages/identity/src/session.ts` | `createSession()` works as-is |
| `packages/memory/access.ts` | Authorization checks work unchanged |
| `packages/memory/acl.ts` | ACL structure supports our use case |

---

## Key Design Decisions

### 1. Dedicated WorkOS root key (not the server identity)

All WorkOS-derived DIDs (users and org spaces) come from a dedicated root key
(`WORKOS_IDENTITY_SECRET`), separate from the server's operational identity.
This means:
- Server key rotation doesn't break WorkOS-derived identities
- The WorkOS root is a single secret to protect/back up
- Enterprise deployments trust their IdP + the WorkOS root key holder
- Personal passkey users continue to derive identity client-side (unaffected)

The derived identities are standard `did:key:*` — they participate in the
existing UCAN/ACL system unchanged. No custom DID methods needed (a future
`did:workos:*` method could add resolution-level semantics but isn't required
for the first take).

### 2. WorkOS SDK vs raw fetch

The `@workos-inc/node` SDK claims Deno support. Try it first. If it has
issues in the Deno runtime, fall back to raw `fetch` calls against the
WorkOS REST API (it's straightforward REST with Bearer token auth).

### 3. Session storage: signed cookies

Use signed JWT cookies for WorkOS sessions rather than server-side session
storage. This avoids needing a session store and is stateless. The JWT contains
the WorkOS user ID and org ID — the DID is re-derived on each request
(deterministic, so this is cheap).

### 4. Coexistence with passkeys

Both auth methods coexist. The LoginView shows:
- "Sign in with Passkey" (existing)
- "Sign in with SSO" (new)
- Passphrase fallback (existing, dev only)

A user authenticated via WorkOS SSO gets an identity stored in the same
KeyStore. If they later use a passkey, that's a different identity (different
DID). This is intentional — enterprise identity is tied to org membership,
personal identity is sovereign.

---

## Implementation Order

**Phase 1** is the critical path and should be built first:
1. Env vars + WorkOS client lib
2. Identity bridge (`workos-identity.ts`)
3. Session management (`workos-session.ts`)
4. Server routes (login → callback → session → logout)
5. Shell LoginView SSO button
6. Whoami enhancement
7. Route registration + test end-to-end

**Phase 2-4** can follow incrementally once Phase 1 works.

---

## Open Questions

1. **SDK or raw fetch?** — Need to test `@workos-inc/node` in Deno. If it
   imports cleanly, use it. Otherwise, the API surface is small enough to
   wrap with fetch.

2. **Serializing identity to client** — The callback handler needs to get
   the derived private key to the client so it can sign UCAN invocations.
   Options: (a) serialize in the session endpoint response, (b) use the
   server as a signing proxy. Option (a) is simpler and matches the existing
   passkey model where the client holds the key.

3. **Multi-org users** — A user might belong to multiple WorkOS orgs. The
   login flow should let them pick which org to authenticate into, or
   default to their primary and let them switch in the shell.

4. **Key rotation** — If a WorkOS user is deprovisioned and re-provisioned,
   they get the same DID (deterministic from user ID). Is that desired?
   Probably yes — their data should persist.

5. **`WORKOS_IDENTITY_SECRET` lifecycle** — This secret is the root of all
   WorkOS-derived identities. Changing it re-keys every user and org space.
   Need a clear operational story: how is it generated, backed up, and
   (eventually) rotated? Once the platform has proper delegation chains,
   rotation becomes: derive from new secret, delegate from old identities
   to new ones.

6. **Company-provided keys** — The opt-in model where a company provides
   their own keypair and delegates to WorkOS is clean but adds onboarding
   complexity. Should this be a Phase 2+ feature, or should we design the
   schema to accommodate it from the start (even if not exposed in UI)?
