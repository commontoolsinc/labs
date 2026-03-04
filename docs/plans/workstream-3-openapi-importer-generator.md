# Workstream 3: OpenAPI Meta-Pattern for Importer Generation

## Vision

Most API importers follow the same shape: authenticate → list resources →
select resource → fetch records. The Airtable importer demonstrates this
concretely: it uses an auth manager to obtain a valid token, calls a list
endpoint (bases), drills into a sub-resource (tables), and finally fetches
paginated records. Given an OpenAPI spec, a large fraction of this structure
can be inferred automatically.

The goal of this workstream is a set of CLI tools that:

1. Parse an OpenAPI spec and extract the information relevant to building an
   importer — auth schemes, list endpoints, pagination conventions, data models.
2. Assemble that information into a structured prompt that encodes the pattern
   framework's conventions.
3. Submit the prompt to Claude via the Anthropic SDK and write the resulting
   files to disk.
4. Run `ct check` to validate the output before presenting it to the developer.

The developer's remaining work should be limited to: correcting edge cases the
spec did not express clearly, wiring provider-specific secrets, and adding any
domain-specific display logic.

---

## Architecture

The tools live under `packages/patterns/tools/`. They are pure Deno scripts
invoked directly with `deno run`. They have no runtime dependency on the
Common Tools pattern framework itself — they are developer-side utilities, not
patterns.

```
packages/patterns/tools/
  openapi-to-provider.ts   # Stage 1a: spec securitySchemes → ProviderDescriptor JSON
  openapi-extract.ts       # Stage 1b: endpoints + models → ExtractedAPI JSON
  importer-prompt.ts       # Stage 2: ExtractedAPI → prompt string for Claude
  generate-importer.ts     # Stage 3: orchestrator CLI
  lib/
    openapi-types.ts       # Shared TypeScript types for OpenAPI 3.x objects
    spec-loader.ts         # fetch-or-read a spec from URL or local path
    schema-utils.ts        # JSON Schema inline / $ref resolution helpers
```

Each stage can be run independently for inspection and debugging.

---

## Detailed Design

### `lib/openapi-types.ts`

Defines the subset of OpenAPI 3.x types that the tools actually read. Keeping
this minimal avoids pulling in a heavy dependency.

```typescript
export interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject | ReferenceObject>;
    securitySchemes?: Record<string, SecuritySchemeObject | ReferenceObject>;
  };
  security?: SecurityRequirementObject[];
}

export interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  delete?: OperationObject;
  parameters?: Array<ParameterObject | ReferenceObject>;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Array<ParameterObject | ReferenceObject>;
  responses: Record<string, ResponseObject | ReferenceObject>;
  security?: SecurityRequirementObject[];
  tags?: string[];
}

export interface ParameterObject {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  schema?: SchemaObject | ReferenceObject;
  description?: string;
}

export interface SchemaObject {
  type?: string;
  items?: SchemaObject | ReferenceObject;
  properties?: Record<string, SchemaObject | ReferenceObject>;
  required?: string[];
  description?: string;
  $ref?: string;
  allOf?: Array<SchemaObject | ReferenceObject>;
  oneOf?: Array<SchemaObject | ReferenceObject>;
}

export interface ReferenceObject {
  $ref: string;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject | ReferenceObject }>;
}

export type SecuritySchemeObject =
  | OAuth2SecurityScheme
  | ApiKeySecurityScheme
  | HttpSecurityScheme;

export interface OAuth2SecurityScheme {
  type: "oauth2";
  flows: {
    authorizationCode?: {
      authorizationUrl: string;
      tokenUrl: string;
      scopes: Record<string, string>;
    };
    clientCredentials?: {
      tokenUrl: string;
      scopes: Record<string, string>;
    };
    implicit?: {
      authorizationUrl: string;
      scopes: Record<string, string>;
    };
  };
}

export interface ApiKeySecurityScheme {
  type: "apiKey";
  in: "header" | "query" | "cookie";
  name: string;
}

export interface HttpSecurityScheme {
  type: "http";
  scheme: "bearer" | "basic";
}

export type SecurityRequirementObject = Record<string, string[]>;
```

### `lib/spec-loader.ts`

```typescript
import type { OpenAPISpec } from "./openapi-types.ts";

/**
 * Load an OpenAPI spec from a URL or local file path.
 * Supports JSON and YAML (basic YAML: converts to JSON via a thin parser).
 */
export async function loadSpec(source: string): Promise<OpenAPISpec> {
  let text: string;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`Failed to fetch spec from ${source}: ${res.status}`);
    }
    text = await res.text();
  } else {
    text = await Deno.readTextFile(source);
  }

  // Detect YAML by checking for absence of leading {
  if (text.trimStart()[0] !== "{") {
    // Use Deno's built-in or a minimal YAML-to-JSON conversion.
    // A real implementation imports a YAML library (e.g., js-yaml from npm).
    throw new Error(
      "YAML specs are not yet supported. Convert to JSON first with:\n" +
        "  deno run npm:js-yaml <spec.yaml> > spec.json",
    );
  }

  return JSON.parse(text) as OpenAPISpec;
}
```

### `lib/schema-utils.ts`

OpenAPI specs use `$ref` pointers extensively. The extraction logic needs to
resolve these to concrete schema objects before reasoning about them.

```typescript
import type { OpenAPISpec, SchemaObject, ReferenceObject } from "./openapi-types.ts";

export function isRef(obj: unknown): obj is ReferenceObject {
  return typeof obj === "object" && obj !== null && "$ref" in obj;
}

/**
 * Resolve a $ref pointer within the spec to its target object.
 * Only supports local refs: #/components/schemas/Foo
 */
export function resolveRef(
  spec: OpenAPISpec,
  ref: string,
): SchemaObject {
  const parts = ref.replace(/^#\//, "").split("/");
  // deno-lint-ignore no-explicit-any
  let current: any = spec;
  for (const part of parts) {
    current = current?.[part];
  }
  if (!current) throw new Error(`Cannot resolve $ref: ${ref}`);
  return current as SchemaObject;
}

/**
 * Resolve a SchemaObject or ReferenceObject, returning a concrete SchemaObject.
 */
export function deref(
  spec: OpenAPISpec,
  obj: SchemaObject | ReferenceObject,
): SchemaObject {
  if (isRef(obj)) return resolveRef(spec, obj.$ref);
  return obj;
}

/**
 * Return the names of top-level fields in a schema (resolving $refs as needed).
 */
export function getSchemaFields(
  spec: OpenAPISpec,
  schema: SchemaObject | ReferenceObject,
): string[] {
  const resolved = deref(spec, schema);
  if (resolved.properties) return Object.keys(resolved.properties);
  if (resolved.allOf) {
    return resolved.allOf.flatMap((s) => getSchemaFields(spec, s));
  }
  return [];
}
```

---

### Tool 1: `openapi-to-provider.ts`

**Purpose**: Extract auth information from `securitySchemes` and emit a
`ProviderDescriptor`-shaped JSON (as defined in Workstream 2) that can be
copy-pasted into a `.descriptor.ts` file or consumed programmatically.

**Type signature**:

```typescript
import type { OpenAPISpec, OAuth2SecurityScheme } from "./lib/openapi-types.ts";

export interface ExtractedProvider {
  /** Lowercase slug, e.g. "notion", "linear" */
  name: string;
  authType: "oauth2" | "apiKey" | "http-bearer" | "unknown";

  // OAuth2 fields (only when authType === "oauth2")
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  availableScopes?: Record<string, string>; // scope key → description
  flow?: "authorizationCode" | "clientCredentials" | "implicit";

  // API key fields (only when authType === "apiKey")
  apiKeyIn?: "header" | "query";
  apiKeyName?: string;

  // Human-readable notes for the prompt / developer
  notes: string[];
}

export function extractProvider(
  spec: OpenAPISpec,
  providerName: string,
): ExtractedProvider;
```

**Extraction logic**:

1. Iterate `spec.components?.securitySchemes`. If there are multiple schemes,
   prefer `oauth2` over `apiKey` over `http`.
2. For `oauth2`, prefer the `authorizationCode` flow. Extract `authorizationUrl`,
   `tokenUrl`, and `scopes`.
3. For `apiKey`, record `in` and `name`. Note in `notes[]` that the pattern
   will need a simple header injection rather than a full auth manager.
4. If no security schemes are present, check the top-level `security` array
   and emit a warning in `notes[]`.

**Example input** (Airtable):

```json
{
  "components": {
    "securitySchemes": {
      "oauth2": {
        "type": "oauth2",
        "flows": {
          "authorizationCode": {
            "authorizationUrl": "https://airtable.com/oauth2/v1/authorize",
            "tokenUrl": "https://airtable.com/oauth2/v1/token",
            "scopes": {
              "data.records:read": "Read records",
              "schema.bases:read": "Read base schemas"
            }
          }
        }
      }
    }
  }
}
```

**Example output**:

```json
{
  "name": "airtable",
  "authType": "oauth2",
  "authorizationEndpoint": "https://airtable.com/oauth2/v1/authorize",
  "tokenEndpoint": "https://airtable.com/oauth2/v1/token",
  "flow": "authorizationCode",
  "availableScopes": {
    "data.records:read": "Read records",
    "schema.bases:read": "Read base schemas"
  },
  "notes": []
}
```

**CLI usage** (standalone):

```
deno run -A packages/patterns/tools/openapi-to-provider.ts \
  --spec ./airtable-spec.json \
  --provider airtable
```

Writes `airtable.provider.json` to the current directory and prints a summary.

---

### Tool 2: `openapi-extract.ts`

**Purpose**: Scan `paths` for endpoints that look like "list" (returns an
array or paginated wrapper) or "get" (returns a single resource) operations,
infer the pagination convention, and produce a structured JSON that the prompt
generator can work from without re-reading the full spec.

**Output type**:

```typescript
export interface ExtractedEndpoint {
  path: string;
  method: "get" | "post";
  operationId: string;
  summary: string;
  pathParams: string[];       // names of required path parameters
  queryParams: string[];      // names of optional query parameters
  paginationStyle:
    | "offset"                // uses ?offset=… query param
    | "cursor"                // uses ?cursor= or ?next_cursor= or similar
    | "page"                  // uses ?page= (1-based integer)
    | "none"                  // endpoint returns all results at once
    | "unknown";
  paginationParam?: string;   // the actual query param name
  nextTokenField?: string;    // field in response body that contains next page token
  responseSchema: string;     // JSON string of the resolved response schema (trimmed)
  itemSchema: string;         // JSON string of the per-item schema, if identifiable
  resourceName: string;       // human-readable name, e.g. "bases", "tasks"
  isList: boolean;
  isGet: boolean;
}

export interface ExtractedAPI {
  provider: ExtractedProvider;
  baseUrl: string;
  listEndpoints: ExtractedEndpoint[];
  getEndpoints: ExtractedEndpoint[];
  models: Record<string, string>; // schema name → JSON Schema string
  importerSuggestion: ImporterSuggestion;
}

/**
 * The tool's best guess at the two-level hierarchy to present in the importer UI.
 * For Airtable: level1 = "bases", level2 = "tables", records = "records".
 * For Notion: level1 = "databases", level2 = null (flat), records = "pages".
 * For GitHub: level1 = "repositories", level2 = "issues" or "pull_requests".
 */
export interface ImporterSuggestion {
  level1: { name: string; listEndpoint: string } | null;
  level2: { name: string; listEndpoint: string; pathParam: string } | null;
  records: { name: string; listEndpoint: string; pathParams: string[] } | null;
  defaultScopes: string[];
}
```

**Detection heuristics**:

**List endpoint detection** — An endpoint is classified as a list endpoint if:
- Its HTTP method is `GET`.
- Its successful response schema (`200` or `2XX`) has a `type: "array"` at the
  top level, OR its response schema has a property whose `type` is `"array"`
  (the paginated wrapper pattern, e.g. `{ bases: [...], offset: "..." }`).
- Its path does not end in `/{id}` or a path parameter that appears to be a
  single-resource lookup.

**Get endpoint detection** — An endpoint is classified as a get endpoint if:
- Its HTTP method is `GET`.
- Its path ends in `/{something}` (a path parameter).
- Its successful response schema returns a single object (not an array).

**Pagination detection** — Scan the response schema and query parameters for
known patterns:

| Pattern | Indicators |
|---------|-----------|
| `offset` | Query param named `offset`; response has `offset` field |
| `cursor` | Query param named `cursor`, `page_token`, `next_cursor`, `after`, `startCursor`; response has corresponding `next_cursor`, `next_page_token`, `has_more` + `cursor` |
| `page` | Query param named `page` (integer); response has `total_pages` or `total_count` |
| `none` | Response array, no pagination params or fields detected |

**Hierarchy inference** — After collecting all list endpoints, attempt to
identify a two-level hierarchy:

1. If one list endpoint has no path parameters (e.g. `GET /bases`) and another
   requires one path parameter that appears to be the `id` of the first
   resource (e.g. `GET /bases/{baseId}/tables`), classify them as level1 and
   level2.
2. If no clear two-level hierarchy exists, set `level2: null` and use a single
   list for `records`.

**Example output** (Airtable spec, abbreviated):

```json
{
  "provider": { "name": "airtable", "authType": "oauth2", ... },
  "baseUrl": "https://api.airtable.com/v0",
  "listEndpoints": [
    {
      "path": "/meta/bases",
      "method": "get",
      "operationId": "listBases",
      "summary": "List all bases",
      "pathParams": [],
      "queryParams": ["offset"],
      "paginationStyle": "offset",
      "paginationParam": "offset",
      "nextTokenField": "offset",
      "resourceName": "bases",
      "isList": true,
      "isGet": false,
      "responseSchema": "{ \"type\": \"object\", \"properties\": { \"bases\": { \"type\": \"array\", \"items\": { ... } }, \"offset\": { \"type\": \"string\" } } }",
      "itemSchema": "{ \"type\": \"object\", \"properties\": { \"id\": { ... }, \"name\": { ... }, \"permissionLevel\": { ... } } }"
    },
    {
      "path": "/meta/bases/{baseId}/tables",
      "method": "get",
      "operationId": "listTables",
      "resourceName": "tables",
      "pathParams": ["baseId"],
      "paginationStyle": "none",
      ...
    }
  ],
  "importerSuggestion": {
    "level1": { "name": "bases", "listEndpoint": "/meta/bases" },
    "level2": { "name": "tables", "listEndpoint": "/meta/bases/{baseId}/tables", "pathParam": "baseId" },
    "records": { "name": "records", "listEndpoint": "/{baseId}/{tableId}", "pathParams": ["baseId", "tableId"] },
    "defaultScopes": ["data.records:read", "schema.bases:read"]
  }
}
```

**CLI usage** (standalone):

```
deno run -A packages/patterns/tools/openapi-extract.ts \
  --spec ./airtable-spec.json \
  --provider airtable \
  --out airtable-extracted.json
```

---

### Tool 3: `importer-prompt.ts`

**Purpose**: Given an `ExtractedAPI` JSON, produce a complete prompt string
that can be submitted to Claude to generate the four importer files.

The prompt is structured in four sections:

1. **Context** — Explains the Common Tools pattern framework conventions,
   quoting key rules (handler patterns, `computed()` restrictions, `ifElse`
   usage, `Writable.of`, `wish`/`isReady` gate, `[UI]` placement, `[NAME]`,
   `Default<>`, `Writable<>` in handler bindings).

2. **Reference implementation** — The full text of `airtable-auth.tsx`,
   `airtable-auth-manager.tsx`, `airtable-client.ts`, and
   `airtable-importer.tsx`, presented verbatim as code blocks with file-path
   labels. Claude is instructed to treat these as the authoritative style
   examples.

3. **API specification** — The `ExtractedAPI` JSON, plus the `ExtractedProvider`
   JSON. Presented as a structured data block with a preamble explaining what
   each field means.

4. **Instructions** — Exactly what to generate:
   - `{provider}-auth.tsx` following the shape of `airtable-auth.tsx` with
     the provider's scope list, endpoints, and brand color substituted.
   - `{provider}-auth-manager.tsx` following `airtable-auth-manager.tsx`,
     with scope types and descriptions derived from `availableScopes`.
   - `{provider}-client.ts` following `airtable-client.ts`, implementing the
     extracted list/get endpoints as typed methods with the correct pagination
     loop for the detected style.
   - `{provider}-importer.tsx` following `airtable-importer.tsx`, implementing
     the hierarchy suggested by `importerSuggestion` (one level, two levels,
     or flat as appropriate).

**Type signature**:

```typescript
export interface PromptOptions {
  extracted: ExtractedAPI;
  /** Provider slug for file naming, e.g. "notion" */
  provider: string;
  /** Brand hex color for UI, e.g. "#000000". Optional; defaults to "#18BFFF" */
  brandColor?: string;
  /** Max tokens budget hint — used to decide how much reference code to include */
  maxContextTokens?: number;
}

export function buildImporterPrompt(options: PromptOptions): string;
```

**Prompt template** (abbreviated):

```
You are generating four TypeScript/TSX files that implement an importer pattern
for the {PROVIDER} API in the Common Tools pattern framework.

## Framework Rules (read carefully)

1. All handlers MUST be declared at module scope using handler<EventType, ContextType>().
   Never declare handlers inside a pattern() body.

2. Never access wishResult[UI] inside a computed(). The [UI] symbol crashes the
   reactive graph when read inside a computation. Access it outside and store it
   in a plain variable.

3. Use ifElse(condition, trueBranch, falseBranch) for conditional rendering.
   Never use a ternary inside JSX.

4. Writable state: const x = Writable.of(initialValue). Reading: x.get()
   inside computed. Writing: x.set(value) or x.update({...}) inside handlers.

5. Module-scope handlers receive a context object with Writable cells. Bind
   them inside the pattern body: const bound = myHandler({ cellA, cellB }).

6. Computed values that reference reactive inputs must use computed(() => ...)
   and cast types explicitly: (someCell.get() as MyType).

7. The pattern's return object must include [UI]: <jsx/>, [NAME]: computed(...)
   plus all declared Output fields.

8. Default<T, DefaultValue> marks optional inputs. Writable<T> in handler
   context types marks cells that the handler can write to.

## Reference Implementation

### packages/patterns/airtable/core/airtable-auth.tsx
{FULL FILE CONTENT}

### packages/patterns/airtable/core/util/airtable-auth-manager.tsx
{FULL FILE CONTENT}

### packages/patterns/airtable/core/util/airtable-client.ts
{FULL FILE CONTENT}

### packages/patterns/airtable/airtable-importer.tsx
{FULL FILE CONTENT}

## API Specification for {PROVIDER}

{EXTRACTED_API_JSON}

## What to Generate

Generate four files exactly. Output each file as a code block prefixed with
its relative path from the repo root:

### packages/patterns/{provider}/core/{provider}-auth.tsx
### packages/patterns/{provider}/core/util/{provider}-auth-manager.tsx
### packages/patterns/{provider}/core/util/{provider}-client.ts
### packages/patterns/{provider}/{provider}-importer.tsx

Rules for each file:

**{provider}-auth.tsx**: Model exactly on airtable-auth.tsx.
- Replace all Airtable-specific scope keys/descriptions with the provider's scopes.
- Replace OAuth endpoints with the provider's endpoints.
- Replace "airtable" with "{provider}" in all identifiers, tags (#airtableAuth →
  #{provider}Auth), and UI strings.
- Replace the brand color (#18BFFF) with {BRAND_COLOR}.
- Keep the refreshToken Stream, bgUpdater Stream, handleRefresh handler,
  bgRefreshHandler handler, and reactive clock unchanged.

**{provider}-auth-manager.tsx**: Model on airtable-auth-manager.tsx.
- Replace ScopeKey union type with the provider's actual scope strings.
- Replace SCOPE_DESCRIPTIONS with the provider's scope descriptions.
- Replace wish() query tag.
- Replace navigateTo() target with {Provider}Auth.

**{provider}-client.ts**: Model on airtable-client.ts.
- For each list endpoint in listEndpoints, generate a typed method.
  - Use offset pagination if paginationStyle === "offset".
  - Use cursor pagination if paginationStyle === "cursor": loop while nextTokenField
    is present in the response.
  - Use page pagination if paginationStyle === "page": loop while page < total_pages.
  - Use a single request if paginationStyle === "none".
- Add the token refresh endpoint path based on the provider name:
  /api/integrations/{provider}-oauth/refresh.
- Define TypeScript interfaces for the item schemas extracted from listEndpoints.

**{provider}-importer.tsx**: Model on airtable-importer.tsx.
- Use the importerSuggestion to drive the UI hierarchy:
  - If level1 and level2 are both non-null: reproduce the two-level
    select-then-fetch pattern (like bases → tables → records).
  - If only level1 is non-null: reproduce a one-level select-then-fetch pattern.
  - If level1 is null: show a single "Fetch All" button.
- Use {Provider}AuthManager with the suggested defaultScopes.
- Replace all Airtable-specific type names and UI strings.

Do not add explanatory prose outside code blocks. Do not add TODO comments.
Write complete, working files.
```

---

### Tool 4: `generate-importer.ts` (Orchestrator CLI)

**Purpose**: Tie all three stages together into a single command that a
developer runs once per new provider.

**Interface**:

```
deno run -A packages/patterns/tools/generate-importer.ts \
  --spec <url-or-file-path>   \
  --provider <name>           \
  [--brand-color <hex>]       \
  [--out-dir <path>]          \
  [--skip-check]              \
  [--dry-run]
```

| Flag | Description | Default |
|------|-------------|---------|
| `--spec` | URL or local path to the OpenAPI JSON spec | required |
| `--provider` | Lowercase provider slug (used in file names and identifiers) | required |
| `--brand-color` | Hex color for the auth UI buttons | `#18BFFF` |
| `--out-dir` | Directory to write generated files | `packages/patterns/{provider}` |
| `--skip-check` | Skip running `ct check` after generation | false |
| `--dry-run` | Print files to stdout instead of writing them | false |

**Steps**:

```typescript
async function main(args: ParsedArgs) {
  // 1. Load spec
  console.log("[1/5] Loading spec from", args.spec);
  const spec = await loadSpec(args.spec);

  // 2. Extract provider descriptor
  console.log("[2/5] Extracting auth schemes...");
  const provider = extractProvider(spec, args.provider);
  console.log(`      auth type: ${provider.authType}`);
  if (provider.notes.length) {
    for (const note of provider.notes) console.warn("      NOTE:", note);
  }

  // 3. Extract endpoints and models
  console.log("[3/5] Extracting endpoints and models...");
  const extracted = extractAPI(spec, provider);
  console.log(`      list endpoints: ${extracted.listEndpoints.length}`);
  console.log(`      importer suggestion:`, extracted.importerSuggestion);

  // 4. Build prompt and call Claude
  console.log("[4/5] Generating files via Claude...");
  const prompt = buildImporterPrompt({
    extracted,
    provider: args.provider,
    brandColor: args.brandColor,
  });

  const files = await callClaude(prompt);
  // files: Array<{ path: string; content: string }>
  // Parsing: split Claude's output on code block markers prefixed with
  // "### packages/patterns/..."

  if (args.dryRun) {
    for (const file of files) {
      console.log("\n---", file.path, "---");
      console.log(file.content);
    }
    return;
  }

  // 5. Write files
  for (const file of files) {
    const absPath = resolve(Deno.cwd(), file.path);
    await Deno.mkdir(dirname(absPath), { recursive: true });
    await Deno.writeTextFile(absPath, file.content);
    console.log("      wrote", file.path);
  }

  // 6. Run ct check
  if (!args.skipCheck) {
    console.log("[5/5] Running ct check...");
    for (const file of files.filter((f) => f.path.endsWith(".tsx"))) {
      const result = await new Deno.Command("deno", {
        args: ["task", "ct", "check", file.path],
        stdout: "inherit",
        stderr: "inherit",
      }).output();
      if (!result.success) {
        console.error(`ct check failed for ${file.path}`);
        Deno.exit(1);
      }
    }
  }

  console.log("\nDone. Files written to", args.outDir);
  console.log("Next steps:");
  console.log("  1. Set ANTHROPIC_API_KEY if not already set.");
  console.log(`  2. Add ${args.provider.toUpperCase()}_CLIENT_ID and`);
  console.log(`     ${args.provider.toUpperCase()}_CLIENT_SECRET to toolshed env.`);
  console.log(`  3. Create a ${args.provider}.descriptor.ts (see Workstream 2).`);
  console.log(`  4. Deploy: ct piece new packages/patterns/${args.provider}/...`);
}
```

**`callClaude` implementation**:

```typescript
import Anthropic from "npm:@anthropic-ai/sdk";

async function callClaude(
  prompt: string,
): Promise<Array<{ path: string; content: string }>> {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 16000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return parseGeneratedFiles(raw);
}

/**
 * Parse Claude's output, which is expected to contain code blocks prefixed
 * with "### packages/patterns/..." lines.
 *
 * Example format:
 *   ### packages/patterns/notion/core/notion-auth.tsx
 *   ```tsx
 *   // ...file content...
 *   ```
 */
function parseGeneratedFiles(
  raw: string,
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const sections = raw.split(/^### /m).slice(1);
  for (const section of sections) {
    const firstNewline = section.indexOf("\n");
    const path = section.slice(0, firstNewline).trim();
    const codeMatch = section.match(/```(?:tsx?|typescript)?\n([\s\S]*?)```/);
    if (path && codeMatch) {
      files.push({ path, content: codeMatch[1] });
    }
  }
  return files;
}
```

**Error handling strategy**:

- If `loadSpec` fails (network error, invalid JSON), exit immediately with a
  clear message including the source URL and HTTP status.
- If `extractProvider` finds no security schemes, print a prominent warning
  but continue — the prompt notes the ambiguity and instructs Claude to ask
  about auth in an inline comment.
- If `callClaude` times out or returns malformed output (fewer than 4 files
  parsed), retry once with the same prompt. On second failure, write the raw
  Claude output to `{provider}-raw-output.txt` and exit with instructions for
  manual parsing.
- If `ct check` fails, leave the written files in place (do not delete) and
  print the check output so the developer can fix the specific issue. Exit
  with a non-zero code so CI catches it.

---

## Example: Generating a Notion Importer

```bash
deno run -A packages/patterns/tools/generate-importer.ts \
  --spec https://raw.githubusercontent.com/notion-site/openapi/main/notion-openapi.json \
  --provider notion \
  --brand-color "#000000"
```

**What happens internally**:

**Step 1 — Load spec**: The Notion OpenAPI spec is fetched. It defines
`securitySchemes: { notion_oauth: { type: "oauth2", flows: { authorizationCode: { ... } } } }`.

**Step 2 — Extract provider**:

```json
{
  "name": "notion",
  "authType": "oauth2",
  "authorizationEndpoint": "https://api.notion.com/v1/oauth/authorize",
  "tokenEndpoint": "https://api.notion.com/v1/oauth/token",
  "flow": "authorizationCode",
  "availableScopes": {},
  "notes": ["Notion OAuth does not enumerate individual scopes in the spec; uses workspace-level access."]
}
```

**Step 3 — Extract endpoints**: Notion's spec includes:
- `GET /databases` — lists databases accessible to the integration; uses
  cursor pagination (`start_cursor` / `next_cursor` / `has_more`).
- `POST /databases/{database_id}/query` — fetches pages (records) from a
  database; cursor paginated.
- `GET /pages/{page_id}` — single page get endpoint.
- `GET /users` — list users (less relevant for an importer).

The extraction identifies:
- `level1`: databases → `GET /databases`
- `level2`: null (Notion is flat — databases are the top-level container)
- `records`: pages → `POST /databases/{database_id}/query`

`importerSuggestion.level2 = null` triggers the single-level importer template,
where the user selects a database and fetches its pages directly.

**Step 4 — Generate files**: Claude receives the prompt and produces:

- `packages/patterns/notion/core/notion-auth.tsx` — note: since Notion does not
  enumerate scopes, the `SCOPE_MAP` is replaced with a single entry
  `"read_content": "Read workspace content"` based on the prompt note.
- `packages/patterns/notion/core/util/notion-auth-manager.tsx`
- `packages/patterns/notion/core/util/notion-client.ts` — `listDatabases()` with
  cursor pagination loop; `queryDatabase(databaseId)` using `POST` with cursor
  pagination.
- `packages/patterns/notion/notion-importer.tsx` — one-level select (choose
  database) then fetch pages.

**Step 5 — Validate**: `ct check` runs on the two `.tsx` files.

**Remaining developer work**:

1. Add `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` to toolshed env.
2. Create `packages/toolshed/routes/integrations/notion-oauth/notion.descriptor.ts`
   (per Workstream 2).
3. Wire the Notion OAuth callback — Notion requires the client credentials to
   be sent as HTTP Basic auth during token exchange, so set
   `tokenAuthMethod: "basic"` in the descriptor.
4. Review the generated `notion-client.ts` to confirm the `POST /databases/{id}/query`
   body shape matches Notion's actual API.
5. Deploy the auth piece and test the OAuth flow.

---

## Files to Create

```
packages/patterns/tools/
  generate-importer.ts          # Orchestrator CLI (Stage 3)
  importer-prompt.ts            # Prompt builder (Stage 2)
  openapi-extract.ts            # Endpoint extractor (Stage 1b)
  openapi-to-provider.ts        # Auth scheme extractor (Stage 1a)
  lib/
    openapi-types.ts            # OpenAPI 3.x type definitions
    schema-utils.ts             # $ref resolution helpers
    spec-loader.ts              # URL / file loader
  deno.json                     # package config with "test" task stub
```

No modifications to existing packages are required. The tools directory is
entirely self-contained.

**`packages/patterns/tools/deno.json`**:

```json
{
  "name": "@commontools/importer-tools",
  "version": "0.1.0",
  "tasks": {
    "test": "echo 'No tests defined.'"
  },
  "imports": {
    "npm:@anthropic-ai/sdk": "npm:@anthropic-ai/sdk@^0.36.0"
  }
}
```

Per the repository guidelines for adding new packages, the `tasks.test` entry
is required even if no tests exist, to prevent the root test runner from
recursively spawning itself.

---

## Dependencies

### Anthropic SDK

The generator calls the Claude API directly via the official SDK:

```typescript
import Anthropic from "npm:@anthropic-ai/sdk";
```

The SDK is imported via npm specifier. No `deno.lock` update is needed for
the tools directory since it is a separate workspace package.

The `ANTHROPIC_API_KEY` environment variable must be set when running
`generate-importer.ts`. The tool exits with an informative error message if
the key is absent.

### OpenAPI Spec Parser

The tools do not import a full OpenAPI validation library. The `OpenAPISpec`
types in `lib/openapi-types.ts` are minimal and hand-written to cover exactly
the fields the extraction logic reads. This avoids a large transitive
dependency and keeps the tools fast to start.

If YAML support is needed, `js-yaml` can be added via `npm:js-yaml` and used
only in `spec-loader.ts`. The current design defers this until there is a
concrete YAML spec to test against.

### JSON Schema `$ref` Resolution

The `lib/schema-utils.ts` module resolves local `$ref` pointers
(`#/components/schemas/Foo`). It does not support remote `$ref` pointers
(`https://...`) or `$ref` chains across files. If a spec uses remote
references, the developer should first bundle it with a tool such as
`deno run npm:@apidevtools/json-schema-ref-parser` before running the
generator.

---

## Verification

### Primary verification: feed it the Airtable spec

The most direct way to validate the toolchain end-to-end is to run it against
the Airtable OpenAPI spec and diff the output against the hand-written
importer:

```bash
# 1. Download Airtable's published spec (or use a local snapshot)
curl -o /tmp/airtable-spec.json \
  https://airtable.com/api/openapi.json

# 2. Run the generator in dry-run mode (no files written)
deno run -A packages/patterns/tools/generate-importer.ts \
  --spec /tmp/airtable-spec.json \
  --provider airtable-generated \
  --dry-run

# 3. Compare the generated client against the hand-written one
diff packages/patterns/airtable/core/util/airtable-client.ts \
     /tmp/airtable-generated-client.ts
```

**What to look for in the diff**:

- The `listBases()` method should use an offset pagination loop identical in
  structure to the hand-written version.
- The `listTables()` method should make a single request (Airtable tables
  endpoint is not paginated).
- The `listRecords()` method should use an offset pagination loop with a
  `maxRecords` cap.
- Type interfaces should match (`AirtableBase`, `AirtableTable`,
  `AirtableRecord`).
- The auth URL in `refreshToken()` should point to
  `/api/integrations/airtable-oauth/refresh`.

Differences are expected in:
- Minor identifier naming (e.g. `AIRTABLE_API_BASE` vs `AIRTABLE_BASE_URL`).
- Order of methods.
- Debug logging verbosity.

These differences are acceptable and expected. The structural correctness is
what matters.

### Secondary verification: run `ct check` on generated files

```bash
deno run -A packages/patterns/tools/generate-importer.ts \
  --spec /tmp/airtable-spec.json \
  --provider airtable-generated \
  --out-dir /tmp/airtable-generated
# The --skip-check flag is NOT set, so ct check runs automatically.
```

A passing `ct check` means the generated TSX is well-formed according to the
pattern framework's type checker.

### Tertiary verification: deploy and test

After verifying the Airtable case, run the generator against a second,
structurally different API (e.g. Notion, which uses cursor pagination and a
POST-based query endpoint). Deploy the generated auth piece and importer to a
local toolshed instance and walk through the full OAuth flow manually:

1. Open the generated auth piece. Confirm the OAuth redirect reaches the
   provider's authorization page.
2. Authorize. Confirm the callback writes an access token to the auth cell.
3. Open the generated importer. Confirm the auth manager shows "Connected"
   and the isReady gate unlocks.
4. Fetch the top-level resource list. Confirm records load and display
   correctly in the table.

If all three verification steps pass for two structurally different providers,
the toolchain is ready for use on new providers.

---

## Stage 2: Template System (Future)

Once several providers have been generated and the diffs between hand-written
and generated code are understood, patterns will emerge that do not require an
LLM call at all. For example:

- **Offset-paginated list client method**: the structure is identical across
  every provider. It can be expressed as a string template with `{ENDPOINT}`,
  `{ITEM_TYPE}`, and `{ARRAY_FIELD}` substitutions.
- **Auth manager scope union type**: purely mechanical substitution from the
  spec's scope list.
- **Single-level importer UI**: if `importerSuggestion.level2 === null`, the
  entire TSX can be generated by substituting provider name and resource names
  into a fixed template.

When these templates are extracted, `generate-importer.ts` can route to the
template path for the mechanical parts and use the LLM only for the
provider-specific logic (unusual auth flows, nested response shapes,
non-standard pagination). This reduces API cost and latency for future
providers.

The template system is not part of this workstream. It is deferred until at
least three providers have been generated and the common structure is clear
from empirical evidence.
