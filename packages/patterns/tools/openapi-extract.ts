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

/** Detailed pagination info for the prompt module. */
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
  /** Detected pagination pattern (derived from paginated endpoints) */
  pagination?: PaginationInfo;
  /** Rate limit info if detected */
  rateLimit?: {
    requestsPerSecond?: number;
    headerName?: string;
  };
}

// ============================================================================
// REF RESOLUTION
// ============================================================================

type Spec = Record<string, unknown>;

const MAX_REF_DEPTH = 10;

/**
 * Resolve a `$ref` string like `#/components/schemas/Pet` against the spec.
 * Tracks visited refs to prevent infinite recursion from circular `$ref`
 * chains, and enforces a max depth as a safety net.
 */
function resolveRef(
  spec: Spec,
  ref: string,
  cache: Map<string, Record<string, unknown>>,
  visited?: Set<string>,
): Record<string, unknown> {
  if (!ref.startsWith("#/")) return {};

  // Return cached result if available
  const cached = cache.get(ref);
  if (cached) return cached;

  const seen = visited ?? new Set<string>();
  if (seen.has(ref) || seen.size >= MAX_REF_DEPTH) return {};
  seen.add(ref);

  const parts = ref.slice(2).split("/");
  // deno-lint-ignore no-explicit-any
  let current: any = spec;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return {};
    current = current[part];
  }
  let result: Record<string, unknown>;
  if (current && typeof current === "object" && "$ref" in current) {
    result = resolveRef(spec, current["$ref"] as string, cache, seen);
  } else {
    result = (current as Record<string, unknown>) ?? {};
  }

  cache.set(ref, result);
  return result;
}

/**
 * If `obj` contains a `$ref` key, resolve it; otherwise return `obj` as-is.
 */
function maybeResolve(
  spec: Spec,
  obj: Record<string, unknown>,
  cache: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  if ("$ref" in obj && typeof obj["$ref"] === "string") {
    return resolveRef(spec, obj["$ref"], cache);
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
  cache: Map<string, Record<string, unknown>>,
): string {
  const resolved = maybeResolve(spec, schema, cache);
  const type = resolved["type"] as string | undefined;

  if (type === "array") {
    const items = resolved["items"] as Record<string, unknown> | undefined;
    if (items) {
      const inner = schemaToTypeString(spec, items, cache);
      return `array<${inner}>`;
    }
    return "array";
  }

  if (type) return type;

  // allOf / oneOf / anyOf — take the first entry as a rough approximation
  for (const combo of ["allOf", "oneOf", "anyOf"]) {
    const list = resolved[combo] as Record<string, unknown>[] | undefined;
    if (list && list.length > 0) {
      return schemaToTypeString(spec, list[0], cache);
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
  cache: Map<string, Record<string, unknown>>,
): boolean {
  const resolved = maybeResolve(spec, schema, cache);

  if (resolved["type"] === "array") return true;

  const props = resolved["properties"] as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!props) return false;

  for (const value of Object.values(props)) {
    const propResolved = maybeResolve(spec, value, cache);
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

/** Page-size parameter names commonly seen across APIs. */
const PAGE_SIZE_PARAMS = [
  "limit",
  "pageSize",
  "page_size",
  "per_page",
  "perPage",
  "maxResults",
  "max_results",
  "count",
];

interface PaginationResult {
  isPaginated: boolean;
  style?: "offset" | "cursor" | "page";
  /** The query parameter name that drives pagination */
  requestParam?: string;
  /** The response property that carries the next-page token/offset */
  responseCursorPath?: string;
  /** The response property that carries the data array */
  responseDataPath?: string;
  /** The query parameter that controls page size */
  pageSizeParam?: string;
}

/**
 * Detect pagination by inspecting both query parameters and the 200 response
 * schema properties.
 */
function detectPagination(
  spec: Spec,
  parameters: ExtractedParameter[],
  responseSchema: Record<string, unknown> | undefined,
  cache: Map<string, Record<string, unknown>>,
): PaginationResult {
  const queryParamNames = new Set<string>();
  const responsePropertyNames = new Set<string>();

  // Collect names from query params
  for (const p of parameters) {
    if (p.in === "query") queryParamNames.add(p.name);
  }

  // Collect names from response schema top-level properties
  if (responseSchema) {
    const resolved = maybeResolve(spec, responseSchema, cache);
    const props = resolved["properties"] as
      | Record<string, unknown>
      | undefined;
    if (props) {
      for (const key of Object.keys(props)) {
        responsePropertyNames.add(key);
      }
    }
  }

  const allCandidates = new Set([...queryParamNames, ...responsePropertyNames]);

  // Match against known indicators, in priority order
  for (const style of ["offset", "cursor", "page"] as const) {
    for (const indicator of PAGINATION_INDICATORS[style]) {
      if (allCandidates.has(indicator)) {
        const requestParam = queryParamNames.has(indicator)
          ? indicator
          : undefined;

        const responseCursorPath = responsePropertyNames.has(indicator)
          ? indicator
          : undefined;

        // Find the data array in the response
        let responseDataPath: string | undefined;
        if (responseSchema) {
          const resolved = maybeResolve(spec, responseSchema, cache);
          const props = resolved["properties"] as
            | Record<string, Record<string, unknown>>
            | undefined;
          if (props) {
            for (const [key, val] of Object.entries(props)) {
              const propResolved = maybeResolve(spec, val, cache);
              if (propResolved["type"] === "array") {
                responseDataPath = key;
                break;
              }
            }
          }
        }

        // Detect page-size parameter
        let pageSizeParam: string | undefined;
        for (const psp of PAGE_SIZE_PARAMS) {
          if (queryParamNames.has(psp)) {
            pageSizeParam = psp;
            break;
          }
        }

        return {
          isPaginated: true,
          style,
          requestParam,
          responseCursorPath,
          responseDataPath,
          pageSizeParam,
        };
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
  cache: Map<string, Record<string, unknown>>,
): ExtractedParameter[] {
  if (!rawParams) return [];

  return rawParams
    .map((raw) => {
      const param = maybeResolve(spec, raw, cache);
      const location = param["in"] as string;
      if (!["path", "query", "header"].includes(location)) return null;

      const schema = param["schema"]
        ? maybeResolve(
          spec,
          param["schema"] as Record<string, unknown>,
          cache,
        )
        : {};

      const desc = param["description"] as string | undefined;

      return {
        name: param["name"] as string,
        in: location as "path" | "query" | "header",
        required: (param["required"] as boolean) ?? false,
        type: schemaToTypeString(spec, schema, cache),
        ...(desc !== undefined ? { description: desc } : {}),
      };
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
  cache: Map<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!responses) return undefined;

  const statusCodes = Object.keys(responses).sort();
  const successCodes = statusCodes.filter((c) => c.startsWith("2"));
  const preferred = ["200", "201", ...successCodes];

  for (const code of preferred) {
    const raw = responses[code] as Record<string, unknown> | undefined;
    if (!raw) continue;
    const response = maybeResolve(spec, raw, cache);

    const content = response["content"] as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!content) continue;

    const json = content["application/json"] ?? content["*/*"];
    if (!json) continue;

    const schema = json["schema"] as Record<string, unknown> | undefined;
    if (!schema) continue;

    return maybeResolve(spec, schema, cache);
  }

  return undefined;
}

// ============================================================================
// MODEL EXTRACTION
// ============================================================================

function extractModels(
  spec: Spec,
  cache: Map<string, Record<string, unknown>>,
): ExtractedModel[] {
  const components = spec["components"] as Record<string, unknown> | undefined;
  if (!components) return [];

  const schemas = components["schemas"] as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!schemas) return [];

  const models: ExtractedModel[] = [];

  for (const [name, rawSchema] of Object.entries(schemas)) {
    const schema = maybeResolve(spec, rawSchema, cache);
    const props = schema["properties"] as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!props) continue;

    const properties: Record<string, { type: string; description?: string }> =
      {};
    for (const [propName, propSchema] of Object.entries(props)) {
      const resolved = maybeResolve(spec, propSchema, cache);
      properties[propName] = {
        type: schemaToTypeString(spec, resolved, cache),
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

function extractEndpoints(
  spec: Spec,
  cache: Map<string, Record<string, unknown>>,
): ExtractedEndpoint[] {
  const paths = spec["paths"] as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!paths) return [];

  const endpoints: ExtractedEndpoint[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    const resolvedPathItem = maybeResolve(spec, pathItem, cache);

    const pathParams = resolvedPathItem["parameters"] as
      | Record<string, unknown>[]
      | undefined;

    for (const method of HTTP_METHODS) {
      const operation = resolvedPathItem[method] as
        | Record<string, unknown>
        | undefined;
      if (!operation) continue;

      const opParams = operation["parameters"] as
        | Record<string, unknown>[]
        | undefined;
      const mergedRawParams = mergeParameters(pathParams, opParams);
      const parameters = extractParameters(spec, mergedRawParams, cache);

      const responseSchema = extractResponseSchema(
        spec,
        operation["responses"] as Record<string, unknown> | undefined,
        cache,
      );

      const pagination = detectPagination(
        spec,
        parameters,
        responseSchema,
        cache,
      );

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

function hasPathParams(endpoint: ExtractedEndpoint): boolean {
  return endpoint.parameters.some((p) => p.in === "path");
}

function categorizeEndpoints(
  spec: Spec,
  endpoints: ExtractedEndpoint[],
  cache: Map<string, Record<string, unknown>>,
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
          ep.responseSchema &&
          looksLikeArrayResponse(spec, ep.responseSchema, cache)
        ) {
          listEndpoints.push(ep);
        } else if (hasPathParams(ep)) {
          getEndpoints.push(ep);
        } else {
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
// PAGINATION SYNTHESIS
// ============================================================================

/**
 * Derive an API-level `PaginationInfo` from the per-endpoint pagination data.
 * Takes the first paginated endpoint's detection results as representative.
 */
function derivePagination(
  spec: Spec,
  endpoints: ExtractedEndpoint[],
  cache: Map<string, Record<string, unknown>>,
): PaginationInfo | undefined {
  for (const ep of endpoints) {
    if (!ep.isPaginated) continue;

    const result = detectPagination(
      spec,
      ep.parameters,
      ep.responseSchema,
      cache,
    );

    if (result.isPaginated && result.style) {
      return {
        style: result.style,
        requestParam: result.requestParam,
        responseCursorPath: result.responseCursorPath,
        responseDataPath: result.responseDataPath,
        pageSizeParam: result.pageSizeParam,
      };
    }
  }

  return undefined;
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

export function extractAPI(spec: Record<string, unknown>): ExtractedAPI {
  const cache = new Map<string, Record<string, unknown>>();

  const info = (spec["info"] as Record<string, unknown>) ?? {};
  const title = (info["title"] as string) ?? "Untitled API";

  const servers = spec["servers"] as Record<string, unknown>[] | undefined;
  const baseUrl = (servers?.[0]?.["url"] as string) ?? "";

  const endpoints = extractEndpoints(spec, cache);
  const models = extractModels(spec, cache);
  const categories = categorizeEndpoints(spec, endpoints, cache);
  const pagination = derivePagination(spec, endpoints, cache);

  return {
    title,
    baseUrl,
    endpoints,
    models,
    ...categories,
    pagination,
  };
}
