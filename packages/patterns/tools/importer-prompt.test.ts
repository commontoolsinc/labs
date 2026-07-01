import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { generateImporterPrompt } from "./importer-prompt.ts";
import type { ExtractedAPI } from "./openapi-extract.ts";
import type { ExtractedProviderConfig } from "./openapi-to-provider.ts";

function sectionBetween(prompt: string, start: string, end: string): string {
  const startParts = prompt.split(start);
  assertEquals(startParts.length, 2);
  const endParts = startParts[1].split(end);
  assertEquals(endParts.length, 2);
  return endParts[0];
}

function sourceBlockBetween(
  prompt: string,
  heading: string,
  endMarker: string,
): string {
  const startParts = prompt.split(`${heading}\n\n`);
  assertEquals(startParts.length, 2);
  const endParts = startParts[1].split(endMarker);
  assertEquals(endParts.length, 2);
  return endParts[0];
}

function commonfabricImports(source: string): string {
  const matches = source.matchAll(
    /import\s*\{(?<imports>[\s\S]*?)\}\s*from\s*"commonfabric";/g,
  );
  return Array.from(matches, (match) => match.groups?.imports ?? "").join("\n");
}

const providerConfig: ExtractedProviderConfig = {
  name: "acme",
  authorizationEndpoint: "https://auth.example.com/oauth/authorize",
  tokenEndpoint: "https://auth.example.com/oauth/token",
  scopes: {
    "records.read": "Read records",
    "records.write": "Write records",
  },
  defaultScopes: "records.read",
  securitySchemeType: "oauth2",
  oauthFlowType: "authorizationCode",
};

const endpointWithParameters = {
  operationId: "listWidgets",
  method: "get",
  path: "/v1/widgets/{baseId}",
  summary: "List widgets",
  description: "Returns widgets visible to the signed-in user.",
  parameters: [
    {
      name: "baseId",
      in: "path" as const,
      required: true,
      type: "string",
      description: "Base identifier",
    },
    {
      name: "cursor",
      in: "query" as const,
      required: false,
      type: "string",
      description: "Pagination cursor",
    },
  ],
  responseSchema: {
    type: "object",
    properties: {
      data: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
      },
    },
  },
  isPaginated: true,
  paginationStyle: "cursor" as const,
};

const getEndpoint = {
  operationId: "getWidget",
  method: "get",
  path: "/v1/widgets/{id}",
  summary: "Get widget",
  parameters: [
    {
      name: "id",
      in: "path" as const,
      required: true,
      type: "string",
    },
  ],
  isPaginated: false,
};

const api: ExtractedAPI = {
  title: "Acme",
  baseUrl: "https://api.example.com",
  endpoints: [endpointWithParameters, getEndpoint],
  models: [],
  listEndpoints: [endpointWithParameters],
  getEndpoints: [getEndpoint],
  createEndpoints: [],
  updateEndpoints: [],
  deleteEndpoints: [],
  pagination: {
    style: "cursor",
    requestParam: "cursor",
    responseCursorPath: "meta.nextCursor",
    responseDataPath: "data",
    pageSizeParam: "limit",
  },
  rateLimit: {
    requestsPerSecond: 12,
    headerName: "Retry-After",
  },
};

Deno.test("generateImporterPrompt includes auth availability and current JSX guidance", () => {
  const prompt = generateImporterPrompt({
    providerName: "acme",
    brandColor: "#123456",
    api,
    providerConfig,
    primaryListEndpoint: "/v1/widgets",
    primaryGetEndpoint: "/v1/widgets/{id}",
  });
  const reference = sectionBetween(
    prompt,
    "<reference-implementations>",
    "</reference-implementations>",
  );
  const instructions = sectionBetween(
    prompt,
    "<instructions>",
    "</instructions>",
  );

  assertStringIncludes(
    instructions,
    'availability.state === "ready" ? availability.auth : null',
  );
  assertStringIncludes(instructions, "AuthManagerBase<ProviderAuth>");
  assertStringIncludes(
    instructions,
    "Bare ternaries for conditional rendering",
  );
  assertStringIncludes(instructions, '{loading ? "Loading..." : "Fetch Data"}');
  assertStringIncludes(instructions, "`auth ? mainContent : notReadyPanel`");
  assertStringIncludes(
    instructions,
    "Use `authIsReady(availability)` only for boolean readiness checks",
  );
  assertStringIncludes(
    instructions,
    'Import `authIsReady` from `"../auth/auth-types.ts"`',
  );
  assertStringIncludes(
    instructions,
    "Each provider call handler takes a non-null",
  );
  assertStringIncludes(
    instructions,
    'Always use `wish({ query: "#acmeAuth", scope: [".", "~"] })`',
  );
  assertFalse(instructions.includes("ifElse"));

  assertStringIncludes(reference, "## Reference: Airtable Auth Pattern");
  assertStringIncludes(
    instructions,
    "return the provider-typed fields including `availability`",
  );
  assertStringIncludes(reference, "type VNode");
  assertStringIncludes(reference, "[UI]: VNode;");
  assertStringIncludes(reference, "userChip: VNode;");
  assertStringIncludes(reference, "[TILE_UI]: VNode;");
  assertFalse(reference.includes("userChip: unknown;"));
  assertFalse(reference.includes("[TILE_UI]: unknown;"));
  assertStringIncludes(
    instructions,
    "Type renderable output fields as `VNode`",
  );
  assertStringIncludes(
    instructions,
    "Use `boolean` for loading or pending fields",
  );
  assertStringIncludes(
    instructions,
    "Keep raw API responses and unchecked child pattern outputs as `unknown`",
  );
  assertStringIncludes(reference, "AuthInfo");
  assertStringIncludes(reference, "return `Airtable: ${selectedBaseName}");
  assertFalse(reference.includes("return \\`Airtable:"));
});

Deno.test("generateImporterPrompt embeds current Airtable source references", async () => {
  const prompt = generateImporterPrompt({
    providerName: "acme",
    brandColor: "#123456",
    api,
    providerConfig,
    primaryListEndpoint: "/v1/widgets",
    primaryGetEndpoint: "/v1/widgets/{id}",
  });
  const references = [
    {
      heading: "## Reference: Airtable Auth Pattern (airtable-auth.tsx)",
      endMarker:
        "\n\n## Reference: Airtable Auth Manager (airtable-auth-manager.tsx)",
      source: new URL(
        "../airtable/core/airtable-auth.tsx",
        import.meta.url,
      ),
    },
    {
      heading:
        "## Reference: Airtable Auth Manager (airtable-auth-manager.tsx)",
      endMarker: "\n\n## Reference: Airtable API Client (airtable-client.ts)",
      source: new URL(
        "../airtable/core/util/airtable-auth-manager.tsx",
        import.meta.url,
      ),
    },
    {
      heading: "## Reference: Airtable API Client (airtable-client.ts)",
      endMarker: "\n\n## Reference: Airtable Importer (airtable-importer.tsx)",
      source: new URL(
        "../airtable/core/util/airtable-client.ts",
        import.meta.url,
      ),
    },
    {
      heading: "## Reference: Airtable Importer (airtable-importer.tsx)",
      endMarker: "\n</reference-implementations>",
      source: new URL("../airtable/airtable-importer.tsx", import.meta.url),
    },
  ];

  let importerSource = "";
  for (const reference of references) {
    const embedded = sourceBlockBetween(
      prompt,
      reference.heading,
      reference.endMarker,
    );
    assertEquals(embedded, await Deno.readTextFile(reference.source));

    if (reference.heading.includes("Importer")) {
      importerSource = embedded;
    }
  }

  assertFalse(/\bifElse\s*\(/.test(importerSource));
  assertFalse(/\bifElse\b/.test(commonfabricImports(importerSource)));
});

Deno.test("generateImporterPrompt renders extracted API details", () => {
  const prompt = generateImporterPrompt({
    providerName: "acme",
    brandColor: "#123456",
    api,
    providerConfig,
    primaryListEndpoint: "/v1/widgets",
    primaryGetEndpoint: "/v1/widgets/{id}",
  });
  const apiInfo = sectionBetween(prompt, "<api-info>", "</api-info>");

  assertStringIncludes(apiInfo, "- **Provider name (slug):** acme");
  assertStringIncludes(apiInfo, "- **Brand color:** #123456");
  assertStringIncludes(apiInfo, "- **Base URL:** https://api.example.com");
  assertStringIncludes(
    apiInfo,
    "- **Security scheme:** oauth2 (authorizationCode)",
  );
  assertStringIncludes(
    apiInfo,
    "- **Authorization endpoint:** https://auth.example.com/oauth/authorize",
  );
  assertStringIncludes(
    apiInfo,
    "- **Token endpoint:** https://auth.example.com/oauth/token",
  );
  assertStringIncludes(apiInfo, "- `records.read` — Read records");
  assertStringIncludes(apiInfo, "- Requests per second: 12");
  assertStringIncludes(apiInfo, "#### GET /v1/widgets/{baseId}");
  assertStringIncludes(apiInfo, "#### GET /v1/widgets/{id}");
  assertStringIncludes(apiInfo, "Pagination: cursor");
  assertStringIncludes(apiInfo, "Path parameters:");
  assertStringIncludes(apiInfo, "`baseId` (required): Base identifier");
  assertStringIncludes(apiInfo, "Query parameters:");
  assertStringIncludes(apiInfo, "`cursor`: Pagination cursor");
  assertStringIncludes(apiInfo, "Response schema:");
  assertStringIncludes(
    apiInfo,
    "### Primary List Endpoint (user hint): /v1/widgets",
  );
  assertStringIncludes(
    apiInfo,
    "### Primary Get Endpoint (user hint): /v1/widgets/{id}",
  );
});

Deno.test("generateImporterPrompt handles APIs without scopes or pagination", () => {
  const flatProvider: ExtractedProviderConfig = {
    name: "flat",
    scopes: {},
    defaultScopes: "",
    securitySchemeType: "none",
  };
  const flatApi: ExtractedAPI = {
    title: "Flat",
    baseUrl: "https://flat.example.com",
    endpoints: [{
      method: "post",
      path: "/items",
      parameters: [],
      isPaginated: false,
    }],
    models: [],
    listEndpoints: [],
    getEndpoints: [],
    createEndpoints: [],
    updateEndpoints: [],
    deleteEndpoints: [],
  };

  const prompt = generateImporterPrompt({
    providerName: "flat",
    brandColor: "#abcdef",
    api: flatApi,
    providerConfig: flatProvider,
  });
  const apiInfo = sectionBetween(prompt, "<api-info>", "</api-info>");

  assertStringIncludes(apiInfo, "No scopes defined in the spec");
  assertStringIncludes(apiInfo, "- **Security scheme:** none");
  assertStringIncludes(apiInfo, "- **Base URL:** https://flat.example.com");
  assertStringIncludes(apiInfo, "No pagination pattern detected");
  assertStringIncludes(apiInfo, "#### POST /items");
  assertFalse(apiInfo.includes("Authorization endpoint:"));
  assertFalse(apiInfo.includes("Rate Limiting"));
});
