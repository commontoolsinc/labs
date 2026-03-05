/**
 * openapi-to-provider.ts — Parse an OpenAPI 3.x spec's `securitySchemes` and
 * extract OAuth2 configuration into the Common Tools `ProviderDescriptor`
 * format.
 *
 * Usage:
 *   import { extractProviderConfig, generateDescriptorSource } from "./openapi-to-provider.ts";
 *   const spec = JSON.parse(await Deno.readTextFile("openapi.json"));
 *   const config = extractProviderConfig(spec, "acme");
 *   const source = generateDescriptorSource(config);
 *   await Deno.writeTextFile("acme.descriptor.ts", source);
 *
 * No external dependencies beyond Deno std.
 *
 * @module
 */

import { toPascalCase } from "./openapi-utils.ts";

/** Extracted OAuth2 / auth configuration from an OpenAPI spec. */
export interface ExtractedProviderConfig {
  name: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  scopes: Record<string, string>; // scope name -> description
  defaultScopes: string; // space-separated
  /** Raw security scheme type: "oauth2", "apiKey", "http", etc. */
  securitySchemeType: string;
  /** OAuth2 flow type when applicable: "authorizationCode", "implicit", etc. */
  oauthFlowType?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers for navigating untyped OpenAPI JSON
// ---------------------------------------------------------------------------

/** Safely access a nested path on an unknown object. */
function getPath(
  obj: Record<string, unknown>,
  ...keys: string[]
): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (
      current === null || current === undefined || typeof current !== "object"
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Type guard for plain objects. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// OpenAPI security scheme types
// ---------------------------------------------------------------------------

interface OAuthFlow {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes?: Record<string, string>;
}

interface SecurityScheme {
  type: string; // "oauth2" | "apiKey" | "http" | "openIdConnect"
  description?: string;
  // oauth2
  flows?: Record<string, OAuthFlow>;
  // apiKey
  name?: string;
  in?: string; // "query" | "header" | "cookie"
  // http
  scheme?: string; // "bearer", "basic", etc.
  bearerFormat?: string;
  // openIdConnect
  openIdConnectUrl?: string;
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/**
 * Extract provider configuration from a parsed OpenAPI 3.x JSON spec.
 *
 * Looks through `components.securitySchemes` for an OAuth2 scheme first,
 * falling back to apiKey or HTTP bearer if no OAuth2 scheme is found.
 *
 * @param spec          Parsed OpenAPI 3.x spec (plain JSON object)
 * @param providerName  Lowercase slug used as the `name` field (e.g. "acme")
 */
export function extractProviderConfig(
  spec: Record<string, unknown>,
  providerName: string,
): ExtractedProviderConfig {
  const schemes = getPath(spec, "components", "securitySchemes");

  if (!isRecord(schemes)) {
    return {
      name: providerName,
      scopes: {},
      defaultScopes: "",
      securitySchemeType: "none",
    };
  }

  // 1. Look for an OAuth2 security scheme
  for (const [_key, raw] of Object.entries(schemes)) {
    if (!isRecord(raw)) continue;
    const scheme = raw as unknown as SecurityScheme;
    if (scheme.type !== "oauth2" || !isRecord(scheme.flows)) continue;

    // Prefer authorizationCode flow; fall back to first available flow
    const preferredFlowOrder = [
      "authorizationCode",
      "clientCredentials",
      "implicit",
      "password",
    ];

    let chosenFlowName: string | undefined;
    let chosenFlow: OAuthFlow | undefined;

    for (const flowName of preferredFlowOrder) {
      const flow = scheme.flows[flowName];
      if (isRecord(flow)) {
        chosenFlowName = flowName;
        chosenFlow = flow as unknown as OAuthFlow;
        break;
      }
    }

    // If none of the preferred names matched, grab the first key
    if (!chosenFlow) {
      const firstKey = Object.keys(scheme.flows)[0];
      if (firstKey && isRecord(scheme.flows[firstKey])) {
        chosenFlowName = firstKey;
        chosenFlow = scheme.flows[firstKey] as unknown as OAuthFlow;
      }
    }

    if (!chosenFlow) continue;

    const scopes: Record<string, string> = {};
    if (isRecord(chosenFlow.scopes)) {
      for (const [scopeName, scopeDesc] of Object.entries(chosenFlow.scopes)) {
        scopes[scopeName] = typeof scopeDesc === "string" ? scopeDesc : "";
      }
    }

    return {
      name: providerName,
      authorizationEndpoint: chosenFlow.authorizationUrl,
      tokenEndpoint: chosenFlow.tokenUrl,
      scopes,
      defaultScopes: Object.keys(scopes).join(" "),
      securitySchemeType: "oauth2",
      oauthFlowType: chosenFlowName,
    };
  }

  // 2. Fall back to apiKey
  for (const [_key, raw] of Object.entries(schemes)) {
    if (!isRecord(raw)) continue;
    const scheme = raw as unknown as SecurityScheme;
    if (scheme.type === "apiKey") {
      return {
        name: providerName,
        scopes: {},
        defaultScopes: "",
        securitySchemeType: "apiKey",
      };
    }
  }

  // 3. Fall back to http (bearer / basic)
  for (const [_key, raw] of Object.entries(schemes)) {
    if (!isRecord(raw)) continue;
    const scheme = raw as unknown as SecurityScheme;
    if (scheme.type === "http") {
      return {
        name: providerName,
        scopes: {},
        defaultScopes: "",
        securitySchemeType: `http/${scheme.scheme ?? "unknown"}`,
      };
    }
  }

  return {
    name: providerName,
    scopes: {},
    defaultScopes: "",
    securitySchemeType: "none",
  };
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

/**
 * Generate a TypeScript source string for a `ProviderDescriptor` file,
 * following the same format as the airtable/google descriptor files in
 * `packages/toolshed/routes/integrations/`.
 *
 * The generated source uses environment variables for clientId and
 * clientSecret, with keys derived from the provider name
 * (e.g. ACME_CLIENT_ID, ACME_CLIENT_SECRET).
 *
 * @param config  Extracted provider config from `extractProviderConfig()`
 * @returns       TypeScript source string ready to write to disk
 */
export function generateDescriptorSource(
  config: ExtractedProviderConfig,
): string {
  const envPrefix = config.name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const pascalName = toPascalCase(config.name);

  const lines: string[] = [];

  // Header comment
  lines.push(`/**`);
  lines.push(` * ${pascalName} OAuth2 provider descriptor.`);
  lines.push(` *`);
  lines.push(` * ## Setup`);
  lines.push(` *`);
  lines.push(` * 1. Create an OAuth2 application with the ${pascalName} API.`);
  lines.push(
    ` * 2. Set the redirect URL to:`,
  );
  lines.push(
    ` *      http://localhost:8000/api/integrations/${config.name}-oauth/callback`,
  );
  lines.push(` * 3. Add to packages/toolshed/.env:`);
  lines.push(`  *      ${envPrefix}_CLIENT_ID=<your client id>`);
  lines.push(`  *      ${envPrefix}_CLIENT_SECRET=<your client secret>`);
  lines.push(` * 4. Restart the dev servers`);
  lines.push(` */`);

  // Imports
  lines.push(`import env from "@/env.ts";`);
  lines.push(
    `import type { ProviderDescriptor } from "../oauth2-common/oauth2-common.types.ts";`,
  );
  lines.push(``);

  // Descriptor
  lines.push(
    `export const ${pascalName}Descriptor: ProviderDescriptor = {`,
  );
  lines.push(`  name: "${config.name}",`);
  lines.push(`  clientId: env.${envPrefix}_CLIENT_ID,`);
  lines.push(`  clientSecret: env.${envPrefix}_CLIENT_SECRET,`);

  if (config.authorizationEndpoint) {
    lines.push(
      `  authorizationEndpoint: "${config.authorizationEndpoint}",`,
    );
  }

  if (config.tokenEndpoint) {
    lines.push(`  tokenEndpoint: "${config.tokenEndpoint}",`);
  }

  // Default scopes — quote the string
  lines.push(
    `  defaultScopes: "${config.defaultScopes}",`,
  );

  lines.push(`};`);
  lines.push(``);

  return lines.join("\n");
}
