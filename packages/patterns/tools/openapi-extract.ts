/**
 * OpenAPI 3.x spec extractor — pulls structured endpoint and model information
 * needed to generate importer patterns.
 *
 * No external dependencies. Expects already-parsed JSON as input.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ExtractedParameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  type: string;
  description?: string;
}

export interface ExtractedEndpoint {
  operationId?: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  parameters: ExtractedParameter[];
  responseSchema?: Record<string, unknown>;
  isPaginated: boolean;
  paginationStyle?: "offset" | "cursor" | "page";
}

export interface ExtractedModel {
  name: string;
  properties: Record<string, { type: string; description?: string }>;
}

export interface ExtractedAPI {
  title: string;
  baseUrl: string;
  endpoints: ExtractedEndpoint[];
  models: ExtractedModel[];
  listEndpoints: ExtractedEndpoint[];
  getEndpoints: ExtractedEndpoint[];
  createEndpoints: ExtractedEndpoint[];
  updateEndpoints: ExtractedEndpoint[];
  deleteEndpoints: ExtractedEndpoint[];
}

// ============================================================================
// REF RESOLUTION
// ============================================================================

type Spec = Record<string, unknown>;

/**
 * Resolve a `$ref` string like `#/components/schemas/Pet` against the spec.
 * Handles single-level resolution (if the resolved value itself has a `$ref`,
 * we resolve one more time, but no deeper to avoid cycles).
 */
function resolveRef(spec: Spec, ref: string): Record<string, unknown> {
  if (!ref.startsWith("#/")) return {};
  const parts = ref.slice(2).split("/");
  // deno-lint-ignore no-explicit-any
  let current: any = spec;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return {};
    current = current[part];
  }
  if (current && typeof current === "object" && "$ref" in current) {
    return resolveRef(spec, current["$ref"] as string);
  }
  return (current as Record<string, unknown>) ?? {};
}

/**
 * If `obj` contains a `$ref` key, resolve it; otherwise return `obj` as-is.
 */
function maybeResolve(
  spec: Spec,
  obj: Record<string, unknown>,
): Record<string, unknown> {
  if ("$ref" in obj && typeof obj["$ref"] === "string") {
    return resolveRef(spec, obj["$ref"]);
  }
  return obj;
}

// ============================================================================
// SCHEMA HELPERS
// ============================================================================

/**
 * Turn an OpenAPI schema node into a short type string (e.g. "string",
 * "integer", "array<string>", "object").
 */
function schemaToTypeString(
  spec: Spec,
  schema: Record<string, unknown>,
): string {
  const resolved = maybeResolve(spec, schema);
  const type = resolved["type"] as string | undefined;

  if (type === "array") {
    const items = resolved["items"] as Record<string, unknown> | undefined;
    if (items) {
      const inner = schemaToTypeString(spec, items);
      return `array<${inner}>`;
    }
    return "array";
  }

  if (type) return type;

  // allOf / oneOf / anyOf — take the first entry as a rough approximation
  for (const combo of ["allOf", "oneOf", "anyOf"]) {
    const list = resolved[combo] as Record<string, unknown>[] | undefined;
    if (list && list.length > 0) {
      return schemaToTypeString(spec, list[0]);
    }
  }

  return "object";
}

/**
 * Check whether a response schema looks like it returns an array of items.
 * This covers two common shapes:
 *   1. The schema itself is type: array
 *   2. The schema is an object with a property whose value is type: array
 *      (e.g. `{ records: [...] }`, `{ data: [...] }`, `{ items: [...] }`)
 */
function looksLikeArrayResponse(
  spec: Spec,
  schema: Record<string, unknown>,
): boolean {
  const resolved = maybeResolve(spec, schema);

  if (resolved["type"] === "array") return true;

  const props = resolved["properties"] as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!props) return false;

  for (const value of Object.values(props)) {
    const propResolved = maybeResolve(spec, value);
    if (propResolved["type"] === "array") return true;
  }

  return false;
}

// ============================================================================
// PAGINATION DETECTION
// ============================================================================

const PAGINATION_INDICATORS: Record<
  "offset" | "cursor" | "page",
  string[]
> = {
  offset: ["offset", "next_offset", "nextOffset"],
  cursor: [
    "cursor",
    "next_cursor",
    "nextCursor",
    "pageToken",
    "next_page_token",
    "nextPageToken",
  ],
  page: ["page", "next_page", "nextPage", "pageNumber"],
};

interface PaginationResult {
  isPaginated: boolean;
  style?: "offset" | "cursor" | "page";
}

/**
 * Detect pagination by inspecting both query parameters and the 200 response
 * schema properties.
 */
function detectPagination(
  spec: Spec,
  parameters: ExtractedParameter[],
  responseSchema: Record<string, unknown> | undefined,
): PaginationResult {
  const candidates = new Set<string>();

  // Collect names from query params
  for (const p of parameters) {
    if (p.in === "query") candidates.add(p.name);
  }

  // Collect names from response schema top-level properties
  if (responseSchema) {
    const resolved = maybeResolve(spec, responseSchema);
    const props = resolved["properties"] as
      | Record<string, unknown>
      | undefined;
    if (props) {
      for (const key of Object.keys(props)) {
        candidates.add(key);
      }
    }
  }

  // Match against known indicators, in priority order
  for (
    const style of ["offset", "cursor", "page"] as const
  ) {
    for (const indicator of PAGINATION_INDICATORS[style]) {
      if (candidates.has(indicator)) {
        return { isPaginated: true, style };
      }
    }
  }

  return { isPaginated: false };
}

// ============================================================================
// PARAMETER EXTRACTION
// ============================================================================

function extractParameters(
  spec: Spec,
  rawParams: Record<string, unknown>[] | undefined,
): ExtractedParameter[] {
  if (!rawParams) return [];

  return rawParams
    .map((raw) => {
      const param = maybeResolve(spec, raw);
      const location = param["in"] as string;
      if (!["path", "query", "header"].includes(location)) return null;

      const schema = param["schema"]
        ? maybeResolve(spec, param["schema"] as Record<string, unknown>)
        : {};

      return {
        name: param["name"] as string,
        in: location as "path" | "query" | "header",
        required: (param["required"] as boolean) ?? false,
        type: schemaToTypeString(spec, schema),
        description: (param["description"] as string) ?? undefined,
      } as ExtractedParameter;
    })
    .filter((p): p is ExtractedParameter => p !== null);
}

// ============================================================================
// RESPONSE SCHEMA EXTRACTION
// ============================================================================

/**
 * Pull the JSON schema from the first 2xx response that has
 * `application/json` content.
 */
function extractResponseSchema(
  spec: Spec,
  responses: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!responses) return undefined;

  // Try 200, 201, then any 2xx
  const statusCodes = Object.keys(responses).sort();
  const successCodes = statusCodes.filter((c) => c.startsWith("2"));
  const preferred = ["200", "201", ...successCodes];

  for (const code of preferred) {
    const raw = responses[code] as Record<string, unknown> | undefined;
    if (!raw) continue;
    const response = maybeResolve(spec, raw);

    const content = response["content"] as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!content) continue;

    const json = content["application/json"] ?? content["*/*"];
    if (!json) continue;

    const schema = json["schema"] as Record<string, unknown> | undefined;
    if (!schema) continue;

    return maybeResolve(spec, schema);
  }

  return undefined;
}

// ============================================================================
// MODEL EXTRACTION
// ============================================================================

function extractModels(spec: Spec): ExtractedModel[] {
  const components = spec["components"] as Record<string, unknown> | undefined;
  if (!components) return [];

  const schemas = components["schemas"] as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!schemas) return [];

  const models: ExtractedModel[] = [];

  for (const [name, rawSchema] of Object.entries(schemas)) {
    const schema = maybeResolve(spec, rawSchema);
    const props = schema["properties"] as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!props) continue;

    const properties: Record<string, { type: string; description?: string }> =
      {};
    for (const [propName, propSchema] of Object.entries(props)) {
      const resolved = maybeResolve(spec, propSchema);
      properties[propName] = {
        type: schemaToTypeString(spec, resolved),
        ...(resolved["description"]
          ? { description: resolved["description"] as string }
          : {}),
      };
    }

    models.push({ name, properties });
  }

  return models;
}

// ============================================================================
// ENDPOINT EXTRACTION
// ============================================================================

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
];

function extractEndpoints(spec: Spec): ExtractedEndpoint[] {
  const paths = spec["paths"] as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!paths) return [];

  const endpoints: ExtractedEndpoint[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    const resolvedPathItem = maybeResolve(spec, pathItem);

    // Path-level parameters apply to all operations under this path
    const pathParams = resolvedPathItem["parameters"] as
      | Record<string, unknown>[]
      | undefined;

    for (const method of HTTP_METHODS) {
      const operation = resolvedPathItem[method] as
        | Record<string, unknown>
        | undefined;
      if (!operation) continue;

      // Merge path-level and operation-level parameters (operation wins)
      const opParams = operation["parameters"] as
        | Record<string, unknown>[]
        | undefined;
      const mergedRawParams = mergeParameters(pathParams, opParams);
      const parameters = extractParameters(spec, mergedRawParams);

      const responseSchema = extractResponseSchema(
        spec,
        operation["responses"] as Record<string, unknown> | undefined,
      );

      const pagination = detectPagination(spec, parameters, responseSchema);

      endpoints.push({
        operationId: operation["operationId"] as string | undefined,
        method: method.toUpperCase(),
        path,
        summary: operation["summary"] as string | undefined,
        description: operation["description"] as string | undefined,
        parameters,
        responseSchema,
        isPaginated: pagination.isPaginated,
        paginationStyle: pagination.style,
      });
    }
  }

  return endpoints;
}

/**
 * Merge path-level and operation-level parameters. Operation-level parameters
 * override path-level ones with the same name+in combination.
 */
function mergeParameters(
  pathParams: Record<string, unknown>[] | undefined,
  opParams: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] | undefined {
  if (!pathParams && !opParams) return undefined;
  if (!pathParams) return opParams;
  if (!opParams) return pathParams;

  const byKey = new Map<string, Record<string, unknown>>();

  for (const p of pathParams) {
    const key = `${p["name"]}:${p["in"]}`;
    byKey.set(key, p);
  }
  for (const p of opParams) {
    const key = `${p["name"]}:${p["in"]}`;
    byKey.set(key, p);
  }

  return Array.from(byKey.values());
}

// ============================================================================
// ENDPOINT CATEGORIZATION
// ============================================================================

/** Has at least one path parameter (e.g. /pets/{petId}) */
function hasPathParams(endpoint: ExtractedEndpoint): boolean {
  return endpoint.parameters.some((p) => p.in === "path");
}

function categorizeEndpoints(
  spec: Spec,
  endpoints: ExtractedEndpoint[],
): Pick<
  ExtractedAPI,
  | "listEndpoints"
  | "getEndpoints"
  | "createEndpoints"
  | "updateEndpoints"
  | "deleteEndpoints"
> {
  const listEndpoints: ExtractedEndpoint[] = [];
  const getEndpoints: ExtractedEndpoint[] = [];
  const createEndpoints: ExtractedEndpoint[] = [];
  const updateEndpoints: ExtractedEndpoint[] = [];
  const deleteEndpoints: ExtractedEndpoint[] = [];

  for (const ep of endpoints) {
    switch (ep.method) {
      case "GET": {
        if (
          ep.responseSchema && looksLikeArrayResponse(spec, ep.responseSchema)
        ) {
          listEndpoints.push(ep);
        } else if (hasPathParams(ep)) {
          getEndpoints.push(ep);
        } else {
          // GET without path params and non-array response — could be either,
          // default to list
          listEndpoints.push(ep);
        }
        break;
      }
      case "POST":
        createEndpoints.push(ep);
        break;
      case "PUT":
      case "PATCH":
        updateEndpoints.push(ep);
        break;
      case "DELETE":
        deleteEndpoints.push(ep);
        break;
    }
  }

  return {
    listEndpoints,
    getEndpoints,
    createEndpoints,
    updateEndpoints,
    deleteEndpoints,
  };
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

export function extractAPI(spec: Record<string, unknown>): ExtractedAPI {
  // Basic info
  const info = (spec["info"] as Record<string, unknown>) ?? {};
  const title = (info["title"] as string) ?? "Untitled API";

  const servers = spec["servers"] as Record<string, unknown>[] | undefined;
  const baseUrl = (servers?.[0]?.["url"] as string) ?? "";

  // Extract data
  const endpoints = extractEndpoints(spec);
  const models = extractModels(spec);
  const categories = categorizeEndpoints(spec, endpoints);

  return {
    title,
    baseUrl,
    endpoints,
    models,
    ...categories,
  };
}
