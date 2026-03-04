/**
 * importer-prompt.ts — Generate a structured prompt for Claude to produce a
 * complete importer pattern suite (auth, auth-manager, API client, importer)
 * for an arbitrary OAuth2-backed API provider.
 *
 * Usage:
 *   import { generateImporterPrompt } from "./importer-prompt.ts";
 *
 *   const prompt = generateImporterPrompt({
 *     providerName: "notion",
 *     brandColor: "#000000",
 *     api: extractedAPI,
 *     providerConfig: providerConfig,
 *     primaryListEndpoint: "/v1/search",
 *   });
 *
 * The returned string is a self-contained prompt that Claude can use to
 * generate four working pattern files in one shot.
 *
 * @module
 */

import type { ExtractedProviderConfig } from "./openapi-to-provider.ts";

// ---------------------------------------------------------------------------
// Types for extracted API info (compatible with openapi-extract.ts if present)
// ---------------------------------------------------------------------------

/** A single API endpoint extracted from an OpenAPI spec. */
export interface ExtractedEndpoint {
  /** HTTP method (GET, POST, etc.) */
  method: string;
  /** URL path, e.g. "/v1/databases/{database_id}/query" */
  path: string;
  /** Short summary from the spec */
  summary?: string;
  /** Longer description */
  description?: string;
  /** Path parameters */
  pathParameters?: ExtractedParameter[];
  /** Query parameters */
  queryParameters?: ExtractedParameter[];
  /** Request body schema (JSON-serializable) */
  requestBody?: Record<string, unknown>;
  /** Response schema (JSON-serializable) */
  responseSchema?: Record<string, unknown>;
  /** Tags from the spec */
  tags?: string[];
}

/** A single parameter extracted from an endpoint. */
export interface ExtractedParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

/** Detected pagination pattern for the API. */
export interface PaginationInfo {
  /** Style of pagination: "cursor", "offset", "page", "link" */
  style: "cursor" | "offset" | "page" | "link" | "unknown";
  /** Name of the cursor/offset parameter in requests */
  requestParam?: string;
  /** Path to the cursor/token in responses (dot-separated) */
  responseCursorPath?: string;
  /** Path to the data array in responses (dot-separated) */
  responseDataPath?: string;
  /** Name of the page-size parameter */
  pageSizeParam?: string;
}

/** Complete extracted API information. */
export interface ExtractedAPI {
  /** Base URL for API requests */
  baseUrl: string;
  /** All extracted endpoints */
  endpoints: ExtractedEndpoint[];
  /** Detected pagination pattern */
  pagination?: PaginationInfo;
  /** Rate limit info if detected */
  rateLimit?: {
    requestsPerSecond?: number;
    headerName?: string;
  };
}

// ---------------------------------------------------------------------------
// Prompt context
// ---------------------------------------------------------------------------

export interface PromptContext {
  providerName: string;
  brandColor: string;
  api: ExtractedAPI;
  providerConfig: ExtractedProviderConfig;
  /** Optional: user-provided hint for the primary list endpoint */
  primaryListEndpoint?: string;
  /** Optional: user-provided hint for the primary get endpoint */
  primaryGetEndpoint?: string;
}

// ---------------------------------------------------------------------------
// Reference source code (embedded as template literals)
// ---------------------------------------------------------------------------

const AIRTABLE_AUTH_SOURCE = `/// <cts-enable />
import {
  computed,
  Default,
  getPatternEnvironment,
  handler,
  NAME,
  pattern,
  Secret,
  Stream,
  UI,
  Writable,
} from "commontools";

const env = getPatternEnvironment();

/**
 * Airtable OAuth token data.
 * Uses \`accessToken\` field (OAuth2TokenSchema convention).
 */
export type AirtableAuth = {
  accessToken: Default<Secret<string>, "">;
  tokenType: Default<string, "">;
  scope: Default<string[], []>;
  expiresIn: Default<number, 0>;
  expiresAt: Default<number, 0>;
  refreshToken: Default<Secret<string>, "">;
  user: Default<{
    email: string;
    name: string;
    picture: string;
  }, { email: ""; name: ""; picture: "" }>;
};

interface Input {
  selectedScopes: Default<SelectedScopes, { /* defaults */ }>;
  auth: Default<AirtableAuth, { /* empty defaults */ }>;
}

/** Airtable OAuth authentication for Airtable APIs. #airtableAuth */
interface Output {
  auth: AirtableAuth;
  scopes: string[];
  selectedScopes: SelectedScopes;
  userChip: unknown;
  previewUI: unknown;
  refreshToken: Stream<Record<string, never>>;
  bgUpdater: Stream<Record<string, never>>;
}

// Key parts of the pattern:
// 1. Uses \`ct-oauth\` component for OAuth flow
// 2. Computes active scopes from user selection
// 3. Handles token refresh via server endpoint
// 4. Provides bgUpdater for background-charm-service
// 5. Uses reactive clock for token expiry display

export default pattern<Input, Output>(({ auth, selectedScopes }) => {
  const scopes = computed(() => {
    const base: string[] = ["user.email:read"];
    for (const [key, enabled] of Object.entries(selectedScopes)) {
      if (enabled) base.push(key);
    }
    return base;
  });

  // ... (scope checks, token refresh, UI) ...

  return {
    [NAME]: computed(() => auth?.user?.email ? \`Airtable Auth (\${auth.user.email})\` : "Airtable Auth"),
    [UI]: (
      <div>
        <ct-oauth
          $auth={auth}
          scopes={scopes}
          provider="airtable"
          providerLabel="Airtable"
          brandColor="#18BFFF"
          loginEndpoint="/api/integrations/airtable-oauth/login"
          tokenField="accessToken"
        />
      </div>
    ),
    auth,
    scopes,
    selectedScopes,
    userChip,
    previewUI,
    refreshToken: refreshTokenHandler({ auth }),
    bgUpdater: bgRefreshHandler({ auth }),
  };
});`;

const AIRTABLE_AUTH_MANAGER_SOURCE = `/// <cts-enable />
/**
 * Airtable Auth Manager - Unified auth management utility
 *
 * Uses wish() with framework picker for account selection.
 * Detects missing scopes, expired tokens, provides recovery UI.
 *
 * Usage:
 *   const { auth, fullUI, isReady } = AirtableAuthManager({
 *     requiredScopes: ["data.records:read", "schema.bases:read"],
 *   });
 */
import {
  action, computed, Default, handler, ifElse,
  navigateTo, pattern, UI, wish, Writable,
} from "commontools";

import AirtableAuth, { type AirtableAuth as AirtableAuthType } from "../airtable-auth.tsx";

export type ScopeKey = "data.records:read" | "data.records:write" | "schema.bases:read" | /* etc */;

export const AirtableAuthManager = pattern<
  AirtableAuthManagerInput,
  AirtableAuthManagerOutput
>(({ requiredScopes, debugMode }) => {
  // 1. wish() discovers auth across the space
  const wishResult = wish<AirtableAuthPiece>({
    query: "#airtableAuth",
    scope: [".", "~"],
  });
  const auth = wishResult.result.auth;

  // 2. Small focused computeds
  const hasAuth = computed(() => !!auth);
  const hasToken = computed(() => !!auth?.accessToken);
  const hasEmail = computed(() => !!auth?.user?.email);

  // 3. Reactive clock for token expiry
  const now = Writable.of(Date.now());
  setInterval(() => now.set(Date.now()), 30_000);

  const isTokenExpired = computed(() => {
    const expiresAt = auth?.expiresAt ?? 0;
    return expiresAt > 0 && expiresAt < now.get();
  });

  // 4. Scope verification
  const missingScopes = computed((): ScopeKey[] => {
    const granted: string[] = (auth?.scope ?? []) as string[];
    return (requiredScopes as ScopeKey[]).filter(key => !granted.includes(key));
  });
  const hasRequiredScopes = computed(() => (missingScopes as ScopeKey[]).length === 0);

  // 5. Picker UI - NOT inside computed (crashes reactive graph)
  const pickerUI = wishResult[UI];

  // 6. State machine
  const currentState = computed((): AuthState => {
    if (!hasAuth) return "loading";
    if (!hasToken || !hasEmail) return "needs-login";
    if (!hasRequiredScopes) return "missing-scopes";
    if (isTokenExpired) return "token-expired";
    return "ready";
  });

  const isReady = computed(() =>
    hasToken && hasEmail && !isTokenExpired && hasRequiredScopes
  );

  // 7. Actions for creating/managing auth
  const createAuth = action(() => navigateTo(AirtableAuth({ /* defaults */ })));
  const reauthenticate = action(() => navigateTo(wishResult.result));

  // 8. Compose fullUI via chained ifElse
  const fullUI = ifElse(isReadyState, readyUI,
    ifElse(isTokenExpiredState, tokenExpiredUI,
      ifElse(isMissingScopes, missingScopesUI,
        ifElse(isNeedsLogin, needsLoginUI, loadingUI))));

  return {
    auth: computed(() => auth ?? null),
    isReady,
    fullUI,
    [UI]: fullUI,
  };
});

export default AirtableAuthManager;`;

const AIRTABLE_CLIENT_SOURCE = `/**
 * Airtable API client with automatic token refresh and retry logic.
 */
import { getPatternEnvironment, Writable } from "commontools";

const env = getPatternEnvironment();
const AIRTABLE_API_BASE = "https://api.airtable.com/v0";
const AIRTABLE_META_BASE = "https://api.airtable.com/v0/meta";

export class AirtableClient {
  private authCell: Writable<AirtableAuthType>;
  private retries: number;
  private delay: number;

  constructor(authCell: Writable<AirtableAuthType>, config = {}) {
    this.authCell = authCell;
    this.retries = config.retries ?? 2;
    this.delay = config.delay ?? 1000;
  }

  private getToken(): string {
    const auth = this.authCell.get();
    return auth?.accessToken || "";
  }

  private async request<T>(url: string, options: RequestInit = {}): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const token = this.getToken();
      if (!token) throw new Error("No access token available");
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            Authorization: \`Bearer \${token}\`,
            "Content-Type": "application/json",
            ...options.headers,
          },
        });
        if (response.status === 401) {
          await this.refreshToken();
          continue;
        }
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : this.delay * (attempt + 1);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(\`API error \${response.status}: \${errorBody}\`);
        }
        return (await response.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.retries) {
          await new Promise(r => setTimeout(r, this.delay));
        }
      }
    }
    throw lastError || new Error("Request failed after retries");
  }

  private async refreshToken(): Promise<void> {
    const auth = this.authCell.get();
    const refreshToken = auth?.refreshToken;
    if (!refreshToken) throw new Error("No refresh token available");
    const res = await fetch(
      new URL("/api/integrations/airtable-oauth/refresh", env.apiUrl),
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }) }
    );
    if (!res.ok) throw new Error(\`Token refresh failed: \${res.status}\`);
    const json = await res.json();
    this.authCell.update({ ...json.tokenInfo, user: auth.user });
  }

  // Pagination: uses offset-based cursor
  async listBases(): Promise<AirtableBase[]> {
    const bases: AirtableBase[] = [];
    let offset: string | undefined;
    do {
      const url = new URL(\`\${AIRTABLE_META_BASE}/bases\`);
      if (offset) url.searchParams.set("offset", offset);
      const response = await this.request<{ bases: AirtableBase[]; offset?: string }>(url.toString());
      bases.push(...response.bases);
      offset = response.offset;
    } while (offset);
    return bases;
  }

  async listRecords(baseId: string, tableId: string, options = {}): Promise<AirtableRecord[]> {
    const records: AirtableRecord[] = [];
    let offset: string | undefined;
    const maxRecords = options.maxRecords ?? 1000;
    do {
      const url = new URL(\`\${AIRTABLE_API_BASE}/\${baseId}/\${encodeURIComponent(tableId)}\`);
      if (offset) url.searchParams.set("offset", offset);
      const response = await this.request<{ records: AirtableRecord[]; offset?: string }>(url.toString());
      records.push(...response.records);
      offset = response.offset;
      if (records.length >= maxRecords) break;
    } while (offset);
    return records.slice(0, maxRecords);
  }
}`;

const AIRTABLE_IMPORTER_SOURCE = `/// <cts-enable />
import {
  computed, Default, handler, ifElse, NAME,
  pattern, UI, Writable,
} from "commontools";
import { AirtableAuthManager, type ScopeKey } from "./core/util/airtable-auth-manager.tsx";
import { AirtableClient } from "./core/util/airtable-client.ts";

const REQUIRED_SCOPES: ScopeKey[] = ["data.records:read", "schema.bases:read"];

// Module-scope handlers for async API calls
const fetchBases = handler<unknown, {
  auth: Writable<AirtableAuth>;
  bases: Writable<BaseInfo[]>;
  loading: Writable<boolean>;
  error: Writable<string>;
}>(async (_event, { auth, bases, loading, error }) => {
  loading.set(true);
  error.set("");
  try {
    const client = new AirtableClient(auth);
    const result = await client.listBases();
    bases.set(result.map(b => ({ id: b.id, name: b.name })));
  } catch (e) {
    error.set(e instanceof Error ? e.message : String(e));
  } finally {
    loading.set(false);
  }
});

export default pattern<Input, Output>(({ selectedBaseId, selectedTableId }) => {
  // 1. Auth manager provides auth + UI
  const { auth: authResult, isReady, fullUI: authUI } = AirtableAuthManager({
    requiredScopes: REQUIRED_SCOPES,
  });
  const auth = authResult as any;

  // 2. Mutable state via Writable cells
  const bases = Writable.of<BaseInfo[]>([]);
  const tables = Writable.of<TableInfo[]>([]);
  const records = Writable.of<AirtableRecordData[]>([]);
  const loading = Writable.of(false);
  const error = Writable.of("");

  // 3. Derived state via computed
  const hasBases = computed(() => bases.get().length > 0);
  const recordCount = computed(() => records.get().length);

  // 4. Bind handlers with reactive inputs
  const boundFetchBases = fetchBases({ auth, bases, loading, error });

  // 5. UI with ifElse for conditional rendering
  return {
    [NAME]: computed(() => "Airtable Importer"),
    [UI]: (
      <div style={{ padding: "25px", maxWidth: "900px" }}>
        <h2>Airtable Importer</h2>
        {authUI}
        {ifElse(isReady,
          <div>
            <button onClick={boundFetchBases} disabled={loading}>
              {ifElse(loading, "Loading...", "Load Bases")}
            </button>
            {ifElse(hasBases, baseListUI, <p>Click to load bases</p>)}
            {/* ... table selection, record display ... */}
          </div>,
          null
        )}
      </div>
    ),
    records: computed(() => records.get()),
    bases: computed(() => bases.get()),
  };
});`;

// ---------------------------------------------------------------------------
// Prompt generation
// ---------------------------------------------------------------------------

/**
 * Generate a comprehensive prompt for Claude to produce a complete importer
 * pattern suite for the given API provider.
 */
export function generateImporterPrompt(ctx: PromptContext): string {
  const {
    providerName,
    brandColor,
    api,
    providerConfig,
    primaryListEndpoint,
    primaryGetEndpoint,
  } = ctx;

  const pascalName = providerName
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  const camelName = pascalName.charAt(0).toLowerCase() + pascalName.slice(1);
  const hashTag = `#${camelName}Auth`;
  const providerLabel = pascalName;

  const sections: string[] = [];

  // =========================================================================
  // SECTION 1: System context — Pattern framework overview
  // =========================================================================
  sections.push(`<system>
You are generating Common Tools pattern files for the "${providerLabel}" API integration.

## Common Tools Pattern Framework

Common Tools patterns are reactive programs (similar to Solid.js components)
that define a reactive graph once upfront. They are NOT re-invoked like React
components.

### Imports

All patterns start with:
\`\`\`tsx
/// <cts-enable />
import {
  computed, Default, handler, ifElse, NAME, pattern, Secret,
  Stream, UI, Writable, getPatternEnvironment, wish, action, navigateTo,
} from "commontools";
\`\`\`

Import only what you need from the above list.

### Core Concepts

- **\`pattern<Input, Output>(fn)\`** — Defines a pattern. The function runs once
  and returns an object with output cells.
- **\`computed(() => expr)\`** — Derived reactive value. Re-evaluates when
  dependencies change. NEVER access \`wishResult[UI]\` inside a computed.
- **\`Writable.of(initialValue)\`** — Mutable reactive cell. Use \`.get()\` to read,
  \`.set(value)\` to write, \`.update(partial)\` for partial updates.
- **\`handler<EventType, ContextType>(async (event, context) => { ... })\`** —
  Async event handler. Declare at module scope, bind inside the pattern by
  passing context: \`myHandler({ cell1, cell2 })\`.
- **\`ifElse(condition, trueNode, falseNode)\`** — Conditional rendering.
  condition must be a reactive value (computed or cell).
- **\`wish<T>({ query, scope })\`** — Discover pieces across the space. Returns
  \`{ result, [UI] }\`. The \`[UI]\` is a picker component. NEVER access
  \`wishResult[UI]\` inside a \`computed()\` — it crashes the reactive graph.
- **\`action(() => expr)\`** — Create a navigation/side-effect action.
- **\`navigateTo(piece)\`** — Navigate to another piece.
- **\`cell(value)\`** — Create a named cell (alias for Writable.of in some contexts).
- **\`[NAME]\`** — Special symbol for the piece's display name.
- **\`[UI]\`** — Special symbol for the piece's rendered UI.
- **\`Default<T, D>\`** — Type with a default value.
- **\`Secret<T>\`** — Type wrapper marking a value as secret.
- **\`Stream<T>\`** — Stateless channel. Written via \`.send()\`. Used for handlers
  that can be called from other pieces.

### UI Components

Use \`<common-*>\` or \`ct-*\` custom elements:

- \`<ct-oauth $auth={auth} scopes={scopes} provider="..." providerLabel="..." brandColor="..." loginEndpoint="..." tokenField="...">\` — OAuth flow component
- \`<ct-checkbox $checked={cell}>Label</ct-checkbox>\` — Checkbox with bidirectional binding
- \`<ct-input $value={cell} placeholder="..." />\` — Text input with bidirectional binding
- \`<ct-select $value={cell} items={[{label, value}]} />\` — Select dropdown
- \`<ct-button onClick={handler}>Label</ct-button>\` — Button
- \`<ct-card>...</ct-card>\` — Styled card container
- \`<ct-vstack gap={N}>...</ct-vstack>\` — Vertical stack layout
- \`<ct-render $cell={patternInstance} />\` — Render a sub-pattern

Native HTML elements (\`<div>\`, \`<table>\`, \`<button>\`) work with object-style
\`style={{ camelCase: "value" }}\`. Custom \`ct-*\` elements use string-style
\`style="kebab-case: value;"\`.

### Anti-Patterns to Avoid

1. **NEVER** access \`wishResult[UI]\` inside a \`computed()\` — crashes silently
2. **NEVER** use React patterns (useState, useEffect, etc.)
3. **NEVER** re-invoke the pattern function — it runs exactly once
4. \`computed()\` failures propagate silently — downstream values become undefined
5. Always use \`handler()\` for async operations (API calls), not inline async
6. Use module-scope \`handler()\` definitions, bind inside the pattern

### File Structure Convention

For a provider named "acme":
\`\`\`
packages/patterns/acme/
  acme-importer.tsx          # Main importer pattern
  core/
    acme-auth.tsx            # Auth pattern (thin, uses ct-oauth)
    util/
      acme-auth-manager.tsx  # Auth manager (token lifecycle, wish-based discovery)
      acme-client.ts         # Typed API client with pagination + retry
\`\`\`
</system>`);

  // =========================================================================
  // SECTION 2: Reference implementations
  // =========================================================================
  sections.push(`<reference-implementations>
Study these working implementations carefully. Your generated code must follow
the same patterns exactly.

## Reference: Airtable Auth Pattern (airtable-auth.tsx)

${AIRTABLE_AUTH_SOURCE}

## Reference: Airtable Auth Manager (airtable-auth-manager.tsx)

${AIRTABLE_AUTH_MANAGER_SOURCE}

## Reference: Airtable API Client (airtable-client.ts)

${AIRTABLE_CLIENT_SOURCE}

## Reference: Airtable Importer (airtable-importer.tsx)

${AIRTABLE_IMPORTER_SOURCE}
</reference-implementations>`);

  // =========================================================================
  // SECTION 3: Extracted API information
  // =========================================================================
  sections.push(`<api-info>
## Provider: ${providerLabel}

- **Provider name (slug):** ${providerName}
- **Brand color:** ${brandColor}
- **Base URL:** ${api.baseUrl}
- **Security scheme:** ${providerConfig.securitySchemeType}${
    providerConfig.oauthFlowType ? ` (${providerConfig.oauthFlowType})` : ""
  }
${
    providerConfig.authorizationEndpoint
      ? `- **Authorization endpoint:** ${providerConfig.authorizationEndpoint}`
      : ""
  }
${
    providerConfig.tokenEndpoint
      ? `- **Token endpoint:** ${providerConfig.tokenEndpoint}`
      : ""
  }

### OAuth2 Scopes

${
    Object.keys(providerConfig.scopes).length > 0
      ? Object.entries(providerConfig.scopes)
        .map(([scope, desc]) => `- \`${scope}\` — ${desc}`)
        .join("\n")
      : "(No scopes defined in the spec — the provider may use a flat token without scopes.)"
  }

### Pagination

${
    api.pagination
      ? `- **Style:** ${api.pagination.style}
- **Request param:** ${api.pagination.requestParam ?? "(not detected)"}
- **Response cursor path:** ${
        api.pagination.responseCursorPath ?? "(not detected)"
      }
- **Response data path:** ${api.pagination.responseDataPath ?? "(not detected)"}
- **Page size param:** ${api.pagination.pageSizeParam ?? "(not detected)"}`
      : "(No pagination pattern detected. Check endpoints below for cursor/offset params.)"
  }

${
    api.rateLimit
      ? `### Rate Limiting
- Requests per second: ${api.rateLimit.requestsPerSecond ?? "unknown"}
- Header: ${api.rateLimit.headerName ?? "unknown"}`
      : ""
  }

### Available Endpoints

${
    api.endpoints.map((ep) => {
      let block = `#### ${ep.method.toUpperCase()} ${ep.path}`;
      if (ep.summary) block += `\n${ep.summary}`;
      if (ep.description) block += `\n${ep.description}`;
      if (ep.tags?.length) block += `\nTags: ${ep.tags.join(", ")}`;

      if (ep.pathParameters?.length) {
        block += "\n\nPath parameters:";
        for (const p of ep.pathParameters) {
          block += `\n  - \`${p.name}\`${p.required ? " (required)" : ""}${
            p.description ? `: ${p.description}` : ""
          }`;
          if (p.schema) block += ` — ${JSON.stringify(p.schema)}`;
        }
      }

      if (ep.queryParameters?.length) {
        block += "\n\nQuery parameters:";
        for (const p of ep.queryParameters) {
          block += `\n  - \`${p.name}\`${p.required ? " (required)" : ""}${
            p.description ? `: ${p.description}` : ""
          }`;
          if (p.schema) block += ` — ${JSON.stringify(p.schema)}`;
        }
      }

      if (ep.responseSchema) {
        block += `\n\nResponse schema:\n\`\`\`json\n${
          JSON.stringify(ep.responseSchema, null, 2)
        }\n\`\`\``;
      }

      return block;
    }).join("\n\n")
  }

${
    primaryListEndpoint
      ? `### Primary List Endpoint (user hint): ${primaryListEndpoint}`
      : ""
  }
${
    primaryGetEndpoint
      ? `### Primary Get Endpoint (user hint): ${primaryGetEndpoint}`
      : ""
  }
</api-info>`);

  // =========================================================================
  // SECTION 4: Generation instructions
  // =========================================================================
  sections.push(`<instructions>
Generate four complete files for the **${providerLabel}** provider. Output each
file in a fenced code block with the file path as a comment on the first line.

## File 1: \`packages/patterns/${providerName}/core/${providerName}-auth.tsx\`

A thin auth pattern that wraps the \`<ct-oauth>\` component. Follow the Airtable
auth reference exactly, adapting for ${providerLabel}:

- First line: \`/// <cts-enable />\`
- Export a type \`${pascalName}Auth\` with fields:
  - \`accessToken: Default<Secret<string>, "">\`  (or \`token\` if the provider uses that convention)
  - \`tokenType: Default<string, "">\`
  - \`scope: Default<string[], []>\`
  - \`expiresIn: Default<number, 0>\`
  - \`expiresAt: Default<number, 0>\`
  - \`refreshToken: Default<Secret<string>, "">\`
  - \`user: Default<{ email: string; name: string; picture: string }, { email: ""; name: ""; picture: "" }>\`
- Use the \`#${
    hashTag.slice(1)
  }\` tag in the Output interface JSDoc comment for wish() discovery
- Use \`<ct-oauth>\` with:
  - \`provider="${providerName}"\`
  - \`providerLabel="${providerLabel}"\`
  - \`brandColor="${brandColor}"\`
  - \`loginEndpoint="/api/integrations/${providerName}-oauth/login"\`
  - \`tokenField="accessToken"\`
- Handle token refresh via \`/api/integrations/${providerName}-oauth/refresh\`
- Include a \`bgUpdater\` stream handler for background-charm-service
- Define scope checkboxes matching the available scopes:
${
    Object.entries(providerConfig.scopes).map(([s, d]) =>
      `  - \`${s}\`: "${d}"`
    ).join("\n") || "  (define reasonable defaults based on the API endpoints)"
  }

## File 2: \`packages/patterns/${providerName}/core/util/${providerName}-auth-manager.tsx\`

Auth manager utility pattern. Follow the Airtable auth manager reference:

- First line: \`/// <cts-enable />\`
- Import the auth pattern: \`import ${pascalName}Auth, { type ${pascalName}Auth as ${pascalName}AuthType } from "../${providerName}-auth.tsx";\`
- Use \`wish<${pascalName}AuthPiece>({ query: "${hashTag}", scope: [".", "~"] })\` to discover auth
- Implement the full state machine: loading -> needs-login -> missing-scopes -> token-expired -> ready
- Extract \`pickerUI = wishResult[UI]\` OUTSIDE of any computed()
- Provide \`fullUI\` via chained \`ifElse()\` calls
- Export \`${pascalName}AuthManager\` as both named and default export
- Use brand color \`${brandColor}\` for buttons and status indicators

## File 3: \`packages/patterns/${providerName}/core/util/${providerName}-client.ts\`

Typed API client class. Follow the Airtable client reference:

- Import \`getPatternEnvironment\` and \`Writable\` from "commontools"
- Import auth type from the auth pattern
- Base URL: \`${api.baseUrl}\`
- Implement:
  - \`private request<T>(url, options)\` with:
    - Bearer token auth from \`this.authCell.get().accessToken\`
    - Retry logic (default 2 retries)
    - 401 -> auto refresh token via \`/api/integrations/${providerName}-oauth/refresh\`
    - 429 -> respect Retry-After header${
    api.rateLimit?.requestsPerSecond
      ? `, max ${api.rateLimit.requestsPerSecond} req/s`
      : ""
  }
  - \`private refreshToken()\` — calls the server refresh endpoint
  - Public methods for each key API endpoint, with proper TypeScript types
  - Pagination support using the ${api.pagination?.style ?? "detected"} pattern:
${
    api.pagination
      ? `    - Request param: \`${api.pagination.requestParam}\`
    - Response cursor: \`${api.pagination.responseCursorPath}\`
    - Data path: \`${api.pagination.responseDataPath}\``
      : "    - Implement based on the endpoint response schemas"
  }

## File 4: \`packages/patterns/${providerName}/${providerName}-importer.tsx\`

Main importer pattern. Follow the Airtable importer reference:

- First line: \`/// <cts-enable />\`
- Import from \`"commontools"\`: computed, Default, handler, ifElse, NAME, pattern, UI, Writable
- Import the auth manager and client
- Define module-scope \`handler()\` functions for each API call:
  - Each handler takes \`auth\`, relevant state cells (\`loading\`, \`error\`, result cells)
  - Each uses \`try/catch/finally\` with \`loading.set(true/false)\`
  - Creates a client instance: \`new ${pascalName}Client(auth)\`
- The pattern function:
  1. Creates auth manager: \`const { auth, isReady, fullUI: authUI } = ${pascalName}AuthManager({ requiredScopes: [...] })\`
  2. Defines Writable cells for mutable state (lists, loading, error)
  3. Defines computed cells for derived state (hasList, recordCount, etc.)
  4. Binds handlers with reactive context
  5. Returns [NAME], [UI], and data outputs
- UI structure:
  1. Title header
  2. \`{authUI}\` for auth status/picker
  3. \`ifElse(isReady, mainContent, null)\` — main content only when authenticated
  4. Inside main content:
     - Resource selection (hierarchical if applicable, like base -> table)
     - Fetch button with loading state: \`{ifElse(loading, "Loading...", "Fetch Data")}\`
     - Data display in an HTML \`<table>\` with sticky headers
     - Error display with \`ifElse(hasError, errorDiv, null)\`
  5. Use brand color \`${brandColor}\` for buttons and highlights

## Critical Patterns to Follow

1. **wish() for auth discovery** — Always use \`wish({ query: "${hashTag}", scope: [".", "~"] })\`
2. **handler() for async ops** — Define at module scope, bind inside pattern
3. **ifElse() for conditional rendering** — condition must be computed/cell, not raw boolean
4. **Writable.of() for mutable state** — Use \`.get()\` in handlers, \`.set()\` to update
5. **computed() for derived values** — Pure computations only, no side effects
6. **Token refresh on 401** — Client auto-refreshes via server endpoint
7. **No React patterns** — No useState, useEffect, hooks, or re-rendering
8. **Data in <table>** — Use standard HTML table with inline styles for data display
9. **First line: \`/// <cts-enable />\`** — Required for all .tsx pattern files
10. **Import from "commontools"** — Not from individual packages
</instructions>`);

  return sections.join("\n\n");
}
